// Tests für die Brücke zum neuen Agenten (src/agent2). Aufruf: npm test
// Der Ende-zu-Ende-Test startet den echten Python-Agenten (agent/.venv) mit einem Drehbuch-Modell.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Peer } = require('../src/agent2/rpc');
const { AgentBridge } = require('../src/agent2/bridge');

const ROOT = path.join(__dirname, '..');
const VENV_PY = path.join(ROOT, 'agent', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
// AURA_AGENT_PYTHON: z. B. das Python eines installierten Aura (CI prüft so den Windows-Installer).
const HAS_PYTHON =
  fs.existsSync(VENV_PY) || (process.env.AURA_AGENT_PYTHON && fs.existsSync(process.env.AURA_AGENT_PYTHON));

function pair() {
  const a = new Peer((line) => setImmediate(() => b.feed(line)));
  const b = new Peer((line) => setImmediate(() => a.feed(line)));
  return [a, b];
}

test('rpc: Anfragen in beide Richtungen, Fehler und Benachrichtigungen', async () => {
  const [a, b] = pair();
  b.on('work', async (p) => ({ decision: await b.request('host.approve', { tool: p.tool }) }));
  a.on('host.approve', async (p) => (p.tool === 'ls' ? 'once' : 'deny'));
  const seen = [];
  a.onNotify('task.text', (p) => seen.push(p.delta));
  assert.deepStrictEqual(await a.request('work', { tool: 'ls' }), { decision: 'once' });
  assert.deepStrictEqual(await a.request('work', { tool: 'rm' }), { decision: 'deny' });
  await assert.rejects(a.request('gibtsnicht'), (e) => e.code === -32601);
  b.notify('task.text', { delta: 'hi' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(seen, ['hi']);
});

test('rpc: geschlossene Verbindung beendet offene Anfragen', async () => {
  const p = new Peer(() => {});
  const pending = p.request('host.screenshot');
  p.close('weg');
  await assert.rejects(pending, /weg/);
});

test('rpc: Zeilen dürfen zerstückelt ankommen', async () => {
  const got = [];
  const p = new Peer(() => {});
  p.onNotify('x', (params) => got.push(params.n));
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { n: 1 } }) + '\n';
  p.feed(line.slice(0, 7));
  p.feed(line.slice(7) + line);
  assert.deepStrictEqual(got, [1, 1]);
});

test(
  'bridge: echter Python-Agent mit Drehbuch – lesen, fragen, ablehnen',
  { skip: !HAS_PYTHON && 'agent/.venv fehlt (cd agent && uv sync)' },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-bridge-'));
    const victim = path.join(tmp, 'bleibt.txt');
    fs.writeFileSync(victim, 'x');
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(
      script,
      JSON.stringify([
        [{ name: 'list_dir', args: { path: tmp } }],
        [{ name: 'run_command', args: { command: `rm ${victim}` } }],
        'Ordner gelesen, Löschen wurde abgelehnt.'
      ])
    );
    process.env.AURA_AGENT_TEST_SCRIPT = script;
    const approvals = [];
    const bridge = new AgentBridge({
      app: { isPackaged: false, getAppPath: () => ROOT, getPath: () => tmp },
      settings: () => ({ model: 'scripted', dataDir: path.join(tmp, 'agent'), auraDir: path.join(tmp, 'aura') }),
      host: {
        approve: async (req) => {
          approvals.push(req);
          return { decision: 'deny' };
        },
        screenshot: async () => ({ mime: 'image/jpeg', data: '' })
      }
    });
    const steps = [];
    let text = '';
    try {
      const done = await bridge.runTask(
        { taskId: 't1', chatId: 'c1', text: 'lösch bleibt.txt' },
        {
          onText: (d) => {
            text += d;
          },
          onStep: (s) => steps.push(`${s.tool}:${s.state}`)
        }
      );
      assert.strictEqual(done.text, 'Ordner gelesen, Löschen wurde abgelehnt.');
      assert.strictEqual(text, done.text);
      assert.deepStrictEqual(steps, ['list_dir:run', 'list_dir:ok', 'run_command:ask', 'run_command:denied']);
      assert.strictEqual(approvals.length, 1);
      assert.strictEqual(approvals[0].tool, 'run_command');
      assert.ok(fs.existsSync(victim), 'Datei darf nicht gelöscht sein');
    } finally {
      bridge.stop();
      delete process.env.AURA_AGENT_TEST_SCRIPT;
    }
  }
);

test(
  'bridge: deleted chats are forgotten by the agent, queued while it is not running (AURA-106)',
  { skip: !HAS_PYTHON && 'agent/.venv fehlt (cd agent && uv sync)' },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-forget-'));
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, JSON.stringify(['erledigt', 'erledigt', 'erledigt']));
    process.env.AURA_AGENT_TEST_SCRIPT = script;
    const dataDir = path.join(tmp, 'agent');
    const make = (chatIds) =>
      new AgentBridge({
        app: { isPackaged: false, getAppPath: () => ROOT, getPath: () => tmp },
        settings: () => ({ model: 'scripted', dataDir, auraDir: path.join(tmp, 'aura') }),
        host: {
          approve: async () => ({ decision: 'deny' }),
          screenshot: async () => ({ mime: 'image/jpeg', data: '' })
        },
        chatIds
      });
    const sessionCount = async (bridge, chatId) => {
      // ask the agent itself: retain with every known id but this one would remove it; count via forget instead
      const r = await bridge.peer.request('chat.forget', { chatId });
      return r.sessions;
    };
    let bridge = make(() => ['kept', 'gone', 'queued']);
    try {
      await bridge.runTask({ taskId: 't1', chatId: 'gone', text: 'eins' });
      await bridge.runTask({ taskId: 't2', chatId: 'queued', text: 'zwei' });
      await bridge.runTask({ taskId: 't3', chatId: 'orphan', text: 'drei' });
      // While running: forget goes straight to the agent.
      const gone = await bridge.forgetChat('gone');
      assert.strictEqual(gone.sessions, 1);
      assert.ok(gone.episodes > 0, 'request and answer were searchable episodes');
      bridge.stop();
      // Agent stopped: the deletion is queued instead of starting the agent.
      assert.deepStrictEqual(await bridge.forgetChat('queued'), { queued: true });
      assert.deepStrictEqual(bridge.readForgetQueue(), ['queued']);
      // Next start: the queue is sent and orphans (not in chatIds, here "orphan") are forgotten.
      bridge = make(() => ['kept', 'queued']);
      await bridge.runTask({ taskId: 't4', chatId: 'kept', text: 'vier' });
      for (let i = 0; i < 50 && bridge.readForgetQueue().length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepStrictEqual(bridge.readForgetQueue(), []);
      await new Promise((r) => setTimeout(r, 300)); // chat.retain runs after the queue
      assert.strictEqual(await sessionCount(bridge, 'queued'), 0);
      assert.strictEqual(await sessionCount(bridge, 'orphan'), 0);
      assert.strictEqual(await sessionCount(bridge, 'kept'), 1);
    } finally {
      bridge.stop();
      delete process.env.AURA_AGENT_TEST_SCRIPT;
    }
  }
);
