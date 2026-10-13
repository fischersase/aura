// OAuth 2.1 client for remote MCP servers (src/oauth.js, AURA-95) against a local test authorization server.
const test = require('node:test');
const assert = require('node:assert');
const { createOAuthClient, OAuthError, vaultName, resourceMetadataFrom } = require('../src/oauth');
const { startOAuthServer } = require('./fixtures/oauth-server');

// The "browser": follows the authorization redirect to the loopback callback, like a user who agrees.
const browser = (opened) => async (url) => {
  opened.push(url);
  const res = await fetch(url, { redirect: 'manual' });
  const next = res.headers.get('location');
  if (next) await fetch(next);
};

function memoryVault() {
  const data = new Map();
  const meta = new Map();
  return {
    data,
    meta,
    get: (n) => data.get(n) ?? null,
    set: (n, v, _note, m) => {
      data.set(n, v);
      meta.set(n, m);
    },
    remove: (n) => {
      data.delete(n);
      meta.delete(n);
    }
  };
}

function client(extra = {}) {
  const opened = [];
  const vault = memoryVault();
  const c = createOAuthClient({
    fetch,
    openExternal: browser(opened),
    vault,
    clientMetadataUrl: 'https://fischersase.github.io/aura/oauth/client.json',
    allowHttpLoopback: true,
    ...extra
  });
  return { c, vault, opened };
}

test('connect with dynamic registration, PKCE and resource; tools work with the header', async (t) => {
  const srv = await startOAuthServer();
  t.after(() => srv.close());
  const { c, vault, opened } = client();
  const r = await c.connect('jira', srv.mcpUrl);
  assert.strictEqual(r.ok, true);
  const auth = new URL(opened[0]);
  assert.strictEqual(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(auth.searchParams.get('resource'), srv.mcpUrl);
  assert.match(auth.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  // Refresh token only in the vault, typed as oauth with the issuer as provider.
  const stored = JSON.parse(vault.data.get(vaultName('jira')));
  assert.ok(stored.refreshToken);
  assert.strictEqual(vault.meta.get(vaultName('jira')).kind, 'oauth');
  assert.strictEqual(vault.meta.get(vaultName('jira')).provider, srv.base);
  const header = await c.authHeader('jira');
  const res = await fetch(srv.mcpUrl, { headers: header });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).tools, ['list_issues']);
  assert.ok(c.connected('jira'));
});

test('expired access token is refreshed transparently, with rotation', async (t) => {
  const srv = await startOAuthServer({ tokenTtl: 30 }); // under the 60 s refresh margin
  t.after(() => srv.close());
  const { c, vault } = client();
  await c.connect('jira', srv.mcpUrl);
  const first = JSON.parse(vault.data.get(vaultName('jira'))).refreshToken;
  const header = await c.authHeader('jira');
  const second = JSON.parse(vault.data.get(vaultName('jira'))).refreshToken;
  assert.notStrictEqual(first, second, 'refresh token rotated and stored');
  assert.strictEqual(srv.state.tokenRequests.at(-1).grant_type, 'refresh_token');
  assert.strictEqual(srv.state.tokenRequests.at(-1).resource, srv.mcpUrl);
  assert.strictEqual((await fetch(srv.mcpUrl, { headers: header })).status, 200);
});

test('disconnect revokes the refresh token and deletes it', async (t) => {
  const srv = await startOAuthServer();
  t.after(() => srv.close());
  const { c, vault } = client();
  await c.connect('jira', srv.mcpUrl);
  const refresh = JSON.parse(vault.data.get(vaultName('jira'))).refreshToken;
  assert.deepStrictEqual(await c.disconnect('jira'), { revoked: true });
  assert.deepStrictEqual(srv.state.revoked, [refresh]);
  assert.strictEqual(vault.data.size, 0);
  assert.ok(!c.connected('jira'));
  await assert.rejects(c.authHeader('jira'), /Nicht verbunden/);
});

