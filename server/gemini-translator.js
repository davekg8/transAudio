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
 * GeminiTranslator — manages a single WebSocket connection to the
 * Gemini Live Translate API for one target language.
 *
 * Events:
 *   'audio'        (base64PcmChunk)  — translated audio (PCM 24 kHz mono)
 *   'connected'                      — WebSocket open & setup acknowledged
 *   'reconnecting' (attempt)         — session temporarily disconnected, attempting reconnect
 *   'disconnected'                   — WebSocket closed
 *   'error'        (Error)           — any error
 */
class GeminiTranslator extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey         Gemini API key
   * @param {string} opts.targetLanguage Target language code (e.g. "en")
   * @param {string} [opts.voiceName]    TTS voice name (default "Kore")
   * @param {string} [opts.model]        Gemini model name
   */
  constructor({ apiKey, targetLanguage, voiceName = 'Kore', model, reconnectBaseDelay = 1000, setupTimeout = 15000 }) {
    super();
    this._apiKey = apiKey;
    this._targetLanguage = targetLanguage;
    this._voiceName = voiceName;
    // Only Live Translate models support translationConfig — never fall back to general models.
    this._modelName = model || process.env.GEMINI_MODEL || LIVE_TRANSLATE_MODEL;

    this._logger = new Logger(`GeminiTranslator/${this._targetLanguage}`);
    this._ws = null;
    this._connected = false;
    this._setupComplete = false;
    this._intentionalClose = false;
    this._sendCount = 0;

    // Reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 8;
    this._reconnectTimer = null;
    this._reconnectBaseDelay = reconnectBaseDelay;
    this._setupTimeout = setupTimeout;
  }

  get isConnected() {
    return this._connected && this._setupComplete;
  }

  get status() {
    if (this.isConnected) return 'connected';
    if (this._connected) return 'setup_pending';
    if (this._reconnectTimer) return 'reconnecting';
    return 'disconnected';
  }

  get modelName() {
    return this._modelName;
  }

  /**
   * Open WebSocket to Gemini and perform setup handshake.
   */
  async connect() {
    if (this._connected) return;

    this._intentionalClose = false;

    // Drop any half-open socket left by a failed attempt.
    this._closeSocket();

    return new Promise((resolve, reject) => {
      // Build connection URL, but NEVER log the API key
      const url = `${GEMINI_WS_URL}?key=${this._apiKey}`;

      this._logger.info(`Connecting to Gemini Live API using model: ${this._modelName}`);
      const ws = new WebSocket(url);
      this._ws = ws;

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        // Close this socket so its 'close' event cannot trigger a second reconnect.
        if (this._ws === ws) this._closeSocket();
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        resolve();
      };

      const setupTimer = setTimeout(() => {
        fail(new Error(`Setup not acknowledged within ${this._setupTimeout}ms`));
      }, this._setupTimeout);

      ws.on('open', () => {
        if (this._ws !== ws) return;
        this._connected = true;
        this._logger.info('WebSocket connected. Sending setup payload…');
        this._sendSetup();
      });

      ws.on('message', (raw) => {
        if (this._ws !== ws) return;
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg, succeed, fail);
        } catch (err) {
          this._logger.error('Failed to parse incoming message', err);
        }
      });

      ws.on('error', (err) => {
        if (this._ws !== ws) return;
        this._logger.error('WebSocket connection error', err);
        this.emit('error', err);
        fail(err);
      });

      ws.on('close', (code, reason) => {
        // Ignore sockets we already replaced or closed on purpose.
        if (this._ws !== ws) return;
        this._ws = null;
        this._connected = false;
        this._setupComplete = false;
        this._logger.warn(`WebSocket connection closed (code=${code}, reason=${reason || 'none'})`);
        this.emit('disconnected');

        if (!settled) {
          fail(new Error(`WebSocket closed before setup (code=${code})`));
        } else if (!this._intentionalClose) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Send PCM 16kHz mono audio chunk to Gemini for translation.
   * @param {string} base64PcmChunk
   */
  sendAudio(base64PcmChunk) {
    if (!this.isConnected) {
      if (!this._dropWarnShown) {
        this._logger.warn('Audio chunk dropped — translator not in connected state');
        this._dropWarnShown = true;
      }
      return;
    }
    this._dropWarnShown = false;

    this._sendCount++;
    if (this._sendCount % 100 === 1) {
      this._logger.info(`Audio chunk #${this._sendCount} sent to Gemini (${base64PcmChunk.length} bytes base64)`);
    }

    const payload = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64PcmChunk,
          },
        ],
      },
    };

    this._wsSend(payload);
  }

  onAudio(callback) {
    this.on('audio', callback);
  }

  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    if (this._ws) {
      this._logger.info('Gracefully disconnecting session…');
    }
    this._closeSocket();
  }

  /**
   * Retry the connection with exponential backoff. Keeps retrying after
   * failed attempts until it succeeds or the attempt limit is reached.
   */
  scheduleReconnect() {
    if (this._intentionalClose || this._reconnectTimer) return;

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

  _sendSetup() {
    // Payload aligned with the official Gemini Live Translate API spec.
    // The translationConfig is only supported by gemini-*-live-translate-preview models.
    const setup = {
      setup: {
        model: this._modelName,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: this._targetLanguage,
          },
        },
      },
    };

    this._wsSend(setup);
  }

  _handleMessage(msg, onSetupDone, onSetupReject) {
    // Server error
    if (msg.error) {
      const errMsg = msg.error.message || JSON.stringify(msg.error);
      this._logger.error(`Gemini API Error: ${errMsg}`);
      this.emit('error', new Error(errMsg));
      if (!this._setupComplete && typeof onSetupReject === 'function') {
        onSetupReject(new Error(errMsg));
      }
      return;
    }

    // Setup acknowledgement
    if (msg.setupComplete) {
      this._setupComplete = true;
      // Only a completed setup counts as a successful reconnect.
      this._reconnectAttempts = 0;
      this._logger.info(`Setup complete — model=${this._modelName}, lang=${this._targetLanguage}`);
      this.emit('connected');
      if (typeof onSetupDone === 'function') onSetupDone();
      return;
    }

    // Translated audio chunks
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.emit('audio', part.inlineData.data);
        }
      }
    }
  }

  _wsSend(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _closeSocket() {
    const ws = this._ws;
    this._ws = null;
    this._connected = false;
    this._setupComplete = false;
    if (ws) {
      try {
        ws.close(1000, 'Client disconnect');
      } catch (err) {
        ws.terminate?.();
      }
    }
  }
}

module.exports = GeminiTranslator;
