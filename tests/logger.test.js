'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Logger = require('../server/logger');

test('Logger - redacts API key query parameters', () => {
  const textWithKey = 'wss://generativelanguage.googleapis.com/ws?key=AIzaSyD-Secret123456';
  const redacted = Logger.redact(textWithKey);
  assert.strictEqual(redacted.includes('AIzaSyD-Secret123456'), false);
  assert.strictEqual(redacted.includes('[REDACTED_API_KEY]'), true);
});

test('Logger - formats log message with module name', () => {
  const logger = new Logger('TestModule');
  assert.strictEqual(logger._moduleName, 'TestModule');
});
