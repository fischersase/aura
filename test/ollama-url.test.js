// Remote Ollama warning (src/ollama.js isLocalUrl, AURA-62): only this computer counts as local.
const test = require('node:test');
const assert = require('node:assert');
const { isLocalUrl } = require('../src/ollama');

test('loopback addresses are local', () => {
  for (const u of [
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://LOCALHOST',
    'http://[::1]:11434',
    'http://127.0.0.2:8080',
    undefined,
    ''
  ]) {
    assert.strictEqual(isLocalUrl(u), true, String(u));
  }
});

test('everything else is remote', () => {
  for (const u of [
    'http://192.168.1.20:11434',
    'https://ollama.example.com',
    'http://127.0.0.1.evil.com',
    'http://localhost.evil.com',
    'http://0.0.0.0:11434',
    'http://10.0.0.1',
    'not a url'
  ]) {
    assert.strictEqual(isLocalUrl(u), false, u);
  }
});
