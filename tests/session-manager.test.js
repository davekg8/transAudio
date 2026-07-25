'use strict';

const test = require('node:test');
const assert = require('node:assert');
const SessionManager = require('../server/session-manager');

test('SessionManager - initialization and status snapshot', () => {
  const manager = new SessionManager({ apiKey: 'fake_key', model: 'models/gemini-3.5-live-translate-preview' });
  assert.strictEqual(manager.isStreaming, false);

  const status = manager.getStatus();
  assert.strictEqual(status.streaming, false);
  assert.deepStrictEqual(status.sessions, {});
});

test('SessionManager - stopSession when inactive is safe', async () => {
  const manager = new SessionManager({ apiKey: 'fake_key' });
  await manager.stopSession();
  assert.strictEqual(manager.isStreaming, false);
});
