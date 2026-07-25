'use strict';

const Logger = require('./logger');

/**
 * AudioBroadcaster — manages public WebSocket clients and broadcasts
 * translated audio to them, grouped by language.
 */
class AudioBroadcaster {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.churchName]
   */
  constructor({ churchName = 'Notre Église' } = {}) {
    this._churchName = churchName;
    this._logger = new Logger('AudioBroadcaster');

    /** @type {Map<WebSocket, { language: string }>} */
    this._clients = new Map();

    /** @type {string[]} languages that have an active Gemini session */
    this._availableLanguages = [];

    /** @type {boolean} whether translation is currently streaming */
    this._streamingActive = false;
  }

  setChurchName(name) {
    this._churchName = name || 'Notre Église';
  }

  addClient(ws, language) {
    this._clients.set(ws, { language });
    this._logger.info(`Client joined channel [${language}] — Total clients: ${this._clients.size}`);

    // Send current configuration and state to new client
    this._send(ws, {
      type: 'languages',
      available: this._availableLanguages,
    });

    this._send(ws, {
      type: 'info',
      streaming: this._streamingActive,
      churchName: this._churchName,
      language,
    });
  }

  removeClient(ws) {
    if (this._clients.has(ws)) {
      const { language } = this._clients.get(ws);
      this._clients.delete(ws);
      this._logger.info(`Client left channel [${language}] — Remaining clients: ${this._clients.size}`);
    }
  }

  broadcast(language, base64AudioChunk) {
    const msg = JSON.stringify({ type: 'audio', data: base64AudioChunk });

    for (const [ws, meta] of this._clients) {
      if (meta.language === language && ws.readyState === 1 /* OPEN */) {
        ws.send(msg);
      }
    }
  }

  notifyAll(message) {
    const raw = JSON.stringify(message);
    for (const [ws] of this._clients) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  notifySessionStatus(language, state) {
    for (const [ws, meta] of this._clients) {
      if (meta.language === language && ws.readyState === 1) {
        this._send(ws, {
          type: 'session_status',
          language,
          state, // 'connected', 'reconnecting', 'disconnected'
        });
      }
    }
  }

  setAvailableLanguages(languages) {
    this._availableLanguages = languages;
    this.notifyAll({ type: 'languages', available: languages });
  }

  getAvailableLanguages() {
    return this._availableLanguages;
  }

  notifyStreamingState(active) {
    this._streamingActive = active;
    for (const [ws, meta] of this._clients) {
      if (ws.readyState === 1) {
        this._send(ws, {
          type: 'info',
          streaming: active,
          churchName: this._churchName,
          language: meta.language,
        });
      }
    }
  }

  getClientCounts() {
    const counts = {};
    for (const [, meta] of this._clients) {
      counts[meta.language] = (counts[meta.language] || 0) + 1;
    }
    return counts;
  }

  get totalClients() {
    return this._clients.size;
  }

  _send(ws, obj) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  }
}

module.exports = AudioBroadcaster;
