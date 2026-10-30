'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const Logger = require('./logger');

// Gemini Multimodal Live API endpoint
const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// IMPORTANT: Only gemini-*-live-translate-preview models support translationConfig.
// Do NOT fall back to generic Gemini models — they will reject the translationConfig payload.
const LIVE_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview';

/**
 * GeminiTranslator — keeps one Gemini Live Translate session alive for one
 * target language, for as long as a service lasts.
 *
 * Gemini closes Live connections after a while. To survive that:
 *   • session resumption: Gemini sends resume handles; a new connection
 *     opened with the latest handle continues the same session (context kept);
 *   • goAway: when Gemini announces the end of a connection, a replacement
 *     is opened first and audio switches over without a gap;
 *   • context window compression: lets one session run longer than the
 *     default audio limit;
 *   • input audio is kept (a few seconds) while reconnecting, then replayed.
 * If the model rejects the resumption/compression options, they are turned
 * off automatically and the translator keeps working without them.
 *
 * Events:
 *   'audio'        (base64PcmChunk)  — translated audio (PCM 24 kHz mono)
 *   'connected'                      — session ready (also after a reconnect)
 *   'reconnecting' (attempt)         — session lost, retry scheduled
 *   'disconnected'                   — session lost
 *   'error'        (Error)           — any error
 */
