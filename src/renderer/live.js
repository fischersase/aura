// Gemini Live über die Live API (WebSocket): Mikrofon, Bildschirm, Sprachausgabe, Klick-Hinweise.
// The WebSocket to the Live API lives in the main process (src/live-relay.js, AURA-15); the renderer never sees the
// API key. RelaySocket offers the small part of the WebSocket interface this file uses.
class RelaySocket {
  constructor() {
    this.readyState = 0; // CONNECTING
    this.id = null;
    this.onopen = this.onmessage = this.onclose = null;
    const mine = (fn) => (ev) => { if (ev.id === this.id) fn(ev); };
    this.off = [
      window.api.onLiveOpened(mine(() => { this.readyState = 1; this.onopen && this.onopen(); })),
      window.api.onLiveMessage(mine((ev) => this.onmessage && this.onmessage({ data: ev.data }))),
      window.api.onLiveClosed(mine((ev) => this.closed(ev.code, ev.reason)))
    ];
    window.api.liveOpen().then((r) => {
      if (r && r.id) this.id = r.id;
      else this.closed(1008, (r && r.error) || 'Keine Verbindung');
    }, (err) => this.closed(1011, String(err.message || err)));
  }

  send(text) { if (this.readyState === 1) window.api.liveSend(this.id, text); }

  close() {
    if (this.id) window.api.liveClose(this.id);
    this.closed(1000, '');
  }

  closed(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.off.forEach((f) => f());
    this.onclose && this.onclose({ code, reason });
  }
}

const LIVE_SYSTEM = (lang) =>
  `Du bist Aura, ein Live-Assistent auf dem Computer des Nutzers und sprichst ${lang}, außer der Nutzer spricht eine andere Sprache. ` +
  'Du siehst laufend den Bildschirm des Nutzers (etwa ein Bild pro Sekunde). Antworte gesprochen, kurz und natürlich. ' +
  'Wenn der Nutzer fragt, wo er klicken, tippen oder hinschauen soll, rufe das Werkzeug point_at mit der Position im ' +
  'NEUESTEN Bildschirmbild auf: x und y sind auf 0 bis 1000 normiert (0,0 = oben links, 1000,1000 = unten rechts), ' +
  'label ist ein sehr kurzer Hinweis wie "Hier auf Speichern klicken". Sag gleichzeitig in einem Satz, was zu tun ist. ' +
  'Bei mehreren Schritten zeig immer nur den nächsten Schritt und warte, bis der Nutzer ihn erledigt hat. ' +
  'Rufe clear_pointer auf, wenn der Hinweis nicht mehr gebraucht wird. Du klickst nie selbst.';

const LIVE_TOOLS = [{
  functionDeclarations: [
    {
      name: 'point_at',
      description: 'Zeigt dem Nutzer mit einem leuchtenden Ring auf dem Bildschirm, wo er klicken oder hinschauen soll.',
      parameters: {
        type: 'OBJECT',
        properties: {
          x: { type: 'NUMBER', description: 'Horizontale Position 0–1000 im neuesten Bildschirmbild' },
          y: { type: 'NUMBER', description: 'Vertikale Position 0–1000 im neuesten Bildschirmbild' },
          label: { type: 'STRING', description: 'Kurzer Hinweistext' }
        },
        required: ['x', 'y']
      }
    },
    { name: 'clear_pointer', description: 'Entfernt alle Hinweise vom Bildschirm.' }
  ]
}];

// Mit Agent v2 kann Live auch selbst handeln: Programme öffnen, Musik steuern, Dateien, Webseiten …
const AGENT_TOOL = {
  name: 'aura_ausfuehren',
  description: 'Lässt den Aura-Agenten etwas am Computer erledigen (Programme, Fenster, Musik, Dateien, Webseiten, Einstellungen). ' +
    'Gibt das Ergebnis zurück. Folgenreiches muss der Nutzer im Aura-Fenster freigeben.',
  parameters: { type: 'OBJECT', properties: { request: { type: 'STRING', description: 'Klare, vollständige Aufgabe auf Deutsch' } }, required: ['request'] }
};
const AGENT_SYSTEM = ' Wenn der Nutzer möchte, dass etwas am Computer erledigt wird, rufe aura_ausfuehren mit einer klaren Aufgabe auf ' +
  'und sag danach kurz, was herauskam. Behaupte nur Erfolg, wenn das Ergebnis ihn belegt.';

