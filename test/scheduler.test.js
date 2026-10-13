// Background and scheduled tasks (src/scheduler.js, AURA-121) with a fake clock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createScheduler, validTrigger, nextRun, describe } = require('../src/scheduler');

const at = (s) => new Date(s).getTime(); // local time

test('daily triggers: next matching day and time, weekdays respected', () => {
  const t = validTrigger({ kind: 'daily', time: '9:00', days: [1, 2, 3, 4, 5] }, 0);
  assert.deepStrictEqual(t, { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] });
  // Tuesday 2026-10-13 10:00 → Wednesday 09:00
  assert.strictEqual(nextRun(t, at('2026-10-13T10:00')), at('2026-10-14T09:00'));
  // Friday 2026-10-16 10:00 → Monday 2026-10-19 09:00 (weekend skipped)
  assert.strictEqual(nextRun(t, at('2026-10-16T10:00')), at('2026-10-19T09:00'));
  assert.strictEqual(nextRun({ kind: 'daily', time: '09:00' }, at('2026-10-13T08:00')), at('2026-10-13T09:00'));
  assert.match(describe(t), /täglich um 09:00 Uhr \(Mo, Di, Mi, Do, Fr\)/);
});

test('invalid triggers are refused with a clear message', () => {
  const now = at('2026-10-13T10:00');
  assert.throws(() => validTrigger({ kind: 'interval', minutes: 1 }, now), /15 Minuten/);
  assert.throws(() => validTrigger({ kind: 'once', at: '2020-01-01T00:00' }, now), /Vergangenheit/);
  assert.throws(() => validTrigger({ kind: 'daily', time: '25:00' }, now), /Uhrzeit/);
  assert.throws(() => validTrigger({ kind: 'cron', expr: '* * * * *' }, now), /Unbekannte/);
});

function scheduler(clock, run) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aura-sched-')), 'tasks.json');
  return { s: createScheduler({ file, now: () => clock.t, run }), file };
}

test('a due task runs once; a once-task disables itself; results are kept', async () => {
  const clock = { t: at('2026-10-13T08:59') };
  const runs = [];
  const { s, file } = scheduler(clock, async (task) => {
    runs.push(task.id);
    return { text: 'Erinnerung: Müll rausbringen' };
  });
  const task = s.add({
    title: 'Müll',
    prompt: 'Erinnere mich an den Müll',
    trigger: { kind: 'once', at: '2026-10-13T09:00' }
  });
  assert.strictEqual(s.tick().length, 0, 'not yet due');
  clock.t = at('2026-10-13T09:00:10');
  await Promise.all(s.tick());
  assert.deepStrictEqual(runs, [task.id]);
  assert.strictEqual(s.tick().length, 0, 'once only');
  const [t] = s.list();
  assert.strictEqual(t.enabled, false);
  assert.strictEqual(t.lastText, 'Erinnerung: Müll rausbringen');
  // Stored on disk and loaded again.
  assert.strictEqual(createScheduler({ file, now: () => clock.t, run: async () => ({}) }).list()[0].id, task.id);
});

test('after sleep a missed recurring run is caught up once, not in a batch', async () => {
  const clock = { t: at('2026-10-13T08:00') };
  let n = 0;
  const { s } = scheduler(clock, async () => {
    n++;
    return {};
  });
  s.add({ title: 'Briefing', prompt: 'Tagesbriefing', trigger: { kind: 'daily', time: '09:00' } });
  clock.t = at('2026-10-16T12:00'); // computer slept for three days
  await Promise.all(s.tick());
  await Promise.all(s.tick());
  assert.strictEqual(n, 1);
  assert.strictEqual(s.list()[0].nextRun, at('2026-10-17T09:00'));
});

test('at most three run in parallel; errors are recorded', async () => {
  const clock = { t: at('2026-10-13T08:00') };
  const release = [];
  let hold = true;
  const { s } = scheduler(clock, (task) =>
    task.title === 'kaputt'
      ? Promise.reject(new Error('Agent nicht verfügbar'))
      : hold
        ? new Promise((r) => release.push(r))
        : Promise.resolve({})
  );
  for (let i = 0; i < 4; i++) s.add({ title: 't' + i, prompt: 'x', trigger: { kind: 'interval', minutes: 15 } });
  clock.t += 16 * 60_000;
  const started = s.tick();
  assert.strictEqual(started.length, 3);
  assert.strictEqual(s.list().filter((t) => t.running).length, 3);
  release.forEach((r) => r({}));
  await Promise.all(started);
  hold = false;
  for (const t of s.list()) s.remove(t.id);
  const broken = s.add({ title: 'kaputt', prompt: 'x', trigger: { kind: 'interval', minutes: 15 } });
  clock.t += 16 * 60_000;
  await Promise.all(s.tick());
  const b = s.list().find((t) => t.id === broken.id);
  assert.strictEqual(b.lastStatus, 'error');
  assert.match(b.lastText, /nicht verfügbar/);
  assert.ok(s.remove(broken.id));
  assert.ok(!s.remove(broken.id));
});

test('watch tasks: prompt carries the last result; "NICHTS NEUES" keeps the last real result', async () => {
  const { runPrompt, isNothingNew } = require('../src/scheduler');
  const clock = { t: at('2026-10-13T08:00') };
  const answers = ['AURA-131 ist neu: Login-Fehler', 'NICHTS NEUES', '**NICHTS NEUES**'];
  const prompts = [];
  const { s } = scheduler(clock, async (task) => {
    prompts.push(runPrompt(task));
    return { text: answers.shift() };
  });
  s.add({
    title: 'Jira',
    prompt: 'Gibt es neue Jira-Tickets?',
    trigger: { kind: 'interval', minutes: 30 },
    onlyIfNew: true
  });
  for (let i = 0; i < 3; i++) {
    clock.t += 31 * 60_000;
    await Promise.all(s.tick());
  }
  assert.match(prompts[0], /antworte genau „NICHTS NEUES“/);
  assert.doesNotMatch(prompts[0], /Letztes Ergebnis/);
  assert.match(prompts[1], /Letztes Ergebnis: AURA-131 ist neu/);
  assert.match(prompts[2], /Letztes Ergebnis: AURA-131 ist neu/, 'a quiet run does not replace the last result');
  assert.strictEqual(s.list()[0].lastText, 'AURA-131 ist neu: Login-Fehler');
  assert.ok(isNothingNew(' **NICHTS NEUES**'));
  assert.ok(!isNothingNew('Es gibt nichts Neues, aber …'));
  // Normal tasks get their prompt unchanged.
  assert.strictEqual(runPrompt({ prompt: 'x' }), 'x');
});
