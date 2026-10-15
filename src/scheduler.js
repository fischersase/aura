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
 *   { kind: 'interval', minutes: number } | { kind: 'cron', expr: string }} Trigger
 * days: 1 = Monday … 7 = Sunday (ISO); empty or missing = every day.
 * @typedef {{ id: string, title: string, prompt: string, trigger: Trigger, created: number, enabled: boolean,
 *   nextRun: number | null, lastRun?: number, lastStatus?: string, lastText?: string, chatId: string,
 *   onlyIfNew?: boolean }} Task
 * onlyIfNew (AURA-123): a watch task; the run reports only when something new turned up (else "NICHTS NEUES").
 */

/**
 * Parses a single cron field into a Set of allowed integer values.
 * Supports `*`, `&#42;/step`, `a-b`, `a-b/step`, and comma-separated lists.
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {boolean} [isDow]
 * @returns {Set<number>}
 */
function parseCronField(field, min, max, isDow = false) {
  const out = new Set();
  for (const rawPart of String(field || '').split(',')) {
    const part = rawPart.trim();
    if (!part) throw new Error(`Ungültiges Cron-Feld „${field}“.`);
    const slashParts = part.split('/');
    if (slashParts.length > 2) throw new Error(`Ungültiges Cron-Feld „${field}“.`);
    const base = slashParts[0];
    let step = 1;
    if (slashParts.length === 2) {
      if (!/^[1-9]\d*$/.test(slashParts[1])) throw new Error(`Ungültiger Schrittwert in „${field}“.`);
      step = Number(slashParts[1]);
    }
    let start = min;
    let end = max;
    if (base !== '*') {
      const dashParts = base.split('-');
      if (dashParts.length > 2 || !dashParts.every((d) => /^\d+$/.test(d))) {
        throw new Error(`Ungültiges Cron-Feld „${field}“.`);
      }
      start = Number(dashParts[0]);
      end = dashParts.length === 2 ? Number(dashParts[1]) : start;
      if (isDow) {
        if (start === 7) start = 0;
        if (end === 7 && dashParts.length === 1) end = 0;
      }
      if (start < min || end > (isDow ? 7 : max) || start > end) {
        throw new Error(`Cron-Wert außerhalb des Bereichs (${min}–${max}): „${field}“.`);
      }
    }
    for (let v = start; v <= end; v += step) {
      out.add(isDow && v === 7 ? 0 : v);
    }
  }
  if (!out.size) throw new Error(`Leeres Cron-Feld „${field}“.`);
  return out;
}

/**
 * Parses a 5-field cron expression (minute hour dom month dow).
 * @param {string} expr
 */
function parseCron(expr) {
  const parts = String(expr || '')
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron-Ausdruck braucht genau 5 Felder: Minute Stunde Tag Monat Wochentag (z. B. 0 8 * * 1-5).');
  }
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 6, true);
  // Prevent every-minute spam (< 15 min average when all hours/days match)
  if (minutes.size > 4 && hours.size === 24 && doms.size === 31 && months.size === 12 && dows.size === 7) {
    const sorted = [...minutes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] < MIN_INTERVAL_MIN) {
        throw new Error(`Cronjob darf höchstens alle ${MIN_INTERVAL_MIN} Minuten laufen.`);
      }
    }
  }
  return {
    minutes,
    hours,
    doms,
    months,
    dows,
    domWild: parts[2] === '*',
    dowWild: parts[4] === '*',
    normalized: parts.join(' ')
  };
}

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
  if (t.kind === 'cron') {
    const parsed = parseCron(String(t.expr || ''));
    return { kind: 'cron', expr: parsed.normalized };
  }
  throw new Error('Unbekannte Art von Zeitplan (once, daily, interval oder cron).');
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
  if (t.kind === 'cron') {
    const c = parseCron(t.expr);
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    // Search up to 366 days ahead in minute/hour steps
    const limit = from + 366 * 24 * 60 * 60_000;
    while (d.getTime() <= limit) {
      if (!c.months.has(d.getMonth() + 1)) {
        d.setMonth(d.getMonth() + 1, 1);
        d.setHours(0, 0, 0, 0);
        continue;
      }
      const domMatch = c.doms.has(d.getDate());
      const dowMatch = c.dows.has(d.getDay());
      const dayOk = c.domWild && c.dowWild ? true : c.domWild ? dowMatch : c.dowWild ? domMatch : domMatch || dowMatch;
      if (!dayOk) {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        continue;
      }
      if (!c.hours.has(d.getHours())) {
        d.setHours(d.getHours() + 1, 0, 0, 0);
        continue;
      }
      if (!c.minutes.has(d.getMinutes())) {
        d.setMinutes(d.getMinutes() + 1, 0, 0);
        continue;
      }
      return d.getTime();
    }
    return null;
  }
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
  if (t.kind === 'cron') return `Cron: ${t.expr}`;
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

  /** @param {{ title?: string, prompt?: string, trigger?: any, onlyIfNew?: boolean }} p */
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
      chatId: 'bg-' + id,
      ...(p.onlyIfNew ? { onlyIfNew: true } : {})
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

  /** @param {Task} t */
  function executeTask(t) {
    running.add(t.id);
    save();
    return deps
      .run(t)
      .then((r) => {
        t.lastStatus = (r && r.status) || 'ok';
        // A watch run with nothing new keeps the last real result for the next comparison.
        const text = String((r && r.text) || '').slice(0, 500);
        if (!(t.onlyIfNew && isNothingNew(text))) t.lastText = text;
      })
      .catch((err) => {
        t.lastStatus = 'error';
        t.lastText = String(err && err.message ? err.message : err).slice(0, 500);
      })
      .finally(() => {
        t.lastRun = now();
        running.delete(t.id);
        save();
      });
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
      t.nextRun = nextRun(t.trigger, t0);
      if (t.trigger.kind === 'once') t.enabled = false;
      started.push(executeTask(t));
    }
    return started;
  }

  /**
   * Immediately starts a scheduled task by ID (e.g. "Jetzt starten" in Zentrale).
   * @param {string} id
   */
  function runNow(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t || running.has(t.id)) return false;
    executeTask(t);
    return true;
  }

  return {
    add,
    remove,
    setEnabled,
    tick,
    runNow,
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

// Watch tasks answer exactly this when nothing new turned up; the run then stays silent.
const NOTHING_NEW = 'NICHTS NEUES';
const isNothingNew = (/** @type {string} */ text) => /^\s*\**\s*NICHTS NEUES\b/i.test(String(text || ''));

/**
 * The prompt a run gets: for watch tasks with the previous result, so the agent can tell what is new.
 * @param {Task} t
 */
function runPrompt(t) {
  if (!t.onlyIfNew) return t.prompt;
  return (
    `${t.prompt}\n\n[Prüfauftrag: Melde nur, was seit der letzten Prüfung neu ist. Ist nichts Neues dabei, ` +
    `antworte genau „${NOTHING_NEW}“ und sonst nichts.` +
    (t.lastText && !isNothingNew(t.lastText) ? ` Letztes Ergebnis: ${t.lastText}` : '') +
    ']'
  );
}

module.exports = {
  createScheduler,
  validTrigger,
  nextRun,
  describe,
  runPrompt,
  isNothingNew,
  NOTHING_NEW,
  MIN_INTERVAL_MIN,
  MAX_PARALLEL
};
