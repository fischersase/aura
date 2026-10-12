// Einstellungen in %APPDATA%/Aura/settings.json (Linux: ~/.config/Aura).
// Der API-Key wird mit Electron safeStorage verschlüsselt (Windows DPAPI, unter Linux der Schlüsselbund).
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

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
  liveModel: 'gemini-3.8-live',
  liveVoice: '',
  language: 'Deutsch',
  panelCorner: 'bottom-right',
  glowStay: true, // Rand leuchtet, solange das Fenster offen ist (false = nur kurz aufleuchten)
  liveFps: 1,
  autostart: true,
  monthlyBudgetUsd: 10, // lokales Limit; Spend-Cap in AI Studio zusätzlich empfohlen
  setupDone: false,
  includeScreenInChat: false,
  apiKeyEnc: ''
};

// Nutzerprofil: was Aura über dich wissen darf (fließt in die Systemanweisung ein, wenn share an ist).
const DEFAULT_PROFILE = { name: '', location: '', occupation: '', about: '', preferences: '', share: true };

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

function getApiKey() {
  const s = load();
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (!s.apiKeyEnc) return '';
  try {
    const buf = Buffer.from(s.apiKeyEnc, 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
}

function setApiKey(key) {
  const k = (key || '').trim();
  const enc = !k ? '' : safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(k).toString('base64')
    : Buffer.from(k, 'utf8').toString('base64');
  save({ apiKeyEnc: enc });
}

// Einstellungen ohne Geheimnisse, für die Oberfläche.
function publicSettings() {
  const { apiKeyEnc, ...rest } = load();
  return {
    ...rest,
    hasApiKey: !!getApiKey(),
    platform: process.platform,
    version: app.getVersion(),
    session: process.platform === 'linux' ? (process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11')) : ''
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
  return lines.length ? 'Profil des Nutzers (selbst angegeben; nutze es, wo es hilft, ohne es ungefragt aufzuzählen):\n' + lines.join('\n') : '';
}

const isLocal = () => load().provider === 'ollama';

// Startklar: lokal braucht keinen Key, Gemini schon.
const ready = () => isLocal() || !!getApiKey();

module.exports = { DEFAULTS, DEFAULT_PROFILE, profilePrompt, load, save, getApiKey, setApiKey, publicSettings, isLocal, ready };
