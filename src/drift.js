// @ts-check
// Drift protection for MCP servers (AURA-97, FR-DISC-004): when the user approves a connector, Aura stores a snapshot
// of its tools (name, description, input schema) and its SHA-256 as "toolsHash" in mcp.json. A server whose tools
// change afterwards (e.g. a description that now tells the model to send data elsewhere) is paused until the user
// approves the diff. The agent checks the same hash itself (extensions/mcp.py, same canonical form).
const crypto = require('crypto');

/** @typedef {{ name: string, description: string, inputSchema: any }} ToolInfo */

/**
 * Canonical JSON: keys sorted at every level, no spaces (same as Python json.dumps(sort_keys=True, separators)).
 * @param {any} v
 * @returns {string}
 */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((/** @type {string} */ k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(v === undefined ? null : v);
}

/** The part of a tool list that counts, sorted by name. @param {any[]} tools */
function snapshot(tools) {
  return (tools || [])
    .map((t) => ({ name: String(t.name), description: String(t.description || ''), inputSchema: t.inputSchema || {} }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** @param {any[]} tools */
const hash = (tools) =>
  crypto
    .createHash('sha256')
    .update(canonical(snapshot(tools)), 'utf8')
    .digest('hex');

/**
 * What changed between the approved snapshot and the current tools.
 * @param {ToolInfo[]} before
 * @param {any[]} now
 */
function diff(before, now) {
  const a = new Map(snapshot(before).map((t) => [t.name, t]));
  const b = new Map(snapshot(now).map((t) => [t.name, t]));
  return {
    added: [...b.keys()].filter((n) => !a.has(n)).map((n) => b.get(n)),
    removed: [...a.keys()].filter((n) => !b.has(n)),
    changed: [...b.keys()]
      .filter((n) => a.has(n) && canonical(a.get(n)) !== canonical(b.get(n)))
      .map((n) => ({ name: n, before: a.get(n), after: b.get(n) }))
  };
}

module.exports = { canonical, snapshot, hash, diff };
