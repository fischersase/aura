// Brücke zum neuen Agenten (agent/, Python + Google ADK): Prozess starten, Aufträge schicken,
// Rückfragen (Freigabe, Bildschirmfoto) beantworten, Not-Aus. Siehe docs/adr/0001.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Peer, PROTOCOL_VERSION } = require('./rpc');

const CANCEL_TIMEOUT_MS = 2000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

class AgentBridge {
  // app: Electron-app; settings(): Einstellungen für initialize; host: { approve(req), ask(req), screenshot(maxWidth) }
  constructor({ app, settings, host, onModelStatus }) {
    this.app = app;
    this.settings = settings;
    this.host = host;
    this.onModelStatus = onModelStatus || (() => {});
    this.proc = null;
    this.peer = null;
    this.ready = null;
    this.initKey = '';
    this.tasks = new Map(); // taskId → { handlers, resolve, reject }
  }

  // Welches Python? 1. AURA_AGENT_PYTHON, 2. mitgeliefert (resources/python), 3. Entwicklung (agent/.venv).
  pythonPath() {
    if (process.env.AURA_AGENT_PYTHON) return process.env.AURA_AGENT_PYTHON;
    const win = process.platform === 'win32';
    const bundled = path.join(process.resourcesPath || '', 'python', win ? 'python.exe' : path.join('bin', 'python3'));
    if (this.app.isPackaged && fs.existsSync(bundled)) return bundled;
    const dev = path.join(this.app.getAppPath(), 'agent', '.venv', win ? 'Scripts/python.exe' : 'bin/python');
    if (fs.existsSync(dev)) return dev;
    return null;
  }

  available() { return !!this.pythonPath(); }

  logStream() {
    const dir = path.join(this.app.getPath('userData'), 'agent');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent.log');
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1'); } catch {}
    return fs.createWriteStream(file, { flags: 'a' });
  }

  // Startet den Prozess bei Bedarf und wartet auf initialize. Ändern sich die Einstellungen
  // (z. B. anderes Modell), wird der Prozess neu gestartet, sobald kein Auftrag läuft.
  ensure() {
    const init = this.settings();
    const key = JSON.stringify(init);
    if (this.ready && key !== this.initKey && this.tasks.size === 0) this.stop();
    if (this.ready) return this.ready;
    const python = this.pythonPath();
    if (!python) return Promise.reject(new Error('Agent v2 ist nicht installiert (kein Python für agent/ gefunden).'));
    this.initKey = key;
    // -I: isoliert, ignoriert PYTHONPATH und Nutzer-site-packages (kein fremder Code im Agenten).
    const proc = spawn(python, ['-I', '-m', 'aura_agent'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1' },
      windowsHide: true
    });
    this.proc = proc;
    const log = this.logStream();
    log.write(`\n--- Start ${new Date().toISOString()} (${python}) ---\n`);
    proc.stderr.pipe(log);
    const peer = new Peer((line) => { if (proc.stdin.writable) proc.stdin.write(line); });
    this.peer = peer;
    proc.stdout.on('data', (d) => peer.feed(d));
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
    proc.on('error', (err) => this.onExit(proc, null, String(err.message || err)));

    peer.on('host.approve', (req) => this.host.approve(req));
    peer.on('host.screenshot', (req) => this.host.screenshot(req.maxWidth || 1600));
    peer.on('host.ask', (req) => this.host.ask(req));
    peer.on('host.input', (req) => (this.host.input ? this.host.input(req) : { error: 'Eingabe nicht verfügbar' }));
    peer.onNotify('task.text', (p) => this.handler(p.taskId, 'onText', p.delta));
    peer.onNotify('task.step', (p) => this.handler(p.taskId, 'onStep', p));
    peer.onNotify('task.plan', (p) => this.handler(p.taskId, 'onPlan', p.items));
    peer.onNotify('task.done', (p) => this.finish(p.taskId, null, p));
    peer.onNotify('task.error', (p) => this.finish(p.taskId, new Error(p.message), null));
    peer.onNotify('model.status', (p) => this.onModelStatus(p));

    this.ready = peer.request('initialize', {
      protocol: PROTOCOL_VERSION,
      settings: init
    }, 30000).catch((err) => { this.stop(); throw err; });
    return this.ready;
  }

  handler(taskId, name, arg) {
    const t = this.tasks.get(taskId);
    if (t && t.handlers[name]) t.handlers[name](arg);
  }

  finish(taskId, err, result) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    this.tasks.delete(taskId);
    if (err) t.reject(err); else t.resolve(result);
  }

  // Ein Auftrag; löst mit {text, cancelled, steps, usage} auf, wenn der Agent fertig ist.
  async runTask({ taskId, chatId, text, images }, handlers = {}) {
    await this.ensure();
    const done = new Promise((resolve, reject) => this.tasks.set(taskId, { handlers, resolve, reject }));
    try {
      await this.peer.request('task.start', { taskId, chatId, text, images: images || [] }, 10000);
    } catch (err) {
      this.tasks.delete(taskId);
      throw err;
    }
    return done;
  }

  // Not-Aus für einen Auftrag. Antwortet der Agent nicht rechtzeitig, wird der Prozess hart beendet.
  async cancel(taskId) {
    if (!this.peer || !this.tasks.has(taskId)) return;
    try {
      await this.peer.request('task.cancel', { taskId }, CANCEL_TIMEOUT_MS);
    } catch {
      this.kill('Not-Aus: Agent hat nicht reagiert');
    }
  }

  async cancelAll() {
    if (!this.peer || this.tasks.size === 0) return;
    try {
      await this.peer.request('task.cancelAll', {}, CANCEL_TIMEOUT_MS);
    } catch {
      this.kill('Not-Aus: Agent hat nicht reagiert');
    }
  }

  kill(reason) {
    if (this.proc && this.proc.exitCode === null) {
      // Windows: ganzen Prozessbaum beenden (laufende PowerShell-Befehle des Agenten eingeschlossen).
      if (process.platform === 'win32') {
        try { execFile('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], { windowsHide: true }, () => {}); } catch {}
      }
      try { this.proc.kill('SIGKILL'); } catch {}
    }
    this.onExit(this.proc, null, reason);
  }

  onExit(proc, code, signal) {
    if (proc !== this.proc) return;
    const reason = `Agent-Prozess beendet (${signal || 'Code ' + code})`;
    if (this.peer) this.peer.close(reason);
    for (const id of [...this.tasks.keys()]) this.finish(id, new Error(reason), null);
    this.proc = null;
    this.peer = null;
    this.ready = null;
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    try { this.peer.notify('shutdown'); } catch {}
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { if (proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch {} } }, 1500);
    this.onExit(proc, null, 'beendet');
  }
}

module.exports = { AgentBridge, defaultAuraDir: () => path.join(os.homedir(), '.aura') };
