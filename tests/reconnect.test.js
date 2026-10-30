'use strict';

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');

/* Fake `ws` module so the real connect/reconnect code runs without network.
   Each new socket follows the next scripted behaviour: 'fail' errors out,
   'ok' opens and acknowledges setup. */
const script = [];
const sockets = [];
class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    sockets.push(this);
    const behaviour = script.shift() || 'ok';
    setImmediate(() => {
      if (behaviour === 'fail') {
        this.emit('error', new Error('ECONNREFUSED'));
        this.emit('close', 1006, '');
      } else {
        this.readyState = 1;
        this.emit('open');
      }
    });
  }
  send(data) {
    if (JSON.parse(data).setup) {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))));
    }
  }
  close() {
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
