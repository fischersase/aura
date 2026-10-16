// Credential vault v2 (src/secrets.js, src/keystore.js, src/credential-audit.js, AURA-93): typed entries,
// migration from v1, no weak storage without consent, no plaintext, audit without values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createVault } = require('../src/secrets');
const { createCredentialAudit } = require('../src/credential-audit');
const { WeakProtectionError, protectionOf, enableWeakIfAllowed } = require('../src/keystore');

const VALUE = ['ghp', 'TestOnly', 'x'.repeat(30)].join('_');

// Reversible fake of Electron's safeStorage; the backend decides strong or weak.
function fakeSafeStorage(backend = 'gnome_libsecret', available = true) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (t) => Buffer.from('enc:' + Buffer.from(t).toString('hex')),
    decryptString: (b) => {
      const s = b.toString();
      if (!s.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(s.slice(4), 'hex').toString();
    }
  };
}

function setup({ backend, available, allowWeak = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-vault-'));
  const file = path.join(dir, 'secrets.json');
  const auditFile = path.join(dir, 'credential-audit.jsonl');
  let gemini = '';
  let clock = 1_000_000;
  const vault = createVault({
    safeStorage: fakeSafeStorage(backend, available),
    file: () => file,
    gemini: { getApiKey: () => gemini, setApiKey: (k) => (gemini = k) },
    allowWeak: () => allowWeak,
    audit: createCredentialAudit(
      () => auditFile,
      () => clock
    ),
    now: () => clock,
    platform: 'linux'
  });
  return { vault, file, auditFile, tick: (ms) => (clock += ms), dir };
}

test('protection: keyring strong, basic_text weak, unavailable none', () => {
  assert.strictEqual(protectionOf(fakeSafeStorage('gnome_libsecret'), 'linux'), 'strong');
  assert.strictEqual(protectionOf(fakeSafeStorage('basic_text'), 'linux'), 'weak');
  assert.strictEqual(protectionOf(fakeSafeStorage('basic_text'), 'win32'), 'strong');
  assert.strictEqual(protectionOf(fakeSafeStorage('gnome_libsecret', false), 'linux'), 'none');
});

test('Linux without keyring: weak until the user agrees, then the fixed-key backend is switched on', () => {
  // Electron 44 reports no encryption at all for basic_text until setUsePlainTextEncryption(true).
  let plain = false;
  const ss = {
    ...fakeSafeStorage('basic_text'),
    isEncryptionAvailable: () => plain,
    setUsePlainTextEncryption: (v) => (plain = v)
  };
  assert.strictEqual(protectionOf(ss, 'linux'), 'weak');
  enableWeakIfAllowed(ss, false, 'linux');
  assert.strictEqual(plain, false, 'nothing switched on without consent');
  enableWeakIfAllowed(ss, true, 'linux');
  assert.strictEqual(plain, true);
  assert.strictEqual(
    protectionOf({ ...ss, setUsePlainTextEncryption: undefined, isEncryptionAvailable: () => false }, 'linux'),
    'none'
  );
});

test('stores typed entries and lists them without values', () => {
  const { vault, file } = setup();
  vault.set('GITHUB_TOKEN', VALUE, 'GitHub', { provider: 'GitHub', scopes: ['repo:read'] });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.version, 2);
  assert.strictEqual(disk.secrets.GITHUB_TOKEN.kind, 'api_key');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(VALUE), 'no plaintext on disk');
  assert.strictEqual(vault.get('GITHUB_TOKEN'), VALUE);
  const [, item] = vault.list();
  assert.strictEqual(item.name, 'GITHUB_TOKEN');
  assert.strictEqual(item.kind, 'api_key');
  assert.strictEqual(item.provider, 'GitHub');
  assert.deepStrictEqual(item.scopes, ['repo:read']);
  assert.ok(!JSON.stringify(vault.list()).includes(VALUE), 'list never contains the value');
  assert.ok(!('enc' in item));
  assert.throws(() => vault.set('X', VALUE, '', { kind: 'cookie' }), /Unbekannte Art/);
});

test('migrates a v1 file to v2 and keeps every value readable', () => {
  const { vault, file, auditFile } = setup();
  const enc = fakeSafeStorage().encryptString(VALUE).toString('base64');
  fs.writeFileSync(file, JSON.stringify({ OLD_KEY: { enc, created: 5, updated: 6, note: 'alt' } }));
  assert.strictEqual(vault.get('OLD_KEY'), VALUE);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.version, 2);
  assert.deepStrictEqual(disk.secrets.OLD_KEY, { kind: 'api_key', enc, created: 5, updated: 6, note: 'alt' });
  assert.match(fs.readFileSync(auditFile, 'utf8'), /"action":"migrate"/);
});

test('weak backend: refuses without consent, stores with it; none always refuses', () => {
  const weak = setup({ backend: 'basic_text' });
  assert.throws(() => weak.vault.set('K', VALUE), WeakProtectionError);
  assert.ok(!fs.existsSync(weak.file), 'nothing written');
  const allowed = setup({ backend: 'basic_text', allowWeak: true });
  allowed.vault.set('K', VALUE);
  assert.strictEqual(allowed.vault.get('K'), VALUE);
  const none = setup({ available: false, allowWeak: true });
  assert.throws(() => none.vault.set('K', VALUE), /nicht verfügbar/);
});

