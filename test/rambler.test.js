const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

test('Rambler supports immediate stop/cancel on Windows (pointerdown, Esc shortcut, abortable fetch, race guard)', () => {
  const mainJs = read('main.js');
  const ramblerJs = read('renderer/rambler.js');
  const geminiJs = read('gemini.js');
  const ollamaJs = read('ollama.js');

  // Renderer handles Windows WS_EX_NOACTIVATE clicks via pointerdown and guards openMic races
  assert.match(ramblerJs, /el\.addEventListener\('pointerdown'/);
  assert.match(ramblerJs, /const mySession = \+\+sessionId/);
  assert.match(ramblerJs, /if \(mySession !== sessionId \|\| !active\)/);
  assert.match(ramblerJs, /state === 'abort'/);

  // Main process registers Escape while active, aborts in-flight processing, and has a stop guard & timeout
  assert.match(mainJs, /function registerRamblerEscape\(on\)/);
  assert.match(mainJs, /globalShortcut\.register\('Escape'/);
  assert.match(mainJs, /function cancelRambler\(\)/);
  assert.match(mainJs, /RAMBLER_TIMEOUT_MS/);
  assert.match(mainJs, /ramblerState\.stopGuardTimer/);
  assert.match(mainJs, /if \(ramblerState\.processing\) \{\s*cancelRambler\(\);/);

  // Gemini and Ollama rambler requests accept AbortSignal
  assert.match(geminiJs, /async function rambler\(\{[^}]*signal[^}]*\}\)/);
  assert.match(ollamaJs, /async function rambler\(\{[^}]*signal[^}]*\}\)/);
});
