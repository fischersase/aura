// „Aura Zentrale“: Verwaltungsfenster für Werkzeuge, MCP-Server, Skills, Anweisungen, Protokoll und Chats.
const { BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const { enableWeakIfAllowed } = require('./keystore');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const chats = require('./chats');
const tools = require('./agent/tools');
const skills = require('./agent/skills');
const mcp = require('./agent/mcp');
const loop = require('./agent/loop');
const secrets = require('./secrets');
const connectors = require('./connectors');
const sandbox = require('./sandbox');
const drift = require('./drift');

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers';
let win = null;

/**
 * @param {string} icon
 * @param {{ page?: string, connect?: string, query?: string, chatId?: string | null }} [nav] e.g. from the connect card or panel
 */
function open(icon, nav) {
  const navigate = () => nav && win && !win.isDestroyed() && win.webContents.send('z:navigate', nav);
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    navigate();
    return;
  }
  win = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 780,
    minHeight: 540,
    title: 'Aura Zentrale',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    webPreferences: { preload: path.join(__dirname, 'preload-zentrale.js'), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'zentrale.html'));
  win.webContents.once('did-finish-load', navigate);
  win.on('closed', () => {
    win = null;
  });
}

// ---------- mcp.json lesen/schreiben ----------

function readMcpConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(mcp.configFile(), 'utf8'));
    return raw.mcpServers || raw.servers || {};
  } catch {
    return {};
  }
}

function writeMcpConfig(servers) {
  fs.mkdirSync(path.dirname(mcp.configFile()), { recursive: true });
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(mcp.configFile(), 'utf8'));
  } catch {}
  delete raw.servers;
  raw.mcpServers = servers;
  fs.writeFileSync(mcp.configFile(), JSON.stringify(raw, null, 2) + '\n');
}

const validName = (n) => /^[A-Za-z0-9_.-]{1,40}$/.test(String(n || ''));

// ---------- Zustand für die Oberfläche ----------

// Approved tools of a server: snapshot file next to its sandbox directory, hash in mcp.json (AURA-97).
const snapshotFile = (name) => path.join(sandbox.serverDir(skills.auraDir(), name), 'tools.json');

function approveTools(name, tools) {
  const all = readMcpConfig();
  if (!all[name]) return false;
  const file = snapshotFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(drift.snapshot(tools), null, 2) + '\n');
  all[name] = { ...all[name], toolsHash: drift.hash(tools) };
  writeMcpConfig(all);
  return true;
}

// Connectors (catalog/registry) are approved by the user's "Verbinden"; the first successful listing is the test
// call, and its tools become the approved snapshot.
async function approveNewConnectors() {
  let changed = false;
  for (const [name, c] of Object.entries(readMcpConfig())) {
    const connector = c.catalogId || c.source === 'registry' || connectors.forUrl(c.url);
    const st = mcp.status().find((x) => x.name === name);
    if (!connector || c.toolsHash || c.disabled || !st || st.error || !st.tools) continue;
    changed = approveTools(name, mcp.listedTools(name)) || changed;
  }
  if (changed) await mcp.sync(true);
}

