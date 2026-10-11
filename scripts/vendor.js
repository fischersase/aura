// Kopiert Whisper (transformers.js) und die ONNX-Runtime für den Browser nach src/vendor,
// damit die App ohne CDN auskommt. Läuft nach npm install / npm ci.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'vendor');
const files = [
  ['node_modules/@huggingface/transformers/dist/transformers.min.js', 'transformers.min.js'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm']
];

fs.mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) {
    console.warn(`vendor: ${from} fehlt, lokales Whisper ist dann nicht verfügbar.`);
    continue;
  }
  fs.copyFileSync(src, path.join(out, to));
}
console.log('vendor: Whisper-Laufzeit nach src/vendor kopiert.');
