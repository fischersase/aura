// IPC sender validation (src/security.js, AURA-18): each channel only from the windows that need it, and each window's
// preload exposes only what that window uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const sec = require('../src/security');

const SRC = path.join(__dirname, '..', 'src');
const DIR = path.join(path.sep === '\\' ? 'C:\\Program Files\\Aura' : '/opt/Aura', 'resources', 'app.asar', 'src', 'renderer');
const page = (name) => pathToFileURL(path.join(DIR, name)).href;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// Which preload each page gets (src/main.js, src/zentrale.js).
const PRELOADS = {
  'preload.js': ['panel.html', 'setup.html', 'settings.html'],
  'preload-overlay.js': ['overlay.html'],
  'preload-rambler.js': ['rambler.html'],
  'preload-stt.js': ['stt.html'],
  'preload-zentrale.js': ['zentrale.html']
};

// Minimal ipcMain double: on/once/removeListener from EventEmitter, handle → a map for invoke().
function fakeIpc() {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (channel, fn) => handlers.set(channel, fn);
  ipc.invoke = (channel, event, ...args) => handlers.get(channel)(event, ...args);
  return ipc;
}
const from = (name, extra = {}) => ({ senderFrame: { url: page(name), parent: null, ...extra } });

test('sensitive channels only from their windows', () => {
  assert.strictEqual(sec.ipcAllowed(page('zentrale.html'), 'z:saveServer', DIR), true);
  assert.strictEqual(sec.ipcAllowed(page('zentrale.html'), 'z:setSecret', DIR), true);
  for (const p of ['panel.html', 'overlay.html', 'rambler.html', 'stt.html', 'setup.html', 'settings.html']) {
    assert.strictEqual(sec.ipcAllowed(page(p), 'z:saveServer', DIR), false, p);
    assert.strictEqual(sec.ipcAllowed(page(p), 'z:setSecret', DIR), false, p);
  }
  for (const p of ['overlay.html', 'rambler.html', 'stt.html', 'zentrale.html']) {
    for (const ch of ['settings:save', 'settings:get', 'chat:send', 'agent:approval', 'open:external', 'live:config']) {
      assert.strictEqual(sec.ipcAllowed(page(p), ch, DIR), false, `${p} ${ch}`);
    }
  }
  assert.strictEqual(sec.ipcAllowed(page('panel.html'), 'agent:approval', DIR), true);
  assert.strictEqual(sec.ipcAllowed(page('settings.html'), 'agent:approval', DIR), false);
  assert.strictEqual(sec.ipcAllowed(page('panel.html'), 'unknown:channel', DIR), false);
  assert.strictEqual(sec.ipcAllowed(page('zentrale.html'), 'z:', DIR), false);
});

test('foreign pages, subframes and destroyed frames are rejected', () => {
  for (const url of ['https://example.com/panel.html', 'http://127.0.0.1:47800/zentrale.html', 'file:///tmp/zentrale.html', '', undefined]) {
    assert.strictEqual(sec.ipcAllowed(url, 'z:state', DIR), false, String(url));
  }
  assert.strictEqual(sec.senderAllowed(from('panel.html'), 'chat:send', DIR), true);
  assert.strictEqual(sec.senderAllowed(from('panel.html', { parent: {} }), 'chat:send', DIR), false);
  assert.strictEqual(sec.senderAllowed({ senderFrame: null }, 'chat:send', DIR), false);
  assert.strictEqual(sec.senderAllowed({}, 'chat:send', DIR), false);
});

