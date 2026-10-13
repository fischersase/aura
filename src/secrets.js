// @ts-check
// Schlüsselverwaltung (credential vault, AURA-93): API-Keys, Tokens und Passwörter für MCP-Server und Dienste,
// verschlüsselt mit Electron safeStorage (Windows DPAPI, macOS Schlüsselbund, Linux Secret Service/KWallet) in
// userData/secrets.json. Werte verlassen den Hauptprozess nie Richtung Oberfläche; in mcp.json steht nur
// ${secret:NAME}. Ohne Schlüsselbund (schwacher Schutz) speichert Aura nur nach ausdrücklicher Zustimmung.
const fs = require('fs');
const path = require('path');
const { protectionOf, assertStorable, enableWeakIfAllowed } = require('./keystore');

const GEMINI = 'GEMINI_API_KEY'; // liegt in den Einstellungen, wird hier nur mit angezeigt
const REF = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;
const KINDS = ['api_key', 'oauth', 'password', 'basic'];
const LAST_USED_EVERY_MS = 60 * 1000; // lastUsed at most once a minute per secret (resolve runs on every MCP start)
const validName = (/** @type {unknown} */ n) => /^[A-Za-z0-9_.-]{1,64}$/.test(String(n || ''));

/** @typedef {'api_key' | 'oauth' | 'password' | 'basic'} SecretKind */
/**
 * One stored credential. For oauth, enc holds the refresh token; access tokens never touch the disk.
 * @typedef {object} SecretEntry
 * @property {SecretKind} kind
 * @property {string} enc
 * @property {number} created
 * @property {number} updated
 * @property {string} note
 * @property {string} [provider]
 * @property {string[]} [scopes]
 * @property {number} [expiresAt]
 * @property {number} [lastUsed]
 */
/** @typedef {{ version: 2, secrets: Record<string, SecretEntry> }} VaultFile */
/**
 * What the UI gets: never the value, only its last four characters.
 * @typedef {object} SecretInfo
 * @property {string} name
 * @property {string} note
 * @property {string} hint
 * @property {string[]} usedBy
 * @property {SecretKind} [kind]
 * @property {string} [provider]
 * @property {string[]} [scopes]
 * @property {number} [expiresAt]
 * @property {number} [lastUsed]
 * @property {number} [created]
 * @property {number} [updated]
 * @property {boolean} [broken]
 * @property {boolean} [builtin]
 * @property {boolean} [set]
 * @property {boolean} [fromEnv]
 */
/**
 * @typedef {object} VaultDeps
 * @property {import('./keystore').SafeStorageLike} safeStorage
 * @property {() => string} file path of secrets.json
 * @property {{ getApiKey: () => string, setApiKey: (key: string) => void }} gemini the key in the settings
 * @property {() => boolean} allowWeak the user agreed to weak storage (Linux without keyring)
 * @property {{ write: (e: import('./credential-audit').CredentialEvent) => void }} audit
 * @property {() => number} [now]
 * @property {string} [platform]
 */

