// JSON-RPC peer of the app (src/agent2/rpc.js): malformed lines from the agent must not throw in the main process.
const test = require('node:test');
const assert = require('node:assert');
const { Peer, RpcError } = require('../src/agent2/rpc');

function peer() {
  const sent = [];
  const p = new Peer((line) => sent.push(JSON.parse(line)));
  return { p, sent };
}

test('non-object lines and broken JSON are ignored', () => {
  const { p } = peer();
  for (const line of ['null\n', '42\n', '"text"\n', '[1,2]\n', '{broken\n'])
    assert.doesNotThrow(() => p.feed(line), line);
});

test('an error that is not an object still rejects the request', async () => {
  const { p, sent } = peer();
  const pending = p.request('task.start', {});
  p.feed(JSON.stringify({ id: sent[0].id, error: 'kaputt' }) + '\n');
  await assert.rejects(pending, (err) => err instanceof RpcError && err.message === 'kaputt' && err.code === -32603);
});

test('error objects keep code, message and data', async () => {
  const { p, sent } = peer();
  const pending = p.request('task.start', {});
  p.feed(JSON.stringify({ id: sent[0].id, error: { code: -32602, message: 'falsch', data: { x: 1 } } }) + '\n');
  await assert.rejects(pending, (err) => err.code === -32602 && err.message === 'falsch' && err.data.x === 1);
});

test('handler errors become JSON-RPC errors', async () => {
  const { p, sent } = peer();
  p.on('host.approve', () => {
    throw Object.assign(new Error('nein'), { code: -32001 });
  });
  p.feed(JSON.stringify({ id: 7, method: 'host.approve', params: {} }) + '\n');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(sent.at(-1).error, { code: -32001, message: 'nein' });
});
