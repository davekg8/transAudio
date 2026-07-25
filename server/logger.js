'use strict';

/**
 * Structured Logger utility for TransAudio.
 * Redacts sensitive API keys and formats log messages.
 */
class Logger {
  constructor(moduleName = 'Server') {
    this._moduleName = moduleName;
  }

  static redact(text) {
    if (typeof text !== 'string') return text;
    // Hide API key query params
    return text.replace(/(key=)[A-Za-z0-9_\-]+/g, '$1[REDACTED_API_KEY]');
  }

  _format(level, message) {
    const ts = new Date().toISOString();
    const cleanMsg = Logger.redact(message);
    return `[${ts}] [${level}] [${this._moduleName}] ${cleanMsg}`;
  }

  info(message) {
    console.log(this._format('INFO', message));
  }

  warn(message) {
    console.warn(this._format('WARN', message));
  }

  error(message, err) {
    const errMsg = err ? `${message}: ${err.stack || err.message || err}` : message;
    console.error(this._format('ERROR', errMsg));
  }

  debug(message) {
    if (process.env.DEBUG) {
      console.log(this._format('DEBUG', message));
    }
  }
}

module.exports = Logger;