/** @param {VaultDeps} deps */
function createVault(deps) {
  const now = deps.now || Date.now;
  const { safeStorage, audit } = deps;
  /** @type {Map<string, number>} */
  const usedAt = new Map();

  const protection = () => protectionOf(safeStorage, deps.platform);

  /** @returns {Record<string, SecretEntry>} */
  function read() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(deps.file(), 'utf8'));
    } catch {
      return {};
    }
    if (!raw || typeof raw !== 'object') return {};
    if (raw.version === 2 && raw.secrets && typeof raw.secrets === 'object') return raw.secrets;
    // Version 1 (before AURA-93): a flat map { name: { enc, created, updated, note } }. Same values, now typed.
    /** @type {Record<string, SecretEntry>} */
    const migrated = {};
    for (const [name, e] of Object.entries(raw)) {
      if (!e || typeof e !== 'object' || typeof e.enc !== 'string') continue;
      migrated[name] = {
        kind: 'api_key',
        enc: e.enc,
        created: e.created || now(),
        updated: e.updated || now(),
        note: e.note || ''
      };
    }
    write(migrated);
    audit.write({ action: 'migrate', name: '*', kind: 'v1→v2' });
    return migrated;
  }

  /** @param {Record<string, SecretEntry>} secrets */
  function write(secrets) {
    const file = deps.file();
    /** @type {VaultFile} */
    const data = { version: 2, secrets };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  }

  /** @param {string} value */
  function encrypt(value) {
    assertStorable(protection(), deps.allowWeak());
    enableWeakIfAllowed(safeStorage, deps.allowWeak(), deps.platform);
    return safeStorage.encryptString(value).toString('base64');
  }

  /** @param {SecretEntry} e */
  function decrypt(e) {
    return safeStorage.decryptString(Buffer.from(e.enc, 'base64'));
  }

  /**
   * Records a use (connector start, request header) at most once a minute per secret.
   * @param {string} name
   * @param {string} [by]
   */
  function markUsed(name, by) {
    const t = now();
    if (t - (usedAt.get(name) || 0) < LAST_USED_EVERY_MS) return;
    usedAt.set(name, t);
    const all = read();
    if (!all[name]) return;
    all[name].lastUsed = t;
    write(all);
    audit.write({ action: 'use', name, kind: all[name].kind, by });
  }

  /**
   * @param {string} name
   * @returns {string | null}
   */
  function get(name) {
    if (name === GEMINI) return deps.gemini.getApiKey() || null;
    const e = read()[name];
    if (!e) return null;
    try {
      return decrypt(e);
    } catch {
      return null;
    }
  }

  /**
   * @param {string} name
   * @param {unknown} value
   * @param {unknown} [note]
   * @param {{ kind?: SecretKind, provider?: string, scopes?: string[], expiresAt?: number }} [meta]
   */
  function set(name, value, note, meta = {}) {
    if (!validName(name))
      throw new Error('Name nur mit Buchstaben, Ziffern, Punkt, Minus oder Unterstrich (max. 64 Zeichen).');
    const v = String(value || '').trim();
    if (!v) throw new Error('Der Wert ist leer.');
    const kind = meta.kind || 'api_key';
    if (!KINDS.includes(kind)) throw new Error(`Unbekannte Art „${kind}“.`);
    if (name === GEMINI) {
      deps.gemini.setApiKey(v); // same storage rule in store.js
      audit.write({ action: 'set', name, kind: 'api_key' });
      return;
    }
    const enc = encrypt(v);
    const all = read();
    const t = now();
    const prev = all[name];
    all[name] = {
      kind,
      enc,
      created: (prev && prev.created) || t,
      updated: t,
      note: note != null ? String(note).slice(0, 200) : (prev && prev.note) || '',
      ...(meta.provider ? { provider: String(meta.provider).slice(0, 200) } : {}),
      ...(meta.scopes ? { scopes: meta.scopes.map(String).slice(0, 50) } : {}),
      ...(meta.expiresAt ? { expiresAt: Number(meta.expiresAt) } : {}),
      ...(prev && prev.lastUsed ? { lastUsed: prev.lastUsed } : {})
    };
    write(all);
    audit.write({ action: 'set', name, kind });
  }

  /**
   * @param {string} name
   * @param {unknown} note
   */
  function setNote(name, note) {
    const all = read();
    if (!all[name]) return;
    all[name].note = String(note || '').slice(0, 200);
    write(all);
  }

  /** @param {string} name */
  function remove(name) {
    if (name === GEMINI) {
      deps.gemini.setApiKey('');
      audit.write({ action: 'delete', name, kind: 'api_key' });
      return;
    }
    const all = read();
    const kind = all[name] && all[name].kind;
    if (!kind) return;
    delete all[name];
    write(all);
    usedAt.delete(name);
    audit.write({ action: 'delete', name, kind });
  }

  // Liste ohne Werte, nur mit den letzten vier Zeichen zum Wiedererkennen.
  /**
   * @param {Record<string, string[]>} [usedBy] secret name → servers that reference it
   * @returns {SecretInfo[]}
   */
  function list(usedBy = {}) {
    const tail = (/** @type {string | null | undefined} */ v) => (v && v.length >= 12 ? '…' + v.slice(-4) : '');
    /** @type {SecretInfo[]} */
    const out = Object.entries(read()).map(([name, e]) => {
      let hint = '',
        broken = false;
      try {
        hint = tail(decrypt(e));
      } catch {
        broken = true;
      }
      return {
        name,
        kind: e.kind,
        note: e.note || '',
        provider: e.provider,
        scopes: e.scopes,
        expiresAt: e.expiresAt,
        lastUsed: e.lastUsed,
        created: e.created,
        updated: e.updated,
        hint,
        broken,
        usedBy: usedBy[name] || []
      };
    });
    const g = deps.gemini.getApiKey();
    out.unshift({
      name: GEMINI,
      kind: 'api_key',
      provider: 'Google Gemini',
      note: 'Gemini API (Einstellungen)',
      builtin: true,
      set: !!g,
      hint: tail(g),
      fromEnv: !!process.env.GEMINI_API_KEY,
      usedBy: ['Aura (Gemini)']
    });
    return out.sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0) || a.name.localeCompare(b.name));
  }

  // Ersetzt ${secret:NAME} in Strings, Arrays und Objekten (env, headers, args, url).
  /**
   * @param {unknown} value
   * @param {string[]} [missing] collects names of secrets that do not exist
   * @param {string} [by] who uses it (for lastUsed and the audit)
   * @returns {unknown}
   */
  function resolve(value, missing = [], by) {
    if (typeof value === 'string')
      return value.replace(REF, (_m, n) => {
        const v = get(n);
        if (v == null) {
          missing.push(n);
          return '';
        }
        markUsed(n, by);
        return v;
      });
    if (Array.isArray(value)) return value.map((v) => resolve(v, missing, by));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, missing, by)]));
    return value;
  }

  /**
   * @param {Record<string, unknown>} cfg
   * @returns {Record<string, unknown>}
   */
  function resolveServerConfig(cfg) {
    /** @type {string[]} */
    const missing = [];
    const out = { ...cfg };
    const by = typeof cfg.name === 'string' ? `MCP-Server ${cfg.name}` : 'MCP-Server';
    for (const k of ['command', 'args', 'env', 'url', 'headers', 'cwd'])
      if (cfg[k] != null) out[k] = resolve(cfg[k], missing, by);
    if (missing.length)
      throw new Error(
        `Schlüssel fehlt: ${[...new Set(missing)].join(', ')}. Lege ihn in der Aura Zentrale unter „Schlüssel & Konten“ an.`
      );
    return out;
  }

  return { protection, get, set, setNote, remove, list, resolve, resolveServerConfig, markUsed };
}

