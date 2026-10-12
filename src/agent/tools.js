// Werkzeuge des Agenten: Befehle, Dateien suchen/lesen/schreiben, öffnen, Bildschirmfoto.
// Jedes Werkzeug sagt selbst, ob es etwas verändert (dann fragt die App vorher nach).
const { shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const input = require('./input');

const IS_WIN = process.platform === 'win32';
const MAX_OUT = 12000; // Zeichen, die ans Modell zurückgehen
const running = new Set(); // laufende Befehle, für die Notbremse

const clip = (s, n = MAX_OUT) => {
  s = String(s || '');
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  return s.slice(0, half) + `\n… (${s.length - n} Zeichen ausgelassen) …\n` + s.slice(-half);
};

// "~", %VAR% und $HOME auflösen; relative Pfade gelten ab dem Benutzerordner.
function expand(p) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return os.homedir();
  if (s === '~' || /^~[\\/]/.test(s)) s = path.join(os.homedir(), s.slice(1));
  s = s.replace(/%([A-Za-z_][\w]*)%/g, (m, v) => process.env[v] ?? m)
    .replace(/\$(HOME|USER)\b/g, (m, v) => (v === 'HOME' ? os.homedir() : process.env.USER || m));
  return path.resolve(os.homedir(), s);
}