test('guardIpc: handle rejects, on/once drop calls from the wrong window', async () => {
  const ipc = fakeIpc();
  const warnings = [];
  sec.guardIpc(ipc, { rendererDir: DIR, log: (m) => warnings.push(m) });
  ipc.handle('z:state', () => 'state');
  assert.strictEqual(await ipc.invoke('z:state', from('zentrale.html')), 'state');
  assert.throws(() => ipc.invoke('z:state', from('panel.html')), /Not allowed/);

  const calls = [];
  ipc.on('chat:send', (_e, x) => calls.push(x));
  ipc.emit('chat:send', from('overlay.html'), 'bad');
  ipc.emit('chat:send', from('panel.html'), 'good');
  assert.deepStrictEqual(calls, ['good']);

  const ready = [];
  ipc.once('stt:ready', () => ready.push(1));
  ipc.emit('stt:ready', from('panel.html'));
  ipc.emit('stt:ready', from('stt.html'));
  ipc.emit('stt:ready', from('stt.html'));
  assert.deepStrictEqual(ready, [1]);
  assert.strictEqual(warnings.length, 3);

  assert.throws(() => ipc.handle('secret:dump', () => 1), /IPC_ACCESS/);
  assert.throws(() => ipc.on('secret:dump', () => 1), /IPC_ACCESS/);
  assert.strictEqual(sec.guardIpc(ipc), ipc); // idempotent
});

test('every channel registered in src has an IPC_ACCESS entry', () => {
  const registered = new Set();
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    for (const m of read(f).matchAll(/ipcMain\.(?:handle|on|once)\('([^']+)'(?!\s*\+)/g)) registered.add(m[1]);
  }
  assert.ok(registered.size > 40, `only ${registered.size} channels found`);
  for (const ch of registered) assert.ok(sec.IPC_ACCESS[ch], `${ch} has no IPC_ACCESS entry`);
  // src/zentrale.js registers 'z:' + name for its API.
  assert.match(read('zentrale.js'), /ipcMain\.handle\('z:' \+ name/);
  // Entries without a handler are dead permissions.
  for (const ch of Object.keys(sec.IPC_ACCESS)) assert.ok(registered.has(ch), `IPC_ACCESS has unused channel ${ch}`);
});

test('each preload only uses channels its windows may call', () => {
  for (const [preload, pages] of Object.entries(PRELOADS)) {
    const src = read(preload);
    const channels = [...src.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'(?!\s*\+)/g)].map((m) => m[1]);
    // The Zentrale preload builds 'z:' + name from a list of names.
    if (/ipcRenderer\.invoke\('z:' \+ n/.test(src)) channels.push('z:state', 'z:saveServer', 'z:setSecret');
    assert.ok(channels.length > 0, preload);
    for (const ch of channels) {
      assert.ok(pages.some((p) => sec.ipcAllowed(page(p), ch, DIR)), `${preload} uses ${ch}, which none of ${pages} may call`);
    }
  }
});

test('each page finds every api function it uses in its preload', () => {
  for (const [preload, pages] of Object.entries(PRELOADS)) {
    const exposed = new Set([...read(preload).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
    for (const p of pages) {
      const html = read(path.join('renderer', p));
      const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s !== 'web-shim.js');
      for (const s of scripts) {
        for (const m of read(path.join('renderer', s)).matchAll(/\bapi\.(\w+)/g)) {
          if (m[1] === 'web') continue; // only set by web-shim.js in the browser
          assert.ok(exposed.has(m[1]), `${p} (${s}) uses api.${m[1]}, missing in ${preload}`);
        }
      }
    }
  }
});

test('windows load the preload the tests assume', () => {
  const main = read('main.js');
  assert.match(main, /overlay = baseWindow\(\{[^}]*preload: 'preload-overlay\.js'/);
  assert.match(main, /ramblerBar = baseWindow\(\{[^}]*preload: 'preload-rambler\.js'/);
  assert.match(main, /preload: path\.join\(__dirname, 'preload-stt\.js'\)/);
  assert.match(main, /security\.guardIpc\(ipcMain\)/);
  assert.match(read('zentrale.js'), /preload: path\.join\(__dirname, 'preload-zentrale\.js'\)/);
  // Guard installed before the first registration.
  assert.ok(main.indexOf('security.guardIpc(ipcMain)') < main.indexOf('ipcMain.on('));
});
