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

// Audio kept while the connection is being renewed (100 ms chunks → 15 s).
const MAX_PENDING_CHUNKS = 150;

/**
 * GeminiTranslator — manages the WebSocket connection to the Gemini Live
 * Translate API for one target language.
 *
 * Live sessions are time-limited by Google: the server announces the end with
 * `goAway` and hands out `sessionResumption` handles. The translator renews the
 * connection transparently (resuming the session) and buffers the audio sent
 * meanwhile, so a 2-hour service is not cut every few minutes.
 *
 * Events:
 *   'audio'             (base64PcmChunk)  — translated audio (PCM 24 kHz mono)
 *   'input_transcript'  (text)            — what the model heard
 *   'output_transcript' (text)            — the translation, as text
 *   'connected'                           — WebSocket open & setup acknowledged
 *   'reconnecting'      (attempt)         — connection lost, retrying
 *   'disconnected'                        — WebSocket closed
 *   'error'             (Error)           — any error
 */
class GeminiTranslator extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey         Gemini API key
   * @param {string} opts.targetLanguage Target language code (e.g. "en")
   * @param {string} [opts.model]        Gemini model name
   * @param {string} [opts.url]          Endpoint override (tests)
   */
  constructor({ apiKey, targetLanguage, model, url }) {
    super();
    this._endpoint = url || GEMINI_WS_URL;
    this._apiKey = apiKey;
    this._targetLanguage = targetLanguage;
    // Only Live Translate models support translationConfig — never fall back to general models.
    this._modelName = model || process.env.GEMINI_MODEL || LIVE_TRANSLATE_MODEL;

    this._logger = new Logger(`GeminiTranslator/${this._targetLanguage}`);
    this._ws = null;
    this._connected = false;
    this._setupComplete = false;
    this._intentionalClose = false;
    this._sendCount = 0;
    this._audioOutCount = 0;

    // Session renewal state
    this._resumeHandle = null;
    this._pending = [];
    this._renewing = false;

    // Reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 8;
    this._reconnectTimer = null;
  }

  get isConnected() {
    return this._connected && this._setupComplete;
  }

  get status() {
    if (this.isConnected) return 'connected';
    if (this._connected) return 'setup_pending';
    if (this._reconnectTimer || this._renewing) return 'reconnecting';
    return 'disconnected';
  }

  get modelName() {
    return this._modelName;
  }

  /**
   * Open WebSocket to Gemini and perform setup handshake.
   * Resolves once the server acknowledged the setup.
   */
  connect() {
    if (this.isConnected) return Promise.resolve();
    this._intentionalClose = false;
    return this._open();
  }

  /**
   * Send PCM 16kHz mono audio chunk to Gemini for translation.
   * @param {string} base64PcmChunk
   */
  sendAudio(base64PcmChunk) {
    if (!this.isConnected) {
      // Connection being renewed: keep the audio and flush it once back.
      if (this._renewing || this._reconnectTimer || this._connected) {
        this._pending.push(base64PcmChunk);
        if (this._pending.length > MAX_PENDING_CHUNKS) this._pending.shift();
      }
      return;
    }

    this._sendCount++;
    if (this._sendCount % 600 === 1) {
      this._logger.info(`Audio chunk #${this._sendCount} sent to Gemini`);
    }
    this._sendAudioNow(base64PcmChunk);
  }

  onAudio(callback) {
    this.on('audio', callback);
  }

  disconnect() {
    this._intentionalClose = true;
    this._renewing = false;
    this._pending = [];
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    if (this._ws) {
      this._logger.info('Gracefully disconnecting session…');
      const ws = this._ws;
      this._ws = null;
      ws.close(1000, 'Client disconnect');
    }

    this._connected = false;
    this._setupComplete = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  _open() {
    return new Promise((resolve, reject) => {
      // Build connection URL, but NEVER log the API key
      const url = `${this._endpoint}?key=${this._apiKey}`;
      const resuming = Boolean(this._resumeHandle);
      this._logger.info(`${resuming ? 'Resuming' : 'Connecting to'} Gemini Live session (model: ${this._modelName})`);

      const ws = new WebSocket(url);
      this._ws = ws;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      ws.on('open', () => {
        if (ws !== this._ws) return;
        this._connected = true;
        this._sendSetup(ws);
      });

      ws.on('message', (raw) => {
        if (ws !== this._ws) return;
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (err) {
          this._logger.error('Failed to parse incoming message', err);
          return;
        }
        this._handleMessage(msg, done);
      });

      ws.on('error', (err) => {
        if (ws !== this._ws) return;
        this._logger.error('WebSocket connection error', err);
        this.emit('error', err);
        done(err);
      });

      ws.on('close', (code, reason) => {
        if (ws !== this._ws) return; // an old socket we replaced on purpose
        const wasSetup = this._setupComplete;
        this._connected = false;
        this._setupComplete = false;
        this._ws = null;
        if (this._intentionalClose) {
          this.emit('disconnected');
          return;
        }
        this._logger.warn(`Gemini connection closed (code=${code}, reason=${reason || 'none'})`);
        done(new Error(`Connection closed before setup (code=${code})`));

        if (!wasSetup && this._resumeHandle) {
          // A stale resumption handle can be refused: start a fresh session.
          this._logger.warn('Resumption refused — starting a fresh session');
          this._resumeHandle = null;
        }
        this.emit('disconnected');
        if (wasSetup || this._renewing || this._reconnectAttempts > 0) {
          this._scheduleReconnect();
        }
      });
    });
  }

  _sendSetup(ws) {
    // Payload aligned with the official Gemini Live Translate API spec.
    // The translationConfig is only supported by gemini-*-live-translate-preview models.
    const setup = {
      setup: {
        model: this._modelName,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Lets the connection be renewed without losing the session.
        sessionResumption: this._resumeHandle ? { handle: this._resumeHandle } : {},
        // Keeps long sessions (a whole service) within the context window.
        contextWindowCompression: { slidingWindow: {} },
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: this._targetLanguage,
          },
        },
      },
    };

    ws.send(JSON.stringify(setup));
  }

  _handleMessage(msg, onSetupDone) {
    // Server error
    if (msg.error) {
      const errMsg = msg.error.message || JSON.stringify(msg.error);
      this._logger.error(`Gemini API Error: ${errMsg}`);
      const err = new Error(errMsg);
      this.emit('error', err);
      onSetupDone(err);
      return;
    }

    // Setup acknowledgement
    if (msg.setupComplete) {
      this._setupComplete = true;
      this._reconnectAttempts = 0;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      const resumed = this._renewing;
      this._renewing = false;
      this._logger.info(`Setup complete — model=${this._modelName}, lang=${this._targetLanguage}${resumed ? ' (session renewed)' : ''}`);
      this._flushPending();
      this.emit('connected');
      onSetupDone();
      return;
    }

    // Resumption handle for the next connection
    if (msg.sessionResumptionUpdate) {
      const { newHandle, resumable } = msg.sessionResumptionUpdate;
      if (resumable && newHandle) this._resumeHandle = newHandle;
    }

    // The server is about to end this connection: renew it now.
    if (msg.goAway) {
      this._logger.info(`Gemini announced the end of the connection (timeLeft=${msg.goAway.timeLeft || '?'}) — renewing`);
      this._renew();
      return;
    }

    const content = msg.serverContent;

    // Transcriptions: shown as live captions to listeners and in the admin console
    if (content?.inputTranscription?.text) {
      this._logger.debug(`Heard [${content.inputTranscription.languageCode || '?'}]: ${content.inputTranscription.text}`);
      this.emit('input_transcript', content.inputTranscription.text);
    }
    if (content?.outputTranscription?.text) {
      this._logger.debug(`Translated: ${content.outputTranscription.text}`);
      this.emit('output_transcript', content.outputTranscription.text);
    }

    // Translated audio chunks
    if (content?.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data) {
          this._audioOutCount++;
          if (this._audioOutCount % 500 === 1) {
            this._logger.info(`Translated audio chunk #${this._audioOutCount} received from Gemini`);
          }
          this.emit('audio', part.inlineData.data);
        }
      }
    }
  }

  /** Replace the current connection with a resumed one. */
  _renew() {
    if (this._intentionalClose || this._renewing) return;
    this._renewing = true;
    const old = this._ws;
    this._connected = false;
    this._setupComplete = false;
    this._open().catch((err) => this._logger.error('Session renewal failed', err));
    if (old) old.close(1000, 'Renewing session');
  }

  _flushPending() {
    const pending = this._pending;
    this._pending = [];
    for (const chunk of pending) this._sendAudioNow(chunk);
  }

  _sendAudioNow(base64PcmChunk) {
    // Live Translate expects realtimeInput.audio (the legacy mediaChunks
    // field is not handled by gemini-*-live-translate-preview models).
    this._wsSend({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64PcmChunk,
        },
      },
    });
  }

  _wsSend(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _scheduleReconnect() {
    if (this._intentionalClose || this._reconnectTimer) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._renewing = false;
      this._pending = [];
      this._logger.error('Max reconnect attempts reached. Giving up.');
      this.emit('error', new Error('Connexion à Gemini perdue (nombre maximal de tentatives atteint)'));
      return;
    }

    const delay = Math.min(500 * Math.pow(2, this._reconnectAttempts), 15000);
    this._reconnectAttempts++;
    this._logger.warn(`Scheduling reconnection in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})…`);
    this.emit('reconnecting', this._reconnectAttempts);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._renewing = true;
      this._open().catch((err) => this._logger.error('Reconnection attempt failed', err.message));
    }, delay);
  }
}

module.exports = GeminiTranslator;