function hasCmd(name) {
  try {
    execFileSync(IS_WIN ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------- Nur lesende Befehle laufen ohne Rückfrage ----------

const READONLY = new Set([
  'ls', 'dir', 'pwd', 'whoami', 'hostname', 'date', 'uname', 'uptime', 'df', 'du', 'free', 'cat', 'type', 'head', 'tail',
  'wc', 'which', 'where', 'where.exe', 'file', 'stat', 'find', 'fd', 'fdfind', 'locate', 'plocate', 'grep', 'rg', 'sort', 'uniq',
  'echo', 'lsblk', 'lscpu', 'lsusb', 'lspci', 'ipconfig', 'systeminfo', 'ver', 'tree',
  'id', 'groups', 'lsb_release', 'xdg-user-dir',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'get-itemproperty', 'get-date', 'get-process', 'get-service',
  'get-computerinfo', 'get-volume', 'get-psdrive', 'get-netipaddress', 'get-location', 'select-string', 'select-object',
  'sort-object', 'measure-object', 'format-table', 'format-list', 'test-path', 'resolve-path', 'out-string'
]);
// Schalter, mit denen sonst harmlose Befehle schreiben oder andere Programme starten.
const RISKY_ARGS = {
  find: /(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)(\s|$)/i,
  sort: /(^|\s)(-o|--output)/,
  tree: /(^|\s)-o(\s|$)/,
  fd: /(^|\s)(-x|-X|--exec\S*)(\s|$)/,
  fdfind: /(^|\s)(-x|-X|--exec\S*)(\s|$)/,
  date: /(^|\s)(-s|--set)/
};

// Wie agent/src/aura_agent/policy/shell_classifier.py (AURA-13): keine Programme, die andere starten oder das System
// umstellen (env, ip, hostnamectl, nvidia-smi …), und keine Umgebungsvariablen außer harmlosen (können Schlüssel enthalten).
const SAFE_VARS = new Set(['HOME', 'USER', 'PWD', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']);
function readsEnv(c) {
  if (/(^|[^$\w])env:|\/proc\/[^\s/]+\/environ/i.test(c)) return true; // Laufwerk env: (nicht $env:NAME)
  return [...c.matchAll(/\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)/gi)].some((m) => !SAFE_VARS.has(m[1].toUpperCase()));
}

function isReadOnly(command) {
  const c = String(command || '').trim();
  if (!c || /[;&<>`\n\r]|\$\(|\$\{/.test(c) || readsEnv(c)) return false;
  return c.split('|').every((seg) => {
    const words = seg.trim().split(/\s+/);
    const name = (words[0] || '').toLowerCase();
    const risky = RISKY_ARGS[name];
    return READONLY.has(name) && !(risky && risky.test(words.slice(1).join(' ')));
  });
}

// ---------- Befehl ausführen ----------

function runCommand({ command, cwd, timeoutSec }, { signal }) {
  return new Promise((resolve) => {
    const dir = cwd ? expand(cwd) : os.homedir();
    const ms = Math.min(Math.max(Number(timeoutSec) || 120, 5), 900) * 1000;
    const child = IS_WIN
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + command], { cwd: dir, windowsHide: true })
      : spawn('/bin/bash', ['-lc', command], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let out = '';
    const add = (d) => { if (out.length < 200000) out += d.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; kill(child); }, ms);
    const onAbort = () => kill(child);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = (code, err) => {
      clearTimeout(timer);
      running.delete(child);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        output: clip(out) || '(keine Ausgabe)',
        ...(timedOut ? { note: `Nach ${ms / 1000} s abgebrochen.` } : {}),
        ...(err ? { error: err } : {})
      });
    };
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
}

function kill(child) {
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL'); // ganze Prozessgruppe
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function killAll() {
  for (const c of running) kill(c);
  running.clear();
}

// ---------- Dateien suchen ----------

const SKIP_DIRS = new Set(['node_modules', 'AppData', '$Recycle.Bin', 'Library', 'snap', '__pycache__', 'site-packages', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']);
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|py|java|c|cpp|h|cs|go|rs|rb|php|sh|ps1|bat|ini|cfg|conf|yaml|yml|toml|log|tex|rtf|sql)$/i;

function toMatcher(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return () => true;
  if (/[*?]/.test(q)) {
    const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return (n) => re.test(n);
  }
  const words = q.split(/\s+/);
  return (n) => { const l = n.toLowerCase(); return words.every((w) => l.includes(w)); };
}

async function fileContains(file, text) {
  try {
    const st = await fsp.stat(file);
    if (st.size > 2 * 1024 * 1024) return false;
    return (await fsp.readFile(file, 'utf8')).toLowerCase().includes(text);
  } catch {
    return false;
  }
}

async function findFiles({ name, folder, contains, max }, { signal }) {
  const root = expand(folder);
  const limit = Math.min(Number(max) || 30, 200);
  const match = toMatcher(name);
  const needle = String(contains || '').trim().toLowerCase();
  const found = [];
  const started = Date.now();
  const queue = [root];
  let dirs = 0;
  let partial = false;
  while (queue.length && found.length < limit) {
    if (signal && signal.aborted) break;
    if (Date.now() - started > 15000 || dirs > 60000) { partial = true; break; }
    const dir = queue.shift();
    dirs++;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) queue.push(full);
        if (!needle && match(e.name)) found.push(full + path.sep);
      } else if (match(e.name)) {
        if (needle && !(TEXT_EXT.test(e.name) && await fileContains(full, needle))) continue;
        found.push(full);
      }
      if (found.length >= limit) break;
    }
  }
  const results = await Promise.all(found.map(async (f) => {
    try {
      const st = await fsp.stat(f);
      return { path: f, size: st.isDirectory() ? undefined : st.size, modified: st.mtime.toISOString().slice(0, 16).replace('T', ' ') };
    } catch {
      return { path: f };
    }
  }));
  return { root, count: results.length, results, ...(partial ? { note: 'Suche aus Zeitgründen nicht vollständig, ggf. Ordner genauer angeben.' } : {}) };
}

// ---------- Ordner und Dateien lesen ----------

async function listFolder({ path: p }) {
  const dir = expand(p);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = await Promise.all(entries.slice(0, 300).map(async (e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return { name: e.name + '/', type: 'Ordner' };
    try {
      const st = await fsp.stat(full);
      return { name: e.name, size: st.size, modified: st.mtime.toISOString().slice(0, 10) };
    } catch {
      return { name: e.name };
    }
  }));
  return { path: dir, count: entries.length, items };
}

async function readFile({ path: p, offset }) {
  const file = expand(p);
  const st = await fsp.stat(file);
  if (st.isDirectory()) return listFolder({ path: file });
  let text;
  if (/\.pdf$/i.test(file)) {
    if (!hasCmd('pdftotext')) return { error: 'PDF lesen braucht das Programm pdftotext (Paket poppler-utils).' };
    text = execFileSync('pdftotext', ['-layout', file, '-'], { maxBuffer: 50 * 1024 * 1024 }).toString();
  } else {
    if (st.size > 20 * 1024 * 1024) return { error: `Datei ist zu groß (${Math.round(st.size / 1048576)} MB).` };
    const buf = await fsp.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { error: 'Das ist keine Textdatei; Inhalt kann ich nicht lesen.', size: st.size };
    text = buf.toString('utf8');
  }
  const start = Math.max(0, Number(offset) || 0);
  const chunk = text.slice(start, start + 20000);
  return {
    path: file,
    totalChars: text.length,
    content: chunk,
    ...(start + chunk.length < text.length ? { more: `Weiter mit offset ${start + chunk.length}` } : {})
  };
}

async function writeFile({ path: p, content, append }) {
  const file = expand(p);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (append) await fsp.appendFile(file, String(content ?? ''));
  else await fsp.writeFile(file, String(content ?? ''));
  return { ok: true, path: file, bytes: Buffer.byteLength(String(content ?? '')) };
}

// ---------- Öffnen: Ordner, Dateien, Webseiten, Programme ----------

const EXEC_EXT = /\.(exe|bat|cmd|com|ps1|vbs|js|msi|scr|sh|run|appimage|jar|py)$/i;

function desktopEntries() {
  const dirs = [
    '/usr/share/applications', '/usr/local/share/applications', path.join(os.homedir(), '.local/share/applications'),
    '/var/lib/flatpak/exports/share/applications', path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
    '/var/lib/snapd/desktop/applications'
  ];
  const apps = [];
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      try {
        const txt = fs.readFileSync(path.join(d, f), 'utf8');
        const sec = txt.split(/^\[/m).find((s) => s.startsWith('Desktop Entry]')) || '';
        const get = (k) => { const m = sec.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
        if (/true/i.test(get('NoDisplay')) || /true/i.test(get('Hidden'))) continue;
        const names = [get('Name'), get('Name\\[de\\]'), get('GenericName'), get('GenericName\\[de\\]'), get('Keywords'), f.replace(/\.desktop$/, '')];
        apps.push({ id: f.replace(/\.desktop$/, ''), file: path.join(d, f), name: get('Name'), names: names.filter(Boolean).join(' ').toLowerCase(), exec: get('Exec') });
      } catch {}
    }
  }
  return apps;
}

function startMenuLinks() {
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs')
  ];
  const out = [];
  const walk = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) out.push({ file: full, name: e.name.replace(/\.(lnk|url|appref-ms)$/i, ''), names: e.name.toLowerCase() });
    }
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

// Programme, die Windows ohne Startmenü-Eintrag mitbringt.
const WIN_BUILTIN = { notepad: 'notepad.exe', editor: 'notepad.exe', rechner: 'calc.exe', calc: 'calc.exe', paint: 'mspaint.exe', explorer: 'explorer.exe', 'datei-explorer': 'explorer.exe', terminal: 'wt.exe', powershell: 'powershell.exe', cmd: 'cmd.exe', 'task-manager': 'taskmgr.exe', taskmanager: 'taskmgr.exe', systemsteuerung: 'control.exe', einstellungen: 'ms-settings:' };

function bestMatch(items, query) {
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/);
  const scored = items.map((a) => {
    const n = (a.name || '').toLowerCase();
    let s = 0;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 60;
    else if (n.includes(q)) s = 40;
    else if (words.every((w) => a.names.includes(w))) s = 20;
    return { a, s: s ? s - n.length / 100 : 0 };
  }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  return scored.map((x) => x.a);
}

function launchApp(query) {
  if (IS_WIN) {
    const hits = bestMatch(startMenuLinks(), query);
    if (hits.length) {
      shell.openPath(hits[0].file);
      return { opened: hits[0].name, via: 'Startmenü', alternatives: hits.slice(1, 5).map((h) => h.name) };
    }
    const b = WIN_BUILTIN[query.toLowerCase().trim()];
    if (b) {
      if (b.endsWith(':')) shell.openExternal(b);
      else spawn('cmd.exe', ['/c', 'start', '', b], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return { opened: b };
    }
  } else {
    const hits = bestMatch(desktopEntries(), query);
    if (hits.length) {
      const h = hits[0];
      if (hasCmd('gtk-launch')) spawn('gtk-launch', [h.id], { detached: true, stdio: 'ignore' }).unref();
      else if (hasCmd('gio')) spawn('gio', ['launch', h.file], { detached: true, stdio: 'ignore' }).unref();
      else spawn('/bin/sh', ['-c', h.exec.replace(/%[a-zA-Z]/g, '').trim()], { detached: true, stdio: 'ignore' }).unref();
      return { opened: h.name, alternatives: hits.slice(1, 5).map((x) => x.name) };
    }
  }
  return { error: `Kein installiertes Programm „${query}“ gefunden. Prüfe den Namen oder nutze run_command.` };
}

async function open({ target }) {
  const t = String(target || '').trim();
  if (/^(https?:|mailto:|ms-settings:)/i.test(t)) {
    await shell.openExternal(t);
    return { opened: t };
  }
  const looksLikePath = /[\\/]/.test(t) || /^~/.test(t) || /^[a-z]:/i.test(t) || /\.[a-z0-9]{1,5}$/i.test(t);
  {
    const p = expand(t); // auch ein bloßer Name, falls es ihn im Benutzerordner gibt
    if (fs.existsSync(p)) {
      const err = await shell.openPath(p);
      return err ? { error: err } : { opened: p };
    }
    if (looksLikePath && /[\\/]/.test(t)) return { error: `Pfad nicht gefunden: ${p}` };
  }
  return launchApp(t);
}

// ---------- Werkzeugliste ----------

const TOOLS = [
  {
    name: 'run_command',
    description: IS_WIN
      ? 'Führt einen PowerShell-Befehl auf dem Windows-PC des Nutzers aus und gibt die Ausgabe zurück. Für Systeminfos, Programme verwalten, Dateien bearbeiten usw.'
      : 'Führt einen Befehl in bash auf dem Linux-PC des Nutzers aus und gibt die Ausgabe zurück. Für Systeminfos, Programme verwalten, Dateien bearbeiten usw.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Der Befehl' },
        cwd: { type: 'string', description: 'Arbeitsordner (Standard: Benutzerordner)' },
        timeoutSec: { type: 'number', description: 'Abbruch nach so vielen Sekunden (Standard 120)' }
      },
      required: ['command']
    },
    changes: (a) => !isReadOnly(a.command),
    label: (a) => a.command,
    run: runCommand
  },
  {
    name: 'find_files',
    description: 'Sucht Dateien und Ordner nach Namen (Teilwörter oder Muster wie *.pdf), optional nur Textdateien mit bestimmtem Inhalt.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Teil des Namens oder Muster, z. B. "rechnung" oder "*.docx"' },
        folder: { type: 'string', description: 'Wo gesucht wird (Standard: Benutzerordner), z. B. ~/Dokumente' },
        contains: { type: 'string', description: 'Nur Textdateien, die diesen Text enthalten' },
        max: { type: 'number', description: 'Höchstzahl Treffer (Standard 30)' }
      }
    },
    changes: () => false,
    label: (a) => [a.name, a.contains && `„${a.contains}“`, a.folder && `in ${a.folder}`].filter(Boolean).join(' ') || 'Dateien',
    run: findFiles
  },
  {
    name: 'list_folder',
    description: 'Listet den Inhalt eines Ordners auf.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ordner, z. B. ~/Downloads' } }, required: ['path'] },
    changes: () => false,
    label: (a) => a.path,
    run: listFolder
  },
  {
    name: 'read_file',
    description: 'Liest eine Textdatei oder PDF (bis 20.000 Zeichen pro Aufruf).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'number', description: 'Ab diesem Zeichen weiterlesen' } },
      required: ['path']
    },
    changes: () => false,
    label: (a) => a.path,
    run: readFile
  },
  {
    name: 'write_file',
    description: 'Schreibt Text in eine Datei (legt sie an oder ersetzt sie; mit append=true anhängen).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } },
      required: ['path', 'content']
    },
    changes: () => true,
    label: (a) => (a.append ? '+ ' : '') + a.path,
    detail: (a) => clip(a.content, 1500),
    run: writeFile
  },
  {
    name: 'open',
    description: 'Öffnet einen Ordner, eine Datei, eine Webseite (https://…) oder startet ein installiertes Programm per Name (z. B. "Firefox", "Rechner", "Spotify").',
    parameters: { type: 'object', properties: { target: { type: 'string', description: 'Pfad, URL oder Programmname' } }, required: ['target'] },
    changes: (a) => EXEC_EXT.test(String(a.target || '').trim()), // Skripte und .exe nur mit Freigabe
    label: (a) => a.target,
    run: open
  },
  {
    name: 'screenshot',
    description: 'Macht ein Bildschirmfoto, damit du siehst, was gerade auf dem Bildschirm ist.',
    parameters: { type: 'object', properties: {} },
    changes: () => false,
    label: () => 'Bildschirm',
    run: async (_a, ctx) => ({ ok: true, image: await ctx.screenshot() })
  }
];

// ---------- Programme bedienen (Maus und Tastatur) ----------

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const coord = { type: 'number', description: '0 bis 1000 im letzten Bildschirmfoto' };

// Nach jeder Eingabe ein frisches Bildschirmfoto, damit das Modell das Ergebnis sieht.
async function withShot(result, ctx) {
  if (result.error) return result;
  await settle();
  try { return { ...result, image: await ctx.screenshot() }; } catch { return result; }
}

TOOLS.push(
  {
    name: 'click',
    description: 'Klickt mit der Maus auf eine Stelle des Bildschirms. x und y von 0 bis 1000 bezogen auf das letzte Bildschirmfoto (0,0 = oben links). Vorher immer ein Bildschirmfoto machen. Danach kommt automatisch ein neues Bildschirmfoto zurück.',
    parameters: {
      type: 'object',
      properties: { x: coord, y: coord, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean', description: 'Doppelklick' }, what: { type: 'string', description: 'Worauf geklickt wird, z. B. "Speichern-Knopf"' } },
      required: ['x', 'y', 'what']
    },
    changes: () => true,
    label: (a) => `${a.what || 'Stelle'} (${Math.round(a.x)}, ${Math.round(a.y)})${a.double ? ', doppelt' : ''}${a.button === 'right' ? ', rechts' : ''}`,
    run: async (a, ctx) => {
      const p = ctx.toScreen(Number(a.x), Number(a.y));
      return withShot(await input.click(p.x, p.y, { button: a.button, double: !!a.double }), ctx);
    }
  },
  {
    name: 'type_text',
    description: 'Tippt Text in das gerade aktive Eingabefeld (vorher hineinklicken). Zeilenumbrüche werden zu Enter.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    changes: () => true,
    label: (a) => clip(a.text, 200),
    run: async (a, ctx) => withShot(await input.typeText(a.text), ctx)
  },
  {
    name: 'press_keys',
    description: 'Drückt eine Taste oder Tastenkombination im aktiven Fenster, z. B. "enter", "ctrl+s", "alt+tab", "ctrl+shift+t", "f5".',
    parameters: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] },
    changes: () => true,
    label: (a) => a.keys,
    run: async (a, ctx) => withShot(await input.pressKeys(a.keys), ctx)
  }
);

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

module.exports = { TOOLS, byName, killAll, isReadOnly, expand };
