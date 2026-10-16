// Rambler-Leiste: nimmt auf, zeigt Pegel in der mittleren Kapsel, schickt WAV an den Hauptprozess.
const $ = (id) => document.getElementById(id);
const bar = $('bar');
const bars = [...document.querySelectorAll('#wave i')];
const MAX_MS = 5 * 60 * 1000;

let mic = null;
let chunks = [];
let startedAt = 0;
let maxTimer = null;

function show(state, opts = {}) {
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

async function startRecording(selection) {
  chunks = [];
  startedAt = Date.now();
  show('listening', { selection });
  try {
    mic = await Audio16.openMic((samples, rms) => {
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
    clearTimeout(maxTimer);
    maxTimer = setTimeout(stopRecording, MAX_MS);
  } catch (err) {
    window.api.ramblerError('Mikrofon nicht verfügbar: ' + err.message);
  }
}

function closeMic() {
  clearTimeout(maxTimer);
  if (mic) mic.close();
  mic = null;
}

function stopRecording() {
  if (!mic) return;
  closeMic();
  if (Date.now() - startedAt < 300 || !chunks.length) {
    window.api.ramblerAudio('');
    return;
  }
  show('processing');
  window.api.ramblerAudio(Audio16.wavBase64(chunks));
  chunks = [];
}

window.api.onRamblerStart(({ selection }) => startRecording(selection));
window.api.onRamblerStop(stopRecording);
window.api.onRamblerState((s) => show(s.state, s));

$('stop').onclick = stopRecording;
$('cancel').onclick = () => {
  closeMic();
  chunks = [];
  window.api.ramblerCancel();
};
$('undo').onclick = () => window.api.ramblerUndo();
$('full').onclick = () => window.api.ramblerFull();

// Lokales Whisper lädt beim ersten Diktat sein Modell herunter.
window.api.onSttProgress((p) => {
  const label = $('label');
  if (!bar.classList.contains('processing') || !p || !p.total) return;
  label.classList.remove('hidden');
  label.textContent = `${Math.round((p.loaded / p.total) * 100)} %`;
});
