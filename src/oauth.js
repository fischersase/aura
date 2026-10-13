// @ts-check
// OAuth 2.1 for remote MCP servers (AURA-95), following the MCP authorization spec (2025-11-25):
// protected resource metadata (RFC 9728) → authorization server metadata (RFC 8414 / OIDC) → client registration
// (pre-registered, Client ID Metadata Document, or Dynamic Client Registration) → authorization code with PKCE S256
// through the system browser and a loopback redirect → tokens with the resource indicator (RFC 8707) → refresh with
// rotation → revocation (RFC 7009) on disconnect.
// Runs only in the main process. The refresh token lives in the credential vault (kind "oauth"); access tokens
// stay in memory. The agent only ever gets an Authorization header for a single request (host.authHeader).
const crypto = require('crypto');
const http = require('http');

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;
const VAULT_PREFIX = 'OAUTH_';

/**
 * @typedef {object} Deps
 * @property {typeof fetch} fetch
 * @property {(url: string) => unknown} openExternal opens the authorization URL in the user's browser
 * @property {{ get: (name: string) => string | null, set: (name: string, value: string, note?: string, meta?: object) => void, remove: (name: string) => void }} vault
 * @property {string} clientMetadataUrl URL of Aura's Client ID Metadata Document
 * @property {() => number} [now]
 * @property {boolean} [allowHttpLoopback] tests only: accept http issuers on 127.0.0.1/localhost
 * @property {number} [callbackTimeoutMs]
 */
/**
 * What the vault holds per server (encrypted as one value).
 * @typedef {object} Grant
 * @property {string} refreshToken
 * @property {string} clientId
 * @property {string} [clientSecret]
 * @property {string} tokenEndpoint
 * @property {string} [revocationEndpoint]
 * @property {string} issuer
 * @property {string} resource
 * @property {string} [scope]
 */
/** @typedef {{ issuer: string, authorization_endpoint: string, token_endpoint: string, registration_endpoint?: string, revocation_endpoint?: string, code_challenge_methods_supported?: string[], client_id_metadata_document_supported?: boolean, scopes_supported?: string[] }} AuthServerMetadata */

class OAuthError extends Error {}

const b64url = (/** @type {Buffer} */ buf) => buf.toString('base64url');
const vaultName = (/** @type {string} */ server) => VAULT_PREFIX + server.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 50);

/**
 * https everywhere; http only for loopback when explicitly allowed (tests).
 * @param {string} url
 * @param {boolean} allowHttpLoopback
 */
function assertSecureUrl(url, allowHttpLoopback) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new OAuthError(`Ungültige Adresse: ${url}`);
  }
  if (u.protocol === 'https:') return;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && loopback && allowHttpLoopback) return;
  throw new OAuthError(`Unsichere Adresse für die Anmeldung (nur https): ${u.origin}`);
}

/** @param {string | null} header */
function resourceMetadataFrom(header) {
  const m = /resource_metadata="([^"]+)"/i.exec(header || '');
  return m ? m[1] : null;
}

