// The Zentrale's server list (src/agent/mcp.js) sends the OAuth header for "auth": "oauth" servers, so a
// signed-in server shows its tools instead of HTTP 401 (2026-10-13).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

test('oauth servers are listed with the header from the OAuth client', async (t) => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(req.headers.authorization || '');
      if (req.headers.authorization !== 'Bearer ok') {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
        return res.end('{"error":"invalid_token"}');
      }
      const m = JSON.parse(raw);
      if (m.id == null) return res.end();
      const result = m.method === 'tools/list' ? { tools: [{ name: 'getJiraIssue', inputSchema: {} }] } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mcp-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = oldHome;
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  delete require.cache[require.resolve('../src/agent/mcp')];
  const mcp = require('../src/agent/mcp');
  fs.mkdirSync(path.dirname(mcp.configFile()), { recursive: true });
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  fs.writeFileSync(mcp.configFile(), JSON.stringify({ mcpServers: { Atlassian: { url, auth: 'oauth' } } }));

  await mcp.sync(true);
  assert.match(mcp.status()[0].error, /Nicht angemeldet/, 'without a sign-in no request is sent');
  assert.deepStrictEqual(seen, []);

  mcp.setAuthProvider(async (name) => {
    assert.strictEqual(name, 'Atlassian');
    return { Authorization: 'Bearer ok' };
  });
  await mcp.sync(true);
  const [s] = mcp.status();
  assert.strictEqual(s.error, null);
  assert.deepStrictEqual(s.toolNames, ['getJiraIssue']);
  assert.ok(seen.every((h) => h === 'Bearer ok'));
  mcp.closeAll();
});
