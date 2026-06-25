'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');

// Gemini Multimodal Live API endpoint
const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/**
 * GeminiTranslator — manages a single WebSocket connection to the
 * Gemini 3.5 Live Translate API for one target language.
 *
 * Events:
 *   'audio'    (base64PcmChunk)  — translated audio (PCM 24 kHz mono)
 *   'connected'                  — WebSocket open & setup acknowledged
 *   'disconnected'               — WebSocket closed
 *   'error'    (Error)           — any error
 */
class GeminiTranslator extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey         Gemini API key
   * @param {string} opts.targetLanguage Target language code (e.g. "en")
   * @param {string} [opts.voiceName]    TTS voice name (default "Kore")
   */
  constructor({ apiKey, targetLanguage, voiceName = 'Kore' }) {
    super();
    this._apiKey = apiKey;
    this._targetLanguage = targetLanguage;
    this._voiceName = voiceName;

    this._ws = null;
    this._connected = false;
    this._setupComplete = false;
    this._intentionalClose = false;

    // Reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 8;
    this._reconnectTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                        */
  /* ------------------------------------------------------------------ */

  /** Whether the translator is connected and setup is complete. */
  get isConnected() {
    return this._connected && this._setupComplete;
  }

  /** Current connection status as a human-readable string. */
  get status() {
    if (this.isConnected) return 'connected';
    if (this._connected) return 'setup_pending';
    return 'disconnected';
  }

  /**
   * Open the WebSocket to Gemini and perform the setup handshake.
   * Resolves once setup is acknowledged by the server.
   */
  async connect() {
    if (this._connected) return;

    this._intentionalClose = false;

    return new Promise((resolve, reject) => {
      const url = `${GEMINI_WS_URL}?key=${this._apiKey}`;

      this._log('Connecting to Gemini Live Translate API…');
      this._ws = new WebSocket(url);

      // ---------- open ----------
      this._ws.on('open', () => {
        this._connected = true;
        this._reconnectAttempts = 0;
        this._log('WebSocket open — sending setup message');
        this._sendSetup();
      });

      // ---------- message ----------
      this._ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg, resolve);
        } catch (err) {
          this._log(`Failed to parse message: ${err.message}`);
        }
      });

      // ---------- error ----------
      this._ws.on('error', (err) => {
        this._log(`WebSocket error: ${err.message}`);
        this.emit('error', err);
        if (!this._setupComplete) reject(err);
      });

      // ---------- close ----------
      this._ws.on('close', (code, reason) => {
        const wasConnected = this._connected;
        this._connected = false;
        this._setupComplete = false;
        this._log(`WebSocket closed (code=${code}, reason=${reason || 'none'})`);
        this.emit('disconnected');

        if (!this._intentionalClose && wasConnected) {
          this._scheduleReconnect();
        }
      });
    });
  }

  /**
   * Send a PCM audio chunk to Gemini for translation.
   * @param {string} base64PcmChunk Base64-encoded PCM 16 kHz mono audio
   */
  sendAudio(base64PcmChunk) {
    if (!this.isConnected) {
      if (!this._dropWarnShown) {
        this._log('⚠ Audio dropped — not yet connected/setup complete');
        this._dropWarnShown = true;
      }
      return;
    }
    this._dropWarnShown = false;

    // Log periodically to confirm audio is flowing to Gemini
    if (!this._sendCount) this._sendCount = 0;
    this._sendCount++;
    if (this._sendCount % 100 === 1) {
      this._log(`Sending audio chunk #${this._sendCount} to Gemini (${base64PcmChunk.length} chars base64)`);
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

  /**
   * Register a callback for translated audio chunks.
   * Shortcut for `on('audio', callback)`.
   * @param {(base64Chunk: string) => void} callback
   */
  onAudio(callback) {
    this.on('audio', callback);
  }

  /**
   * Gracefully close the connection (no automatic reconnect).
   */
  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);

    if (this._ws) {
      this._log('Disconnecting…');
      this._ws.close(1000, 'Client disconnect');
      this._ws = null;
    }

    this._connected = false;
    this._setupComplete = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /** Send the initial setup/config message. */
  _sendSetup() {
    const setup = {
      setup: {
        model: 'models/gemini-3.5-live-translate-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this._voiceName,
              },
            },
          },
          translationConfig: {
            targetLanguageCode: this._targetLanguage,
            echoTargetLanguage: true,
          },
        },
      },
    };

    this._wsSend(setup);
  }

  /**
   * Process an incoming JSON message from Gemini.
   * @param {Object} msg           Parsed message
   * @param {Function} onSetupDone Resolve callback from connect()
   */
  _handleMessage(msg, onSetupDone) {
    // Setup acknowledgement
    if (msg.setupComplete) {
      this._setupComplete = true;
      this._log('Setup complete — ready to translate');
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

  /** Safely JSON-stringify and send over the WebSocket. */
  _wsSend(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  /** Schedule a reconnection with exponential back-off. */
  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._log('Max reconnect attempts reached — giving up');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    this._log(`Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})…`);

    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        this._log(`Reconnect failed: ${err.message}`);
      }
    }, delay);
  }

  /** Prefixed logger. */
  _log(message) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [GeminiTranslator/${this._targetLanguage}] ${message}`);
  }
}

module.exports = GeminiTranslator;
