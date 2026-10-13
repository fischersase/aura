// @ts-check
// Aura Zentrale im Browser: kleiner HTTP-Server nur auf 127.0.0.1.
// Schutz: zufälliges Zugriffstoken pro App-Start (kommt per URL-Fragment in den Browser, nie in Logs
// oder Referer), Prüfung von Host/Origin gegen DNS-Rebinding und fremde Webseiten, strenge CSP.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { webAccess, describe } = require('./web-access');

const PORTS = [47800, 47801, 47802, 47803, 47804, 47805];
const MAX_BODY = 2 * 1024 * 1024;
const RENDERER = path.join(__dirname, 'renderer');
/** @type {Record<string, [string, string]>} path → [file, content type] */
const FILES = {
  '/': [path.join(RENDERER, 'zentrale.html'), 'text/html; charset=utf-8'],
  '/zentrale.html': [path.join(RENDERER, 'zentrale.html'), 'text/html; charset=utf-8'],
  '/zentrale.js': [path.join(RENDERER, 'zentrale.js'), 'text/javascript; charset=utf-8'],
  '/zentrale.css': [path.join(RENDERER, 'zentrale.css'), 'text/css; charset=utf-8'],
  '/web-shim.js': [path.join(RENDERER, 'web-shim.js'), 'text/javascript; charset=utf-8'],
  '/assets/icon.png': [path.join(__dirname, '..', 'assets', 'icon.png'), 'image/png'],
  '/favicon.ico': [path.join(__dirname, '..', 'assets', 'icon.png'), 'image/png']
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store'
};

/** @type {import('http').Server | null} */
let server = null;
// Asks the user in the desktop app before a browser tab changes MCP servers, rules, skills or secrets (AURA-63).
// Replaceable for tests (setConfirm).
let confirm = askInDesktop;
/** @type {Promise<unknown>} */
let confirmQueue = Promise.resolve();
let port = 0;
let token = '';

const newToken = () => crypto.randomBytes(32).toString('base64url');
const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {string} [type]
 */
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** @param {import('http').IncomingMessage} req */
function authorized(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || '');
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handle(req, res) {
  // Nur Anfragen an unsere eigene Adresse (verhindert DNS-Rebinding).
  if (!allowedHosts().includes(String(req.headers.host || '').toLowerCase()))
    return send(res, 421, { error: 'Falscher Host' });
  const origin = req.headers.origin;
  if (
    origin &&
    !allowedHosts()
      .map((h) => 'http://' + h)
      .includes(origin)
  )
    return send(res, 403, { error: 'Fremde Herkunft' });
  const url = new URL(req.url || '/', 'http://x');

  if (req.method === 'GET' && FILES[url.pathname]) {
    const [file, type] = FILES[url.pathname];
    try {
      return send(res, 200, fs.readFileSync(file), type);
    } catch {
      return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    }
  }

  const m = /^\/api\/([A-Za-z]+)$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    if (!authorized(req))
      return send(res, 401, {
        error: 'Kein gültiger Zugang. Öffne die Zentrale über Aura (Tray-Menü → Zentrale im Browser).'
      });
    if (!/^application\/json\b/.test(req.headers['content-type'] || ''))
      return send(res, 415, { error: 'JSON erwartet' });
    const API = /** @type {Record<string, (arg: unknown) => unknown>} */ (require('./zentrale').API);
    const fn = Object.prototype.hasOwnProperty.call(API, m[1]) ? API[m[1]] : null;
    if (!fn) return send(res, 404, { error: 'Unbekannte Funktion' });
    const access = webAccess(m[1]);
    if (access === 'deny')
      return send(res, 403, { error: 'Im Browser nicht verfügbar. Bitte in der Zentrale-App ausführen.' });
    let arg;
    try {
      const raw = await readBody(req);
      arg = raw ? JSON.parse(raw).arg : undefined;
    } catch {
      return send(res, 400, { error: 'Ungültige Anfrage' });
    }
    if (access === 'confirm' && !(await confirm(describe(m[1], arg))))
      return send(res, 403, { error: 'In Aura abgelehnt.' });
    try {
      const out = await fn(arg);
      return send(res, 200, { result: out === undefined ? null : out });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
}

/**
 * @param {number} p port, 0 = any free port
 * @returns {Promise<import('http').Server>}
 */
function listen(p) {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        try {
          send(res, 500, { error: 'Fehler' });
        } catch {}
      });
    });
    s.once('error', reject);
    s.listen(p, '127.0.0.1', () => resolve(s));
  });
}

async function start() {
  if (server) return;
  for (const p of PORTS) {
    try {
      server = await listen(p);
      port = p;
      break;
    } catch {}
  }
  if (!server) {
    server = await listen(0);
    port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  }
  token = newToken();
}

/**
 * @param {string} what
 * @returns {Promise<boolean>}
 */
async function askInDesktop(what) {
  const { dialog } = require('electron');
  // Nacheinander, damit mehrere Anfragen nicht übereinander erscheinen.
  const run = confirmQueue.then(() =>
    dialog.showMessageBox({
      type: 'warning',
      title: 'Aura Zentrale im Browser',
      message: 'Die Zentrale im Browser möchte etwas ändern:',
      detail: `${what}\n\nNur erlauben, wenn du das gerade selbst im Browser ausgelöst hast.`,
      buttons: ['Ablehnen', 'Erlauben'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
  );
  confirmQueue = run.catch(() => {});
  try {
    return /** @type {{ response: number }} */ (await run).response === 1;
  } catch {
    return false;
  }
}

/** @param {((what: string) => Promise<boolean>) | null | undefined} fn */
function setConfirm(fn) {
  confirm = fn || askInDesktop;
}

// Startet bei Bedarf und öffnet die Zentrale im Standardbrowser.
async function open() {
  await start();
  shell.openExternal(`http://127.0.0.1:${port}/#t=${token}`);
  return info();
}

// Alle offenen Browser-Tabs abmelden.
function resetToken() {
  if (server) token = newToken();
  return info();
}

function stop() {
  if (server) server.close();
  server = null;
  port = 0;
  token = '';
  return info();
}

const info = () => ({ running: !!server, url: server ? `http://127.0.0.1:${port}/` : '' });

// Nur für Tests: Link mit Token, ohne Browser zu öffnen.
async function testUrl() {
  await start();
  return `http://127.0.0.1:${port}/#t=${token}`;
}

module.exports = { open, start, stop, resetToken, info, testUrl, setConfirm };