/** @param {Deps} deps */
function createOAuthClient(deps) {
  const now = deps.now || Date.now;
  const allowHttp = !!deps.allowHttpLoopback;
  /** @type {Map<string, { token: string, expiresAt: number }>} */
  const accessTokens = new Map();

  /**
   * @param {string} url
   * @param {RequestInit} [init]
   */
  async function getJson(url, init) {
    const res = await deps.fetch(url, { ...init, headers: { Accept: 'application/json', ...(init && init.headers) } });
    if (!res.ok) throw new OAuthError(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Protected resource metadata of an MCP server: from the 401 challenge, else from the well-known locations.
   * @param {string} serverUrl
   */
  async function protectedResource(serverUrl) {
    assertSecureUrl(serverUrl, allowHttp);
    const u = new URL(serverUrl);
    const candidates = [];
    try {
      const probe = await deps.fetch(serverUrl, {
        method: 'GET',
        headers: { Accept: 'application/json, text/event-stream' }
      });
      const fromHeader = resourceMetadataFrom(probe.headers.get('www-authenticate'));
      if (fromHeader) candidates.push(fromHeader);
    } catch {}
    const path = u.pathname.replace(/\/$/, '');
    if (path) candidates.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
    candidates.push(`${u.origin}/.well-known/oauth-protected-resource`);
    for (const url of candidates) {
      assertSecureUrl(url, allowHttp);
      try {
        const prm = await getJson(url);
        if (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers.length) return prm;
      } catch {}
    }
    throw new OAuthError('Der Server nennt keinen Anmeldedienst (protected resource metadata fehlt).');
  }

  /**
   * RFC 8414 / OIDC discovery in the order of the MCP spec (path insertion first).
   * @param {string} issuer
   * @returns {Promise<AuthServerMetadata>}
   */
  async function authServerMetadata(issuer) {
    assertSecureUrl(issuer, allowHttp);
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/$/, '');
    const urls = path
      ? [
          `${u.origin}/.well-known/oauth-authorization-server${path}`,
          `${u.origin}/.well-known/openid-configuration${path}`,
          `${u.origin}${path}/.well-known/openid-configuration`
        ]
      : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
    for (const url of urls) {
      try {
        const meta = await getJson(url);
        if (meta && meta.authorization_endpoint && meta.token_endpoint) {
          if (meta.issuer && meta.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, ''))
            throw new OAuthError(`Anmeldedienst meldet einen anderen Aussteller (${meta.issuer}).`);
          for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'])
            if (meta[k]) assertSecureUrl(meta[k], allowHttp);
          return meta;
        }
      } catch (err) {
        if (err instanceof OAuthError && /anderen Aussteller|Unsichere/.test(err.message)) throw err;
      }
    }
    throw new OAuthError(`Keine Anmelde-Metadaten bei ${issuer} gefunden.`);
  }

  /**
   * Starts the loopback listener; resolves with the code of the first callback carrying the right state.
   * @param {string} state
   */
  function listen(state) {
    return new Promise((resolveListen, rejectListen) => {
      /** @type {(code: string) => void} */
      let gotCode = () => {};
      /** @type {(err: Error) => void} */
      let failed = () => {};
      const code = new Promise((res, rej) => {
        gotCode = res;
        failed = rej;
      });
      let done = false;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        const page = (/** @type {number} */ status, /** @type {string} */ text) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(`<!doctype html><meta charset="utf-8"><title>Aura</title><p>${text}</p>`);
        };
        if (u.pathname !== '/callback' || done) return page(404, 'Nicht gefunden.');
        if (u.searchParams.get('state') !== state) return page(400, 'Ungültige Anmeldung.'); // keep listening
        const err = u.searchParams.get('error');
        const c = u.searchParams.get('code');
        done = true;
        page(
          200,
          err
            ? 'Anmeldung abgebrochen. Du kannst dieses Fenster schließen.'
            : 'Angemeldet. Du kannst dieses Fenster schließen.'
        );
        clearTimeout(timer);
        server.closeAllConnections(); // a browser's keep-alive connection must not hold the listener open
        server.close();
        if (err || !c) failed(new OAuthError(`Anmeldung abgebrochen: ${err || 'kein Code'}`));
        else gotCode(c);
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        server.closeAllConnections(); // a browser's keep-alive connection must not hold the listener open
        server.close();
        failed(new OAuthError('Anmeldung nicht abgeschlossen (Zeit abgelaufen).'));
      }, deps.callbackTimeoutMs || CALLBACK_TIMEOUT_MS);
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => {
        const addr = /** @type {import('net').AddressInfo} */ (server.address());
        const close = () => {
          done = true;
          clearTimeout(timer);
          server.closeAllConnections();
          server.close();
        };
        resolveListen({ redirectUri: `http://127.0.0.1:${addr.port}/callback`, code, close });
      });
    });
  }

  /**
   * @param {AuthServerMetadata} meta
   * @param {string} redirectUri
   * @param {{ clientId?: string, clientSecret?: string }} preset
   * @returns {Promise<{ clientId: string, clientSecret?: string }>}
   */
  async function registerClient(meta, redirectUri, preset) {
    if (preset.clientId) return { clientId: preset.clientId, clientSecret: preset.clientSecret };
    if (meta.client_id_metadata_document_supported) return { clientId: deps.clientMetadataUrl };
    if (meta.registration_endpoint) {
      const r = await getJson(meta.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Aura',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        })
      });
      if (!r.client_id) throw new OAuthError('Registrierung beim Anmeldedienst fehlgeschlagen.');
      return { clientId: r.client_id, clientSecret: r.client_secret };
    }
    throw new OAuthError(
      'Dieser Dienst verlangt eine eigene Client-ID (z. B. aus einem Google-Cloud-Projekt). Trag sie beim Server ein.'
    );
  }

  /**
   * @param {string} tokenEndpoint
   * @param {Record<string, string>} form
   * @param {{ clientId: string, clientSecret?: string }} client
   */
  async function tokenRequest(tokenEndpoint, form, client) {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const body = new URLSearchParams({ ...form, client_id: client.clientId });
    if (client.clientSecret) {
      headers.Authorization =
        'Basic ' +
        Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString(
          'base64'
        );
    }
    const res = await deps.fetch(tokenEndpoint, { method: 'POST', headers, body: body.toString() });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token)
      throw new OAuthError(`Anmeldedienst hat kein Token ausgegeben (${json.error || res.status}).`);
    return json;
  }

  /**
   * @param {string} server name of the MCP server
   * @param {Grant} grant
   * @param {{ access_token: string, expires_in?: number, refresh_token?: string, scope?: string }} tokens
   */
  function remember(server, grant, tokens) {
    accessTokens.set(server, {
      token: tokens.access_token,
      expiresAt: now() + (Number(tokens.expires_in) || 3600) * 1000
    });
    const next = {
      ...grant,
      refreshToken: tokens.refresh_token || grant.refreshToken,
      scope: tokens.scope || grant.scope
    };
    if (!next.refreshToken) return;
    deps.vault.set(vaultName(server), JSON.stringify(next), `Anmeldung für MCP-Server ${server}`, {
      kind: 'oauth',
      provider: grant.issuer,
      scopes: next.scope ? next.scope.split(' ') : undefined
    });
  }

  /** @param {string} server */
  function grantOf(server) {
    const raw = deps.vault.get(vaultName(server));
    if (!raw) return null;
    try {
      return /** @type {Grant} */ (JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Full sign-in for one MCP server. Resolves when the user signed in in the browser.
   * @param {string} server name of the MCP server
   * @param {string} serverUrl its URL
   * @param {{ clientId?: string, clientSecret?: string, scope?: string }} [preset]
   */
  async function connect(server, serverUrl, preset = {}) {
    const prm = await protectedResource(serverUrl);
    const issuer = String(prm.authorization_servers[0]);
    const meta = await authServerMetadata(issuer);
    if (!(meta.code_challenge_methods_supported || []).includes('S256'))
      throw new OAuthError('Der Anmeldedienst unterstützt kein PKCE (S256); Aura meldet sich dort nicht an.');
    const resource = String(prm.resource || serverUrl);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const {
      redirectUri,
      code,
      close: closeListener
    } = /** @type {{ redirectUri: string, code: Promise<string>, close: () => void }} */ (await listen(state));
    try {
      const client = await registerClient(meta, redirectUri, preset);
      const scope = preset.scope || (Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(' ') : '');
      const auth = new URL(meta.authorization_endpoint);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('client_id', client.clientId);
      auth.searchParams.set('redirect_uri', redirectUri);
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('state', state);
      auth.searchParams.set('resource', resource);
      if (scope) auth.searchParams.set('scope', scope);
      await deps.openExternal(auth.toString());
      const authCode = await code;
      const tokens = await tokenRequest(
        meta.token_endpoint,
        {
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource
        },
        client
      );
      /** @type {Grant} */
      const grant = {
        refreshToken: tokens.refresh_token || '',
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        tokenEndpoint: meta.token_endpoint,
        ...(meta.revocation_endpoint ? { revocationEndpoint: meta.revocation_endpoint } : {}),
        issuer,
        resource,
        ...(tokens.scope ? { scope: tokens.scope } : scope ? { scope } : {})
      };
      remember(server, grant, tokens);
      return { ok: true, issuer, scope: grant.scope || '' };
    } finally {
      closeListener();
    }
  }

  /**
   * Authorization header for one request; refreshes (with rotation) shortly before expiry.
   * @param {string} server
   * @returns {Promise<{ Authorization: string }>}
   */
  async function authHeader(server) {
    const cached = accessTokens.get(server);
    if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return { Authorization: `Bearer ${cached.token}` };
    const grant = grantOf(server);
    if (!grant || !grant.refreshToken) throw new OAuthError('Nicht verbunden – in der Aura Zentrale anmelden.');
    const tokens = await tokenRequest(
      grant.tokenEndpoint,
      { grant_type: 'refresh_token', refresh_token: grant.refreshToken, resource: grant.resource },
      grant
    );
    remember(server, grant, tokens);
    return { Authorization: `Bearer ${tokens.access_token}` };
  }

  /**
   * Revokes the refresh token at the provider (if it offers revocation) and deletes it.
   * @param {string} server
   */
  async function disconnect(server) {
    const grant = grantOf(server);
    accessTokens.delete(server);
    let revoked = false;
    if (grant && grant.revocationEndpoint) {
      try {
        const body = new URLSearchParams({
          token: grant.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: grant.clientId
        });
        const res = await deps.fetch(grant.revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
        revoked = res.ok;
      } catch {}
    }
    deps.vault.remove(vaultName(server));
    return { revoked };
  }

  /** @param {string} server */
  const connected = (server) => !!grantOf(server);

  return { connect, authHeader, disconnect, connected, protectedResource, authServerMetadata };
}

module.exports = { createOAuthClient, OAuthError, vaultName, resourceMetadataFrom };
