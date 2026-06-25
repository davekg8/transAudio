'use strict';

/**
 * AudioBroadcaster — manages public WebSocket clients and broadcasts
 * translated audio to them, grouped by language.
 */
class AudioBroadcaster {
  constructor() {
    /** @type {Map<WebSocket, { language: string }>} */
    this._clients = new Map();

    /** @type {string[]} languages that have an active Gemini session */
    this._availableLanguages = [];

    /** @type {boolean} whether translation is currently streaming */
    this._streamingActive = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Client management                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Register a client WebSocket for a given language.
   * @param {WebSocket} ws
   * @param {string}    language  BCP-47 code
   */
  addClient(ws, language) {
    this._clients.set(ws, { language });
    console.log(`[Broadcaster] Client joined (${language}) — total: ${this._clients.size}`);

    // Send current state to the new client
    this._send(ws, {
      type: 'languages',
      available: this._availableLanguages,
    });

    this._send(ws, {
      type: 'info',
      streaming: this._streamingActive,
      language,
    });
  }

  /**
   * Unregister a client.
   * @param {WebSocket} ws
   */
  removeClient(ws) {
    if (this._clients.has(ws)) {
      const { language } = this._clients.get(ws);
      this._clients.delete(ws);
      console.log(`[Broadcaster] Client left (${language}) — total: ${this._clients.size}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Broadcasting                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Send a translated audio chunk to every client subscribed to `language`.
   * @param {string} language          BCP-47 code
   * @param {string} base64AudioChunk  Base64-encoded PCM 24 kHz
   */
  broadcast(language, base64AudioChunk) {
    const msg = JSON.stringify({ type: 'audio', data: base64AudioChunk });

    for (const [ws, meta] of this._clients) {
      if (meta.language === language && ws.readyState === 1 /* OPEN */) {
        ws.send(msg);
      }
    }
  }

  /**
   * Send a JSON message to ALL connected clients regardless of language.
   * @param {Object} message
   */
  notifyAll(message) {
    const raw = JSON.stringify(message);
    for (const [ws] of this._clients) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Language / state management                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Update the list of available languages and notify all clients.
   * @param {string[]} languages
   */
  setAvailableLanguages(languages) {
    this._availableLanguages = languages;
    this.notifyAll({ type: 'languages', available: languages });
  }

  /** @returns {string[]} */
  getAvailableLanguages() {
    return this._availableLanguages;
  }

  /**
   * Notify all clients about the streaming state.
   * @param {boolean} active
   */
  notifyStreamingState(active) {
    this._streamingActive = active;
    for (const [ws, meta] of this._clients) {
      if (ws.readyState === 1) {
        this._send(ws, {
          type: 'info',
          streaming: active,
          language: meta.language,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Stats                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * @returns {Object<string, number>} e.g. { en: 5, fr: 3 }
   */
  getClientCounts() {
    const counts = {};
    for (const [, meta] of this._clients) {
      counts[meta.language] = (counts[meta.language] || 0) + 1;
    }
    return counts;
  }

  /** @returns {number} */
  get totalClients() {
    return this._clients.size;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                          */
  /* ------------------------------------------------------------------ */

  _send(ws, obj) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  }
}

module.exports = AudioBroadcaster;
