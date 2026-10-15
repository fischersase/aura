// @ts-check
// Brücke zum neuen Agenten (agent/, Python + Google ADK): Prozess starten, Aufträge schicken,
// Rückfragen (Freigabe, Bildschirmfoto) beantworten, Not-Aus. Siehe docs/adr/0001.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Peer, PROTOCOL_VERSION } = require('./rpc');

const CANCEL_TIMEOUT_MS = 2000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What the agent may ask the app (host.* requests). Requests come from the agent process and are untrusted input.
 * @typedef {object} Host
 * @property {(req: any) => unknown} approve
 * @property {(req: any) => unknown} ask
 * @property {(maxWidth: number) => unknown} screenshot
 * @property {(req: any) => unknown} [input]
 * @property {(req: any) => unknown} [authHeader] fresh Authorization header for an OAuth MCP server (AURA-95)
 * @property {(req: any) => unknown} [searchRegistry] official MCP registry search (AURA-96)
 * @property {(req: any) => unknown} [takeover] the user takes over the browser (AURA-118)
 * @property {(req: any) => unknown} [scheduleTask] store a scheduled task (AURA-121)
 * @property {(req: any) => unknown} [loginsFor] website logins for an origin (AURA-124)
 * @property {(req: any) => unknown} [loginFill] credentials of a website login, origin-bound
 * @property {(req: any) => unknown} [listTasks] scheduled tasks
 * @property {(req: any) => unknown} [cancelTask] delete a scheduled task
 * @property {(req: any) => unknown} [proposeConnector] connect card in the panel (AURA-96)
 */
/** @typedef {{ onText?: (delta: string) => void, onStep?: (step: any) => void, onPlan?: (items: any) => void }} TaskHandlers */
/** @typedef {{ handlers: Record<string, ((arg: any) => void) | undefined>, resolve: (result: any) => void, reject: (err: Error) => void }} RunningTask */

class AgentBridge {
  /**
   * @param {object} options
   * @param {Pick<import('electron').App, 'isPackaged' | 'getAppPath' | 'getPath'>} options.app
   * @param {() => Record<string, unknown>} options.settings settings for initialize
   * @param {Host} options.host
   * @param {(status: any) => void} [options.onModelStatus]
   * @param {() => string[]} [options.chatIds] IDs of the chats the app still has; others are forgotten at start
   */
  constructor({ app, settings, host, onModelStatus, chatIds }) {
    this.app = app;
    this.settings = settings;
    this.host = host;
    this.onModelStatus = onModelStatus || (() => {});
    this.chatIds = chatIds || null;
    /** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
    this.proc = null;
    /** @type {fs.WriteStream | null} */
    this.log = null;
    /** @type {InstanceType<typeof Peer> | null} */
    this.peer = null;
    /** @type {Promise<any> | null} */
    this.ready = null;
    this.initKey = '';
    /** @type {Map<string, RunningTask>} */
    this.tasks = new Map();
  }

  // Welches Python? 1. AURA_AGENT_PYTHON (nur in der Entwicklung und in Tests; installierte Builds ignorieren die
  // Variable, sonst könnte eine fremde Umgebung ein anderes Programm als Agenten unterschieben, AURA-62),
  // 2. mitgeliefert (resources/python), 3. Entwicklung (agent/.venv).
  pythonPath() {
    if (process.env.AURA_AGENT_PYTHON && !this.app.isPackaged) return process.env.AURA_AGENT_PYTHON;
    const win = process.platform === 'win32';
    const bundled = path.join(process.resourcesPath || '', 'python', win ? 'python.exe' : path.join('bin', 'python3'));
    if (this.app.isPackaged && fs.existsSync(bundled)) return bundled;
    const dev = path.join(this.app.getAppPath(), 'agent', '.venv', win ? 'Scripts/python.exe' : 'bin/python');
    if (fs.existsSync(dev)) return dev;
    return null;
  }

  available() {
    return !!this.pythonPath();
  }

