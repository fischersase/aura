const $ = (id) => document.getElementById(id);
const steps = [...document.querySelectorAll('.step')];
const dots = [...document.querySelectorAll('.dots i')];
let step = 0;
let keyOk = false;
let hasKey = false;

function status(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok === undefined ? '' : ok ? 'ok' : 'bad');
}

function show(i) {
  step = i;
  steps.forEach((s, n) => s.classList.toggle('on', n === i));
  dots.forEach((d, n) => d.classList.toggle('on', n <= i));
  $('back').style.visibility = i === 0 ? 'hidden' : 'visible';
  $('next').textContent = i === 0 ? "Los geht's" : i === steps.length - 1 ? 'Fertig' : 'Weiter';
  if (i === 1) setTimeout(() => $('apiKey').focus(), 50);
}

async function testKey() {
  const key = $('apiKey').value.trim();
  if (!key && hasKey) { keyOk = true; status($('keyStatus'), 'Gespeicherter Key wird weiterverwendet.', true); return true; }
  if (!key) { status($('keyStatus'), 'Bitte den Key einfügen.', false); return false; }
  status($('keyStatus'), 'Prüfe …');
  const r = await window.api.testKey(key);
  keyOk = r.ok;
  status($('keyStatus'), r.ok ? 'Key funktioniert.' : 'Fehler: ' + r.message, r.ok);
  if (r.ok) await window.api.saveSettings({ apiKey: key });
  return r.ok;
}

$('testKey').onclick = testKey;
$('apiKey').addEventListener('input', () => { keyOk = false; });
$('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('next').click(); });

$('back').onclick = () => show(Math.max(0, step - 1));
$('next').onclick = async () => {
  if (step === 1 && !keyOk && !(await testKey())) return;
  if (step === 2) {
    const v = Math.max(0, Number($('budget').value.replace(',', '.')) || 0);
    await window.api.saveSettings({ monthlyBudgetUsd: v });
  }
  if (step === steps.length - 1) {
    await window.api.saveSettings({ autostart: $('autostart').checked });
    window.api.setupDone();
    return;
  }
  show(step + 1);
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-url]');
  if (b) { e.preventDefault(); window.api.openExternal(b.dataset.url); }
});

window.api.getSettings().then((s) => {
  hasKey = s.hasApiKey;
  if (hasKey) $('apiKey').placeholder = '•••••••• (gespeichert – leer lassen zum Behalten)';
  $('budget').value = String(s.monthlyBudgetUsd ?? 10);
  $('autostart').checked = s.autostart !== false;
  const pretty = (a) => (a || '–').replace('Control', 'Strg').replace('Space', 'Leertaste');
  $('kG').textContent = pretty(s.hotkeyGemini);
  $('kL').textContent = pretty(s.hotkeyLive);
  $('kD').textContent = pretty(s.hotkeyRambler);
});
show(0);