test('audit records set, use and delete without the value; lastUsed at most once a minute', () => {
  const { vault, auditFile, tick } = setup();
  vault.set('API', VALUE);
  const cfg = { name: 'srv', command: 'x', env: { TOKEN: '${secret:API}' } };
  assert.deepStrictEqual(vault.resolveServerConfig(cfg).env, { TOKEN: VALUE });
  vault.resolveServerConfig(cfg); // within the minute: no second "use"
  tick(61_000);
  vault.resolveServerConfig(cfg);
  vault.remove('API');
  const log = fs.readFileSync(auditFile, 'utf8');
  assert.ok(!log.includes(VALUE), 'audit never contains the value');
  const actions = log
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).action);
  assert.deepStrictEqual(actions, ['set', 'use', 'use', 'delete']);
  assert.match(log, /"by":"MCP-Server srv"/);
});

test('lastUsed is shown in the list', () => {
  const { vault } = setup();
  vault.set('API', VALUE);
  vault.resolve('${secret:API}');
  assert.strictEqual(typeof vault.list().find((x) => x.name === 'API').lastUsed, 'number');
});

test('missing secrets are reported by name', () => {
  const { vault } = setup();
  assert.throws(() => vault.resolveServerConfig({ env: { A: '${secret:NOPE}' } }), /NOPE/);
});

// store.js: the Gemini key follows the same rule (no plaintext fallback any more).
function loadStore(safeStorage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-store-'));
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { app: { getPath: () => dir, getVersion: () => '0.0.0' }, safeStorage };
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/store')];
    return { store: require('../src/store'), dir };
  } finally {
    Module._load = orig;
  }
}

test('store: Gemini key is never written as plaintext; weak needs consent', () => {
  const key = ['AIza', 'Sy', 'TestOnly'].join('') + 'k'.repeat(25);
  const { store, dir } = loadStore(fakeSafeStorage('basic_text'));
  assert.throws(() => store.setApiKey(key), WeakProtectionError);
  assert.ok(
    !fs.existsSync(path.join(dir, 'settings.json')) ||
      !fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('apiKeyEnc": "QUl6')
  );
  store.save({ allowWeakSecretStorage: true });
  store.setApiKey(key);
  assert.strictEqual(store.getApiKey(), key);
  const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes(key));
  assert.ok(!raw.includes(Buffer.from(key).toString('base64')), 'not base64 plaintext either');
});

test('store: a legacy plaintext key keeps working and is re-encrypted once a keyring exists', () => {
  const key = ['AIza', 'Sy', 'TestOnly'].join('') + 'p'.repeat(25);
  const { store, dir } = loadStore(fakeSafeStorage('gnome_libsecret'));
  // As written by Aura <= 0.11.1 without a keyring: base64 of the plain key.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyEnc: Buffer.from(key).toString('base64') }));
  assert.strictEqual(store.getApiKey(), key);
  const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes(Buffer.from(key).toString('base64')), 'migrated to encrypted');
  assert.strictEqual(store.getApiKey(), key);
});

test('website logins are bound to their origin and never show the password (AURA-124)', () => {
  const { vault: v } = setup();
  v.set('BAHN', JSON.stringify({ username: 'anna@example.org', password: 'Geheim-123!' }), 'Bahn', {
    kind: 'login',
    origin: 'https://www.bahn.de'
  });
  assert.deepStrictEqual(v.loginsFor('https://www.bahn.de'), [{ name: 'BAHN', username: 'anna@example.org' }]);
  assert.deepStrictEqual(v.loginsFor('https://evil.example'), []);
  assert.deepStrictEqual(v.loginFor('BAHN', 'https://www.bahn.de'), {
    username: 'anna@example.org',
    password: 'Geheim-123!'
  });
  assert.throws(() => v.loginFor('BAHN', 'https://evil.example'), /nicht zu https:\/\/evil\.example/);
  const listed = v.list().find((e) => e.name === 'BAHN');
  assert.strictEqual(listed.hint, 'anna@example.org');
  assert.strictEqual(listed.origin, 'https://www.bahn.de');
  assert.ok(!JSON.stringify(v.list()).includes('Geheim'), 'no part of the password in the listing');
});

test('store: backs up Local State os_crypt.encrypted_key and restores it after an upgrade resets Local State', () => {
  const key = ['AIza', 'Sy', 'WinUpgrade'].join('') + 'w'.repeat(24);
  const { store, dir } = loadStore(fakeSafeStorage('gnome_libsecret'));
  const localStatePath = path.join(dir, 'Local State');
  fs.writeFileSync(localStatePath, JSON.stringify({ os_crypt: { encrypted_key: 'DPAPI_KEY_V1' } }));

  store.setApiKey(key);
  const pub = store.publicSettings();
  assert.strictEqual(pub.hasApiKey, true);
  assert.strictEqual(pub.apiKeyHint, '••••wwww');
  assert.strictEqual(pub.osCryptKeyBackup, undefined);
  assert.strictEqual(pub.apiKeyEnc, undefined);

  // Simulate NSIS installer upgrade wiping/replacing Local State with a new key
  fs.writeFileSync(localStatePath, JSON.stringify({ os_crypt: { encrypted_key: 'NEW_DIFFERENT_KEY' } }));
  assert.strictEqual(store.restoreOsCryptKey(), true);
  const restored = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  assert.strictEqual(restored.os_crypt.encrypted_key, 'DPAPI_KEY_V1');
  assert.strictEqual(store.getApiKey(), key);
});
