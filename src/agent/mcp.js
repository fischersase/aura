// Kleiner MCP-Client (Model Context Protocol): bindet Werkzeuge externer MCP-Server ein.
// Konfiguration wie bei Claude Desktop / Cursor in ~/.aura/mcp.json:
//   { "mcpServers": {
//       "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--isolated"] },
//       "remote":     { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } },
//       "x":          { "command": "…", "autoApprove": ["read_thing"], "disabled": false } } }
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'aura', version: '1' };
const configFile = () => path.join(os.homedir(), '.aura', 'mcp.json');

class StdioConn {
  constructor(name, cfg) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child = spawn(cfg.command, cfg.args || [], {
      cwd: cfg.cwd || os.homedir(),
      env: { ...process.env, ...(cfg.env || {}) },
      shell: IS_WIN, // npx.cmd & Co. unter Windows
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onMessage(line);
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    const fail = (msg) => {
      for (const p of this.pending.values()) p.reject(new Error(msg));
      this.pending.clear();
      this.closed = msg;
    };
    this.child.on('error', (e) => fail(`${name}: ${e.message}`));
    this.child.on('exit', (code) => fail(`${name} wurde beendet (Code ${code}). ${this.stderr.trim().split('\n').pop() || ''}`));
  }

  onMessage(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'MCP-Fehler'));
      else p.resolve(msg.result);
    } else if (msg.id != null && msg.method) {
      // Anfragen des Servers (z. B. ping, roots/list) beantworten wir minimal.
      const result = msg.method === 'roots/list' ? { roots: [] } : {};
      this.write({ jsonrpc: '2.0', id: msg.id, result });
    }
  }

  write(obj) { this.child.stdin.write(JSON.stringify(obj) + '\n'); }

  request(method, params, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: keine Antwort auf ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }

  close() { try { this.child.kill(); } catch {} }
}

// Streamable HTTP: JSON-RPC per POST, Antwort als JSON oder als SSE-Strom.
class HttpConn {
  constructor(name, cfg) {
    this.name = name;
    this.url = cfg.url;
    this.headers = cfg.headers || {};
    this.nextId = 1;
    this.session = null;
  }

  async post(body, timeoutMs = 60000) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
        ...this.headers
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (body.id == null) return null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\n\n/)) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try {
          const m = JSON.parse(data);
          if (m.id === body.id) return m;
        } catch {}
      }
      throw new Error(`${this.name}: keine Antwort im Datenstrom`);
    }
    return res.json();
  }

  async request(method, params, timeoutMs) {
    const m = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs);
    if (m.error) throw new Error(m.error.message || 'MCP-Fehler');
    return m.result;
  }

  notify(method, params) { this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }).catch(() => {}); }

  close() {
    if (this.session) fetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.session, ...this.headers } }).catch(() => {});
  }
}

// ---------- Verwaltung ----------

let servers = new Map(); // name → { conn, tools, error, cfgKey }
let loadedMtime = 0;

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return raw.mcpServers || raw.servers || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    return { __error: String(err.message) };
  }
}

async function connect(name, cfg) {
  const conn = cfg.url ? new HttpConn(name, cfg) : new StdioConn(name, cfg);
  await conn.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }, 30000);
  conn.notify('notifications/initialized');
  const tools = [];
  let cursor;
  do {
    const r = await conn.request('tools/list', cursor ? { cursor } : {}, 30000);
    tools.push(...(r.tools || []));
    cursor = r.nextCursor;
  } while (cursor);
  return { conn, tools };
}

// Startet/aktualisiert die Server aus mcp.json (nur wenn sich die Datei geändert hat).
async function sync(force = false) {
  let mtime = 0;
  try { mtime = fs.statSync(configFile()).mtimeMs; } catch {}
  if (!force && mtime === loadedMtime && servers.size) return;
  loadedMtime = mtime;
  const cfg = readConfig();
  const next = new Map();
  if (cfg.__error) {
    next.set('mcp.json', { tools: [], error: 'mcp.json ist kein gültiges JSON: ' + cfg.__error });
  }
  await Promise.all(Object.entries(cfg).filter(([n, c]) => n !== '__error' && c && !c.disabled).map(async ([name, c]) => {
    const key = JSON.stringify(c);
    const old = servers.get(name);
    if (old && old.cfgKey === key && !old.error) { next.set(name, old); servers.delete(name); return; }
    try {
      const { conn, tools } = await connect(name, c);
      next.set(name, { conn, tools, cfgKey: key, autoApprove: c.autoApprove || [] });
    } catch (err) {
      next.set(name, { tools: [], error: String(err.message || err), cfgKey: key });
    }
  }));
  for (const s of servers.values()) if (s.conn) s.conn.close();
  servers = next;
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');

function textOf(result) {
  const parts = [];
  const images = [];
  for (const c of result.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image' && /jpeg|png|webp/.test(c.mimeType || '')) images.push({ data: c.data, mimeType: c.mimeType });
    else if (c.type === 'resource' && c.resource && c.resource.text) parts.push(c.resource.text);
  }
  if (result.structuredContent && !parts.length) parts.push(JSON.stringify(result.structuredContent));
  return { text: parts.join('\n'), images };
}

// Werkzeuge im Format von tools.js.
function tools() {
  const out = [];
  for (const [server, s] of servers) {
    for (const t of s.tools) {
      const readOnly = t.annotations && t.annotations.readOnlyHint === true;
      const auto = readOnly || (s.autoApprove || []).includes(t.name) || (s.autoApprove || []).includes('*');
      out.push({
        name: `mcp_${safe(server)}_${safe(t.name)}`.slice(0, 64),
        description: `[${server}] ${t.description || t.title || t.name}`.slice(0, 1000),
        parameters: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} },
        changes: () => !auto,
        label: (a) => `${server}: ${t.name} ${JSON.stringify(a)}`.slice(0, 300),
        mcp: true,
        server,
        mcpName: t.name,
        readOnly: !!readOnly,
        run: async (args) => {
          const r = await s.conn.request('tools/call', { name: t.name, arguments: args || {} }, 300000);
          const { text, images } = textOf(r);
          return {
            ...(r.isError ? { error: text.slice(0, 12000) || 'Fehler' } : { output: text.slice(0, 12000) }),
            ...(images.length ? { image: images[0].data } : {})
          };
        }
      });
    }
  }
  return out;
}

function status() {
  return [...servers].map(([name, s]) => ({ name, tools: s.tools.length, toolNames: s.tools.map((t) => t.name), error: s.error || null }));
}

function closeAll() {
  for (const s of servers.values()) if (s.conn) s.conn.close();
  servers.clear();
  loadedMtime = 0;
}

module.exports = { sync, tools, status, closeAll, configFile };
