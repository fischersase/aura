// Schwärzen von Zugangsdaten in Protokollen (src/redact.js, AURA-17); gleiche Fälle wie agent/tests/unit/test_paths_audit.py.
const test = require('node:test');
const assert = require('node:assert');
const { scrub } = require('../src/redact');

test('Zugangsdaten in Befehlen werden geschwärzt', () => {
  // Testwerte zusammengesetzt, damit kein schlüsselähnlicher Text wörtlich im Repo steht (Secret-Scanning).
  const j = (...p) => p.join('');
  const cases = [
    [j("curl -H 'Authorization: Bea", "rer abcdef1234567890xyz' https://api.example.com"), 'abcdef1234567890xyz'],
    [j('export GEMINI_API_KEY=', 'AI', 'za', 'SyA1234567890abcdefghijklmnopqrs && run'), 'SyA1234567890'],
    [j('GH_TOKEN=', 'gh', 'o_', '0123456789abcdefghijABCDEFGHIJ gh pr list'), '0123456789abcdefghij'],
    ['mysql -u root -pS3cretPw! mydb', 'S3cretPw!'],
    ['psql --password=hunter2hunter2 db', 'hunter2hunter2'],
    [j('tool --api-key ', 'sk', '-proj-', 'abcdefghijklmnopqrstuv'), 'abcdefghijklmnop'],
    ['git clone https://user:p4ssw0rd@github.com/x/y.git', 'p4ssw0rd'],
    [j('key: ', 'Zq3xL9vR2mWp8KtY', '7nB4cH6jF1sD5gA0', 'eU2iO8yT'), 'Zq3xL9vR2mWp8KtY']
  ];
  for (const [text, secret] of cases) {
    const out = scrub(text);
    assert.ok(!out.includes(secret) && out.includes('***'), out);
  }
});

test('harmlose Werte bleiben lesbar', () => {
  for (const t of ['git show 3313787f0c2a9d4e5b6a7c8d9e0f1a2b3c4d5e6f', 'ls -la ~/Downloads', 'mkdir -p ~/neu', 'ssh -p 2222 host']) {
    assert.strictEqual(scrub(t), t);
  }
});
