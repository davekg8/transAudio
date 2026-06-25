'use strict';

const GeminiTranslator = require('./gemini-translator');
const EventEmitter = require('events');

/**
 * SessionManager — orchestrates one GeminiTranslator per target language.
 *
 * Responsibilities:
 *   • Start / stop translation sessions for a list of languages
 *   • Fan-out a single audio source to every active translator
 *   • Expose per-language translated-audio callbacks
 *   • Provide a status snapshot for the admin dashboard
 */
class SessionManager extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey  Gemini API key
   */
  constructor({ apiKey }) {
    super();
    this._apiKey = apiKey;

    /** @type {Map<string, GeminiTranslator>} language → translator */
    this._translators = new Map();

    this._streaming = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                        */
  /* ------------------------------------------------------------------ */

  /** Whether at least one session is active. */
  get isStreaming() {
    return this._streaming;
  }

  /**
   * Start translation sessions for the given languages.
   * @param {string[]} languages  Array of BCP-47 codes, e.g. ["en","fr"]
   */
  async startSession(languages) {
    if (this._streaming) {
      console.log('[SessionManager] Already streaming — stopping first');
      await this.stopSession();
    }

    console.log(`[SessionManager] Starting sessions for: ${languages.join(', ')}`);

    const connectPromises = languages.map(async (lang) => {
      const translator = new GeminiTranslator({
        apiKey: this._apiKey,
        targetLanguage: lang,
      });

      // Forward translated audio as events
      translator.onAudio((chunk) => {
        this.emit(`audio:${lang}`, chunk);
      });

      translator.on('connected', () => {
        console.log(`[SessionManager] Session ${lang} connected`);
        this.emit('session_update');
      });

      translator.on('disconnected', () => {
        console.log(`[SessionManager] Session ${lang} disconnected`);
        this.emit('session_update');
      });

      translator.on('error', (err) => {
        console.error(`[SessionManager] Session ${lang} error: ${err.message}`);
        this.emit('session_error', { language: lang, error: err.message });
      });

      this._translators.set(lang, translator);

      try {
        await translator.connect();
      } catch (err) {
        console.error(`[SessionManager] Failed to connect ${lang}: ${err.message}`);
      }
    });

    await Promise.allSettled(connectPromises);
    this._streaming = true;
    console.log('[SessionManager] All sessions started');
  }

  /**
   * Stop all active translation sessions.
   */
  async stopSession() {
    console.log('[SessionManager] Stopping all sessions');
    for (const [lang, translator] of this._translators) {
      translator.disconnect();
      translator.removeAllListeners();
      console.log(`[SessionManager] Session ${lang} stopped`);
    }
    this._translators.clear();
    this._streaming = false;
  }

  /**
   * Feed an audio chunk to ALL active translators.
   * @param {string} base64PcmChunk  Base64-encoded PCM 16 kHz mono
   */
  feedAudio(base64PcmChunk) {
    for (const translator of this._translators.values()) {
      translator.sendAudio(base64PcmChunk);
    }
  }

  /**
   * Register a callback for translated audio of a specific language.
   * @param {string}   language  BCP-47 code
   * @param {Function} callback  (base64Chunk) => void
   */
  onTranslatedAudio(language, callback) {
    this.on(`audio:${language}`, callback);
  }

  /**
   * Return a status snapshot for the admin dashboard.
   * @returns {{ streaming: boolean, sessions: Object<string, string> }}
   */
  getStatus() {
    const sessions = {};
    for (const [lang, translator] of this._translators) {
      sessions[lang] = translator.status;
    }
    return {
      streaming: this._streaming,
      sessions,
    };
  }
}

module.exports = SessionManager;
