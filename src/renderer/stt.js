// Lokale Spracherkennung mit Whisper (transformers.js, läuft komplett auf dem Rechner).
import { pipeline, env } from '../vendor/transformers.min.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', location.href).href;
env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

let current = null; // { model, pipe: Promise }

function wavToFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 44, Math.floor((bytes.length - 44) / 2));
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
  return f;
}

async function load(model) {
  if (current && current.model === model) return current.pipe;
  const progress = (p) => {
    if (p.status === 'progress' && p.total) window.api.sttProgress({ file: p.file, loaded: p.loaded, total: p.total });
  };
  const make = async () => {
    // WebGPU ist deutlich schneller; ohne passende Grafik weiter mit WebAssembly. Vorher prüfen, ob es wirklich
    // einen Adapter gibt: Electron unter Linux meldet navigator.gpu oft ohne Adapter, und ein gescheiterter
    // WebGPU-Versuch lässt danach auch WASM scheitern („no available backend found“).
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    if (adapter) {
      try {
        return await pipeline('automatic-speech-recognition', model, { device: 'webgpu', dtype: 'fp32', progress_callback: progress });
      } catch (err) {
        console.warn('WebGPU nicht nutzbar, nehme WASM:', err);
      }
    }
    return pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback: progress });
  };
  current = { model, pipe: make() };
  current.pipe.catch(() => { current = null; });
  return current.pipe;
}

window.api.onSttRequest(async ({ id, wavBase64, model, language }) => {
  try {
    let asr;
    try {
      asr = await load(model);
    } catch (err) {
      throw new Error(`Whisper-Modell ${model} konnte nicht geladen werden (beim ersten Mal ist Internet nötig): ${err && err.message || err}`);
    }
    const audio = wavToFloat32(wavBase64);
    const out = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      ...(language ? { language } : {}) // ohne Angabe erkennt Whisper die Sprache selbst
    });
    window.api.sttResult({ id, text: String(out.text || '').trim() });
  } catch (err) {
    window.api.sttResult({ id, error: String(err && err.message || err) });
  }
});

window.api.onSttPreload(({ model }) => { load(model).catch(() => {}); });
window.api.sttReady();
