'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { LiveMp3Stream, LiveStreamHub } = require('../server/live-stream');

/** Minimal stand-in for an http.ServerResponse. */
class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = null;
    this.chunks = [];
    this.writableLength = 0;
    this.ended = false;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(chunk); return true; }
  end() { this.ended = true; this.emit('close'); }
  destroy() { this.emit('close'); }
  get bytes() { return this.chunks.reduce((n, c) => n + c.length, 0); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('LiveMp3Stream - serves real-time MP3 to listeners and counts them', async () => {
  const stream = new LiveMp3Stream('en');
  const res = new MockResponse();
  await stream.addListener(res);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['Content-Type'], 'audio/mpeg');
  assert.strictEqual(stream.listenerCount, 1);

  // One second of a 440 Hz tone at 24 kHz
  const pcm = new Int16Array(24000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000);
  stream.pushPcm(Buffer.from(pcm.buffer).toString('base64'));

  await wait(1200);
  // 48 kbps ≈ 6 KB/s: about 1.5 s of stream (300 ms prebuffer + 1.2 s)
  assert.ok(res.bytes > 4000, `expected MP3 data, got ${res.bytes} bytes`);
  assert.ok(res.bytes < 20000, `stream must follow real time, got ${res.bytes} bytes`);
  // MP3 frame sync word
  const all = Buffer.concat(res.chunks);
  assert.ok(all.includes(Buffer.from([0xff])), 'contains MP3 frame data');

  res.emit('close');
  assert.strictEqual(stream.listenerCount, 0);
});

test('LiveMp3Stream - ignores audio when nobody listens', () => {
  const stream = new LiveMp3Stream('es');
  stream.pushPcm(Buffer.alloc(4800).toString('base64'));
  assert.strictEqual(stream._queued, 0);
});

test('LiveStreamHub - per-language listener counts', async () => {
  const hub = new LiveStreamHub();
  const a = new MockResponse();
  const b = new MockResponse();
  await hub.get('en').addListener(a);
  await hub.get('pt').addListener(b);
  assert.deepStrictEqual(hub.listenerCounts(), { en: 1, pt: 1 });
  hub.closeAll();
  assert.deepStrictEqual(hub.listenerCounts(), {});
  assert.ok(a.ended && b.ended);
});
