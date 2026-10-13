// Test authorization server and protected MCP endpoint for src/oauth.js (AURA-95). Plain http on 127.0.0.1; the
// client under test is created with allowHttpLoopback. Consent is automatic: /authorize redirects at once.
const http = require('http');
const crypto = require('crypto');

/**
 * @param {{ s256?: boolean, cimd?: boolean, dcr?: boolean, tokenTtl?: number, scopes?: string[] }} [opts]
 */
async function startOAuthServer(opts = {}) {
  const o = { s256: true, cimd: false, dcr: true, tokenTtl: 3600, scopes: ['read'], ...opts };
  const state = {
    clients: new Map(), // client_id → { redirect_uris }
    codes: new Map(), // code → { client_id, challenge, redirect_uri, resource }
    access: new Map(), // token → expiresAt
    refresh: new Map(), // token → client_id (rotated on use)
    revoked: [],
    tokenRequests: [],
    authorizeRequests: []
  };
  let base = '';
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const form = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve({ raw, params: new URLSearchParams(raw) }));
    });
  const issue = (clientId) => {
    const access = crypto.randomBytes(16).toString('hex');
    const refresh = crypto.randomBytes(16).toString('hex');
    state.access.set(access, Date.now() + o.tokenTtl * 1000);
    state.refresh.set(refresh, clientId);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: o.tokenTtl,
      refresh_token: refresh,
      scope: o.scopes.join(' ')
    };
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === '/mcp') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const exp = token && state.access.get(token[1]);
      if (!exp || exp < Date.now())
        return json(
          res,
          401,
          { error: 'unauthorized' },
          {
            'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
          }
        );
      return json(res, 200, { ok: true, tools: ['list_issues'] });
    }
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: o.scopes });
    if (u.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        ...(o.dcr ? { registration_endpoint: `${base}/register` } : {}),
        code_challenge_methods_supported: o.s256 ? ['S256'] : ['plain'],
        ...(o.cimd ? { client_id_metadata_document_supported: true } : {})
      });
    if (u.pathname === '/register' && req.method === 'POST') {
      const { raw } = await form(req);
      const body = JSON.parse(raw);
      const id = 'client-' + crypto.randomBytes(4).toString('hex');
      state.clients.set(id, { redirect_uris: body.redirect_uris });
      return json(res, 201, { client_id: id, redirect_uris: body.redirect_uris });
    }
    if (u.pathname === '/authorize') {
      const p = u.searchParams;
      state.authorizeRequests.push(Object.fromEntries(p));
      const client = state.clients.get(p.get('client_id'));
      const known = client ? client.redirect_uris.includes(p.get('redirect_uri')) : o.cimd;
      if (!known || p.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      const code = crypto.randomBytes(8).toString('hex');
      state.codes.set(code, {
        client_id: p.get('client_id'),
        challenge: p.get('code_challenge'),
        redirect_uri: p.get('redirect_uri'),
        resource: p.get('resource')
      });
      res.writeHead(302, {
        Location: `${p.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(p.get('state'))}`
      });
      return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const { params } = await form(req);
      state.tokenRequests.push(Object.fromEntries(params));
      if (params.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(params.get('code'));
        state.codes.delete(params.get('code'));
        const challenge = crypto
          .createHash('sha256')
          .update(params.get('code_verifier') || '')
          .digest('base64url');
        if (
          !c ||
          c.challenge !== challenge ||
          c.redirect_uri !== params.get('redirect_uri') ||
          c.resource !== params.get('resource')
        )
          return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(c.client_id));
      }
      if (params.get('grant_type') === 'refresh_token') {
        const clientId = state.refresh.get(params.get('refresh_token'));
        if (!clientId) return json(res, 400, { error: 'invalid_grant' });
        state.refresh.delete(params.get('refresh_token')); // rotation: the old refresh token is spent
        return json(res, 200, issue(clientId));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/revoke' && req.method === 'POST') {
      const { params } = await form(req);
      state.revoked.push(params.get('token'));
      state.refresh.delete(params.get('token'));
      return json(res, 200, {});
    }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    mcpUrl: `${base}/mcp`,
    state,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      })
  };
}

module.exports = { startOAuthServer };
