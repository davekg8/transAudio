'use strict';

const Logger = require('./logger');

/**
 * AudioBroadcaster — keeps track of the listener pages (WebSocket) and pushes
 * them state changes and live captions. The translated audio itself is served
 * as an MP3 stream (see live-stream.js).
 */
class AudioBroadcaster {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.churchName]
   */
  constructor({ churchName = 'Notre Église' } = {}) {
    this._churchName = churchName;
    this._logger = new Logger('AudioBroadcaster');

    /** @type {Map<WebSocket, { language: string|null }>} */
    this._clients = new Map();

    /** @type {string[]} languages listeners can pick */
    this._availableLanguages = [];

    /** @type {boolean} whether translation is currently streaming */
    this._streamingActive = false;
  }

  setChurchName(name) {
    this._churchName = name || 'Notre Église';
  }

  /** Register a page that has not picked a language yet. */
  addPage(ws) {
    this._clients.set(ws, { language: null });
    this._sendState(ws, null);
  }

  addClient(ws, language) {
    const previous = this._clients.get(ws);
    this._clients.set(ws, { language });
    if (!previous || previous.language !== language) {
      this._logger.info(`Client joined channel [${language}] — Total clients: ${this.totalListeners}`);
    }
    this._sendState(ws, language);
  }

  removeClient(ws) {
    if (this._clients.has(ws)) {
      const { language } = this._clients.get(ws);
      this._clients.delete(ws);
      if (language) {
        this._logger.info(`Client left channel [${language}] — Remaining clients: ${this.totalListeners}`);
      }
    }
  }

  /** Legacy: push an audio chunk over WebSocket to one language. */
  broadcast(language, base64AudioChunk) {
    this._sendToLanguage(language, { type: 'audio', data: base64AudioChunk });
  }

  /** Live caption (translated text) for one language. */
  sendCaption(language, text) {
    this._sendToLanguage(language, { type: 'caption', text });
  }

  notifyAll(message) {
    const raw = JSON.stringify(message);
    for (const [ws] of this._clients) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  notifySessionStatus(language, state) {
    this._sendToLanguage(language, {
      type: 'session_status',
      language,
      state, // 'connected', 'reconnecting', 'disconnected'
    });
  }

  setAvailableLanguages(languages) {
    this._availableLanguages = [...languages];
    this.notifyAll({ type: 'languages', available: this._availableLanguages });
  }

  getAvailableLanguages() {
    return this._availableLanguages;
  }

  notifyStreamingState(active) {
    this._streamingActive = active;
    for (const [ws, meta] of this._clients) {
      this._send(ws, {
        type: 'info',
        streaming: active,
        churchName: this._churchName,
        language: meta.language,
      });
    }
  }

  /** Pages that picked a language, per language. */
  getClientCounts() {
    const counts = {};
    for (const [, meta] of this._clients) {
      if (meta.language) counts[meta.language] = (counts[meta.language] || 0) + 1;
    }
    return counts;
  }

  /** Every open page (with or without a language). */
  get totalClients() {
    return this._clients.size;
  }

  get totalListeners() {
    let n = 0;
    for (const [, meta] of this._clients) if (meta.language) n++;
    return n;
  }

  _sendState(ws, language) {
    this._send(ws, { type: 'languages', available: this._availableLanguages });
    this._send(ws, {
      type: 'info',
      streaming: this._streamingActive,
      churchName: this._churchName,
      language,
    });
  }

  _sendToLanguage(language, obj) {
    const raw = JSON.stringify(obj);
    for (const [ws, meta] of this._clients) {
      if (meta.language === language && ws.readyState === 1) ws.send(raw);
    }
  }

  _send(ws, obj) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  }
}

module.exports = AudioBroadcaster;
