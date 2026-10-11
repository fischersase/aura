// Einstellungen in %APPDATA%/Gemini Overlay/settings.json.
// Der API-Key wird mit Windows DPAPI (Electron safeStorage) verschlüsselt abgelegt.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  // Kürzel, die unter Windows standardmäßig frei sind.
  hotkeyGemini: 'Control+Alt+Space', // Strg+Alt+G belegt Google Drive für Desktop
  hotkeyRambler: 'Control+Alt+D',
  hotkeyLive: 'Control+Alt+L',
  chatModel: 'gemini-3.8-flash',
  ramblerModel: 'gemini-3.8-flash',
  liveModel: 'gemini-3.8-live',
  liveVoice: '',
  language: 'Deutsch',
  panelCorner: 'bottom-right',
  glowStay: true, // Rand leuchtet, solange das Fenster offen ist (false = nur kurz aufleuchten)
  liveFps: 1,
  autostart: true,
  includeScreenInChat: false,
  apiKeyEnc: ''
};

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
  return { ...rest, hasApiKey: !!getApiKey() };
}

module.exports = { DEFAULTS, load, save, getApiKey, setApiKey, publicSettings };
