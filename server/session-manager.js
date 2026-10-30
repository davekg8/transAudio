'use strict';

const GeminiTranslator = require('./gemini-translator');
const EventEmitter = require('events');
const Logger = require('./logger');

/**
 * SessionManager — orchestrates one GeminiTranslator per target language.
 *
 * Responsibilities:
 *   • Start / stop translation sessions for a list of languages
 *   • Fan-out a single audio source to every active translator
 *   • Expose per-language translated-audio callbacks
 *   • Provide a status snapshot for the admin dashboard and public clients
 */
class SessionManager extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey  Gemini API key
   * @param {string} [opts.model] Gemini model
   */
  constructor({ apiKey, model }) {
    super();
    this._apiKey = apiKey;
    this._model = model || process.env.GEMINI_MODEL;
    this._logger = new Logger('SessionManager');

    /** @type {Map<string, GeminiTranslator>} language → translator */
    this._translators = new Map();

    this._streaming = false;
    this._audioChunkCount = 0;
  }

  get isStreaming() {
    return this._streaming;
  }

  /**
   * Start translation sessions for the given languages.
   * @param {string[]} languages Array of BCP-47 codes, e.g. ["en","fr"]
   */
  async startSession(languages) {
    if (this._streaming) {
      this._logger.info('Already streaming — stopping existing sessions first');
      await this.stopSession();
    }

    this._logger.info(`Starting translation sessions for: ${languages.join(', ')}`);
    this._audioChunkCount = 0;

    const connectPromises = languages.map(async (lang) => {
      const translator = new GeminiTranslator({
        apiKey: this._apiKey,
        targetLanguage: lang,
        model: this._model
      });

      // Forward translated audio as events
      translator.onAudio((chunk) => {
        this.emit(`audio:${lang}`, chunk);
      });

      translator.on('connected', () => {
        this._logger.info(`Session [${lang}] connected successfully`);
        this.emit('session_status', { language: lang, status: 'connected' });
      });

      translator.on('reconnecting', (attempt) => {
        this._logger.warn(`Session [${lang}] reconnecting (attempt ${attempt})`);
        this.emit('session_status', { language: lang, status: 'reconnecting', attempt });
      });

      translator.on('disconnected', () => {
        this._logger.warn(`Session [${lang}] disconnected`);
        this.emit('session_status', { language: lang, status: 'disconnected' });
      });

      translator.on('error', (err) => {
        this._logger.error(`Session [${lang}] error`, err);
        this.emit('session_error', { language: lang, error: err.message });
      });

      this._translators.set(lang, translator);

      try {
        await translator.connect();
      } catch (err) {
        this._logger.error(`Failed to connect session [${lang}], will retry`, err);
        translator.scheduleReconnect();
      }
    });

    await Promise.allSettled(connectPromises);
    this._streaming = true;
    this._logger.info('All translation sessions initiated');
  }

  /**
   * Stop all active translation sessions.
   */
  async stopSession() {
    this._logger.info('Stopping all active translation sessions');
    for (const [lang, translator] of this._translators) {
      translator.disconnect();
      translator.removeAllListeners();
      // Drop audio subscribers too, otherwise each restart adds one more
      // and listeners receive every chunk several times.
      this.removeAllListeners(`audio:${lang}`);
      this._logger.info(`Session [${lang}] stopped`);
    }
    this._translators.clear();
    this._streaming = false;
    this._audioChunkCount = 0;
  }

  /**
   * Feed an audio chunk to ALL active translators.
   * @param {string} base64PcmChunk Base64-encoded PCM 16 kHz mono
   */
  feedAudio(base64PcmChunk) {
    if (!this._streaming) return;

    this._audioChunkCount++;
    if (this._audioChunkCount % 100 === 1) {
      this._logger.info(`Audio chunk #${this._audioChunkCount} dispatched to ${this._translators.size} session(s)`);
    }

    for (const translator of this._translators.values()) {
      translator.sendAudio(base64PcmChunk);
    }
  }

  /**
   * Register a callback for translated audio of a specific language.
   * @param {string}   language
   * @param {Function} callback (base64Chunk) => void
   */
  onTranslatedAudio(language, callback) {
    this.on(`audio:${language}`, callback);
  }

  /**
   * Return status snapshot for admin/clients.
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
