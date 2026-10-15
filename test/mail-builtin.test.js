// Aura's own mail connector (AURA-98): catalog config, runtime resolution, and the real server answering tools/list,
// also inside the sandbox.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const connectors = require('../src/connectors');
const sandbox = require('../src/sandbox');

const AGENT = path.join(__dirname, '..', 'agent');
const PY = path.join(AGENT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

test('the catalog entry stores a builtin config with vault references only', () => {
  const stored = [];
  const cfg = connectors.configFor(
    connectors.byId('mail'),
    { MAIL_ADDRESS: 'anna@gmail.com', MAIL_PASSWORD: 'abcd efgh ijkl mnop' },
    (k) => `MAIL_${k}`,
    (name) => stored.push(name)
  );
  assert.deepStrictEqual(cfg.env, { MAIL_ADDRESS: 'anna@gmail.com', MAIL_PASSWORD: '${secret:MAIL_MAIL_PASSWORD}' });
  assert.strictEqual(cfg.builtin, 'mail');
  assert.deepStrictEqual(stored, ['MAIL_MAIL_PASSWORD']);
  const run = connectors.resolveBuiltin(cfg, '/opt/Aura/resources/python/bin/python3');
  assert.deepStrictEqual(run.args, ['-I', '-m', 'aura_agent.connectors.mail']);
  assert.throws(() => connectors.resolveBuiltin({ builtin: 'evil' }, '/x'), /Unbekannte/);
});

async function listTools(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mailtest-'));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    delete require.cache[require.resolve('../src/agent/mcp')];
    const mcp = require('../src/agent/mcp');
    fs.mkdirSync(path.dirname(mcp.configFile()), { recursive: true });
    fs.writeFileSync(mcp.configFile(), JSON.stringify({ mcpServers: { mail: cfg } }));
    mcp.setResolver((c, name) => {
      const run = connectors.resolveBuiltin(c, PY, path.join(AGENT, 'src'));
      return cfg.sandbox === false ? run : sandbox.wrap(name, run, { home });
    });
    await mcp.sync(true);
    const st = mcp.status()[0];
    mcp.closeAll();
    return st;
  } finally {
    process.env.HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('the real mail server lists its tools (no login needed for that)', { skip: !fs.existsSync(PY) }, async () => {
  const st = await listTools({
    builtin: 'mail',
    env: { MAIL_ADDRESS: 'a@gmail.com', MAIL_PASSWORD: 'x' },
    sandbox: false
  });
  assert.strictEqual(st.error, null);
  assert.deepStrictEqual(st.toolNames.sort(), ['mail_read', 'mail_search', 'mail_send']);
});

test(
  '… and inside the sandbox',
  { skip: !fs.existsSync(PY) || (!sandbox.findBwrap() && !process.env.AURA_REQUIRE_BWRAP) },
  async () => {
    const st = await listTools({
      builtin: 'mail',
      catalogId: 'mail',
      env: { MAIL_ADDRESS: 'a@gmail.com', MAIL_PASSWORD: 'x' }
    });
    assert.strictEqual(st.error, null, st.error);
    assert.strictEqual(st.tools, 3);
  }
);

test(
  'the builtin google_workspace server lists its 7 Gmail, Calendar, and Drive tools',
  { skip: !fs.existsSync(PY) },
  async () => {
    const st = await listTools({
      builtin: 'google_workspace',
      catalogId: 'google-workspace',
      env: { GOOGLE_EMAIL: 'a@gmail.com', GOOGLE_APP_PASSWORD: 'x' },
      sandbox: false
    });
    assert.strictEqual(st.error, null, st.error);
    assert.deepStrictEqual(st.toolNames.sort(), [
      'workspace_calendar_create',
      'workspace_calendar_events',
      'workspace_drive_read',
      'workspace_drive_search',
      'workspace_gmail_read',
      'workspace_gmail_search',
      'workspace_gmail_send'
    ]);
  }
);
