// @ts-check
// Einstellungen in %APPDATA%/Aura/settings.json (Linux: ~/.config/Aura).
// Der API-Key wird mit Electron safeStorage verschlüsselt (Windows DPAPI, unter Linux der Schlüsselbund).
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { protectionOf, assertStorable, enableWeakIfAllowed } = require('./keystore');

const DEFAULTS = {
  // Kürzel, die unter Windows standardmäßig frei sind.
  hotkeyGemini: 'Control+Alt+Space', // Strg+Alt+G belegt Google Drive für Desktop
  hotkeyRambler: 'Control+Alt+D',
  hotkeyLive: 'Control+Alt+L',
  hotkeyStop: 'Control+Alt+Escape', // Notbremse, nur aktiv solange der Agent arbeitet
  agentEnabled: true, // Aura darf Werkzeuge nutzen (Befehle, Dateien, Programme öffnen)
  agentVersion: 'v2', // 'v2' = Agent auf Google ADK (agent/), 'v1' = bisheriger Agent; Umgebungsvariable AURA_AGENT_VERSION gewinnt
  provider: 'gemini', // 'gemini' (API-Key) oder 'ollama' (lokal)
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'gemma4:e4b', // Chat, Rambler-Nachbearbeitung und Live bei provider 'ollama'
  ollamaContext: 16384, // Kontextlänge für Agent-Aufträge (Tokens); mit 24 GB Grafikspeicher geht auch 32768
  whisperModel: 'onnx-community/whisper-small', // lokale Spracherkennung
  chatModel: 'gemini-3.8-flash',
  ramblerModel: 'gemini-3.8-flash',
  // Spracheingabe im Chat mit Gemini: günstigstes aktuelles Modell mit Audioeingabe (0,30 $/Mio. Audio-Tokens ≈ 0,1 ct/Minute).
  dictationModel: 'gemini-3.5-flash-lite',
  liveModel: 'gemini-3.8-live',
  liveVoice: '',
  language: 'Deutsch',
  panelCorner: 'bottom-right',
  // Panel size chosen by the user (resize grip / enlarge button); null = default.
  panelSize: null,
  glowStay: true, // Rand leuchtet, solange das Fenster offen ist (false = nur kurz aufleuchten)
  liveFps: 1,
  autostart: true,
  monthlyBudgetUsd: 10, // lokales Limit; Spend-Cap in AI Studio zusätzlich empfohlen
  setupDone: false,
  includeScreenInChat: false,
  apiKeyEnc: ''
};

// Nutzerprofil: was Aura über dich wissen darf (fließt in die Systemanweisung ein, wenn share an ist).
// locationMode (AURA-116): 'profile' (only the place above), 'ip' (approximate, opt-in), 'device' (OS, opt-in).
const DEFAULT_PROFILE = {
  name: '',
  location: '',
  occupation: '',
  about: '',
  preferences: '',
  share: true,
  locationMode: 'profile'
};

/** @type {Record<string, any> | null} */
let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

/** @returns {Record<string, any>} */
function load() {
  if (cache) return cache;
  let loaded;
  try {
    loaded = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    loaded = { ...DEFAULTS };
  }
  cache = loaded;
  return loaded;
}

/** @param {Record<string, any>} patch */
function save(patch) {
  const next = { ...load(), ...patch };
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  cache = next;
  return next;
}

// Before AURA-93 a key was stored as base64 plaintext when no keystore was available. Such a value is still read
// (never delete a working key silently) and re-encrypted as soon as strong protection is available.
const LEGACY_PLAIN = /^AIza[0-9A-Za-z_-]{20,}$/;

function getApiKey() {
  const s = load();
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (!s.apiKeyEnc) return '';
  const buf = Buffer.from(s.apiKeyEnc, 'base64');
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(buf);
    } catch {}
  }
  const plain = buf.toString('utf8');
  if (!LEGACY_PLAIN.test(plain)) return '';
  if (protectionOf(safeStorage) === 'strong') {
    save({ apiKeyEnc: safeStorage.encryptString(plain).toString('base64'), apiKeyPlaintext: false });
  } else if (!s.apiKeyPlaintext) {
    save({ apiKeyPlaintext: true }); // shown as a warning in the settings and the Zentrale
  }
  return plain;
}

/**
 * Stores the Gemini key encrypted. Throws WeakProtectionError without a keyring, unless the user allowed weak
 * storage (AURA-93); there is no plaintext fallback any more.
 * @param {string | null | undefined} key
 */
function setApiKey(key) {
  const k = (key || '').trim();
  if (!k) {
    save({ apiKeyEnc: '', apiKeyPlaintext: false });
    return;
  }
  const allowWeak = !!load().allowWeakSecretStorage;
  assertStorable(protectionOf(safeStorage), allowWeak);
  enableWeakIfAllowed(safeStorage, allowWeak);
  save({ apiKeyEnc: safeStorage.encryptString(k).toString('base64'), apiKeyPlaintext: false });
}

// Einstellungen ohne Geheimnisse, für die Oberfläche.
function publicSettings() {
  const { apiKeyEnc, ...rest } = load();
  return {
    ...rest,
    hasApiKey: !!getApiKey(),
    secretProtection: protectionOf(safeStorage),
    platform: process.platform,
    version: app.getVersion(),
    session:
      process.platform === 'linux'
        ? process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11')
        : ''
  };
}

function profilePrompt() {
  const p = { ...DEFAULT_PROFILE, ...(load().profile || {}) };
  if (!p.share) return '';
  const lines = [
    p.name && `Name: ${p.name}`,
    p.location && `Ort/Zeitzone: ${p.location}`,
    p.occupation && `Beruf/Rolle: ${p.occupation}`,
    p.about && `Über den Nutzer: ${p.about}`,
    p.preferences && `Wünsche an Antworten: ${p.preferences}`
  ].filter(Boolean);
  return lines.length
    ? 'Profil des Nutzers (selbst angegeben; nutze es, wo es hilft, ohne es ungefragt aufzuzählen):\n' +
        lines.join('\n')
    : '';
}

const isLocal = () => load().provider === 'ollama';

// Startklar: lokal braucht keinen Key, Gemini schon.
const ready = () => isLocal() || !!getApiKey();

module.exports = {
  DEFAULTS,
  DEFAULT_PROFILE,
  profilePrompt,
  load,
  save,
  getApiKey,
  setApiKey,
  publicSettings,
  isLocal,
  ready
};