async function state(force) {
  try {
    await mcp.sync(!!force);
    await approveNewConnectors();
  } catch {}
  const s = store.load();
  const policy = s.toolPolicy || {};
  const cfg = readMcpConfig();
  const status = Object.fromEntries(mcp.status().map((x) => [x.name, x]));
  const mcpTools = mcp.tools();
  const builtin = tools.TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    asksByDefault:
      t.name === 'run_command'
        ? 'nur bei ändernden Befehlen'
        : t.name === 'open'
          ? 'nur bei Programmdateien'
          : t.changes({})
            ? 'ja'
            : 'nein',
    policy: policy[t.name] || 'default'
  }));
  // OAuth servers without a sign-in are not in error, they wait for "Anmelden" (AURA-95).
  const waitsForSignIn = (/** @type {string} */ name, /** @type {any} */ c) =>
    c.auth === 'oauth' && !secrets.get(require('./oauth').vaultName(name));
  const clashes = connectors.collisions(Object.keys(cfg).filter((n) => cfg[n] && !cfg[n].disabled));
  const servers = Object.entries(cfg).map(([name, c]) => ({
    name,
    catalogId: c.catalogId || (connectors.forUrl(c.url) || {}).id || '',
    // Sandbox (AURA-97): 'on', 'missing' (required but bwrap does not work), 'unsupported' (Windows/macOS), ''
    sandbox: !sandbox.wanted(c.builtin ? { ...c, command: 'python' } : c)
      ? c.command && (c.catalogId || c.source === 'registry')
        ? 'disabled'
        : ''
      : process.platform !== 'linux'
        ? 'unsupported'
        : sandbox.findBwrap()
          ? 'on'
          : 'missing',
    type: c.url ? 'http' : 'stdio',
    command: c.url ? c.url : c.builtin ? `Aura (eingebaut): ${c.builtin}` : [c.command, ...(c.args || [])].join(' '),
    env: Object.keys(c.env || {}),
    disabled: !!c.disabled,
    plainSecrets: plainSecrets(c),
    secretRefs: secrets.refsIn(c),
    auth: c.auth === 'oauth' ? 'oauth' : '',
    signedIn: c.auth === 'oauth' ? !!secrets.get(require('./oauth').vaultName(name)) : false,
    error: clashes[name] || (waitsForSignIn(name, c) ? null : status[name] ? status[name].error : null),
    running: !!(status[name] && !status[name].error),
    drift: !!(status[name] && status[name].drift),
    approved: !!c.toolsHash,
    tools: mcpTools
      .filter((t) => t.server === name)
      .map((t) => ({
        name: t.name,
        title: t.mcpName,
        description: t.description,
        readOnly: t.readOnly,
        policy: policy[t.name] || 'default'
      }))
  }));
  const off = new Set(s.disabledSkills || []);
  return {
    version: require('electron').app.getVersion(),
    provider: s.provider,
    model: s.provider === 'ollama' ? s.ollamaModel : s.chatModel,
    agentEnabled: !!s.agentEnabled,
    agentVersion: process.env.AURA_AGENT_VERSION || s.agentVersion || 'v2',
    profileName: (s.profile && s.profile.name) || '',
    secretCount: secrets.list().filter((x) => !x.builtin).length,
    web: require('./web').info(),
    auraDir: skills.auraDir(),
    builtin,
    servers,
    skills: skills
      .list()
      .map((k) => ({ name: k.name, description: k.description, dir: k.dir, enabled: !off.has(k.name) })),
    agentsMd: (() => {
      try {
        return fs.readFileSync(skills.agentsFile(), 'utf8');
      } catch {
        return '';
      }
    })()
  };
}

