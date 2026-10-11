const $ = (id) => document.getElementById(id);
const FIELDS = ['hotkeyGemini', 'hotkeyRambler', 'hotkeyLive', 'chatModel', 'liveModel', 'ramblerModel', 'liveVoice', 'language', 'liveFps', 'panelCorner'];
let keyTouched = false;

function status(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok === undefined ? '' : ok ? 'ok' : 'bad');
}

async function load() {
  const s = await window.api.getSettings();
  FIELDS.forEach((f) => { $(f).value = s[f] != null ? String(s[f]) : ''; });
  $('autostart').checked = !!s.autostart;
  $('glowStay').checked = !!s.glowStay;
  $('apiKey').placeholder = s.hasApiKey ? '•••••••• (gespeichert)' : 'AIza…';
  if (!s.hasApiKey) status($('keyStatus'), 'Bitte zuerst einen Gemini API-Key eintragen.', false);
}

// Tastenkombination aufnehmen → Electron-Accelerator ("Control+Alt+G")
const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape', Enter: 'Return' };
document.querySelectorAll('input.hotkey').forEach((el) => {
  el.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') { el.value = ''; return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    let key = KEYMAP[e.key] || (e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toUpperCase() : e.key);
    if (!mods.length && !/^F\d+$/.test(key)) {
      status($('hotkeyStatus'), 'Bitte mit Strg, Alt, Umschalt oder Win kombinieren.', false);
      return;
    }
    el.value = [...mods, key].join('+');
    status($('hotkeyStatus'), '');
  });
});

$('apiKey').addEventListener('input', () => { keyTouched = true; });

$('testKey').onclick = async () => {
  status($('keyStatus'), 'Prüfe …');
  const r = await window.api.testKey($('apiKey').value);
  status($('keyStatus'), r.ok ? 'Key funktioniert.' : 'Fehler: ' + r.message, r.ok);
};

$('save').onclick = async () => {
  const patch = {};
  FIELDS.forEach((f) => { patch[f] = $(f).value.trim(); });
  patch.liveFps = Number(patch.liveFps) || 1;
  patch.autostart = $('autostart').checked;
  patch.glowStay = $('glowStay').checked;
  if (keyTouched) patch.apiKey = $('apiKey').value;
  const hk = [patch.hotkeyGemini, patch.hotkeyRambler, patch.hotkeyLive].filter(Boolean);
  if (new Set(hk).size !== hk.length) {
    status($('hotkeyStatus'), 'Zwei Funktionen haben dasselbe Kürzel.', false);
    return;
  }
  const r = await window.api.saveSettings(patch);
  keyTouched = false;
  $('apiKey').value = '';
  if (r.failedHotkeys.length) {
    status($('hotkeyStatus'), 'Nicht registrierbar (schon belegt?): ' + r.failedHotkeys.join(', '), false);
  } else {
    status($('hotkeyStatus'), '');
  }
  status($('saveStatus'), r.settings.hasApiKey ? 'Gespeichert.' : 'Gespeichert, aber noch kein API-Key.', r.settings.hasApiKey);
  load();
};

$('close').onclick = () => window.close();
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) { e.preventDefault(); window.api.openExternal(a.dataset.url); }
});

load();