class GeminiTranslator extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey                Gemini API key
   * @param {string} opts.targetLanguage        Target language code (e.g. "en")
   * @param {string} [opts.voiceName]           TTS voice name (default "Kore")
   * @param {string} [opts.model]               Gemini model name
   * @param {number} [opts.reconnectBaseDelay]  First retry delay in ms (doubles each attempt)
   * @param {number} [opts.setupTimeout]        Max wait for Gemini to accept a session, in ms
   * @param {boolean} [opts.sessionResumption]  Ask for resumption + compression (default on,
   *                                            GEMINI_SESSION_RESUMPTION=false turns it off)
   * @param {number} [opts.drainMs]             How long an old connection keeps delivering
   *                                            translated audio after a handover
   * @param {number} [opts.maxBufferedChunks]   Input chunks kept while reconnecting (100 ms each)
   */
  constructor({
    apiKey,
    targetLanguage,
    voiceName = 'Kore',
    model,
    reconnectBaseDelay = 1000,
    setupTimeout = 15000,
    sessionResumption,
    drainMs = 5000,
    maxBufferedChunks = 50,
  }) {
    super();
    this._apiKey = apiKey;
    this._targetLanguage = targetLanguage;
    this._voiceName = voiceName;
    // Only Live Translate models support translationConfig — never fall back to general models.
    this._modelName = model || process.env.GEMINI_MODEL || LIVE_TRANSLATE_MODEL;

    this._logger = new Logger(`GeminiTranslator/${this._targetLanguage}`);

    /** Connection currently receiving input audio. */
    this._ws = null;
    /** Every socket we opened and have not closed yet (current, opening, draining). */
    this._sockets = new Set();
    this._connecting = false;
    this._intentionalClose = false;
    this._sendCount = 0;

    // Reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 8;
    this._reconnectTimer = null;
    this._reconnectBaseDelay = reconnectBaseDelay;
    this._setupTimeout = setupTimeout;

    // Session continuity
    this._useSessionExtras =
      sessionResumption ?? process.env.GEMINI_SESSION_RESUMPTION !== 'false';
    this._resumeHandle = null;
    this._handoverInProgress = false;
    this._drainMs = drainMs;

    // Input audio kept while no session is ready
    this._pendingAudio = [];
    this._maxBufferedChunks = maxBufferedChunks;
    this._dropWarnShown = false;
  }

  get isConnected() {
    return this._ws !== null;
  }

  get status() {
    if (this.isConnected) return 'connected';
    if (this._connecting) return 'setup_pending';
    if (this._reconnectTimer) return 'reconnecting';
    return 'disconnected';
  }

  get modelName() {
    return this._modelName;
  }

  /**
   * Open a session with Gemini. Resolves once Gemini has accepted it.
   */
  async connect() {
    if (this._ws || this._connecting) return;

    this._intentionalClose = false;
    this._connecting = true;
    try {
      const ws = await this._openSession();
      if (this._intentionalClose) {
        this._closeWs(ws);
        return;
      }
      this._activate(ws);
    } finally {
      this._connecting = false;
    }
  }

  /**
   * Send PCM 16kHz mono audio chunk to Gemini for translation.
   * While reconnecting, the last few seconds are kept and sent once the
   * session is back, so less of the sermon is lost.
   * @param {string} base64PcmChunk
   */
  sendAudio(base64PcmChunk) {
    if (!this.isConnected) {
      if (this._intentionalClose) return;
      this._pendingAudio.push(base64PcmChunk);
      if (this._pendingAudio.length > this._maxBufferedChunks) {
        this._pendingAudio.shift();
        if (!this._dropWarnShown) {
          this._logger.warn('Session not ready — oldest buffered audio is being dropped');
          this._dropWarnShown = true;
        }
      }
      return;
    }
    this._dropWarnShown = false;
    this._sendAudioNow(base64PcmChunk);
  }

  onAudio(callback) {
    this.on('audio', callback);
  }

  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    if (this._sockets.size) {
      this._logger.info('Gracefully disconnecting session…');
    }
    this._ws = null;
    for (const ws of [...this._sockets]) this._closeWs(ws);
    this._pendingAudio = [];
    this._resumeHandle = null;
  }

  /**
   * Retry the connection with exponential backoff. Keeps retrying after
   * failed attempts until it succeeds or the attempt limit is reached.
   */
  scheduleReconnect() {
    if (this._intentionalClose || this._reconnectTimer || this._ws) return;

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._logger.error('Max reconnect attempts reached. Giving up.');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    const delay = Math.min(this._reconnectBaseDelay * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    this._logger.warn(`Scheduling reconnection in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})…`);
    this.emit('reconnecting', this._reconnectAttempts);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        this._logger.error('Reconnection attempt failed', err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /** Make `ws` the connection that receives input audio. */
  _activate(ws) {
    const wasConnected = this.isConnected;
    this._ws = ws;
    this._reconnectAttempts = 0;
    if (!wasConnected) this.emit('connected');
    this._flushPendingAudio();
  }

  /**
   * Open one WebSocket and complete the setup handshake.
   * Resolves with the socket once Gemini sends setupComplete.
   */
  _openSession() {
    const withExtras = this._useSessionExtras;
    const handle = withExtras ? this._resumeHandle : null;

    return new Promise((resolve, reject) => {
      // Build connection URL, but NEVER log the API key
      const url = `${GEMINI_WS_URL}?key=${this._apiKey}`;
      this._logger.info(
        `Connecting to Gemini Live API using model: ${this._modelName}${handle ? ' (resuming session)' : ''}`
      );

      const ws = new WebSocket(url);
      this._sockets.add(ws);

      let opened = false;
      let settled = false;

      const setupTimer = setTimeout(() => {
        failSetup(new Error(`Setup not acknowledged within ${this._setupTimeout}ms`));
      }, this._setupTimeout);

      const failSetup = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        this._closeWs(ws);

        // Gemini answered but refused the setup: retry with fewer options.
        if (opened && !this._intentionalClose) {
          if (handle) {
            this._logger.warn('Resume handle refused — starting a fresh session');
            this._resumeHandle = null;
            resolve(this._openSession());
            return;
          }
          if (withExtras && this._useSessionExtras) {
            this._logger.warn('Model refused session resumption options — continuing without them');
            this._useSessionExtras = false;
            resolve(this._openSession());
            return;
          }
        }
        reject(err);
      };

      ws.on('open', () => {
        opened = true;
        this._logger.info('WebSocket connected. Sending setup payload…');
        this._sendSetup(ws, withExtras, handle);
      });

      ws.on('message', (raw) => {
        if (!this._sockets.has(ws)) return;
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (err) {
          this._logger.error('Failed to parse incoming message', err);
          return;
        }

        if (!settled) {
          if (msg.error) {
            const errMsg = msg.error.message || JSON.stringify(msg.error);
            this._logger.error(`Gemini API Error during setup: ${errMsg}`);
            failSetup(new Error(errMsg));
            return;
          }
          if (msg.setupComplete) {
            settled = true;
            clearTimeout(setupTimer);
            this._logger.info(`Setup complete — model=${this._modelName}, lang=${this._targetLanguage}`);
            resolve(ws);
            return;
          }
        }

        this._handleMessage(ws, msg);
      });

      ws.on('error', (err) => {
        if (!settled) {
          this._logger.error('WebSocket connection error', err);
          failSetup(err);
          return;
        }
        if (ws === this._ws) {
          this._logger.error('WebSocket connection error', err);
          this.emit('error', err);
        }
      });

      ws.on('close', (code, reason) => {
        this._sockets.delete(ws);
        if (!settled) {
          failSetup(new Error(`WebSocket closed before setup (code=${code}, reason=${reason || 'none'})`));
          return;
        }
        if (ws !== this._ws) return; // replaced or draining connection

        this._ws = null;
        this._logger.warn(`WebSocket connection closed (code=${code}, reason=${reason || 'none'})`);
        this.emit('disconnected');

        // A handover already in flight will take over; otherwise reconnect.
        if (!this._intentionalClose && !this._handoverInProgress) {
          this.scheduleReconnect();
        }
      });
    });
  }

  _sendSetup(ws, withExtras, handle) {
    // Payload aligned with the official Gemini Live Translate API spec.
    // The translationConfig is only supported by gemini-*-live-translate-preview models.
    const setup = {
      model: this._modelName,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: this._targetLanguage,
        },
      },
    };

    if (withExtras) {
      setup.sessionResumption = handle ? { handle } : {};
      setup.contextWindowCompression = { slidingWindow: {} };
    }

    this._send(ws, { setup });
  }

  _handleMessage(ws, msg) {
    if (msg.error) {
      const errMsg = msg.error.message || JSON.stringify(msg.error);
      this._logger.error(`Gemini API Error: ${errMsg}`);
      if (ws === this._ws) this.emit('error', new Error(errMsg));
      return;
    }

    // Latest handle to resume this session on a new connection
    const update = msg.sessionResumptionUpdate;
    if (update && update.resumable !== false && update.newHandle) {
      this._resumeHandle = update.newHandle;
    }

    // Gemini will close this connection soon: open the next one now
    if (msg.goAway && ws === this._ws) {
      this._startHandover(msg.goAway.timeLeft);
    }

    // Translated audio chunks (also from a connection being drained)
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.emit('audio', part.inlineData.data);
        }
      }
    }
  }

  /**
   * Replace the current connection before Gemini closes it. Input audio keeps
   * going to the old one until the new one is ready, so nothing is lost.
   */
  async _startHandover(timeLeft) {
    if (this._handoverInProgress || this._intentionalClose) return;
    this._handoverInProgress = true;
    this._logger.info(`Gemini will close this connection (timeLeft=${timeLeft || 'unknown'}) — opening a replacement…`);

    try {
      const fresh = await this._openSession();
      if (this._intentionalClose) {
        this._closeWs(fresh);
        return;
      }
      const old = this._ws;
      this._activate(fresh);
      if (old) this._drain(old);
      this._logger.info('Handover complete');
    } catch (err) {
      this._logger.warn(`Handover failed: ${err.message}`);
    } finally {
      this._handoverInProgress = false;
    }

    // The old connection may have closed while the handover was failing.
    if (!this._ws && !this._intentionalClose) this.scheduleReconnect();
  }

  /** Stop feeding an old connection but let it finish sending translated audio. */
  _drain(ws) {
    const timer = setTimeout(() => this._closeWs(ws), this._drainMs);
    timer.unref?.();
  }

  _flushPendingAudio() {
    if (!this._pendingAudio.length) return;
    const queued = this._pendingAudio;
    this._pendingAudio = [];
    this._logger.info(`Sending ${queued.length} buffered audio chunk(s) after reconnect`);
    for (const chunk of queued) this._sendAudioNow(chunk);
  }

  _sendAudioNow(base64PcmChunk) {
    this._sendCount++;
    if (this._sendCount % 100 === 1) {
      this._logger.info(`Audio chunk #${this._sendCount} sent to Gemini (${base64PcmChunk.length} bytes base64)`);
    }

    this._send(this._ws, {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64PcmChunk,
          },
        ],
      },
    });
  }

  _send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  _closeWs(ws) {
    if (ws === this._ws) this._ws = null;
    this._sockets.delete(ws);
    try {
      ws.close(1000, 'Client disconnect');
    } catch (err) {
      ws.terminate?.();
    }
  }
}

module.exports = GeminiTranslator;
