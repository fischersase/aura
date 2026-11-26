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
  Object.entries(stepEls).forEach(([n, el]) => {
    const active = n === name;
    el.classList.toggle('on', active);
    el.hidden = !active;
  });
  document.querySelector('.dots').innerHTML = flow()
    .map((_, n) => `<i class="${n <= i ? 'on' : ''}"${n === i ? ' aria-current="step"' : ''}></i>`)
    .join('');
  $('back').style.visibility = i === 0 ? 'hidden' : 'visible';
  $('next').textContent = i === 0 ? "Los geht's" : i === flow().length - 1 ? 'Fertig' : 'Weiter';
  if (name === 'key') {
    setTimeout(() => $('apiKey').focus(), 50);
    checkClipboardForKey();
  } else {
    const h = stepEls[name] && stepEls[name].querySelector('h1');
    if (h) setTimeout(() => h.focus(), 40);
  }
  if (name === 'ollama') {
    if (!olPanel) olPanel = OllamaPanel($('ollamaBox'), settings);
    olPanel.check();
  }
}

function pickProvider(p) {
  const btn = document.querySelector(`[data-provider="${p}"]`);
  if (btn && btn.disabled) return;
  provider = p;
  document.querySelectorAll('[data-provider]').forEach((b) => b.classList.toggle('on', b.dataset.provider === p));
}
document.querySelectorAll('[data-provider]').forEach((b) => {
  b.onclick = () => pickProvider(b.dataset.provider);
});

async function checkClipboardForKey() {
  if (!window.api.readClipboardKey || $('apiKey').value.trim()) {
    if ($('clipBanner')) $('clipBanner').classList.add('hidden');
    return;
  }
  try {
    const r = await window.api.readClipboardKey();
    if ($('clipBanner')) $('clipBanner').classList.toggle('hidden', !(r && r.found));
  } catch {}
}

async function pasteAndTestFromClipboard() {
  if (!window.api.readClipboardKey) return;
  const r = await window.api.readClipboardKey();
  if (!r || !r.found || !r.key) {
    status(
      $('keyStatus'),
      'In der Zwischenablage wurde kein Gemini-Key (beginnt mit „AIza“) gefunden. Bitte zuerst in Google AI Studio kopieren.',
      false
    );
    return;
  }
  $('apiKey').value = r.key;
  if ($('clipBanner')) $('clipBanner').classList.add('hidden');
  keyOk = false;
  await testKey();
}

async function testKey() {
  const key = $('apiKey').value.trim();
  if (!key && hasKey) {
    keyOk = true;
    status($('keyStatus'), 'Gespeicherter Key wird weiterverwendet.', true);
    return true;
  }
  if (!key) {
    status($('keyStatus'), 'Bitte den Key einfügen (beginnt mit „AIza“).', false);
    $('apiKey').setAttribute('aria-invalid', 'true');
    return false;
  }
  if (!/^AIza[0-9A-Za-z_-]{15,}$/.test(key)) {
    status(
      $('keyStatus'),
      'Das sieht noch nicht wie ein Gemini API-Key aus – er beginnt immer mit „AIza“ (ohne Leerzeichen).',
      false
    );
    $('apiKey').setAttribute('aria-invalid', 'true');
    return false;
  }
  $('apiKey').removeAttribute('aria-invalid');
  status($('keyStatus'), 'Prüfe Verbindung zu Google Gemini …');
  const r = await window.api.testKey(key);
  keyOk = r.ok;
  status($('keyStatus'), r.ok ? 'Key funktioniert und ist verschlüsselt gespeichert!' : 'Fehler: ' + r.message, r.ok);
  if (!r.ok) {
    $('apiKey').setAttribute('aria-invalid', 'true');
    return false;
  }
  const saved = await window.api.saveSettings({ apiKey: key });
  if (saved.keyError) {
    // No keyring: the key works but is not stored (AURA-93).
    keyOk = false;
    status($('keyStatus'), saved.keyError, false);
    return false;
  }
  hasKey = true;
  return true;
}

$('testKey').onclick = testKey;
if ($('pasteKeyBtn')) $('pasteKeyBtn').onclick = pasteAndTestFromClipboard;
if ($('pasteClipBannerBtn')) $('pasteClipBannerBtn').onclick = pasteAndTestFromClipboard;
if ($('toggleKeyVis')) {
  $('toggleKeyVis').onclick = () => {
    const shown = $('apiKey').type === 'text';
    $('apiKey').type = shown ? 'password' : 'text';
    $('toggleKeyVis').setAttribute('aria-pressed', String(!shown));
  };
}
$('apiKey').addEventListener('input', () => {
  keyOk = false;
  $('apiKey').removeAttribute('aria-invalid');
});
$('apiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) $('next').click();
});
window.addEventListener('focus', () => {
  if (flow()[step] === 'key') checkClipboardForKey();
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
    await window.api.saveSettings({
      autostart: $('autostart').checked,
      telemetryMetricsOptIn: Boolean($('optMetrics') && $('optMetrics').checked),
      telemetryTracesOptIn: Boolean($('optTraces') && $('optTraces').checked)
    });
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
if (window.api.hardwareInfo) {
  window.api.hardwareInfo().then((hw) => {
    if (!hw) return;
    if ($('hwBanner')) $('hwBanner').textContent = `Dein PC: ${hw.summary}`;
    const vram = Number(hw.vramGb || 0);
    const ram = Number(hw.ramGb || 0);
    const canLocal = vram >= 4 || ram >= 8;
    const olBtn = $('ollamaChoiceBtn');
    const olBadge = $('ollamaChoiceBadge');
    if (olBtn && olBadge) {
      if (!canLocal) {
        olBtn.disabled = true;
        olBadge.textContent = `Nicht genug Speicher (${hw.summary} · braucht ≥ 4 GB VRAM oder 8 GB RAM)`;
        if (provider === 'ollama') pickProvider('gemini');
      } else if (vram >= 8) {
        olBadge.textContent = `Gut geeignet (${vram} GB VRAM erkannt)`;
      } else {
        olBadge.textContent = `Kleine Modelle möglich (${ram} GB RAM · große Modelle ausgegraut)`;
      }
    }
  });
}
show(0);
