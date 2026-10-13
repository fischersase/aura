// Tests für die Zentrale-Seiten von Agent v2 (ohne Electron).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-z2-'));
process.env.AURA_TEST_USERDATA = tmp;
const z2 = require('../src/agent2/zentrale-v2');

test('Regelprüfung erkennt fehlende und falsche Angaben', () => {
  assert.deepStrictEqual(z2.checkPolicy('[[rule]]\ntool = "run_command"\ndecision = "allow"\n'), []);
  assert.deepStrictEqual(z2.checkPolicy('# nur Kommentar\n'), []);
  assert.deepStrictEqual(z2.checkPolicy('[[rule]]\ndecision = "allow"\n'), ['Regel 1: tool fehlt']);
  assert.deepStrictEqual(z2.checkPolicy('[[rule]]\ntool = "x"\ndecision = "maybe"\n'), [
    'Regel 1: decision muss allow, ask oder deny sein'
  ]);
});

test('Protokoll liest Audit-Ereignisse lesbar, neueste zuerst', () => {
  const dir = path.join(tmp, 'agent', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { ts: '2026-10-12T01:00:00Z', kind: 'task_start', task: 't', text: 'Pausiere die Musik' },
    { ts: '2026-10-12T01:00:01Z', kind: 'tool_start', tool: 'media_control' },
    { ts: '2026-10-12T01:00:02Z', kind: 'tool_result', tool: 'media_control', ok: true, verified: true },
    { ts: '2026-10-12T01:00:03Z', kind: 'approval', tool: 'trash', decision: 'deny' },
    { ts: '2026-10-12T01:00:04Z', kind: 'task_end', ok: true, steps: 2, ms: 2500 }
  ];
  fs.writeFileSync(path.join(dir, '2026-10.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const rows = z2.audit();
  assert.deepStrictEqual(
    rows.map((r) => r.kind),
    ['Fertig', 'Freigabe', 'Ergebnis', 'Auftrag']
  );
  assert.strictEqual(rows[0].result, 'ok, 2 Schritte, 2.5 s');
  assert.strictEqual(rows[1].bad, true);
  assert.strictEqual(rows[3].detail, 'Pausiere die Musik');
});

test('Systemprüfung meldet nicht erreichbares Ollama mit Hinweis', async () => {
  const checks = await z2.doctor({
    settings: () => ({ ollamaUrl: 'http://127.0.0.1:9', model: 'gemma4:26b', numCtx: 16384 }),
    bridge: { pythonPath: () => null }
  });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.strictEqual(by.Ollama.state, 'bad');
  assert.match(by.Ollama.fix, /Ollama starten/);
  assert.strictEqual(by['Agent v2'].state, 'bad');
  assert.strictEqual(by['Kontextlänge'].state, 'warn');
});
