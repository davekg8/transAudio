'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const SessionManager = require('../server/session-manager');

/** Fake Gemini Live server that records the target language of each session. */
function startFakeGemini() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { open: new Map() }; // ws -> language
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.setup) {
        state.open.set(ws, JSON.stringify(msg.setup));
        ws.send(JSON.stringify({ setupComplete: {} }));
      }
    });
    ws.on('close', () => state.open.delete(ws));
  });
  return new Promise((resolve) => {
    wss.on('listening', () => resolve({ wss, state, url: `ws://127.0.0.1:${wss.address().port}` }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('SessionManager - updateLanguages adds and removes sessions live', async () => {
  const { wss, state, url } = await startFakeGemini();
  const manager = new SessionManager({ apiKey: 'test', url });
  manager.on('session_error', () => {});

  await manager.startSession(['en', 'es']);
  const enTranslator = manager._translators.get('en');
  assert.deepStrictEqual(Object.keys(manager.getStatus().sessions), ['en', 'es']);

  await manager.updateLanguages(['en', 'pt']);
  await wait(100);
  assert.deepStrictEqual(Object.keys(manager.getStatus().sessions), ['en', 'pt']);
  assert.strictEqual(manager._translators.get('en'), enTranslator, 'kept session is not restarted');
  assert.strictEqual(state.open.size, 2, 'removed session is closed on the Gemini side');

  await manager.stopSession();
  wss.close();
});
