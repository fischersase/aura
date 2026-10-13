// Live mit lokalen Modellen: Sprache erkennen (Whisper), Antwort mit Bildschirmfoto (Ollama), vorlesen.
// Anders als die Gemini Live API ist das ein Wechselgespräch: zuhören → nachdenken → sprechen.
const LANG_CODES = {
  deutsch: 'de-DE',
  german: 'de-DE',
  englisch: 'en-US',
  english: 'en-US',
  französisch: 'fr-FR',
  french: 'fr-FR',
  spanisch: 'es-ES',
  spanish: 'es-ES',
  italienisch: 'it-IT',
  italian: 'it-IT'
};

class LocalLiveSession {
  constructor(ui) {
    this.ui = ui; // { status(text), transcript(role, text), level(v), ended(err) }
    this.active = false;
    this.muted = false;
    this.screenOn = true;
    this.state = 'idle'; // listening | thinking | speaking
    this.history = [];
    this.micLevel = 0;
    this.turnId = 0;
  }

  async start({ screen = true } = {}) {
    if (this.active) return;
    this.active = true;
    this.screenOn = screen;
    this.cfg = await window.api.liveConfig();
    if (this.cfg.error) throw new Error(this.cfg.error);
    this.lang = LANG_CODES[String(this.cfg.language || '').toLowerCase()] || navigator.language || 'de-DE';
    this.resetVad();
    this.noise = 0.01;
    this.offProgress = window.api.onSttProgress((p) => {
      if (this.state === 'thinking')
        this.ui.status(`Lade Spracherkennung … ${Math.round((p.loaded / p.total) * 100)} %`);
    });
    this.offHeard = window.api.onLiveHeard(({ id, text }) => {
      if (id !== this.turnId || !this.youEl) return;
      this.youEl.textContent = text;
    });
    this.mic = await Audio16.openMic((samples, rms) => this.onAudio(samples, rms));
    this.listen();
    this.levelLoop();
  }

  resetVad() {
    this.chunks = [];
    this.preroll = [];
    this.loud = 0;
    this.quiet = 0;
    this.talking = false;
  }

  listen() {
    this.state = 'listening';
    this.resetVad();
    this.ui.status(
      this.muted ? 'Mikrofon stumm' : this.screenOn ? 'Hört zu und sieht deinen Bildschirm (lokal)' : 'Hört zu (lokal)'
    );
  }

  // Einfache Sprach-Erkennung über die Lautstärke (100-ms-Blöcke).
  onAudio(samples, rms) {
    this.micLevel = rms;
    if (!this.active || this.muted) return;
    if (!this.talking) this.noise = this.noise * 0.95 + Math.min(rms, 0.05) * 0.05;
    const thr = Math.max(0.012, this.noise * 3);

    if (this.state === 'speaking') {
      // Dazwischenreden unterbricht die Sprachausgabe (höhere Schwelle wegen Lautsprecher-Echo).
      this.loud = rms > thr * 2.5 ? this.loud + 1 : 0;
      if (this.loud >= 3) {
        speechSynthesis.cancel();
        this.listen();
      }
      return;
    }
    if (this.state !== 'listening') return;

    if (!this.talking) {
      this.preroll.push(samples);
      if (this.preroll.length > 4) this.preroll.shift();
      this.loud = rms > thr ? this.loud + 1 : 0;
      if (this.loud >= 2) {
        this.talking = true;
        this.chunks = this.preroll.slice();
        this.quiet = 0;
        window.api.clearPointer();
      }
      return;
    }
    this.chunks.push(samples);
    this.quiet = rms > thr ? 0 : this.quiet + 1;
    if (this.quiet >= 8 || this.chunks.length >= 300) this.endUtterance(); // 0,8 s Pause oder 30 s
  }

  async endUtterance() {
    const chunks = this.chunks;
    this.resetVad();
    if (chunks.length < 6) return; // zu kurz, wohl nur ein Geräusch
    const id = ++this.turnId;
    this.state = 'thinking';
    this.ui.status('Denkt nach …');
    this.ui.transcript('turn');
    this.ui.transcript('you', '…');
    this.youEl = document.querySelector('#liveTranscript .you:last-child');
    const r = await window.api.liveTurn({
      id,
      wavBase64: Audio16.wavBase64(chunks),
      history: this.history.slice(-8),
      screen: this.screenOn
    });
    if (!this.active || id !== this.turnId) return;
    if (r.aborted) return;
    if (r.empty) {
      if (this.youEl) this.youEl.remove();
      this.listen();
      return;
    }
    if (r.error) {
      this.ui.transcript('gem', 'Fehler: ' + r.error);
      this.ui.transcript('turn');
      this.listen();
      return;
    }
    if (this.youEl) this.youEl.textContent = r.question;
    this.history.push({ role: 'you', text: r.question }, { role: 'gem', text: r.say });
    if (r.point) window.api.showPointer(r.point);
    this.ui.transcript('gem', r.say);
    this.ui.transcript('turn');
    this.speak(r.say);
  }

  speak(text) {
    if (!text || !('speechSynthesis' in window)) {
      this.listen();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.lang;
    const voices = speechSynthesis.getVoices();
    const base = this.lang.slice(0, 2);
    const voice =
      voices.find((v) => v.lang === this.lang && v.localService) || voices.find((v) => v.lang.startsWith(base));
    if (voice) u.voice = voice;
    u.rate = 1.05;
    this.state = 'speaking';
    this.ui.status('Spricht … (einfach reinreden zum Unterbrechen)');
    const done = () => {
      if (this.active && this.state === 'speaking') this.listen();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    // Ohne installierte Stimme feuert onend teils nicht.
    clearTimeout(this.speakTimer);
    this.speakTimer = setTimeout(() => {
      if (!speechSynthesis.speaking) done();
    }, 1500);
  }

  toggleScreen() {
    this.screenOn = !this.screenOn;
    if (this.state === 'listening') this.listen();
    return this.screenOn;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.muted && this.state === 'listening') this.resetVad();
    if (this.state === 'listening') this.listen();
    return this.muted;
  }

  levelLoop() {
    let last = 0;
    const tick = (now) => {
      if (!this.active) return;
      let v;
      let out = false;
      if (this.state === 'speaking') {
        v = 0.35 + 0.25 * Math.abs(Math.sin(now / 140)) * Math.abs(Math.sin(now / 370));
        out = true;
      } else if (this.state === 'thinking') {
        v = 0.15 + 0.1 * Math.sin(now / 300);
      } else {
        v = this.muted ? 0 : Math.min(1, this.micLevel * 6);
      }
      this.ui.level(v, out);
      if (now - last > 33) {
        window.api.glowLevel(v);
        last = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(error) {
    if (!this.active) return;
    this.active = false;
    this.turnId++;
    window.api.abortLiveTurn();
    clearTimeout(this.speakTimer);
    try {
      speechSynthesis.cancel();
    } catch {}
    if (this.mic) this.mic.close();
    this.mic = null;
    if (this.offProgress) this.offProgress();
    if (this.offHeard) this.offHeard();
    window.api.clearPointer();
    window.api.glowLevel(0);
    this.ui.ended(error);
  }
}

window.LocalLiveSession = LocalLiveSession;
