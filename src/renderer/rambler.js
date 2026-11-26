// Rambler-Leiste: nimmt auf, zeigt Pegel in der mittleren Kapsel, schickt WAV an den Hauptprozess.
const $ = (id) => document.getElementById(id);
const bar = $('bar');
const bars = [...document.querySelectorAll('#wave i')];
const MAX_MS = 5 * 60 * 1000;

let mic = null;
let chunks = [];
let startedAt = 0;
let maxTimer = null;
let sessionId = 0;
let active = false;
let stopRequested = false;

function show(state, opts = {}) {
  if (state === 'abort' || state === 'idle') {
    cancelRecording(false);
    return;
  }
  if (state === 'listening') {
    bar.classList.add('hidden');
    void bar.offsetWidth;
  }
  bar.classList.remove('hidden', 'out', 'processing', 'error-mode');
  if (state === 'processing') bar.classList.add('processing');
  if (state === 'error') bar.classList.add('error-mode');

  const showWave = state === 'listening' || state === 'processing';
  $('wave').classList.toggle('hidden', !showWave);
  $('stop').classList.toggle('hidden', state !== 'listening');
  $('cancel').classList.toggle('hidden', state === 'done');
  $('undo').classList.toggle('hidden', state !== 'done');
  $('full').classList.toggle('hidden', !(state === 'done' && opts.fullAvailable));

  const label = $('label');
  label.className = 'label';
  if (state === 'listening' || state === 'processing') {
    label.textContent = '';
    label.classList.add('hidden');
    if (state === 'processing') {
      bars.forEach((b) => {
        b.style.height = '';
      });
    }
  } else if (state === 'done') {
    label.textContent = 'Eingefügt';
  } else if (state === 'error') {
    label.textContent = opts.message || 'Fehler';
    label.classList.add('err');
  }
}

function closeMic() {
  clearTimeout(maxTimer);
  maxTimer = null;
  if (mic) {
    try {
      mic.close();
    } catch {}
  }
  mic = null;
}

async function startRecording(selection) {
  closeMic();
  const mySession = ++sessionId;
  active = true;
  stopRequested = false;
  chunks = [];
  startedAt = Date.now();
  show('listening', { selection });
  try {
    const opened = await Audio16.openMic((samples, rms) => {
      if (mySession !== sessionId || !active) return;
      chunks.push(samples);
      const t = Date.now() / 110;
      const v = Math.min(1, rms * 9);
      bars.forEach((b, i) => {
        const centerBoost = 1 - Math.abs(i - (bars.length - 1) / 2) / (bars.length / 1.4);
        const wave = 0.4 + 0.6 * Math.abs(Math.sin(t + i * 0.85));
        const idle = 4 + 3 * Math.abs(Math.sin(t * 0.6 + i * 0.7)) * centerBoost;
        const active = v * 20 * wave * (0.55 + 0.45 * centerBoost);
        b.style.height = Math.round(Math.min(22, idle + active)) + 'px';
      });
    });
    // Falls während des Mikrofon-Starts bereits gestoppt oder abgebrochen wurde, sofort schließen.
    if (mySession !== sessionId || !active) {
      try {
        opened.close();
      } catch {}
      if (stopRequested) {
        stopRequested = false;
        window.api.ramblerAudio('');
      }
      return;
    }
    mic = opened;
    clearTimeout(maxTimer);
    maxTimer = setTimeout(stopRecording, MAX_MS);
  } catch (err) {
    if (mySession !== sessionId) return;
    active = false;
    stopRequested = false;
    window.api.ramblerError('Mikrofon nicht verfügbar: ' + err.message);
  }
}

function stopRecording() {
  if (!active && !mic) {
    window.api.ramblerAudio('');
    return;
  }
  const hadMic = !!mic;
  active = false;
  if (!hadMic) {
    // Mikrofon wird gerade noch geöffnet: direkt abbrechen und Hauptprozess informieren.
    stopRequested = true;
    sessionId++;
    chunks = [];
    window.api.ramblerAudio('');
    return;
  }
  sessionId++;
  closeMic();
  if (Date.now() - startedAt < 300 || !chunks.length) {
    chunks = [];
    window.api.ramblerAudio('');
    return;
  }
  show('processing');
  const wav = Audio16.wavBase64(chunks);
  chunks = [];
  window.api.ramblerAudio(wav);
}

function cancelRecording(notifyMain = true) {
  sessionId++;
  active = false;
  stopRequested = false;
  closeMic();
  chunks = [];
  bar.classList.add('hidden');
  if (notifyMain) window.api.ramblerCancel();
}

// Auf Windows fressen focusable:false-Fenster (WS_EX_NOACTIVATE) teilweise click-Events.
// pointerdown löst zuverlässig beim allerersten Klick aus; click bleibt als Tastatur-Fallback.
function bindButton(el, handler) {
  let handledAt = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handledAt = Date.now();
    handler();
  });
  el.addEventListener('click', (e) => {
    if (Date.now() - handledAt < 400) return;
    e.preventDefault();
    handler();
  });
}

window.api.onRamblerStart(({ selection }) => startRecording(selection));
window.api.onRamblerStop(stopRecording);
window.api.onRamblerState((s) => show(s.state, s));

bindButton($('stop'), stopRecording);
bindButton($('cancel'), () => cancelRecording(true));
bindButton($('undo'), () => window.api.ramblerUndo());
bindButton($('full'), () => window.api.ramblerFull());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelRecording(true);
  }
});

// Lokales Whisper lädt beim ersten Diktat sein Modell herunter.
window.api.onSttProgress((p) => {
  const label = $('label');
  if (!bar.classList.contains('processing') || !p || !p.total) return;
  label.classList.remove('hidden');
  label.textContent = `${Math.round((p.loaded / p.total) * 100)} %`;
});