class LiveSession {
  constructor(ui) {
    this.ui = ui; // { status(text), transcript(role, text, final), level(v), ended(err) }
    this.active = false;
    this.muted = false;
    this.screenOn = true;
    this.handle = null;
    this.ws = null;
    this.mic = null;
    this.player = null;
    this.video = null;
    this.stream = null;
    this.frameTimer = null;
    this.micLevel = 0;
    this.ready = false;
  }

  async start({ screen = true } = {}) {
    if (this.active) return;
    this.active = true;
    this.screenOn = screen;
    this.cfg = await window.api.liveConfig();
    if (this.cfg.error) throw new Error(this.cfg.error);
    if (!this.cfg.hasKey) throw new Error('Kein API-Key hinterlegt.');
    this.usageAcc = { micSec: 0, screenSec: 0, speechSec: 0 };
    this.usageTimer = setInterval(() => this.flushUsage(), 10000);
    this.player = new PcmPlayer(24000);
    this.mic = await Audio16.openMic((samples, rms) => {
      this.micLevel = rms;
      if (!this.ready || this.muted) return;
      const pcm = Audio16.floatToPcm16(samples);
      this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Audio16.bytesToBase64(new Uint8Array(pcm.buffer)) } } });
    });
    if (this.screenOn) await this.startScreen();
    this.connect();
    this.levelLoop();
  }

  connect() {
    this.ready = false;
    this.ui.status(this.handle ? 'Verbindung wird erneuert …' : 'Verbinde …');
    const ws = new RelaySocket();
    this.ws = ws;
    ws.onopen = () => {
      const generationConfig = { responseModalities: ['AUDIO'] };
      if (this.cfg.voice) generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.cfg.voice } } };
      this.send({
        setup: {
          model: `models/${this.cfg.model}`,
          generationConfig,
          systemInstruction: { parts: [{ text: LIVE_SYSTEM(this.cfg.language) + (this.cfg.agent ? AGENT_SYSTEM : '') }] },
          tools: this.cfg.agent ? [{ functionDeclarations: [...LIVE_TOOLS[0].functionDeclarations, AGENT_TOOL] }] : LIVE_TOOLS,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Ohne Kompression enden Audio+Video-Sitzungen nach 2 Minuten.
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: this.handle ? { handle: this.handle } : {}
        }
      });
    };
    ws.onmessage = async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ready = false;
      if (!this.active) return;
      if (this.handle && ev.code !== 1008) {
        setTimeout(() => this.active && this.connect(), 400);
      } else {
        this.stop(ev.reason ? `Verbindung beendet: ${ev.reason}` : 'Verbindung beendet.');
      }
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  onMessage(msg) {
    if (msg.setupComplete) {
      this.ready = true;
      this.ui.status(this.screenOn ? 'Hört zu und sieht deinen Bildschirm' : 'Hört zu');
      this.sendFrame();
      return;
    }
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.handle = u.newHandle;
    }
    if (msg.goAway) {
      // Server beendet die Verbindung bald: mit Handle neu verbinden.
      const old = this.ws;
      this.ws = null;
      try { old.close(); } catch {}
      this.connect();
      return;
    }
    if (msg.toolCall) this.onToolCall(msg.toolCall);
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) this.player.interrupt();
    if (sc.modelTurn && sc.modelTurn.parts) {
      for (const p of sc.modelTurn.parts) {
        if (p.inlineData && p.inlineData.data && /audio/.test(p.inlineData.mimeType || 'audio')) this.player.play(p.inlineData.data);
      }
    }
    if (sc.inputTranscription && sc.inputTranscription.text) this.ui.transcript('you', sc.inputTranscription.text);
    if (sc.outputTranscription && sc.outputTranscription.text) this.ui.transcript('gem', sc.outputTranscription.text);
    if (sc.turnComplete) this.ui.transcript('turn');
  }

  onToolCall(tc) {
    const responses = [];
    for (const fc of tc.functionCalls || []) {
      const a = fc.args || {};
      if (fc.name === 'point_at') {
        window.api.showPointer({ x: Number(a.x), y: Number(a.y), label: a.label || '' });
        responses.push({ id: fc.id, name: fc.name, response: { result: 'Hinweis wird angezeigt.' } });
      } else if (fc.name === 'clear_pointer') {
        window.api.clearPointer();
        responses.push({ id: fc.id, name: fc.name, response: { result: 'ok' } });
      } else if (fc.name === 'aura_ausfuehren') {
        // Der Agent braucht etwas länger: Antwort nachreichen, sobald er fertig ist.
        window.api.agentVoiceTask(a.request).then((r) => {
          this.send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: r }] } });
        });
      } else {
        responses.push({ id: fc.id, name: fc.name, response: { error: 'Unbekanntes Werkzeug' } });
      }
    }
    if (responses.length) this.send({ toolResponse: { functionResponses: responses } });
  }

  async startScreen() {
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.srcObject = this.stream;
      await this.video.play();
      this.canvas = document.createElement('canvas');
      const fps = Math.max(0.2, Math.min(2, this.cfg ? this.cfg.fps : 1));
      clearInterval(this.frameTimer);
      this.frameTimer = setInterval(() => this.sendFrame(), 1000 / fps);
      this.screenOn = true;
    } catch (err) {
      this.screenOn = false;
      this.ui.status('Bildschirmfreigabe nicht möglich: ' + err.message);
    }
  }

  stopScreen() {
    clearInterval(this.frameTimer);
    this.frameTimer = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.screenOn = false;
  }

  async toggleScreen() {
    if (this.screenOn) {
      this.stopScreen();
      this.ui.status('Hört zu (Bildschirm aus)');
    } else {
      await this.startScreen();
      if (this.screenOn) this.ui.status('Hört zu und sieht deinen Bildschirm');
    }
    return this.screenOn;
  }

  sendFrame() {
    if (!this.ready || !this.video || !this.video.videoWidth) return;
    const maxW = 1280;
    const s = Math.min(1, maxW / this.video.videoWidth);
    this.canvas.width = Math.round(this.video.videoWidth * s);
    this.canvas.height = Math.round(this.video.videoHeight * s);
    this.canvas.getContext('2d').drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const data = this.canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
    this.send({ realtimeInput: { video: { mimeType: 'image/jpeg', data } } });
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.muted) this.send({ realtimeInput: { audioStreamEnd: true } });
    return this.muted;
  }

  flushUsage() {
    const a = this.usageAcc;
    if (!a || (!a.micSec && !a.screenSec && !a.speechSec)) return;
    window.api.liveUsage({ ...a });
    this.usageAcc = { micSec: 0, screenSec: 0, speechSec: 0 };
  }

  levelLoop() {
    let last = 0;
    let prev = performance.now();
    const tick = (now) => {
      if (!this.active) return;
      // Laufzeit für die Kostenschätzung mitzählen
      const dt = Math.min(1, (now - prev) / 1000);
      prev = now;
      if (this.ready && this.usageAcc) {
        if (!this.muted) this.usageAcc.micSec += dt;
        if (this.screenOn) this.usageAcc.screenSec += dt;
        if (this.player && this.player.speaking) this.usageAcc.speechSec += dt;
      }
      const out = this.player ? this.player.level() * 4 : 0;
      const inp = this.muted ? 0 : this.micLevel * 6;
      const v = Math.min(1, Math.max(out, inp));
      this.ui.level(v, out > inp);
      if (now - last > 33) { window.api.glowLevel(v); last = now; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(error) {
    if (!this.active) return;
    clearInterval(this.usageTimer);
    this.flushUsage();
    this.active = false;
    this.ready = false;
    const ws = this.ws;
    this.ws = null;
    try { ws && ws.close(); } catch {}
    this.stopScreen();
    if (this.mic) this.mic.close();
    if (this.player) this.player.close();
    this.mic = null;
    this.player = null;
    this.handle = null;
    window.api.clearPointer();
    window.api.glowLevel(0);
    this.ui.ended(error);
  }
}

window.LiveSession = LiveSession;
