// @ts-check
// What the Zentrale in the browser (src/web.js) may call (AURA-63). The desktop window keeps the full API over IPC;
// a browser tab is easier to compromise (extensions, other local pages that got the token), so anything that can
// run commands, weaken the safety rules or change secrets needs a confirmation in the desktop app.

// Read-only or harmless.
const ALLOW = new Set([
  'state',
  'log',
  'chats',
  'deleteChat',
  'policy',
  'memory',
  'audit',
  'doctor',
  'getServer',
  'searchRegistry',
  'connectors',
  'getSkill',
  'secrets',
  'setSecretNote',
  'profile',
  'saveProfile',
  'setAgent',
  'openUrl',
  'webInfo',
  'resetWeb'
]);

// Allowed after the user confirms in the desktop app. Value: German text for the dialog (UI language today).
/** @type {Record<string, (a: any) => string>} */
const CONFIRM = {
  saveServer: (a) => `MCP-Server „${a.name}“ speichern: ${serverCommand(a.config)}`,
  installRegistry: (a) =>
    `MCP-Server „${a.name || (a.server && a.server.name) || '?'}“ aus dem Verzeichnis installieren`,
  installConnector: (a) =>
    `Verbindung „${a && a.id}“ aus dem Aura-Katalog einrichten (Zugangsdaten werden gespeichert)`,
  toggleServer: (a) => `MCP-Server „${a.name}“ ${a.enabled ? 'einschalten (startet ihn)' : 'ausschalten'}`,
  removeServer: (a) => `MCP-Server „${a}“ entfernen`,
  connectServer: (a) => `Beim MCP-Server „${a}“ anmelden (öffnet den Browser)`,
  disconnectServer: (a) => `Beim MCP-Server „${a}“ abmelden`,
  protectServer: (a) => `Schlüssel des MCP-Servers „${a}“ in die Schlüsselverwaltung verschieben`,
  setPolicy: (a) => `Regel für „${a.tool}“ auf „${a.policy}“ setzen`,
  savePolicy: () => 'Regeln (policy.toml) überschreiben',
  saveSkill: (a) => `Skill „${a.name || 'neu'}“ speichern`,
  deleteSkill: (a) => `Skill „${a}“ löschen`,
  toggleSkill: (a) => `Skill „${a.name}“ ${a.enabled ? 'einschalten' : 'ausschalten'}`,
  saveAgentsMd: () => 'Anweisungen an den Agenten (AGENTS.md) überschreiben',
  setSecret: (a) => `Schlüssel „${a.name}“ setzen`,
  deleteSecret: (a) => `Schlüssel „${a}“ löschen`,
  setWeakStorage: (a) =>
    a ? 'Schlüssel ohne Schlüsselbund schwach geschützt speichern' : 'Schwache Speicherung ausschalten',
  memoryUpdate: (a) => `Gedächtnis-Eintrag ändern in „${String(a.text || '').slice(0, 120)}“`,
  memoryDelete: () => 'Einen Gedächtnis-Eintrag löschen',
  memoryDeleteAll: () => 'Das gesamte Gedächtnis löschen',
  memoryPause: (a) => (a ? 'Gedächtnis pausieren' : 'Gedächtnis wieder einschalten'),
  setAgentVersion: (a) => `Agent-Version auf „${a}“ umstellen`,
  installExtension: () => 'GNOME-Erweiterung installieren'
};

// Not over the web at all: opening local files and folders, starting another web session.
const DENY = new Set(['openPath', 'openWeb']);

/** @param {{ url?: string, command?: string, args?: unknown } | null | undefined} config */
function serverCommand(config) {
  const c = config || {};
  const text = c.url ? String(c.url) : [c.command, ...(Array.isArray(c.args) ? c.args : [])].map(String).join(' ');
  return text.length > 300 ? text.slice(0, 300) + ' …' : text;
}

// 'allow' | 'confirm' | 'deny'. Unknown names are denied, so new API functions are not reachable from the browser
// until someone decides.
/**
 * @param {string} name
 * @returns {'allow' | 'confirm' | 'deny'}
 */
function webAccess(name) {
  if (ALLOW.has(name)) return 'allow';
  if (Object.prototype.hasOwnProperty.call(CONFIRM, name)) return 'confirm';
  return 'deny';
}

/**
 * @param {string} name
 * @param {unknown} arg
 * @returns {string}
 */
function describe(name, arg) {
  const fn = CONFIRM[name];
  if (!fn) return name;
  try {
    return fn(arg === undefined || arg === null ? {} : arg);
  } catch {
    return name;
  }
}

module.exports = { webAccess, describe, ALLOW, CONFIRM, DENY };
