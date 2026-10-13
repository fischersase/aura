// „Aura Zentrale“: Verwaltungsfenster für Werkzeuge, MCP-Server, Skills, Anweisungen, Protokoll und Chats.
const { BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const chats = require('./chats');
const tools = require('./agent/tools');
const skills = require('./agent/skills');
const mcp = require('./agent/mcp');
const loop = require('./agent/loop');
const secrets = require('./secrets');

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers';
let win = null;

function open(icon) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'Aura Zentrale',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#1b1c1d',
    webPreferences: { preload: path.join(__dirname, 'preload-zentrale.js'), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'zentrale.html'));
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

async function state(force) {
  try {
    await mcp.sync(!!force);
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
  const servers = Object.entries(cfg).map(([name, c]) => ({
    name,
    type: c.url ? 'http' : 'stdio',
    command: c.url ? c.url : [c.command, ...(c.args || [])].join(' '),
    env: Object.keys(c.env || {}),
    disabled: !!c.disabled,
    plainSecrets: plainSecrets(c),
    secretRefs: secrets.refsIn(c),
    error: status[name] ? status[name].error : null,
    running: !!(status[name] && !status[name].error),
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
// Ohne Verschlüsselung (Linux ohne Schlüsselbund) bleibt die Konfiguration wie eingegeben; die Oberfläche warnt dann.
function protectConfig(serverName, cfg) {
  if (secrets.protection() === 'none') return cfg;
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

const API = {
  state: (force) => state(force),
  log: () => readLog(),
  chats: () => chats.list(),
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
        if (typeof x === 'object' && x && x.secret && value && secrets.protection() !== 'none') {
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
    all[n] = cfg;
    writeMcpConfig(all);
    return { name: n, state: await state(true) };
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
  secrets: () => ({ protection: secrets.protection(), list: secrets.list(usedBy()) }),
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
    shell.openPath(p);
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

module.exports = { open, register, configFromRegistry, API };
