'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const GeminiTranslator = require('../server/gemini-translator');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake Gemini Live server: acknowledges setup, hands out a resumption handle,
 * and sends `goAway` on the first connection after a few audio chunks.
 */
function startFakeGemini() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { setups: [], audioPerConnection: [], connections: 0 };

  wss.on('connection', (ws) => {
    const index = state.connections++;
    state.audioPerConnection[index] = 0;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.setup) {
        state.setups.push(msg.setup);
        ws.send(JSON.stringify({ setupComplete: {} }));
        ws.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: `handle-${index}`, resumable: true } }));
      } else if (msg.realtimeInput) {
        assert.ok(msg.realtimeInput.audio, 'audio must use realtimeInput.audio');
        state.audioPerConnection[index]++;
        if (index === 0 && state.audioPerConnection[0] === 5) {
          ws.send(JSON.stringify({ goAway: { timeLeft: '10s' } }));
        }
      }
    });
  });

  return new Promise((resolve) => {
    wss.on('listening', () => resolve({ wss, state, url: `ws://127.0.0.1:${wss.address().port}` }));
  });
}

test('GeminiTranslator - renews the session on goAway without losing audio', async () => {
  const { wss, state, url } = await startFakeGemini();
  const translator = new GeminiTranslator({ apiKey: 'test', targetLanguage: 'en', url });
  translator.on('error', () => {});

  await translator.connect();
  assert.strictEqual(translator.status, 'connected');
  assert.ok(state.setups[0].sessionResumption, 'asks for resumption handles');
  assert.ok(!state.setups[0].sessionResumption.handle, 'first session is fresh');

  for (let i = 0; i < 20; i++) {
    translator.sendAudio(Buffer.alloc(3200).toString('base64'));
    await wait(10);
  }
  await wait(300);

  assert.strictEqual(state.connections, 2, 'a second connection replaced the first');
  assert.strictEqual(state.setups[1].sessionResumption.handle, 'handle-0', 'resumed with the last handle');
  const total = state.audioPerConnection.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 20, 'every audio chunk reached Gemini');
  assert.strictEqual(translator.status, 'connected');

  translator.disconnect();
  wss.close();
});
