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
const VENV_PY = path.join(ROOT, 'agent', '.venv', 'bin', 'python');

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

test('bridge: echter Python-Agent mit Drehbuch – lesen, fragen, ablehnen', { skip: !fs.existsSync(VENV_PY) && 'agent/.venv fehlt (cd agent && uv sync)' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-bridge-'));
  const victim = path.join(tmp, 'bleibt.txt');
  fs.writeFileSync(victim, 'x');
  const script = path.join(tmp, 'script.json');
  fs.writeFileSync(script, JSON.stringify([
    [{ name: 'list_dir', args: { path: tmp } }],
    [{ name: 'run_command', args: { command: `rm ${victim}` } }],
    'Ordner gelesen, Löschen wurde abgelehnt.'
  ]));
  process.env.AURA_AGENT_TEST_SCRIPT = script;
  const approvals = [];
  const bridge = new AgentBridge({
    app: { isPackaged: false, getAppPath: () => ROOT, getPath: () => tmp },
    settings: () => ({ model: 'scripted', dataDir: path.join(tmp, 'agent'), auraDir: path.join(tmp, 'aura') }),
    host: {
      approve: async (req) => { approvals.push(req); return { decision: 'deny' }; },
      screenshot: async () => ({ mime: 'image/jpeg', data: '' })
    }
  });
  const steps = [];
  let text = '';
  try {
    const done = await bridge.runTask({ taskId: 't1', chatId: 'c1', text: 'lösch bleibt.txt' }, {
      onText: (d) => { text += d; },
      onStep: (s) => steps.push(`${s.tool}:${s.state}`)
    });
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
});
