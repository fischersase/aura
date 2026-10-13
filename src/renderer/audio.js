// Mikrofon (16 kHz PCM), WAV-Kodierung und Wiedergabe von 24-kHz-PCM.
const Audio16 = {
  async openMic(onChunk) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (e) => onChunk(e.data.samples, e.data.rms);
    src.connect(node);
    return {
      close() {
        try {
          node.disconnect();
          src.disconnect();
        } catch {}
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
      }
    };
  },

  floatToPcm16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  },

  bytesToBase64(bytes) {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(bin);
  },

  base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },

  // Float32-Blöcke (16 kHz mono) zu WAV, Base64.
  wavBase64(chunks, sampleRate = 16000) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let o = 0;
    for (const c of chunks) {
      pcm.set(Audio16.floatToPcm16(c), o);
      o += c.length;
    }
    const buf = new ArrayBuffer(44 + pcm.byteLength);
    const v = new DataView(buf);
    const w = (off, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    w(0, 'RIFF');
    v.setUint32(4, 36 + pcm.byteLength, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, pcm.byteLength, true);
    new Int16Array(buf, 44).set(pcm);
    return Audio16.bytesToBase64(new Uint8Array(buf));
  }
};

// Spielt 24-kHz-PCM16-Stücke nahtlos hintereinander ab; liefert Ausgabepegel.
class PcmPlayer {
  constructor(sampleRate = 24000) {
    this.ctx = new AudioContext({ sampleRate });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(this.ctx.destination);
    this.next = 0;
    this.sources = new Set();
    this.data = new Float32Array(this.analyser.fftSize);
  }
  play(b64) {
    const bytes = Audio16.base64ToBytes(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
    const ab = this.ctx.createBuffer(1, f.length, this.ctx.sampleRate);
    ab.copyToChannel(f, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.analyser);
    const t = Math.max(this.ctx.currentTime + 0.02, this.next);
    src.start(t);
    this.next = t + ab.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }
  interrupt() {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    this.sources.clear();
    this.next = 0;
  }
  get speaking() {
    return this.sources.size > 0;
  }
  level() {
    this.analyser.getFloatTimeDomainData(this.data);
    let s = 0;
    for (const x of this.data) s += x * x;
    return Math.sqrt(s / this.data.length);
  }
  close() {
    this.interrupt();
    this.ctx.close();
  }
}

window.Audio16 = Audio16;
window.PcmPlayer = PcmPlayer;
