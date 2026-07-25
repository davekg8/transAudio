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
  constructor({ apiKey, targetLanguage, voiceName = 'Kore', model }) {
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

    return new Promise((resolve, reject) => {
      // Build connection URL, but NEVER log the API key
      const url = `${GEMINI_WS_URL}?key=${this._apiKey}`;

      this._logger.info(`Connecting to Gemini Live API using model: ${this._modelName}`);
      this._ws = new WebSocket(url);

      this._ws.on('open', () => {
        this._connected = true;
        this._reconnectAttempts = 0;
        this._logger.info('WebSocket connected. Sending setup payload…');
        this._sendSetup();
      });

      this._ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg, resolve, reject);
        } catch (err) {
          this._logger.error('Failed to parse incoming message', err);
        }
      });

      this._ws.on('error', (err) => {
        this._logger.error('WebSocket connection error', err);
        this.emit('error', err);
        if (!this._setupComplete) reject(err);
      });

      this._ws.on('close', (code, reason) => {
        const wasConnected = this._connected;
        this._connected = false;
        this._setupComplete = false;
        this._logger.warn(`WebSocket connection closed (code=${code}, reason=${reason || 'none'})`);
        this.emit('disconnected');

        if (!this._intentionalClose && wasConnected) {
          this._scheduleReconnect();
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

    if (this._ws) {
      this._logger.info('Gracefully disconnecting session…');
      this._ws.close(1000, 'Client disconnect');
      this._ws = null;
    }

    this._connected = false;
    this._setupComplete = false;
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

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._logger.error('Max reconnect attempts reached. Giving up.');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    this._logger.warn(`Scheduling reconnection in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})…`);
    this.emit('reconnecting', this._reconnectAttempts);

    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        this._logger.error('Reconnection attempt failed', err);
      }
    }, delay);
  }
}

module.exports = GeminiTranslator;
