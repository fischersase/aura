// Rambler-Leiste: nimmt auf, zeigt Pegel, schickt WAV an den Hauptprozess.
const $ = (id) => document.getElementById(id);
const bar = $('bar');
const bars = [...document.querySelectorAll('#wave i')];
const MAX_MS = 5 * 60 * 1000;

let mic = null;
let chunks = [];
let startedAt = 0;
let maxTimer = null;

function show(state, opts = {}) {
  if (state === 'listening') { bar.classList.add('hidden'); void bar.offsetWidth; } // Einblend-Animation neu starten
  bar.classList.remove('hidden', 'out');
  $('wave').classList.toggle('hidden', state !== 'listening');
  $('stop').classList.toggle('hidden', state !== 'listening');
  $('cancel').classList.toggle('hidden', state === 'done');
  $('undo').classList.toggle('hidden', state !== 'done');
  $('full').classList.toggle('hidden', !(state === 'done' && opts.fullAvailable));
  const label = $('label');
  label.className = 'label';
  if (state === 'listening') {
    label.innerHTML = opts.selection
      ? 'Sag, wie der markierte Text geändert werden soll'
      : 'Rambler hört zu … <small>nochmal Kürzel = fertig</small>';
  } else if (state === 'processing') {
    label.textContent = 'Rambler schreibt …';
    label.classList.add('shimmer');
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
      const v = Math.min(1, rms * 8);
      bars.forEach((b, i) => {
        const f = 0.35 + 0.65 * Math.abs(Math.sin(Date.now() / 120 + i * 1.3));
        b.style.height = Math.max(4, v * 28 * f) + 'px';
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
  if (Date.now() - startedAt < 400 || !chunks.length) {
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
$('cancel').onclick = () => { closeMic(); chunks = []; window.api.ramblerCancel(); };
$('undo').onclick = () => window.api.ramblerUndo();
$('full').onclick = () => window.api.ramblerFull();

// Lokales Whisper lädt beim ersten Diktat sein Modell herunter.
window.api.onSttProgress((p) => {
  const label = $('label');
  if (!label.classList.contains('shimmer')) return;
  label.textContent = `Lade Spracherkennung … ${Math.round((p.loaded / p.total) * 100)} %`;
});