test('Client ID Metadata Document is preferred over registration', async (t) => {
  const srv = await startOAuthServer({ cimd: true });
  t.after(() => srv.close());
  const { c, opened } = client();
  await c.connect('jira', srv.mcpUrl);
  assert.strictEqual(
    new URL(opened[0]).searchParams.get('client_id'),
    'https://fischersase.github.io/aura/oauth/client.json'
  );
  assert.strictEqual(srv.state.clients.size, 0, 'no dynamic registration');
});

test('a preset client id is used as is (e.g. Google Cloud project)', async (t) => {
  const srv = await startOAuthServer({ dcr: false });
  t.after(() => srv.close());
  const { c } = client();
  await assert.rejects(c.connect('g', srv.mcpUrl), /eigene Client-ID/);
  srv.state.clients.set('my-client', { redirect_uris: [] });
  // The test server checks redirect URIs per client; register the loopback pattern the way a provider would.
  const opened = [];
  const c2 = createOAuthClient({
    fetch,
    openExternal: async (url) => {
      opened.push(url);
      const u = new URL(url);
      srv.state.clients.get('my-client').redirect_uris.push(u.searchParams.get('redirect_uri'));
      await browser([])(url);
    },
    vault: memoryVault(),
    clientMetadataUrl: 'x',
    allowHttpLoopback: true
  });
  await c2.connect('g', srv.mcpUrl, { clientId: 'my-client' });
  assert.strictEqual(new URL(opened[0]).searchParams.get('client_id'), 'my-client');
});

test('refuses authorization servers without PKCE S256', async (t) => {
  const srv = await startOAuthServer({ s256: false });
  t.after(() => srv.close());
  const { c, opened } = client();
  await assert.rejects(c.connect('jira', srv.mcpUrl), /PKCE/);
  assert.strictEqual(opened.length, 0, 'browser never opened');
});

test('refuses plain http issuers unless loopback is explicitly allowed (tests)', async (t) => {
  const srv = await startOAuthServer();
  t.after(() => srv.close());
  const { c } = client({ allowHttpLoopback: false });
  await assert.rejects(
    c.connect('jira', srv.mcpUrl),
    (err) => err instanceof OAuthError && /nur https/.test(err.message)
  );
});

test('the callback listener: wrong state is refused and it keeps waiting; only one callback; loopback only', async (t) => {
  const srv = await startOAuthServer();
  t.after(() => srv.close());
  let redirect = '';
  const { c } = client({
    openExternal: async (url) => {
      const res = await fetch(url, { redirect: 'manual' });
      redirect = res.headers.get('location');
      const u = new URL(redirect);
      assert.strictEqual(u.hostname, '127.0.0.1');
      const forged = new URL(redirect);
      forged.searchParams.set('state', 'forged');
      assert.strictEqual((await fetch(forged)).status, 400);
      assert.strictEqual((await fetch(redirect)).status, 200);
    }
  });
  await c.connect('jira', srv.mcpUrl);
  // The listener is closed after the one valid callback.
  await assert.rejects(fetch(redirect));
});

test('sign-in that never completes times out and closes the listener', async (t) => {
  const srv = await startOAuthServer();
  t.after(() => srv.close());
  const { c } = client({ openExternal: async () => {}, callbackTimeoutMs: 200 });
  await assert.rejects(c.connect('jira', srv.mcpUrl), /Zeit abgelaufen/);
});

test('resource metadata URL is read from the WWW-Authenticate challenge', () => {
  assert.strictEqual(
    resourceMetadataFrom(
      'Bearer error="invalid_token", resource_metadata="https://x.test/.well-known/oauth-protected-resource"'
    ),
    'https://x.test/.well-known/oauth-protected-resource'
  );
  assert.strictEqual(resourceMetadataFrom(null), null);
});

test('the published Client ID Metadata Document matches the client id Aura uses', () => {
  const doc = require('../packaging/site/oauth/client.json');
  assert.strictEqual(doc.client_id, 'https://fischersase.github.io/aura/oauth/client.json');
  assert.ok(
    doc.redirect_uris.every((u) => /^http:\/\/(127\.0\.0\.1|localhost)\/callback$/.test(u)),
    'loopback only'
  );
  assert.strictEqual(doc.token_endpoint_auth_method, 'none');
});