  logStream() {
    const dir = path.join(this.app.getPath('userData'), 'agent');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent.log');
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch {}
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
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    this.proc = proc;
    const log = this.logStream();
    this.log = log;
    log.write(`\n--- Start ${new Date().toISOString()} (${python}) ---\n`);
    proc.stderr.pipe(log);
    const peer = new Peer((line) => {
      if (proc.stdin.writable) proc.stdin.write(line);
    });
    this.peer = peer;
    proc.stdout.on('data', (d) => peer.feed(d));
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
    proc.on('error', (err) => this.onExit(proc, null, String(err.message || err)));

    peer.on('host.approve', (req) => this.host.approve(req));
    peer.on('host.screenshot', (req) => this.host.screenshot(req.maxWidth || 1600));
    peer.on('host.ask', (req) => this.host.ask(req));
    peer.on('host.input', (req) => (this.host.input ? this.host.input(req) : { error: 'Eingabe nicht verfügbar' }));
    for (const m of /** @type {const} */ (['scheduleTask', 'listTasks', 'cancelTask', 'loginsFor', 'loginFill'])) {
      peer.on('host.' + m, (req) => {
        const fn = this.host[m];
        return fn ? fn(req) : { error: 'Geplante Aufgaben sind nicht verfügbar.' };
      });
    }
    peer.on('host.takeover', (req) => (this.host.takeover ? this.host.takeover(req) : { decision: 'cancel' }));
    peer.on('host.searchRegistry', (req) =>
      this.host.searchRegistry ? this.host.searchRegistry(req) : { results: [], error: 'Suche nicht verfügbar' }
    );
    peer.on('host.proposeConnector', (req) =>
      this.host.proposeConnector ? this.host.proposeConnector(req) : { decision: 'later' }
    );
    peer.on('host.authHeader', (req) =>
      this.host.authHeader ? this.host.authHeader(req) : { error: 'Anmeldung nicht verfügbar' }
    );
    peer.onNotify('task.text', (p) => this.handler(p.taskId, 'onText', p.delta));
    peer.onNotify('task.step', (p) => this.handler(p.taskId, 'onStep', p));
    peer.onNotify('task.plan', (p) => this.handler(p.taskId, 'onPlan', p.items));
    peer.onNotify('task.done', (p) => this.finish(p.taskId, null, p));
    peer.onNotify('task.error', (p) => this.finish(p.taskId, new Error(p.message), null));
    peer.onNotify('model.status', (p) => this.onModelStatus(p));

    this.ready = peer
      .request(
        'initialize',
        {
          protocol: PROTOCOL_VERSION,
          settings: init
        },
        30000
      )
      .catch((err) => {
        this.stop();
        throw err;
      });
    // After every start: forget chats deleted while the agent was not running, and orphans (AURA-106).
    this.ready.then(() => this.afterStart()).catch(() => {});
    return this.ready;
  }

