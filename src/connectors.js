// @ts-check
// Aura connector catalog (AURA-96): curated, reviewed MCP servers with ready settings (src/catalog/connectors.json).
// Used by the Zentrale (guided connect), the agent bridge (catalog for find_connector, registry search) and the
// server list (catalog tiers for servers whose URL matches an entry).

/**
 * @typedef {{ name: string, label: string, kind: string, secret: boolean, tokenUrl?: string, help: string[] }} Credential
 * @typedef {{ id: string, title: string, description: string, keywords: string[], publisher: string,
 *   verified: string, status: string, homepage: string,
 *   config?: { url?: string, auth?: string, headers?: Record<string, string>, command?: string, args?: string[],
 *     env?: Record<string, string>, builtin?: string },
 *   credentials: Credential[], setup?: string[], tiers?: Record<string, string> }} Connector
 */

/** @type {Connector[]} */
const CATALOG = /** @type {Connector[]} */ (require('./catalog/connectors.json').connectors);

const list = () => CATALOG;

/** @param {string} id */
const byId = (id) => CATALOG.find((c) => c.id === id) || null;

const norm = (/** @type {string} */ u) => String(u || '').replace(/\/+$/, '');

/** Catalog entry for a server the user added by hand with the same URL (e.g. mcp.atlassian.com). */
function forUrl(/** @type {string} */ url) {
  if (!url) return null;
  return CATALOG.find((c) => c.config && c.config.url && norm(c.config.url) === norm(url)) || null;
}

/** Tool prefix of a server, exactly as the agent builds it (extensions/mcp.py ServerConfig.prefix). */
const prefix = (/** @type {string} */ name) =>
  'mcp_' +
  String(name)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 30);

/**
 * Servers whose tool names would collide (FR-DISC-005): same prefix, or one nested in the other (mcp_a / mcp_a_b).
 * @param {string[]} names
 * @returns {Record<string, string>} name → error
 */
function collisions(names) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const a of names)
    for (const b of names) {
      if (a === b) continue;
      const p = prefix(a);
      const q = prefix(b);
      if (p === q || p.startsWith(q + '_') || q.startsWith(p + '_'))
        out[a] = `Werkzeugnamen kollidieren mit dem Server „${b}“; einen der beiden umbenennen.`;
    }
  return out;
}

/**
 * mcp.json entry for a catalog connector. Credentials are stored in the vault; the config only holds ${secret:…}.
 * @param {Connector} entry
 * @param {Record<string, string>} values credential name → value the user entered
 * @param {(credName: string) => string} secretName vault name for a credential
 * @param {(name: string, value: string, note: string) => void} store saves a secret in the vault
 */
function configFor(entry, values, secretName, store) {
  if (!entry.config || entry.status === 'coming') throw new Error(`„${entry.title}“ ist noch nicht verfügbar.`);
  for (const c of entry.credentials)
    if (!String(values[c.name] || '').trim()) throw new Error(`Bitte „${c.label}“ eintragen.`);
  /** @type {Record<string, string>} */
  const refs = {};
  for (const c of entry.credentials) {
    const value = String(values[c.name]).trim();
    if (c.secret) {
      const n = secretName(c.name);
      store(n, value, `${entry.title}: ${c.label}`);
      refs[c.name] = '${secret:' + n + '}';
    } else refs[c.name] = value;
  }
  const fill = (/** @type {string} */ s) => s.replace(/\$\{credential:([A-Z0-9_]+)\}/g, (_m, k) => refs[k] ?? '');
  const mapValues = (/** @type {Record<string, string> | undefined} */ o) =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v)])) : undefined;
  const c = entry.config;
  /** @type {Record<string, any>} */
  const cfg = c.url
    ? { url: c.url, ...(c.auth ? { auth: c.auth } : {}), ...(c.headers ? { headers: mapValues(c.headers) } : {}) }
    : c.builtin
      ? { builtin: c.builtin, ...(c.env ? { env: mapValues(c.env) } : {}) }
      : { command: c.command, args: (c.args || []).map(fill), ...(c.env ? { env: mapValues(c.env) } : {}) };
  cfg.catalogId = entry.id;
  cfg.description = entry.description;
  return cfg;
}

/**
 * Registry search results (zentrale.searchRegistry) in the shape the agent expects (host.searchRegistry).
 * @param {{ results?: Array<{ name: string, title?: string, description?: string, env?: Array<{ name: string, secret?: boolean, required?: boolean }> }>, error?: string }} r
 */
function registrySummary(r) {
  if (!r || r.error) return { results: [], error: (r && r.error) || 'Verzeichnis nicht erreichbar' };
  return {
    results: (r.results || []).slice(0, 10).map((x) => ({
      id: x.name,
      title: x.title || x.name,
      publisher: String(x.name).split('/')[0],
      description: String(x.description || '').slice(0, 300),
      needs: (x.env || []).filter((e) => e.required || e.secret).map((e) => e.name)
    }))
  };
}

const BUILTINS = new Set(['mail']);

/**
 * A connector shipped with Aura ({"builtin": "mail"} in mcp.json) becomes a command with Aura's own Python
 * (AURA-98). In development the agent's sources are bound read-only into the sandbox (they are not in site-packages).
 * @param {Record<string, any>} cfg
 * @param {string | null} python path of Aura's Python (agent bridge)
 * @param {string} [agentSrc] agent/src for development builds
 */
function resolveBuiltin(cfg, python, agentSrc) {
  if (!cfg || !cfg.builtin) return cfg;
  if (!BUILTINS.has(cfg.builtin)) throw new Error(`Unbekannte eingebaute Verbindung „${cfg.builtin}“.`);
  if (!python) throw new Error('Aura-Python nicht gefunden (Agent v2 nicht installiert).');
  const { builtin, ...rest } = cfg;
  return {
    ...rest,
    command: python,
    args: ['-I', '-m', `aura_agent.connectors.${builtin}`],
    ...(agentSrc ? { roPaths: [agentSrc] } : {})
  };
}

module.exports = { list, byId, forUrl, prefix, collisions, configFor, registrySummary, resolveBuiltin };
