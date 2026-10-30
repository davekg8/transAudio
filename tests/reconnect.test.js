'use strict';

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');

/* Fake `ws` module so the real connect/reconnect code runs without network.
   Each new socket follows the next scripted behaviour:
   'ok' accepts setup, 'fail' errors before opening,
   'reject-extras' refuses a setup that asks for session resumption,
   'reject-handle' refuses a setup that carries a resume handle. */
const script = [];
const sockets = [];
class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.behaviour = script.shift() || 'ok';
    sockets.push(this);
    setImmediate(() => {
      if (this.behaviour === 'fail') {
        this.emit('error', new Error('ECONNREFUSED'));
        this.emit('close', 1006, '');
      } else {
        this.readyState = 1;
        this.emit('open');
      }
    });
  }
  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (!msg.setup) return;
    const refuse =
      (this.behaviour === 'reject-extras' && msg.setup.sessionResumption) ||
      (this.behaviour === 'reject-handle' && msg.setup.sessionResumption?.handle);
    this.reply(refuse ? { error: { message: 'Invalid setup' } } : { setupComplete: {} });
  }
  reply(obj) {
    setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(obj))));
  }
  audioSent() {
    return this.sent.filter((m) => m.realtimeInput).map((m) => m.realtimeInput.mediaChunks[0].data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    setImmediate(() => this.emit('close', 1000, ''));
  }
}
FakeWebSocket.OPEN = 1;
require.cache[require.resolve('ws')] = { exports: FakeWebSocket };

const GeminiTranslator = require('../server/gemini-translator');
const SessionManager = require('../server/session-manager');

function waitFor(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

test('keeps retrying after failed reconnect attempts, then recovers', async () => {
  const t = new GeminiTranslator({ apiKey: 'k', targetLanguage: 'en', reconnectBaseDelay: 1 });
  await t.connect();
  assert.strictEqual(t.status, 'connected');
  t.on('error', () => {});

  // Gemini drops the connection, then the next 3 attempts fail.
  script.push('fail', 'fail', 'fail', 'ok');
  const reconnected = waitFor(t, 'connected');
  sockets[sockets.length - 1].emit('close', 1011, 'session expired');
  await reconnected;

  assert.strictEqual(t.status, 'connected');
  assert.strictEqual(t._reconnectAttempts, 0);
  t.disconnect();
});

test('retries when the very first connection fails', async () => {
  script.push('fail', 'ok');
  const manager = new SessionManager({ apiKey: 'k' });
  await manager.startSession(['es']);
  const translator = manager._translators.get('es');
  translator._reconnectBaseDelay = 1;
  translator.on('error', () => {});
  if (translator.status !== 'connected') await waitFor(translator, 'connected');
  assert.strictEqual(manager.getStatus().sessions.es, 'connected');
  await manager.stopSession();
});

test('disconnect cancels a pending reconnect', async () => {
  const t = new GeminiTranslator({ apiKey: 'k', targetLanguage: 'en', reconnectBaseDelay: 50 });
  await t.connect();
  sockets[sockets.length - 1].emit('close', 1011, '');
  assert.strictEqual(t.status, 'reconnecting');
  t.disconnect();
  assert.strictEqual(t.status, 'disconnected');
  const before = sockets.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sockets.length, before);
});

test('restarting sessions does not duplicate translated audio', async () => {
  const manager = new SessionManager({ apiKey: 'k' });
  let received = 0;
  for (let i = 0; i < 3; i++) {
    await manager.startSession(['en']);
    manager.onTranslatedAudio('en', () => received++);
    await manager.stopSession();
  }
  await manager.startSession(['en']);
  manager.onTranslatedAudio('en', () => received++);

  manager.emit('audio:en', 'chunk');
  assert.strictEqual(received, 1);
  await manager.stopSession();
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const last = () => sockets[sockets.length - 1];

test('asks for session resumption and reuses the latest handle on reconnect', async () => {
  const t = new GeminiTranslator({ apiKey: 'k', targetLanguage: 'en', reconnectBaseDelay: 1, sessionResumption: true });
  await t.connect();
  const first = last();
  assert.deepStrictEqual(first.sent[0].setup.sessionResumption, {});
  assert.ok(first.sent[0].setup.contextWindowCompression);

  first.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  first.reply({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  await tick();

  const back = waitFor(t, 'connected');
  first.emit('close', 1011, 'gone');
  await back;
  assert.deepStrictEqual(last().sent[0].setup.sessionResumption, { handle: 'h2' });
  t.disconnect();
});

test('goAway: switches to a new connection without dropping audio', async () => {
  const t = new GeminiTranslator({ apiKey: 'k', targetLanguage: 'en', sessionResumption: true, drainMs: 20 });
  const translated = [];
  t.onAudio((c) => translated.push(c));
  let disconnected = 0;
  t.on('disconnected', () => disconnected++);
  await t.connect();
  const old = last();
  old.reply({ sessionResumptionUpdate: { newHandle: 'h1' } });
  await tick();

  // Delivered synchronously so the replacement is still opening when audio arrives.
  old.emit('message', Buffer.from(JSON.stringify({ goAway: { timeLeft: '5s' } })));
  t.sendAudio('during-handover'); // new connection not ready yet: goes to the old one
  await tick();

  const fresh = last();
  assert.notStrictEqual(fresh, old);
  assert.deepStrictEqual(fresh.sent[0].setup.sessionResumption, { handle: 'h1' });
  t.sendAudio('after-handover');
  assert.deepStrictEqual(old.audioSent(), ['during-handover']);
  assert.deepStrictEqual(fresh.audioSent(), ['after-handover']);

  // The old connection still delivers its last translated words…
  old.reply({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'tail' } }] } } });
  await tick();
  assert.deepStrictEqual(translated, ['tail']);

  // …then is closed, without the translator ever reporting a disconnect.
  await tick(40);
  assert.strictEqual(old.closed, true);
  assert.strictEqual(t.status, 'connected');
  assert.strictEqual(disconnected, 0);
  t.disconnect();
});

test('falls back to a plain session when the model refuses resumption options', async () => {
  script.push('reject-extras', 'reject-extras');
  const t = new GeminiTranslator({ apiKey: 'k', targetLanguage: 'en', sessionResumption: true });
  await t.connect();
  assert.strictEqual(t.status, 'connected');
  assert.strictEqual(last().sent[0].setup.sessionResumption, undefined);
  t.disconnect();
});

test('starts a fresh session when the resume handle is refused', async () => {
  const t = new GeminiTranslator({ apiKey: 'k', targetLanguage: 'en', reconnectBaseDelay: 1, sessionResumption: true });
  await t.connect();
  last().reply({ sessionResumptionUpdate: { newHandle: 'stale' } });
  await tick();

  script.push('reject-handle', 'ok');
  const back = waitFor(t, 'connected');
  last().emit('close', 1011, '');
  await back;
  assert.deepStrictEqual(last().sent[0].setup.sessionResumption, {});
  t.disconnect();
});

test('keeps input audio while reconnecting and sends it once back', async () => {
  const t = new GeminiTranslator({ apiKey: 'k', targetLanguage: 'en', reconnectBaseDelay: 20, maxBufferedChunks: 2 });
  await t.connect();
  const back = waitFor(t, 'connected');
  last().emit('close', 1011, '');

  t.sendAudio('a');
  t.sendAudio('b');
  t.sendAudio('c'); // buffer holds 2 chunks: 'a' is dropped
  await back;
  assert.deepStrictEqual(last().audioSent(), ['b', 'c']);
  t.disconnect();
});
