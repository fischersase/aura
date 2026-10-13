// Aura connector catalog in the app (src/connectors.js, AURA-96).
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/connectors');

test('catalog entries come with ready settings', () => {
  const atlassian = c.byId('atlassian');
  assert.strictEqual(atlassian.config.auth, 'oauth');
  assert.strictEqual(c.forUrl('https://mcp.atlassian.com/v1/mcp/').id, 'atlassian', 'trailing slash ignored');
  assert.strictEqual(c.forUrl('https://example.com/mcp'), null);
  assert.strictEqual(c.forUrl(''), null);
});

test('credentials go to the vault; the config only holds a reference', () => {
  const stored = [];
  const cfg = c.configFor(
    c.byId('github'),
    { GITHUB_TOKEN: '  github_pat_abc  ' },
    (k) => `GITHUB_${k}`,
    (name, value, note) => stored.push({ name, value, note })
  );
  assert.deepStrictEqual(stored, [
    { name: 'GITHUB_GITHUB_TOKEN', value: 'github_pat_abc', note: 'GitHub: Persönlicher Zugriffstoken (fine-grained)' }
  ]);
  assert.strictEqual(cfg.headers.Authorization, 'Bearer ${secret:GITHUB_GITHUB_TOKEN}');
  assert.strictEqual(cfg.catalogId, 'github');
  assert.ok(!JSON.stringify(cfg).includes('github_pat_abc'));
});

test('missing credentials and unavailable entries are refused', () => {
  const noop = () => {};
  assert.throws(() => c.configFor(c.byId('github'), {}, (k) => k, noop), /Persönlicher Zugriffstoken/);
  assert.throws(() => c.configFor(c.byId('mail'), { MAIL_ADDRESS: 'a@gmail.com' }, (k) => k, noop), /App-Passwort/);
  const soon = { id: 'soon', title: 'Bald', status: 'coming', credentials: [] };
  assert.throws(() => c.configFor(soon, {}, (k) => k, noop), /noch nicht verfügbar/);
  const oauth = c.configFor(c.byId('atlassian'), {}, (k) => k, noop);
  assert.deepStrictEqual(Object.keys(oauth).sort(), ['auth', 'catalogId', 'description', 'url']);
});

test('tool prefix collisions match the agent (extensions/mcp.py)', () => {
  assert.strictEqual(c.prefix('my-notes'), 'mcp_my_notes');
  assert.deepStrictEqual(Object.keys(c.collisions(['my-notes', 'my_notes', 'my', 'other'])).sort(), [
    'my',
    'my-notes',
    'my_notes'
  ]);
  assert.deepStrictEqual(c.collisions(['Atlassian', 'GitHub']), {});
});

test('registry results are summarised for the agent', () => {
  const r = c.registrySummary({
    results: [
      {
        name: 'io.github.acme/spotify',
        title: 'Spotify',
        description: 'x'.repeat(500),
        env: [
          { name: 'SPOTIFY_TOKEN', secret: true },
          { name: 'REGION', required: false }
        ]
      }
    ]
  });
  assert.deepStrictEqual(r.results[0].needs, ['SPOTIFY_TOKEN']);
  assert.strictEqual(r.results[0].publisher, 'io.github.acme');
  assert.strictEqual(r.results[0].description.length, 300);
  assert.deepStrictEqual(c.registrySummary({ error: 'offline' }), { results: [], error: 'offline' });
});
