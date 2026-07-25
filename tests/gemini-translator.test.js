'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GeminiTranslator = require('../server/gemini-translator');

test('GeminiTranslator - defaults to gemini-3.5-live-translate-preview model', () => {
  const translator = new GeminiTranslator({
    apiKey: 'fake_key',
    targetLanguage: 'en',
  });

  assert.strictEqual(translator.modelName, 'models/gemini-3.5-live-translate-preview');
  assert.strictEqual(translator.isConnected, false);
  assert.strictEqual(translator.status, 'disconnected');
});

test('GeminiTranslator - disconnect when unopened does not throw', () => {
  const translator = new GeminiTranslator({
    apiKey: 'fake_key',
    targetLanguage: 'fr',
  });

  translator.disconnect();
  assert.strictEqual(translator.isConnected, false);
});
