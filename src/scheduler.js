// @ts-check
// Background and scheduled tasks (AURA-120/121, FR-PAR-020): Aura runs a task at a time, daily/weekly or every N
// minutes, as long as the app runs (also in the tray). Nothing runs while the computer is off or asleep; a run that
// was missed is caught up once after waking, never in a batch (NFR-PAR-003).
//
// Store: userData/agent/tasks.json (written atomically). The runner calls back into main.js to start a headless
// agent task; approvals in background runs are handled there (AURA-122).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_INTERVAL_MIN = 15;
const MAX_TASKS = 50;
const MAX_PARALLEL = 3;

/**
 * @typedef {{ kind: 'once', at: string } | { kind: 'daily', time: string, days?: number[] } |
 *   { kind: 'interval', minutes: number }} Trigger
 * days: 1 = Monday … 7 = Sunday (ISO); empty or missing = every day.
 * @typedef {{ id: string, title: string, prompt: string, trigger: Trigger, created: number, enabled: boolean,
 *   nextRun: number | null, lastRun?: number, lastStatus?: string, lastText?: string, chatId: string }} Task
 */

/**
 * Checks and normalises a trigger from the agent or the Zentrale; throws with a German message.
 * @param {any} t
 * @param {number} now
 * @returns {Trigger}
 */
function validTrigger(t, now) {
  if (!t || typeof t !== 'object') throw new Error('Kein Zeitpunkt angegeben.');
  if (t.kind === 'once') {
    const at = Date.parse(String(t.at || ''));
    if (!Number.isFinite(at)) throw new Error('Zeitpunkt nicht lesbar (erwartet z. B. 2026-10-14T09:00).');
    if (at < now - 60_000) throw new Error('Der Zeitpunkt liegt in der Vergangenheit.');
    return { kind: 'once', at: new Date(at).toISOString() };
  }
  if (t.kind === 'daily') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t.time || ''));
    if (!m) throw new Error('Uhrzeit nicht lesbar (erwartet z. B. 09:00).');
    const days = Array.isArray(t.days)
      ? [...new Set(t.days.map(Number).filter((/** @type {number} */ d) => d >= 1 && d <= 7))].sort()
      : [];
    return { kind: 'daily', time: `${m[1].padStart(2, '0')}:${m[2]}`, ...(days.length ? { days } : {}) };
  }
  if (t.kind === 'interval') {
    const minutes = Math.round(Number(t.minutes));
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MIN)
      throw new Error(`Höchstens alle ${MIN_INTERVAL_MIN} Minuten.`);
    return { kind: 'interval', minutes: Math.min(minutes, 7 * 24 * 60) };
  }
  throw new Error('Unbekannte Art von Zeitplan (once, daily oder interval).');
}

/**
 * Next run after `from` (ms), local time. null = never again.
 * @param {Trigger} t
 * @param {number} from
 */
function nextRun(t, from) {
  if (t.kind === 'once') {
    const at = Date.parse(t.at);
    return at > from ? at : null;
  }
  if (t.kind === 'interval') return from + t.minutes * 60_000;
  const [h, min] = t.time.split(':').map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(h, min);
  for (let i = 0; i < 8; i++) {
    const iso = ((d.getDay() + 6) % 7) + 1; // Monday = 1
    if (d.getTime() > from && (!t.days || t.days.includes(iso))) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, min);
  }
  return null;
}

/** Plain German description, for the approval card and the Zentrale. @param {Trigger} t */
function describe(t) {
  const DAYS = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  if (t.kind === 'once')
    return 'einmal am ' + new Date(t.at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  if (t.kind === 'interval')
    return t.minutes % 60 === 0 ? `alle ${t.minutes / 60} Stunde(n)` : `alle ${t.minutes} Minuten`;
  const days = t.days && t.days.length < 7 ? ' (' + t.days.map((d) => DAYS[d]).join(', ') + ')' : '';
  return `täglich um ${t.time} Uhr${days}`;
}

/**
 * @param {{ file: string, now?: () => number, run: (task: Task) => Promise<{ text?: string, status?: string }> }} deps
 */
function createScheduler(deps) {
  const now = deps.now || Date.now;
  /** @type {Task[]} */
  let tasks = load();
  const running = new Set();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(deps.file, 'utf8'));
      return Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      return [];
    }
  }
  function save() {
    fs.mkdirSync(path.dirname(deps.file), { recursive: true });
    const tmp = deps.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 2));
    fs.renameSync(tmp, deps.file);
  }

  /** @param {{ title?: string, prompt?: string, trigger?: any }} p */
  function add(p) {
    const title = String(p.title || '')
      .trim()
      .slice(0, 120);
    const prompt = String(p.prompt || '')
      .trim()
      .slice(0, 2000);
    if (!title || !prompt) throw new Error('Titel und Auftrag sind nötig.');
    if (tasks.length >= MAX_TASKS) throw new Error(`Höchstens ${MAX_TASKS} geplante Aufgaben.`);
    const trigger = validTrigger(p.trigger, now());
    const id = 'bg' + crypto.randomBytes(5).toString('hex');
    /** @type {Task} */
    const task = {
      id,
      title,
      prompt,
      trigger,
      created: now(),
      enabled: true,
      nextRun: nextRun(trigger, now()),
      chatId: 'bg-' + id
    };
    tasks.push(task);
    save();
    return task;
  }

  /** @param {string} id */
  function remove(id) {
    const before = tasks.length;
    tasks = tasks.filter((t) => t.id !== id);
    if (tasks.length !== before) save();
    return tasks.length !== before;
  }

  /** @param {string} id @param {boolean} enabled */
  function setEnabled(id, enabled) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return false;
    t.enabled = !!enabled;
    t.nextRun = enabled ? nextRun(t.trigger, now()) : null;
    save();
    return true;
  }

  /**
   * Starts due tasks. A run missed while the computer slept is caught up once; the next run is computed from now.
   * @returns {Promise<void>[]}
   */
  function tick() {
    const t0 = now();
    const due = tasks.filter((t) => t.enabled && t.nextRun !== null && t.nextRun <= t0 && !running.has(t.id));
    const started = [];
    for (const t of due) {
      if (running.size >= MAX_PARALLEL) break;
      running.add(t.id);
      t.nextRun = nextRun(t.trigger, t0);
      if (t.trigger.kind === 'once') t.enabled = false;
      save();
      started.push(
        deps
          .run(t)
          .then((r) => {
            t.lastStatus = (r && r.status) || 'ok';
            t.lastText = String((r && r.text) || '').slice(0, 500);
          })
          .catch((err) => {
            t.lastStatus = 'error';
            t.lastText = String(err && err.message ? err.message : err).slice(0, 500);
          })
          .finally(() => {
            t.lastRun = now();
            running.delete(t.id);
            save();
          })
      );
    }
    return started;
  }

  return {
    add,
    remove,
    setEnabled,
    tick,
    list: () => tasks.map((t) => ({ ...t, when: describe(t.trigger), running: running.has(t.id) })),
    start(intervalMs = 30_000) {
      if (!timer) timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { createScheduler, validTrigger, nextRun, describe, MIN_INTERVAL_MIN, MAX_PARALLEL };
