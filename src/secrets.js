// Schlüsselverwaltung: API-Keys und Tokens für MCP-Server, verschlüsselt mit Electron safeStorage
// (Windows DPAPI, macOS Schlüsselbund, Linux Secret Service/kwallet) in userData/secrets.json.
// Werte verlassen den Hauptprozess nie Richtung Oberfläche; in mcp.json steht nur ${secret:NAME}.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const store = require('./store');

const GEMINI = 'GEMINI_API_KEY'; // liegt in den Einstellungen, wird hier nur mit angezeigt
const REF = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;
const file = () => path.join(app.getPath('userData'), 'secrets.json');
const validName = (n) => /^[A-Za-z0-9_.-]{1,64}$/.test(String(n || ''));

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function write(all) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file(), 0o600);
  } catch {}
}

// Unter Linux ohne Schlüsselbund nutzt Electron ein festes Passwort ("basic_text"); das ist kaum besser als Klartext.
function protection() {
  if (!safeStorage.isEncryptionAvailable()) return 'none';
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    const b = safeStorage.getSelectedStorageBackend();
    if (b === 'basic_text' || b === 'unknown') return 'weak';
  }
  return 'strong';
}

function encrypt(value) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      'Verschlüsselung ist auf diesem System nicht verfügbar (kein Schlüsselbund). Schlüssel werden deshalb nicht gespeichert.'
    );
  return safeStorage.encryptString(value).toString('base64');
}

function get(name) {
  if (name === GEMINI) return store.getApiKey() || null;
  const e = read()[name];
  if (!e) return null;
  try {
    return safeStorage.decryptString(Buffer.from(e.enc, 'base64'));
  } catch {
    return null;
  }
}

function set(name, value, note) {
  if (!validName(name))
    throw new Error('Name nur mit Buchstaben, Ziffern, Punkt, Minus oder Unterstrich (max. 64 Zeichen).');
  const v = String(value || '').trim();
  if (!v) throw new Error('Der Wert ist leer.');
  if (name === GEMINI) {
    store.setApiKey(v);
    return;
  }
  const all = read();
  const now = Date.now();
  all[name] = {
    enc: encrypt(v),
    created: (all[name] && all[name].created) || now,
    updated: now,
    note: note != null ? String(note).slice(0, 200) : (all[name] && all[name].note) || ''
  };
  write(all);
}

function setNote(name, note) {
  const all = read();
  if (!all[name]) return;
  all[name].note = String(note || '').slice(0, 200);
  write(all);
}

function remove(name) {
  if (name === GEMINI) {
    store.setApiKey('');
    return;
  }
  const all = read();
  delete all[name];
  write(all);
}

// Liste ohne Werte, nur mit den letzten vier Zeichen zum Wiedererkennen.
function list(usedBy = {}) {
  const tail = (v) => (v && v.length >= 12 ? '…' + v.slice(-4) : '');
  const out = Object.entries(read()).map(([name, e]) => {
    let hint = '',
      broken = false;
    try {
      hint = tail(safeStorage.decryptString(Buffer.from(e.enc, 'base64')));
    } catch {
      broken = true;
    }
    return {
      name,
      note: e.note || '',
      created: e.created,
      updated: e.updated,
      hint,
      broken,
      usedBy: usedBy[name] || []
    };
  });
  const g = store.getApiKey();
  out.unshift({
    name: GEMINI,
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
function resolve(value, missing = []) {
  if (typeof value === 'string')
    return value.replace(REF, (_m, n) => {
      const v = get(n);
      if (v == null) {
        missing.push(n);
        return '';
      }
      return v;
    });
  if (Array.isArray(value)) return value.map((v) => resolve(v, missing));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, missing)]));
  return value;
}

function resolveServerConfig(cfg) {
  const missing = [];
  const out = { ...cfg };
  for (const k of ['command', 'args', 'env', 'url', 'headers', 'cwd'])
    if (cfg[k] != null) out[k] = resolve(cfg[k], missing);
  if (missing.length)
    throw new Error(
      `Schlüssel fehlt: ${[...new Set(missing)].join(', ')}. Lege ihn in der Aura Zentrale unter „Schlüssel“ an.`
    );
  return out;
}

const refsIn = (value) => [...JSON.stringify(value || {}).matchAll(REF)].map((m) => m[1]);

// Sieht der Wert nach einem Geheimnis aus? (für den Hinweis „steht im Klartext in mcp.json“)
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|(^|_)PAT$)/i;
const looksSecret = (key, value) =>
  typeof value === 'string' && value.length >= 8 && !value.includes('${secret:') && SECRETISH.test(key);

module.exports = {
  GEMINI,
  validName,
  protection,
  get,
  set,
  setNote,
  remove,
  list,
  resolve,
  resolveServerConfig,
  refsIn,
  looksSecret
};