const refsIn = (/** @type {unknown} */ value) => [...JSON.stringify(value || {}).matchAll(REF)].map((m) => m[1]);

// Sieht der Wert nach einem Geheimnis aus? (für den Hinweis „steht im Klartext in mcp.json“)
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|(^|_)PAT$)/i;
const looksSecret = (/** @type {string} */ key, /** @type {unknown} */ value) =>
  typeof value === 'string' && value.length >= 8 && !value.includes('${secret:') && SECRETISH.test(key);

// The app's vault, built on first use (Electron's app paths are only valid once the app is running).
/** @type {ReturnType<typeof createVault> | null} */
let vault = null;
function appVault() {
  if (!vault) {
    const { app, safeStorage } = require('electron');
    const store = require('./store');
    const { createCredentialAudit } = require('./credential-audit');
    vault = createVault({
      safeStorage,
      file: () => path.join(app.getPath('userData'), 'secrets.json'),
      gemini: store,
      allowWeak: () => !!store.load().allowWeakSecretStorage,
      audit: createCredentialAudit(() => path.join(app.getPath('userData'), 'credential-audit.jsonl'))
    });
  }
  return vault;
}

module.exports = {
  GEMINI,
  KINDS,
  validName,
  refsIn,
  looksSecret,
  createVault,
  protection: () => appVault().protection(),
  /** @param {string} name */
  get: (name) => appVault().get(name),
  /** @type {ReturnType<typeof createVault>['set']} */
  set: (name, value, note, meta) => appVault().set(name, value, note, meta),
  /** @param {string} name @param {unknown} note */
  setNote: (name, note) => appVault().setNote(name, note),
  /** @param {string} name */
  remove: (name) => appVault().remove(name),
  /** @param {Record<string, string[]>} [usedBy] */
  list: (usedBy) => appVault().list(usedBy),
  /** @param {unknown} value @param {string[]} [missing] */
  resolve: (value, missing) => appVault().resolve(value, missing),
  /** @param {Record<string, unknown>} cfg */
  resolveServerConfig: (cfg) => appVault().resolveServerConfig(cfg),
  /** @param {string} name @param {string} [by] */
  markUsed: (name, by) => appVault().markUsed(name, by)
};
