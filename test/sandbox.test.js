// Sandbox for local MCP servers (src/sandbox.js, AURA-97).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sandbox = require('../src/sandbox');

test('catalog and registry servers are sandboxed; own servers only on request', () => {
  assert.ok(sandbox.wanted({ command: 'npx', catalogId: 'github' }));
  assert.ok(sandbox.wanted({ command: 'uvx', source: 'registry' }));
  assert.ok(!sandbox.wanted({ command: 'uvx', source: 'registry', sandbox: false }));
  assert.ok(!sandbox.wanted({ command: 'my-server' }));
  assert.ok(sandbox.wanted({ command: 'my-server', sandbox: true }));
  assert.ok(!sandbox.wanted({ url: 'https://x', catalogId: 'atlassian' }), 'remote servers do not run locally');
});

test('without a working bwrap a sandboxed server does not start; Windows/macOS say so', () => {
  const cfg = { command: 'npx', args: ['-y', 'x@1.0.0'], catalogId: 'x' };
  assert.throws(() => sandbox.wrap('x', cfg, { platform: 'linux', bwrap: () => null }), /bubblewrap installieren/);
  assert.strictEqual(sandbox.wrap('x', cfg, { platform: 'win32' }).sandboxed, 'unsupported');
  assert.strictEqual(sandbox.wrap('x', { command: 'own' }, { platform: 'linux' }).sandboxed, 'off');
});

test('the arguments bind only system paths, the program root and the own directory; secrets stay out', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-sbx-'));
  const nodeRoot = path.join(home, '.nvm', 'versions', 'node', 'v20');
  fs.mkdirSync(path.join(nodeRoot, 'bin'), { recursive: true });
  const r = sandbox.wrap(
    'GitHub',
    { command: 'npx', args: ['-y', 'srv@1.2.3'], env: { TOKEN: 'secret-value' }, catalogId: 'github' },
    { platform: 'linux', home, bwrap: () => '/usr/bin/bwrap', which: () => path.join(nodeRoot, 'bin', 'npx') }
  );
  assert.strictEqual(r.command, '/usr/bin/bwrap');
  assert.strictEqual(r.sandboxed, 'on');
  const dir = path.join(home, '.aura', 'connectors', 'GitHub');
  assert.ok(fs.existsSync(dir));
  const binds = [];
  for (let i = 0; i < r.args.length; i++) if (/^--(ro-)?bind$/.test(r.args[i])) binds.push(r.args[i + 1]);
  assert.deepStrictEqual(binds, ['/usr', nodeRoot, dir]);
  assert.ok(!r.args.includes(home), 'home itself is never bound');
  assert.ok(!r.args.join(' ').includes('secret-value'), 'secrets stay in the environment, not in argv');
  assert.deepStrictEqual(r.args.slice(-3), [path.join(nodeRoot, 'bin', 'npx'), '-y', 'srv@1.2.3']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('programs in ~/.local/bin do not expose ~/.local', () => {
  const home = '/home/u';
  assert.deepStrictEqual(sandbox.programDirs('/home/u/.local/bin/uvx', home), ['/home/u/.local/bin']);
  assert.deepStrictEqual(sandbox.programDirs('/usr/bin/npx', home), []);
});

// Real sandbox (Linux with a working bwrap): the server cannot read the user's files, but its own directory.
test(
  'a sandboxed program cannot read home files but can write its own directory',
  { skip: !sandbox.findBwrap() && !process.env.AURA_REQUIRE_BWRAP },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-sbx-home-'));
    fs.writeFileSync(path.join(home, 'secret.txt'), 'top secret');
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'key');
    const script = `
    const fs = require('fs');
    const out = {};
    for (const f of [${JSON.stringify(path.join(home, 'secret.txt'))}, ${JSON.stringify(path.join(home, '.ssh', 'id_ed25519'))}])
      try { fs.readFileSync(f); out[f] = 'read'; } catch (e) { out[f] = e.code; }
    fs.writeFileSync(process.env.HOME + '/cache.txt', 'ok');
    out.home = process.env.HOME;
    out.wrote = fs.readFileSync(process.env.HOME + '/cache.txt', 'utf8');
    console.log(JSON.stringify(out));`;
    const r = sandbox.wrap(
      'probe',
      { command: process.execPath, args: ['-e', script], sandbox: true },
      { platform: 'linux', home }
    );
    const p = spawnSync(r.command, r.args, { cwd: r.cwd, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.strictEqual(p.status, 0, p.stderr);
    const out = JSON.parse(p.stdout);
    assert.strictEqual(out[path.join(home, 'secret.txt')], 'ENOENT');
    assert.strictEqual(out[path.join(home, '.ssh', 'id_ed25519')], 'ENOENT');
    assert.strictEqual(out.home, path.join(home, '.aura', 'connectors', 'probe'));
    assert.strictEqual(out.wrote, 'ok');
    assert.ok(fs.existsSync(path.join(home, '.aura', 'connectors', 'probe', 'cache.txt')));
    fs.rmSync(home, { recursive: true, force: true });
  }
);
