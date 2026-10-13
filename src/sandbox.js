// @ts-check
// Sandbox for local MCP servers (AURA-97, FR-DISC-003, decision D5): on Linux, connectors from the Aura catalog or
// the public registry run in bubblewrap. They see the system read-only (/usr, /etc, /opt), their own directory
// ~/.aura/connectors/<name> as HOME, the folder of their start program, and the network; nothing else from the
// user's home (no ~/.ssh, no browser profiles, no documents). Windows and macOS have no sandbox yet (documented gap).
//
// One place for both users of a config: the Zentrale's server list (src/agent/mcp.js) and the agent (initialize).
// Credentials stay in the spawn environment, never in bwrap's arguments (those are visible in the process list).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HINT = 'Sandbox nicht verfügbar: bubblewrap installieren (sudo apt install bubblewrap) und Aura neu starten.';
// Ubuntu 24.04+: user namespaces need an AppArmor profile that allows them. The Aura package installs one
// (/etc/apparmor.d/aura); a development start (npm start) has none.
const HINT_BLOCKED =
  'Sandbox nicht verfügbar: bubblewrap ist installiert, darf hier aber keine abgeschottete Umgebung anlegen ' +
  '(AppArmor). Aura aus dem installierten Paket starten.';

/**
 * @typedef {{ command?: string, args?: string[], env?: Record<string, string>, cwd?: string, url?: string,
 *   catalogId?: string, source?: string, sandbox?: boolean, [k: string]: any }} ServerConfig
 * @typedef {{ platform?: string, home?: string, auraDir?: string, bwrap?: () => string | null,
 *   which?: (cmd: string) => string | null }} Deps
 */

/** Is this config sandboxed? Catalog and registry servers by default; others only on request. */
function wanted(/** @type {ServerConfig} */ cfg) {
  if (!cfg || cfg.url || !cfg.command) return false;
  if (cfg.sandbox === false) return false;
  return cfg.sandbox === true || !!cfg.catalogId || cfg.source === 'registry';
}

let bwrapCache = /** @type {string | null | undefined} */ (undefined);
/** Path of a working bwrap (it can create a user namespace here), or null. Checked once. */
function findBwrap() {
  if (bwrapCache !== undefined) return bwrapCache;
  bwrapCache = null;
  for (const p of ['/usr/bin/bwrap', '/bin/bwrap']) {
    if (!fs.existsSync(p)) continue;
    try {
      execFileSync(p, ['--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', 'true'], {
        stdio: 'ignore',
        timeout: 5000
      });
      bwrapCache = p;
      break;
    } catch {}
  }
  return bwrapCache;
}

/** Absolute path of a command on PATH. */
function which(/** @type {string} */ cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Paths the sandbox already shows read-only. */
const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/opt', '/etc'];

/**
 * Directories the start program needs, read-only. Programs under the system paths need nothing extra. Elsewhere
 * (nvm, ~/.local/bin, a tool cache) the install root (".../node/v20" with bin and lib) is bound, but never a home
 * folder itself, ~/.local (it holds other data, e.g. ~/.local/share/keyrings) or "/".
 * @param {string} program absolute path
 * @param {string} home
 */
function programDirs(program, home) {
  const homes = new Set([home, os.homedir()]);
  const tooWide = (/** @type {string} */ d) =>
    d === path.parse(d).root || homes.has(d) || [...homes].some((h) => d === path.join(h, '.local'));
  const out = new Set();
  for (const p of new Set([program, safeRealpath(program)])) {
    if (SYSTEM.some((s) => p === s || p.startsWith(s + path.sep))) continue;
    const dir = path.dirname(p);
    const parent = path.dirname(dir);
    if (path.basename(dir) === 'bin' && !tooWide(parent)) out.add(parent);
    else if (!tooWide(dir)) out.add(dir);
  }
  // Nested roots (npm inside node/v20) are covered by the outer one.
  return [...out].filter((d) => ![...out].some((o) => o !== d && d.startsWith(o + path.sep)));
}

function safeRealpath(/** @type {string} */ p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Directory of one connector (created on demand). */
const serverDir = (/** @type {string} */ auraDir, /** @type {string} */ name) =>
  path.join(
    auraDir,
    'connectors',
    String(name)
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .slice(0, 60) || '_'
  );

/**
 * The bwrap arguments for one server (pure; tested).
 * @param {{ dir: string, programDirs: string[], pathDirs: string[] }} o
 */
function bwrapArgs(o) {
  const ro = (/** @type {string} */ p) => ['--ro-bind', p, p];
  const roTry = (/** @type {string} */ p) => ['--ro-bind-try', p, p];
  return [
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    ...ro('/usr'),
    ...['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/opt', '/etc'].flatMap(roTry),
    // DNS on systemd systems: /etc/resolv.conf points here.
    ...roTry('/run/systemd/resolve'),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...o.programDirs.flatMap(ro),
    '--bind',
    o.dir,
    o.dir,
    '--chdir',
    o.dir,
    '--setenv',
    'HOME',
    o.dir,
    '--setenv',
    'PATH',
    [...o.pathDirs, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--'
  ];
}

/**
 * Wraps a server config in the sandbox if it should be sandboxed. Returns the config to start, plus `sandboxed`
 * ('on' | 'off' | 'unsupported'). Throws with a hint if the sandbox is required but bwrap does not work.
 * @param {string} name
 * @param {ServerConfig} cfg resolved config (secrets already filled in)
 * @param {Deps} [deps]
 * @returns {ServerConfig & { sandboxed: string }}
 */
function wrap(name, cfg, deps = {}) {
  if (!wanted(cfg)) return { ...cfg, sandboxed: 'off' };
  const platform = deps.platform || process.platform;
  if (platform !== 'linux') return { ...cfg, sandboxed: 'unsupported' };
  const bwrap = (deps.bwrap || findBwrap)();
  if (!bwrap)
    throw new Error(
      ['/usr/bin/bwrap', '/bin/bwrap'].some((p) => fs.existsSync(p)) && !deps.bwrap ? HINT_BLOCKED : HINT
    );
  const home = deps.home || os.homedir();
  const auraDir = deps.auraDir || path.join(home, '.aura');
  const program = (deps.which || which)(String(cfg.command));
  if (!program) throw new Error(`Startprogramm „${cfg.command}“ nicht gefunden.`);
  const dir = serverDir(auraDir, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirs = programDirs(program, home);
  const binDirs = [...new Set([path.dirname(program), ...dirs.map((d) => path.join(d, 'bin'))])];
  return {
    ...cfg,
    command: bwrap,
    args: [...bwrapArgs({ dir, programDirs: dirs, pathDirs: binDirs }), program, ...(cfg.args || [])],
    cwd: dir,
    sandboxed: 'on'
  };
}

module.exports = { wanted, wrap, bwrapArgs, programDirs, serverDir, findBwrap, HINT, HINT_BLOCKED };
