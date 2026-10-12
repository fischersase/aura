const $ = (id) => document.getElementById(id);
const FIELDS = ['provider', 'monthlyBudgetUsd', 'hotkeyGemini', 'hotkeyRambler', 'hotkeyLive', 'hotkeyStop', 'chatModel', 'liveModel', 'ramblerModel', 'dictationModel', 'liveVoice', 'language', 'liveFps', 'panelCorner'];
let keyTouched = false;
let olPanel = null;

function status(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok === undefined ? '' : ok ? 'ok' : 'bad');
}

async function load() {
  const s = await window.api.getSettings();
  FIELDS.forEach((f) => { $(f).value = s[f] != null ? String(s[f]) : ''; });
  $('versionLine').textContent = `Version ${s.version}` + (s.session ? ` · Linux (${s.session})` : '');
  $('autostart').checked = !!s.autostart;
  $('glowStay').checked = !!s.glowStay;
  $('agentEnabled').checked = !!s.agentEnabled;
  $('apiKey').placeholder = s.hasApiKey ? '•••••••• (gespeichert)' : 'AIza…';
  if (!s.hasApiKey) status($('keyStatus'), 'Bitte zuerst einen Gemini API-Key eintragen.', false);
  if (!olPanel) olPanel = OllamaPanel($('ollamaBox'), s);
  $('linuxKeys').classList.toggle('hidden', s.platform !== 'linux');
  applyProvider();
}

function applyProvider() {
  const local = $('provider').value === 'ollama';
  document.body.classList.toggle('local', local);
  if (local && olPanel) olPanel.check();
}
$('provider').addEventListener('change', applyProvider);

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
  patch.monthlyBudgetUsd = Math.max(0, Number(String(patch.monthlyBudgetUsd).replace(',', '.')) || 0);
  patch.autostart = $('autostart').checked;
  patch.glowStay = $('glowStay').checked;
  patch.agentEnabled = $('agentEnabled').checked;
  if (keyTouched) patch.apiKey = $('apiKey').value;
  if (olPanel) Object.assign(patch, olPanel.values());
  const hk = [patch.hotkeyGemini, patch.hotkeyRambler, patch.hotkeyLive, patch.hotkeyStop].filter(Boolean);
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
  const ready = r.settings.provider === 'ollama' || r.settings.hasApiKey;
  status($('saveStatus'), ready ? 'Gespeichert.' : 'Gespeichert, aber noch kein API-Key.', ready);
};

function showUsage(u) {
  const f = (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  status($('usageLine'), `Diesen Monat geschätzt: ${f(u.costUsd)} $${u.budgetUsd ? ' von ' + f(u.budgetUsd) + ' $' : ''} (${u.requests} Anfragen)`, !u.overBudget);
}
window.api.getUsage().then(showUsage);
window.api.onUsage(showUsage);

$('close').onclick = () => window.close();
$('openLog').onclick = () => window.api.openAgentLog();
$('openZentrale').onclick = () => window.api.openZentrale();
$('openAgents').onclick = () => window.api.openAgentFile('agents');
$('openSkills').onclick = () => window.api.openAgentFile('skills');
$('openMcp').onclick = () => window.api.openAgentFile('mcp');

async function showExtensions(force) {
  const el = $('extStatus');
  el.textContent = 'Lade …';
  const x = await window.api.agentExtensions(force === true);
  el.innerHTML = '';
  const line = (text, cls) => { const d = document.createElement('div'); d.textContent = text; if (cls) d.className = cls; el.appendChild(d); };
  line('Eingebaute Werkzeuge: ' + x.builtin.join(', '));
  line(x.hasAgentsMd ? 'AGENTS.md: wird verwendet' : 'AGENTS.md: leer');
  line(x.skills.length ? `Skills: ${x.skills.map((s) => s.name).join(', ')}` : 'Skills: keine');
  if (!x.mcp.length) line('MCP-Server: keine');
  x.mcp.forEach((m) => line(m.error ? `MCP ${m.name}: Fehler – ${m.error}` : `MCP ${m.name}: ${m.toolNames.join(', ') || 'keine Werkzeuge'}`, m.error ? 'bad' : 'ok'));
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = `Ordner: ${x.auraDir}`;
  el.appendChild(hint);
}
$('reloadExt').onclick = () => showExtensions(true);
showExtensions();
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) { e.preventDefault(); window.api.openExternal(a.dataset.url); }
});

load();
