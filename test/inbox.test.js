// Approvals of background runs (src/inbox.js, AURA-122).
const test = require('node:test');
const assert = require('node:assert');
const { createInbox } = require('../src/inbox');

function setup() {
  const timers = [];
  const notified = [];
  const changes = [];
  const inbox = createInbox({
    timeoutMs: 1000,
    notify: (e) => notified.push(e),
    changed: (l) => changes.push(l.length),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => (t.cleared = true)
  });
  return { inbox, timers, notified, changes };
}

const req = {
  stepId: 's1',
  taskId: 'bg-bgabc-1',
  tool: 'run_command',
  label: 'rm alt.zip',
  effect: 'rm alt.zip',
  tier: 2
};

test('an approval waits, notifies once and is answered exactly once', () => {
  const { inbox, notified, changes, timers } = setup();
  const answers = [];
  const decide = inbox.add(req, 'Aufräumen', (ok) => answers.push(ok));
  assert.strictEqual(inbox.list().length, 1);
  assert.strictEqual(inbox.list()[0].detail, '', 'effect equal to the label is not repeated');
  assert.strictEqual(inbox.forTask('bg-bgabc-').length, 1);
  assert.strictEqual(notified[0].title, 'Aufräumen');
  decide('session');
  decide(false);
  assert.deepStrictEqual(answers, ['session']);
  assert.strictEqual(inbox.list().length, 0);
  assert.deepStrictEqual(changes, [1, 0]);
  assert.ok(timers[0].cleared);
});

test('without an answer the timeout denies', () => {
  const { inbox, timers } = setup();
  const answers = [];
  inbox.add(req, 'Aufräumen', (ok) => answers.push(ok));
  assert.strictEqual(timers[0].ms, 1000);
  timers[0].fn();
  assert.deepStrictEqual(answers, [false]);
  assert.strictEqual(inbox.list().length, 0);
});
