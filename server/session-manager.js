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
   * @param {string} [opts.url]   Gemini endpoint override (tests)
   */
  constructor({ apiKey, model, url }) {
    super();
    this._url = url;
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
    await Promise.allSettled(languages.map((lang) => this._addTranslator(lang)));
    this._streaming = true;
    this._logger.info('All translation sessions initiated');
  }

  /**
   * Change the languages while streaming: new languages get a session,
   * removed ones are stopped, the others keep running without interruption.
   * @param {string[]} languages
   */
  async updateLanguages(languages) {
    if (!this._streaming) return;
    const wanted = new Set(languages);
    for (const lang of [...this._translators.keys()]) {
      if (!wanted.has(lang)) this._removeTranslator(lang);
    }
    const added = languages.filter((l) => !this._translators.has(l));
    if (added.length) this._logger.info(`Adding translation sessions for: ${added.join(', ')}`);
    await Promise.allSettled(added.map((lang) => this._addTranslator(lang)));
  }

  /** Language whose session forwards the (shared) source transcript. */
  get _primaryLanguage() {
    return this._translators.keys().next().value;
  }

  async _addTranslator(lang) {
    const translator = new GeminiTranslator({
      apiKey: this._apiKey,
      targetLanguage: lang,
      model: this._model,
      url: this._url
    });

    // Forward translated audio and captions as events
    translator.onAudio((chunk) => {
      this.emit('audio', lang, chunk);
    });
    translator.on('output_transcript', (text) => {
      this.emit('transcript', { language: lang, kind: 'output', text });
    });
    // The source transcript is identical for every language: forward it once.
    translator.on('input_transcript', (text) => {
      if (lang === this._primaryLanguage) this.emit('transcript', { language: lang, kind: 'input', text });
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
      this._logger.error(`Failed to connect session [${lang}]`, err);
    }
  }

  _removeTranslator(lang) {
    const translator = this._translators.get(lang);
    if (!translator) return;
    translator.disconnect();
    translator.removeAllListeners();
    this._translators.delete(lang);
    this._logger.info(`Session [${lang}] stopped`);
  }

  /**
   * Stop all active translation sessions.
   */
  async stopSession() {
    this._logger.info('Stopping all active translation sessions');
    for (const lang of [...this._translators.keys()]) this._removeTranslator(lang);
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
