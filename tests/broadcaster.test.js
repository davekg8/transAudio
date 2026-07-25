'use strict';

const test = require('node:test');
const assert = require('node:assert');
const AudioBroadcaster = require('../server/audio-broadcaster');

class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

test('AudioBroadcaster - addClient & removeClient', () => {
  const broadcaster = new AudioBroadcaster({ churchName: 'Église Grâce' });
  const ws1 = new MockWebSocket();
  const ws2 = new MockWebSocket();

  broadcaster.addClient(ws1, 'en');
  broadcaster.addClient(ws2, 'fr');

  assert.strictEqual(broadcaster.totalClients, 2);
  const counts = broadcaster.getClientCounts();
  assert.strictEqual(counts.en, 1);
  assert.strictEqual(counts.fr, 1);

  // Check initial info message contains churchName
  assert.strictEqual(ws1.sent[1].churchName, 'Église Grâce');
  assert.strictEqual(ws1.sent[1].language, 'en');

  broadcaster.removeClient(ws1);
  assert.strictEqual(broadcaster.totalClients, 1);
  assert.strictEqual(broadcaster.getClientCounts().en, undefined);
});

test('AudioBroadcaster - broadcast sends audio to matching language clients only', () => {
  const broadcaster = new AudioBroadcaster();
  const wsEn = new MockWebSocket();
  const wsFr = new MockWebSocket();

  broadcaster.addClient(wsEn, 'en');
  broadcaster.addClient(wsFr, 'fr');

  broadcaster.broadcast('en', 'base64audiochunk');

  const enAudioMsgs = wsEn.sent.filter(m => m.type === 'audio');
  const frAudioMsgs = wsFr.sent.filter(m => m.type === 'audio');

  assert.strictEqual(enAudioMsgs.length, 1);
  assert.strictEqual(enAudioMsgs[0].data, 'base64audiochunk');
  assert.strictEqual(frAudioMsgs.length, 0);
});

test('AudioBroadcaster - notifySessionStatus', () => {
  const broadcaster = new AudioBroadcaster();
  const wsEn = new MockWebSocket();

  broadcaster.addClient(wsEn, 'en');
  broadcaster.notifySessionStatus('en', 'reconnecting');

  const statusMsg = wsEn.sent.find(m => m.type === 'session_status');
  assert.notStrictEqual(statusMsg, undefined);
  assert.strictEqual(statusMsg.state, 'reconnecting');
});
