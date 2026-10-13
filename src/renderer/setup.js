const $ = (id) => document.getElementById(id);
const stepEls = Object.fromEntries([...document.querySelectorAll('.step')].map((s) => [s.dataset.step, s]));
const FLOWS = {
  gemini: ['welcome', 'provider', 'key', 'budget', 'done'],
  ollama: ['welcome', 'provider', 'ollama', 'done']
};
let provider = 'gemini';
let step = 0;
let keyOk = false;
let hasKey = false;
let olPanel = null;
let settings = {};

const flow = () => FLOWS[provider];

function status(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok === undefined ? '' : ok ? 'ok' : 'bad');
}

function show(i) {
  step = i;
  const name = flow()[i];
  Object.entries(stepEls).forEach(([n, el]) => el.classList.toggle('on', n === name));
  document.querySelector('.dots').innerHTML = flow()
    .map((_, n) => `<i class="${n <= i ? 'on' : ''}"></i>`)
    .join('');
  $('back').style.visibility = i === 0 ? 'hidden' : 'visible';
  $('next').textContent = i === 0 ? "Los geht's" : i === flow().length - 1 ? 'Fertig' : 'Weiter';
  if (name === 'key') setTimeout(() => $('apiKey').focus(), 50);
  if (name === 'ollama') {
    if (!olPanel) olPanel = OllamaPanel($('ollamaBox'), settings);
    olPanel.check();
  }
}

function pickProvider(p) {
  provider = p;
  document.querySelectorAll('[data-provider]').forEach((b) => b.classList.toggle('on', b.dataset.provider === p));
}
document.querySelectorAll('[data-provider]').forEach((b) => {
  b.onclick = () => pickProvider(b.dataset.provider);
});

async function testKey() {
  const key = $('apiKey').value.trim();
  if (!key && hasKey) {
    keyOk = true;
    status($('keyStatus'), 'Gespeicherter Key wird weiterverwendet.', true);
    return true;
  }
  if (!key) {
    status($('keyStatus'), 'Bitte den Key einfügen.', false);
    return false;
  }
  status($('keyStatus'), 'Prüfe …');
  const r = await window.api.testKey(key);
  keyOk = r.ok;
  status($('keyStatus'), r.ok ? 'Key funktioniert.' : 'Fehler: ' + r.message, r.ok);
  if (!r.ok) return false;
  const saved = await window.api.saveSettings({ apiKey: key });
  if (saved.keyError) {
    // No keyring: the key works but is not stored (AURA-93).
    keyOk = false;
    status($('keyStatus'), saved.keyError, false);
    return false;
  }
  return true;
}

$('testKey').onclick = testKey;
$('apiKey').addEventListener('input', () => {
  keyOk = false;
});
$('apiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('next').click();
});

$('back').onclick = () => show(Math.max(0, step - 1));
$('next').onclick = async () => {
  const name = flow()[step];
  if (name === 'provider') await window.api.saveSettings({ provider });
  if (name === 'key' && !keyOk && !(await testKey())) return;
  if (name === 'budget') {
    const v = Math.max(0, Number($('budget').value.replace(',', '.')) || 0);
    await window.api.saveSettings({ monthlyBudgetUsd: v });
  }
  if (name === 'ollama') {
    // Ohne laufendes Ollama oder geladenes Modell trotzdem weiter: die App erklärt es beim ersten Versuch.
    await window.api.saveSettings(olPanel.values());
  }
  if (step === flow().length - 1) {
    await window.api.saveSettings({ autostart: $('autostart').checked });
    window.api.setupDone();
    return;
  }
  show(step + 1);
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-url]');
  if (b) {
    e.preventDefault();
    window.api.openExternal(b.dataset.url);
  }
});

window.api.getSettings().then((s) => {
  settings = s;
  hasKey = s.hasApiKey;
  pickProvider(s.provider === 'ollama' ? 'ollama' : 'gemini');
  if (hasKey) $('apiKey').placeholder = '•••••••• (gespeichert – leer lassen zum Behalten)';
  $('budget').value = String(s.monthlyBudgetUsd ?? 10);
  $('autostart').checked = s.autostart !== false;
  $('linuxDone').classList.toggle('hidden', s.platform !== 'linux');
  const pretty = (a) => (a || '–').replace('Control', 'Strg').replace('Space', 'Leertaste');
  $('kG').textContent = pretty(s.hotkeyGemini);
  $('kL').textContent = pretty(s.hotkeyLive);
  $('kD').textContent = pretty(s.hotkeyRambler);
});
show(0);
