// Lesend-Liste des alten v1-Agenten (src/agent/tools.js), bis er entfernt ist (AURA-13). Aufruf: npm test
const test = require('node:test');
const assert = require('node:assert');
const { isReadOnly } = require('../src/agent/tools');

test('v1: Starter, Systemumstellungen und Umgebungsvariablen sind nicht lesend', () => {
  for (const c of [
    'env',
    'env rm x',
    'printenv',
    'echo $GEMINI_API_KEY',
    'cat /proc/self/environ',
    'ip link set eth0 down',
    'ifconfig eth0 down',
    'hostnamectl set-hostname x',
    'nvidia-smi -pl 100',
    'Get-ChildItem env:',
    'echo $env:GITHUB_TOKEN',
    'ps auxe',
    'rg --pre=sh pattern',
    'rg --pre sh pattern',
    '(ls)'
  ]) {
    assert.strictEqual(isReadOnly(c), false, c);
  }
});

test('v1: harmlose Lesebefehle bleiben lesend', () => {
  for (const c of ['ls -la ~/Downloads', 'cat notes.txt', 'echo $HOME', 'df -h', 'Get-ChildItem $env:USERPROFILE']) {
    assert.strictEqual(isReadOnly(c), true, c);
  }
});
