'use strict';

const Logger = require('./logger');

const SAMPLE_RATE = 24000;       // Gemini output: PCM16 mono 24 kHz
const TICK_MS = 100;             // clock resolution
const BITRATE_KBPS = 48;         // ~6 KB/s per listener
const MAX_QUEUE_SECONDS = 12;    // safety cap if Gemini bursts far ahead of real time

let lamePromise = null;
function loadLame() {
  // @breezystack/lamejs ships a working ES module build; load it once.
  if (!lamePromise) lamePromise = import('@breezystack/lamejs');
  return lamePromise;
}

/**
 * LiveMp3Stream — one continuous "radio" per language.
 *
 * Translated PCM arrives from Gemini in bursts and goes quiet between sentences.
 * A real-time clock pulls PCM from a queue (or silence when the queue is empty),
 * encodes it to MP3 and writes the same bytes to every HTTP listener.
 * Phones play it with a plain <audio> element, which keeps playing with the
 * screen locked and uses ~10x less Wi-Fi than raw PCM over WebSocket.
 */
class LiveMp3Stream {
  constructor(language) {
    this.language = language;
    this._logger = new Logger(`LiveStream/${language}`);
    this._listeners = new Set();
    this._queue = [];            // Int16Array chunks waiting to be played
    this._queued = 0;            // samples in queue
    this._encoder = null;
    this._timer = null;
    this._lastTick = 0;
    this._carry = 0;             // fractional samples owed by the clock
  }

  get listenerCount() {
    return this._listeners.size;
  }

  /** Queue a base64 PCM16 chunk coming from Gemini. */
  pushPcm(base64) {
    if (this._listeners.size === 0) return; // nobody listening: don't build up latency
    const buf = Buffer.from(base64, 'base64');
    const samples = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1)));
    this._queue.push(samples);
    this._queued += samples.length;

    // Keep latency bounded: drop the oldest audio if we're far behind real time.
    const max = SAMPLE_RATE * MAX_QUEUE_SECONDS;
    while (this._queued > max && this._queue.length > 1) {
      this._queued -= this._queue.shift().length;
    }
  }

  /** Attach an HTTP response as a listener. */
  async addListener(res) {
    const lame = await loadLame();
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx, Render, ...)
      'icy-name': `TransAudio ${this.language}`,
    });
    if (res.socket) res.socket.setNoDelay(true);
    this._listeners.add(res);
    res.on('close', () => this._removeListener(res));
    this._logger.info(`Listener joined — ${this._listeners.size} listening`);

    if (!this._timer) this._start(lame);
  }

  /** End every listener (server shutdown). */
  closeAll() {
    for (const res of this._listeners) res.end();
    this._listeners.clear();
    this._stop();
  }

  _removeListener(res) {
    if (!this._listeners.delete(res)) return;
    this._logger.info(`Listener left — ${this._listeners.size} listening`);
    if (this._listeners.size === 0) this._stop();
  }

  _start(lame) {
    this._encoder = new lame.Mp3Encoder(1, SAMPLE_RATE, BITRATE_KBPS);
    this._lastTick = Date.now();
    this._carry = 0;
    // Send a short burst of silence so players start immediately.
    this._emit(this._take(Math.round(SAMPLE_RATE * 0.3)));
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  _stop() {
    clearInterval(this._timer);
    this._timer = null;
    this._encoder = null;
    this._queue = [];
    this._queued = 0;
  }

  _tick() {
    // Produce exactly as many samples as wall-clock time elapsed (no drift).
    const now = Date.now();
    const exact = ((now - this._lastTick) / 1000) * SAMPLE_RATE + this._carry;
    const n = Math.floor(exact);
    this._carry = exact - n;
    this._lastTick = now;
    if (n > 0) this._emit(this._take(Math.min(n, SAMPLE_RATE))); // cap at 1 s after a stall
  }

  /** Take n samples from the queue, padding with silence. */
  _take(n) {
    const out = new Int16Array(n);
    let filled = 0;
    while (filled < n && this._queue.length) {
      const head = this._queue[0];
      const count = Math.min(head.length, n - filled);
      out.set(head.subarray(0, count), filled);
      filled += count;
      if (count === head.length) this._queue.shift();
      else this._queue[0] = head.subarray(count);
      this._queued -= count;
    }
    return out;
  }

  _emit(samples) {
    if (!this._encoder) return;
    const mp3 = this._encoder.encodeBuffer(samples);
    if (!mp3.length) return;
    const chunk = Buffer.from(mp3.buffer, mp3.byteOffset, mp3.length);
    for (const res of this._listeners) {
      // A listener that can't keep up (dead Wi-Fi) is dropped instead of buffering forever.
      if (res.writableLength > 256 * 1024) { res.destroy(); continue; }
      res.write(chunk);
    }
  }
}

/** Registry of streams, one per language. */
class LiveStreamHub {
  constructor() {
    this._streams = new Map();
  }

  get(language) {
    if (!this._streams.has(language)) this._streams.set(language, new LiveMp3Stream(language));
    return this._streams.get(language);
  }

  push(language, base64) {
    const s = this._streams.get(language);
    if (s) s.pushPcm(base64);
  }

  listenerCounts() {
    const counts = {};
    for (const [lang, s] of this._streams) if (s.listenerCount) counts[lang] = s.listenerCount;
    return counts;
  }

  /** Disconnect the listeners of one language (e.g. removed by the admin). */
  close(language) {
    const s = this._streams.get(language);
    if (s) s.closeAll();
  }

  closeAll() {
    for (const s of this._streams.values()) s.closeAll();
  }
}

module.exports = { LiveMp3Stream, LiveStreamHub, SAMPLE_RATE };