  /**
   * Any other request to the agent (e.g. memory.list for the Zentrale); starts the agent if needed.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  async call(method, params = {}) {
    await this.ensure();
    if (!this.peer) throw new Error('Agent-Prozess ist nicht verbunden.');
    return this.peer.request(method, params, 15000);
  }

  forgetQueueFile() {
    return path.join(this.app.getPath('userData'), 'agent', 'forget-queue.json');
  }

  /** @returns {string[]} */
  readForgetQueue() {
    try {
      const ids = JSON.parse(fs.readFileSync(this.forgetQueueFile(), 'utf8'));
      return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** @param {string[]} ids */
  writeForgetQueue(ids) {
    const file = this.forgetQueueFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (ids.length) fs.writeFileSync(file, JSON.stringify([...new Set(ids)]));
    else fs.rmSync(file, { force: true });
  }

  /**
   * Deletes the agent's copy of a chat (session and episodes). Without a running agent the ID is queued and sent
   * at the next start, so deleting never has to start the agent.
   * @param {string} chatId
   */
  async forgetChat(chatId) {
    if (!this.peer || !this.ready) {
      this.writeForgetQueue([...this.readForgetQueue(), chatId]);
      return { queued: true };
    }
    try {
      await this.ready;
      return await this.peer.request('chat.forget', { chatId }, 10000);
    } catch {
      this.writeForgetQueue([...this.readForgetQueue(), chatId]);
      return { queued: true };
    }
  }

  async afterStart() {
    const peer = this.peer;
    if (!peer) return;
    const queued = this.readForgetQueue();
    const failed = [];
    for (const chatId of queued) {
      try {
        await peer.request('chat.forget', { chatId }, 10000);
      } catch {
        failed.push(chatId);
      }
    }
    if (queued.length) this.writeForgetQueue(failed);
    if (this.chatIds) {
      try {
        await peer.request('chat.retain', { chatIds: this.chatIds() }, 30000);
      } catch {}
    }
  }

  /**
   * @param {string} taskId
   * @param {string} name
   * @param {unknown} arg
   */
  handler(taskId, name, arg) {
    const fn = this.tasks.get(taskId)?.handlers[name];
    if (fn) fn(arg);
  }

  /**
   * @param {string} taskId
   * @param {Error | null} err
   * @param {unknown} result
   */
  finish(taskId, err, result) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    this.tasks.delete(taskId);
    if (err) t.reject(err);
    else t.resolve(result);
  }

  /**
   * Ein Auftrag; löst mit {text, cancelled, steps, usage} auf, wenn der Agent fertig ist.
   * @param {{ taskId: string, chatId?: string, text: string, images?: unknown[], incognito?: boolean }} task
   * @param {TaskHandlers} [handlers]
   */
  async runTask({ taskId, chatId, text, images, incognito }, handlers = {}) {
    await this.ensure();
    const peer = this.peer;
    if (!peer) throw new Error('Agent-Prozess ist nicht verbunden.');
    const done = new Promise((resolve, reject) =>
      this.tasks.set(taskId, { handlers: /** @type {RunningTask['handlers']} */ (handlers), resolve, reject })
    );
    try {
      await peer.request(
        'task.start',
        { taskId, chatId, text, images: images || [], ...(incognito ? { incognito: true } : {}) },
        10000
      );
    } catch (err) {
      this.tasks.delete(taskId);
      throw err;
    }
    return done;
  }

  // Not-Aus für einen Auftrag. Antwortet der Agent nicht rechtzeitig, wird der Prozess hart beendet.
  /** @param {string} taskId */
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

  /** @param {string} reason */
  kill(reason) {
    if (this.proc && this.proc.exitCode === null) {
      // Windows: ganzen Prozessbaum beenden (laufende PowerShell-Befehle des Agenten eingeschlossen).
      if (process.platform === 'win32') {
        try {
          execFile('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], { windowsHide: true }, () => {});
        } catch {}
      } else if (this.proc.pid) {
        try {
          process.kill(-this.proc.pid, 'SIGKILL');
        } catch {}
      }
      try {
        this.proc.kill('SIGKILL');
      } catch {}
    }
    this.onExit(this.proc, null, reason);
  }

  /**
   * @param {import('child_process').ChildProcess | null} proc
   * @param {number | null} code
   * @param {string | null} signal
   */
  onExit(proc, code, signal) {
    if (proc !== this.proc) return;
    const reason = `Agent-Prozess beendet (${signal || 'Code ' + code})`;
    if (this.peer) this.peer.close(reason);
    if (this.log) {
      try {
        this.log.end();
      } catch {}
      this.log = null;
    }
    for (const id of [...this.tasks.keys()]) this.finish(id, new Error(reason), null);
    this.proc = null;
    this.peer = null;
    this.ready = null;
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    try {
      this.peer?.notify('shutdown');
    } catch {}
    try {
      proc.stdin.end();
    } catch {}
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        if (process.platform !== 'win32' && proc.pid) {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {}
        }
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }, 1500);
    timer.unref?.();
    this.onExit(proc, null, 'beendet');
  }
}

module.exports = { AgentBridge, defaultAuraDir: () => path.join(os.homedir(), '.aura') };
