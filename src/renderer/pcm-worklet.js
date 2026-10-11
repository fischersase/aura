// Läuft im AudioWorklet: sammelt Mikrofon-Samples und meldet Pegel.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600); // 100 ms bei 16 kHz
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        let sum = 0;
        for (let j = 0; j < this.buf.length; j++) sum += this.buf[j] * this.buf[j];
        this.port.postMessage({ samples: this.buf.slice(0), rms: Math.sqrt(sum / this.buf.length) });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
