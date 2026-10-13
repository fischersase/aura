// Gemini Live relay (src/live-relay.js, AURA-15): the key stays in the main process and in a header; the renderer
// only exchanges messages for its own session.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { LiveRelay, LIVE_PATH, MAX_MESSAGE } = require('../src/live-relay');

const KEY = ['AIza', 'Sy', 'TestOnly'].join('') + 'x'.repeat(27);
const sockets = [];
class FakeWS {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    sockets.push(this);
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen();
  }
  message(data) {
    this.onmessage({ data });
  }
  end(code, reason) {
    this.readyState = 3;
    this.onclose({ code, reason });
  }
}
function window() {
  const w = new EventEmitter();
  w.events = [];
  w.destroyed = false;
  w.isDestroyed = () => w.destroyed;
  w.send = (channel, data) => w.events.push([channel, data]);
  return w;
}
const relay = (key = KEY) => new LiveRelay({ getKey: () => key, WebSocketImpl: FakeWS, base: 'wss://live.test' });

test('the key goes into the handshake header, never into the URL', () => {
  const r = relay();
  const { id } = r.open(window());
  const ws = sockets.at(-1);
  assert.ok(id);
  assert.strictEqual(ws.url, 'wss://live.test' + LIVE_PATH);
  assert.ok(!ws.url.includes(KEY) && !ws.url.includes('key='));
  assert.deepStrictEqual(ws.opts, { headers: { 'x-goog-api-key': KEY } });
});

test('without a key no connection is opened', () => {
  const before = sockets.length;
  assert.deepStrictEqual(relay('').open(window()), { error: 'Kein API-Key hinterlegt.' });
  assert.strictEqual(sockets.length, before);
});

test('messages flow both ways, binary frames arrive as text', () => {
  const r = relay();
  const w = window();
  const { id } = r.open(w);
  const ws = sockets.at(-1);
  assert.strictEqual(r.send(w, id, '{"setup":{}}'), false); // not open yet
  ws.open();
  assert.strictEqual(r.send(w, id, '{"setup":{}}'), true);
  ws.message(new TextEncoder().encode('{"setupComplete":{}}').buffer);
  ws.message('{"serverContent":{}}');
  ws.end(1000, 'bye');
  assert.deepStrictEqual(ws.sent, ['{"setup":{}}']);
  assert.deepStrictEqual(w.events, [
    ['live:opened', { id }],
    ['live:message', { id, data: '{"setupComplete":{}}' }],
    ['live:message', { id, data: '{"serverContent":{}}' }],
    ['live:closed', { id, code: 1000, reason: 'bye' }]
  ]);
  assert.strictEqual(r.sessions.size, 0);
});

test('a window can only use its own session; oversized and non-text messages are dropped', () => {
  const r = relay();
  const a = window();
  const b = window();
  const { id } = r.open(a);
  const ws = sockets.at(-1);
  ws.open();
  assert.strictEqual(r.send(b, id, 'x'), false);
  r.close(id, b);
  assert.strictEqual(ws.closed, false);
  assert.strictEqual(r.send(a, id, { not: 'text' }), false);
  assert.strictEqual(r.send(a, id, 'x'.repeat(MAX_MESSAGE + 1)), false);
  assert.strictEqual(r.send(a, 999, 'x'), false);
  assert.deepStrictEqual(ws.sent, []);
});

test('reconnect replaces the old socket; closing the window closes its session', () => {
  const r = relay();
  const w = window();
  const first = r.open(w).id;
  const ws1 = sockets.at(-1);
  const second = r.open(w).id;
  assert.notStrictEqual(first, second);
  assert.strictEqual(ws1.closed, true);
  ws1.open(); // late events of the replaced socket are not forwarded
  assert.deepStrictEqual(w.events, []);
  const ws2 = sockets.at(-1);
  w.emit('destroyed');
  assert.strictEqual(ws2.closed, true);
  assert.strictEqual(r.sessions.size, 0);
});

test('the renderer never gets the key and connects to nothing itself', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const config = /ipcMain\.handle\('live:config'[\s\S]*?\n\}\);/.exec(src('main.js'))[0];
  assert.doesNotMatch(config, /\bapiKey\s*:/);
  assert.match(config, /hasKey: !!store\.getApiKey\(\)/);
  const live = src('renderer/live.js');
  assert.doesNotMatch(live, /new WebSocket\(|key=|apiKey/);
  assert.match(src('renderer/panel.html'), /connect-src 'none'/);
});