function readLog(limit = 300) {
  try {
    const lines = fs.readFileSync(loop.logFile(), 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Registry-Eintrag → Konfiguration für mcp.json.
function configFromRegistry(server, env = {}) {
  const remote = (server.remotes || [])[0];
  const pkg = (server.packages || []).find((p) => ['npm', 'pypi', 'oci'].includes(p.registryType));
  if (pkg) {
    const pkgArgs = (pkg.packageArguments || [])
      .filter((a) => a.value || a.default)
      .map((a) => (a.type === 'named' ? [a.name, a.value || a.default] : [a.value || a.default]))
      .flat();
    let cfg;
    if (pkg.registryType === 'npm')
      cfg = { command: 'npx', args: ['-y', `${pkg.identifier}@${pkg.version || 'latest'}`, ...pkgArgs] };
    else if (pkg.registryType === 'pypi')
      cfg = { command: 'uvx', args: [`${pkg.identifier}${pkg.version ? '==' + pkg.version : ''}`, ...pkgArgs] };
    else
      cfg = {
        command: 'docker',
        args: [
          'run',
          '-i',
          '--rm',
          ...Object.keys(env).flatMap((k) => ['-e', k]),
          `${pkg.identifier}${pkg.version ? ':' + pkg.version : ''}`,
          ...pkgArgs
        ]
      };
    const e = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
    if (Object.keys(e).length) cfg.env = e;
    return cfg;
  }
  if (remote && remote.url) {
    const headers = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
    return { url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  return null;
}

// ---------- Schnittstelle (für das Fenster per IPC und für den Browser per web.js) ----------
// Jede Methode nimmt höchstens ein Argument und gibt JSON-fähige Daten zurück.

// Klartext-Geheimnisse in mcp.json finden (env/headers), damit die Oberfläche warnen kann.
function plainSecrets(c) {
  const found = [];
  for (const [k, v] of Object.entries(c.env || {})) if (secrets.looksSecret(k, v)) found.push(k);
  for (const [k, v] of Object.entries(c.headers || {})) if (secrets.looksSecret(k, v)) found.push(k);
  return found;
}

function usedBy() {
  const map = {};
  for (const [name, c] of Object.entries(readMcpConfig()))
    for (const ref of secrets.refsIn(c)) (map[ref] = map[ref] || []).push(name);
  return map;
}

const secretNameFor = (server, key) =>
  `${server}_${key}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 64);

// Werte, die wie Schlüssel aussehen, in die Schlüsselverwaltung verschieben und durch ${secret:…} ersetzen.
// Ohne Schlüsselbund wirft secrets.set (AURA-93): der Server wird dann nicht gespeichert, statt den Schlüssel still im
// Klartext in mcp.json zu lassen. Wer das trotzdem will, speichert den Server ausdrücklich ohne Schutz (protect: false).
function protectConfig(serverName, cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const field of ['env', 'headers']) {
    for (const [k, v] of Object.entries(out[field] || {})) {
      if (!secrets.looksSecret(k, v)) continue;
      const n = secretNameFor(serverName, k);
      secrets.set(n, v, `MCP-Server ${serverName}, ${field === 'env' ? 'Variable' : 'Header'} ${k}`);
      out[field][k] = '${secret:' + n + '}';
    }
  }
  return out;
}

// Files are shown in the file manager instead of being handed to the default app for their type: on Ubuntu
// that is often the Firefox snap for .json, which may not read hidden folders like ~/.aura (AURA-111).
function revealOrOpen(p, isFile, sh) {
  if (isFile) sh.showItemInFolder(p);
  else sh.openPath(p);
}

const API = {
  state: (force) => state(force),
  log: () => readLog(),
  chats: () => chats.list(),
  getChat: (id) => chats.get(String(id || '')),
  saveChat: (chat) => chats.save(chat),
  deleteChat: (id) => chats.remove(id),

  setPolicy({ tool, policy }) {
    const p = { ...(store.load().toolPolicy || {}) };
    if (!policy || policy === 'default') delete p[tool];
    else p[tool] = policy;
    store.save({ toolPolicy: p });
    return true;
  },
  setAgent(on) {
    store.save({ agentEnabled: !!on });
    return true;
  },
  setAgentVersion(v) {
    store.save({ agentVersion: v === 'v2' ? 'v2' : 'v1' });
    return true;
  },

  async saveServer({ name, oldName, config, protect }) {
    if (!validName(name))
      return { error: 'Name nur mit Buchstaben, Ziffern, Punkt, Minus oder Unterstrich (max. 40 Zeichen).' };
    if (!config || (!config.command && !config.url)) return { error: 'Befehl oder URL fehlt.' };
    const all = readMcpConfig();
    if (oldName && oldName !== name) delete all[oldName];
    else if (!oldName && all[name]) return { error: `Es gibt schon einen Server „${name}“.` };
    try {
      all[name] = protect === false ? config : protectConfig(name, config);
    } catch (e) {
      return { error: e.message };
    }
    writeMcpConfig(all);
    return state(true);
  },
  getServer: (name) => readMcpConfig()[name] || null,
  removeServer(name) {
    const all = readMcpConfig();
    delete all[name];
    writeMcpConfig(all);
    return state(true);
  },
  toggleServer({ name, enabled }) {
    const all = readMcpConfig();
    if (!all[name]) return state();
    if (enabled) delete all[name].disabled;
    else all[name].disabled = true;
    writeMcpConfig(all);
    return state(true);
  },
  // Klartext-Schlüssel eines Servers in die Schlüsselverwaltung verschieben.
  protectServer(name) {
    const all = readMcpConfig();
    if (!all[name]) return { error: 'Server nicht gefunden.' };
    if (secrets.protection() === 'none')
      return {
        error:
          'Verschlüsselung ist hier nicht verfügbar. Unter Linux gnome-keyring oder KWallet installieren und Aura neu starten.'
      };
    try {
      all[name] = protectConfig(name, all[name]);
    } catch (e) {
      return { error: e.message };
    }
    writeMcpConfig(all);
    return state(true);
  },

  async searchRegistry(q) {
    const url = `${REGISTRY}?search=${encodeURIComponent(String(q || '').trim())}&version=latest&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { error: `Verzeichnis nicht erreichbar (${res.status})` };
    const j = await res.json();
    // Pro Server nur die neueste Version
    const latest = new Map();
    for (const e of j.servers || []) {
      const sv = e.server || e;
      const meta = (e._meta || {})['io.modelcontextprotocol.registry/official'] || {};
      const prev = latest.get(sv.name);
      if (!prev || meta.isLatest || (!prev.isLatest && String(sv.version) > String(prev.server.version)))
        latest.set(sv.name, { server: sv, isLatest: !!meta.isLatest });
    }
    return {
      results: [...latest.values()].slice(0, 30).map(({ server: sv }) => {
        const pkg = (sv.packages || [])[0];
        const remote = (sv.remotes || [])[0];
        return {
          name: sv.name,
          title: sv.title || sv.name.split('/').pop(),
          description: sv.description || '',
          version: sv.version,
          repo: sv.repository && sv.repository.url,
          kind: pkg ? pkg.registryType : remote ? 'remote' : 'unbekannt',
          env: pkg
            ? (pkg.environmentVariables || []).map((v) => ({
                name: v.name,
                description: v.description || '',
                required: !!v.isRequired,
                secret: !!v.isSecret,
                default: v.default || ''
              }))
            : remote
              ? (remote.headers || []).map((h) => ({
                  name: h.name,
                  description: h.description || '',
                  required: !!h.isRequired,
                  secret: !!h.isSecret,
                  default: h.value || ''
                }))
              : [],
          server: sv
        };
      })
    };
  },

  // env: { NAME: { value, secret } } oder { NAME: "wert" }. Geheime Werte landen verschlüsselt in der Schlüsselverwaltung.
  async installRegistry({ name, server, env }) {
    const all = readMcpConfig();
    let n = String(name || server.name.split('/').pop())
      .replace(/[^A-Za-z0-9_.-]/g, '-')
      .slice(0, 40);
    while (all[n]) n += '-2';
    const plain = {};
    try {
      for (const [k, x] of Object.entries(env || {})) {
        const value = typeof x === 'object' && x ? String(x.value || '') : String(x || '');
        if (typeof x === 'object' && x && x.secret && value) {
          const sn = secretNameFor(n, k);
          secrets.set(sn, value, `MCP-Server ${n}, ${k}`);
          plain[k] = '${secret:' + sn + '}';
        } else plain[k] = value;
      }
    } catch (e) {
      return { error: e.message };
    }
    const cfg = configFromRegistry(server, plain);
    if (!cfg) return { error: 'Für diesen Eintrag kennt Aura keine Startart (nur npm, PyPI, Docker oder Remote).' };
    all[n] = { ...cfg, source: 'registry' }; // unreviewed: every tool asks (FR-CON-008)
    writeMcpConfig(all);
    return { name: n, state: await state(true) };
  },

  // Drift protection (AURA-97): what changed since the approval, and approving the new tools.
  driftInfo(name) {
    const tools = mcp.listedTools(String(name || ''));
    if (!tools) return { error: 'Server nicht gefunden.' };
    let before = [];
    try {
      before = JSON.parse(fs.readFileSync(snapshotFile(String(name)), 'utf8'));
    } catch {}
    return drift.diff(before, tools);
  },
  async approveTools(name) {
    const tools = mcp.listedTools(String(name || ''));
    if (!tools || !approveTools(String(name), tools)) return { error: 'Server nicht gefunden.' };
    return state(true);
  },

  // Aura connector catalog (AURA-96): reviewed entries with ready settings; "installed" if a server uses it.
  connectors() {
    const cfg = readMcpConfig();
    const used = new Map();
    for (const [name, c] of Object.entries(cfg)) {
      const id = c.catalogId || (connectors.forUrl(c.url) || {}).id;
      if (id) used.set(id, name);
    }
    return connectors.list().map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      publisher: e.publisher,
      status: e.status,
      homepage: e.homepage,
      oauth: !!(e.config && e.config.auth === 'oauth'),
      credentials: e.credentials,
      setup: e.setup || [],
      server: used.get(e.id) || null
    }));
  },
  // Connect a catalog entry: credentials go to the vault, mcp.json gets the entry with ${secret:…} and catalogId.
  installConnector({ id, values } = {}) {
    const entry = connectors.byId(String(id || ''));
    if (!entry) return { error: 'Unbekannter Eintrag im Katalog.' };
    const all = readMcpConfig();
    let n = entry.title.split(/[ (]/)[0].replace(/[^A-Za-z0-9_.-]/g, '-') || entry.id;
    const existing = Object.entries(all).find(
      ([, c]) => c.catalogId === entry.id || (connectors.forUrl(c.url) || {}).id === entry.id
    );
    if (existing) n = existing[0];
    else while (all[n]) n += '-2';
    let cfg;
    try {
      cfg = connectors.configFor(
        entry,
        values || {},
        (cred) => secretNameFor(n, cred),
        (name, value, note) => secrets.set(name, value, note)
      );
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    all[n] = cfg;
    writeMcpConfig(all);
    return { name: n, oauth: cfg.auth === 'oauth' };
  },

  // Skills
  toggleSkill({ name, enabled }) {
    const off = new Set(store.load().disabledSkills || []);
    if (enabled) off.delete(name);
    else off.add(name);
    store.save({ disabledSkills: [...off] });
    return true;
  },
  getSkill(name) {
    const k = skills.list().find((x) => x.name === name);
    if (!k) return null;
    return { name: k.name, dir: k.dir, content: fs.readFileSync(k.file, 'utf8') };
  },
  saveSkill({ name, content, isNew }) {
    const { meta } = skills.frontmatter(String(content || ''));
    const realName = String(meta.name || name || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(realName))
      return { error: 'Der Name im Kopf (name:) darf nur Kleinbuchstaben, Ziffern und Minus enthalten.' };
    if (!meta.description)
      return { error: 'Im Kopf fehlt „description:“ – daran erkennt das Modell, wann der Skill passt.' };
    let target;
    const existing = skills.list().find((x) => x.name === (isNew ? realName : name));
    if (isNew && existing) return { error: `Es gibt schon einen Skill „${realName}“.` };
    if (existing) target = existing.file;
    else target = path.join(skills.auraDir(), 'skills', realName, 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(content));
    return { ok: true, name: realName };
  },
  deleteSkill(name) {
    const k = skills.list().find((x) => x.name === name);
    // Nur Skills in Auras eigenem Ordner löschen; ~/.agents/skills teilen sich andere Programme.
    if (!k || !k.dir.startsWith(path.join(skills.auraDir(), 'skills')))
      return { error: 'Dieser Skill liegt nicht in ~/.aura/skills und wird hier nicht gelöscht.' };
    fs.rmSync(k.dir, { recursive: true, force: true });
    return { ok: true };
  },

  saveAgentsMd(text) {
    fs.mkdirSync(skills.auraDir(), { recursive: true });
    fs.writeFileSync(skills.agentsFile(), String(text || ''));
    return true;
  },

  // Schlüssel: Werte gehen nur hinein, nie heraus.
  secrets: () => ({
    protection: secrets.protection(),
    allowWeak: !!store.load().allowWeakSecretStorage,
    geminiPlaintext: !!store.load().apiKeyPlaintext,
    list: secrets.list(usedBy())
  }),
  // Linux ohne Schlüsselbund: schwache Speicherung nur nach ausdrücklicher Zustimmung (AURA-93).
  setWeakStorage(allowed) {
    store.save({ allowWeakSecretStorage: !!allowed });
    enableWeakIfAllowed(safeStorage, !!allowed);
    return API.secrets();
  },
  async setSecret({ name, value, note }) {
    try {
      secrets.set(String(name || '').trim(), value, note);
    } catch (e) {
      return { error: e.message };
    }
    try {
      await mcp.sync(true);
    } catch {}
    return API.secrets();
  },
  // Website login (AURA-124): user name + password for one origin, stored together and encrypted.
  setLogin({ name, url, username, password, note } = {}) {
    let origin;
    try {
      const u = new URL(String(url || '').trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      origin = u.origin;
    } catch {
      return { error: 'Bitte die Adresse der Website angeben, z. B. https://www.bahn.de' };
    }
    if (!String(username || '').trim() || !String(password || ''))
      return { error: 'Benutzername und Passwort angeben.' };
    try {
      secrets.set(
        String(name || '').trim(),
        JSON.stringify({ username: String(username).trim(), password: String(password) }),
        note || `Login für ${origin}`,
        { kind: 'login', origin }
      );
    } catch (e) {
      return { error: e.message };
    }
    return API.secrets();
  },
  setSecretNote({ name, note }) {
    secrets.setNote(name, note);
    return API.secrets();
  },
  async deleteSecret(name) {
    secrets.remove(name);
    try {
      await mcp.sync(true);
    } catch {}
    return API.secrets();
  },

  // Profil
  profile: () => ({ ...store.DEFAULT_PROFILE, ...(store.load().profile || {}) }),
  saveProfile(p) {
    const clean = {};
    for (const k of Object.keys(store.DEFAULT_PROFILE))
      clean[k] =
        typeof store.DEFAULT_PROFILE[k] === 'boolean' ? !!(p || {})[k] : String((p || {})[k] || '').slice(0, 2000);
    if (!['profile', 'ip', 'device'].includes(clean.locationMode)) clean.locationMode = 'profile';
    store.save({ profile: clean });
    return API.profile();
  },

  openPath(which) {
    skills.ensureFiles();
    const p =
      which === 'mcp'
        ? mcp.configFile()
        : which === 'skills'
          ? path.join(skills.auraDir(), 'skills')
          : which === 'log'
            ? loop.logFile()
            : skills.auraDir();
    if (which === 'mcp' && !fs.existsSync(p)) writeMcpConfig({});
    if (which === 'log' && !fs.existsSync(p)) fs.writeFileSync(p, '');
    revealOrOpen(p, which === 'mcp' || which === 'log', shell);
    return true;
  },
  openUrl(url) {
    if (/^https:\/\//.test(String(url))) shell.openExternal(String(url));
    return true;
  },
  openWeb: () => require('./web').open(),
  webInfo: () => require('./web').info(),
  resetWeb: () => require('./web').resetToken()
};

function register() {
  for (const name of Object.keys(API)) ipcMain.handle('z:' + name, (_e, arg) => API[name](arg));
}

module.exports = { open, register, configFromRegistry, API, revealOrOpen };
