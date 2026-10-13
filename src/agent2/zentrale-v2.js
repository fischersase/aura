// Zentrale-Seiten für Agent v2: Regeln (policy.toml), Gedächtnis (MEMORY.md), Protokoll (Audit) und Systemprüfung.
// Liest und schreibt die Dateien direkt; der Agent lädt sie beim nächsten Auftrag neu.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auraDir = () => path.join(os.homedir(), '.aura');
const policyFile = () => path.join(auraDir(), 'policy.toml');
const memoryFile = () => path.join(auraDir(), 'memory', 'MEMORY.md');
// Electron erst bei Bedarf laden, damit sich das Modul auch ohne Electron testen lässt.
function userData() {
  try {
    return require('electron').app.getPath('userData');
  } catch {
    return process.env.AURA_TEST_USERDATA || '';
  }
}
const auditDir = () => path.join(userData(), 'agent', 'audit');

const POLICY_TEMPLATE = `# Regeln für Aura (Agent v2). Reihenfolge: deny vor ask vor allow.
# Gesperrtes (Zugangsdaten, Systemzerstörung) kann keine Regel freigeben.
#
# Beispiele:
# [[rule]]
# tool = "run_command"            # Werkzeugname, * und ? erlaubt
# match = '^git (pull|fetch)\\b'   # optional: regulärer Ausdruck auf die Beschreibung (bei Befehlen: der Befehl)
# decision = "allow"              # allow = ohne Rückfrage, ask = immer fragen, deny = nie
#
# [[rule]]
# tool = "browser_*"
# match = 'paypal|bank'
# decision = "deny"
`;

const MEMORY_TEMPLATE =
  '# Aura-Gedächtnis\n\nDinge, die Aura sich über dich und deinen Rechner gemerkt hat. Du kannst die Datei frei bearbeiten.\n';

const read = (f, fallback = '') => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return fallback;
  }
};
function write(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, String(text ?? ''));
  return true;
}

// Sehr einfache Prüfung der TOML-Regeln: jede [[rule]] braucht tool und decision.
function checkPolicy(text) {
  const problems = [];
  const blocks = String(text)
    .split(/^\s*\[\[rule\]\]\s*$/m)
    .slice(1);
  blocks.forEach((b, i) => {
    const body = b.split(/^\s*\[/m)[0].replace(/^\s*#.*$/gm, '');
    if (!/^\s*tool\s*=/m.test(body)) problems.push(`Regel ${i + 1}: tool fehlt`);
    const d = body.match(/^\s*decision\s*=\s*["']?(\w+)/m);
    if (!d) problems.push(`Regel ${i + 1}: decision fehlt`);
    else if (!['allow', 'ask', 'deny'].includes(d[1]))
      problems.push(`Regel ${i + 1}: decision muss allow, ask oder deny sein`);
  });
  return problems;
}

// Audit-Ereignisse der letzten Monate, neueste zuerst, in lesbarer Form.
const KINDS = {
  task_start: 'Auftrag',
  task_end: 'Fertig',
  approval: 'Freigabe',
  blocked: 'Gesperrt',
  tool_start: 'Werkzeug',
  tool_result: 'Ergebnis',
  tool_error: 'Fehler',
  tool_unknown: 'Unbekanntes Werkzeug',
  memory_saved: 'Gemerkt',
  rule_added: 'Regel angelegt',
  skill_activated: 'Skill',
  loop_detected: 'Schleife gestoppt',
  verify_rejected: 'Erfolg korrigiert',
  empty_answer_nudge: 'Leere Antwort',
  task_cancel: 'Not-Aus',
  missing_args: 'Ziel fehlte'
};
function readAudit(limit = 400) {
  let files;
  try {
    files = fs
      .readdirSync(auditDir())
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .slice(-3);
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files) {
    for (const line of read(path.join(auditDir(), f)).split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === 'tool_start') continue; // „Ergebnis“ reicht
        rows.push({
          ts: e.ts,
          kind: KINDS[e.kind] || e.kind,
          tool: e.tool || '',
          detail:
            e.text ||
            e.reason ||
            e.rule ||
            e.fact ||
            e.skill ||
            (e.args ? JSON.stringify(e.args).slice(0, 300) : '') ||
            e.error ||
            '',
          result:
            e.kind === 'approval'
              ? e.decision
              : e.kind === 'tool_result'
                ? e.ok
                  ? e.verified === false
                    ? 'nicht bestätigt'
                    : 'ok'
                  : e.error || 'Fehler'
                : e.kind === 'task_end'
                  ? e.cancelled
                    ? 'abgebrochen'
                    : e.ok
                      ? `ok, ${e.steps} Schritte, ${Math.round((e.ms || 0) / 100) / 10} s`
                      : e.error || 'Fehler'
                  : '',
          bad:
            e.kind === 'blocked' ||
            e.kind === 'tool_error' ||
            (e.kind === 'tool_result' && !e.ok) ||
            (e.kind === 'approval' && e.decision === 'deny')
        });
      } catch {}
    }
  }
  return rows.slice(-limit).reverse();
}

// ---------- GNOME-Erweiterung für Fenster unter Wayland ----------

const EXT_UUID = 'aura-bridge@aura';
const extTarget = () => path.join(os.homedir(), '.local', 'share', 'gnome-shell', 'extensions', EXT_UUID);
function extSource() {
  const packaged = path.join(process.resourcesPath || '', 'gnome-extension', EXT_UUID);
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'gnome-extension', EXT_UUID);
}

async function installExtension() {
  const src = extSource();
  if (!fs.existsSync(src)) return { ok: false, message: 'Erweiterung nicht im Paket gefunden.' };
  fs.mkdirSync(path.dirname(extTarget()), { recursive: true });
  fs.cpSync(src, extTarget(), { recursive: true });
  const r = await run('gnome-extensions', ['enable', EXT_UUID]);
  return {
    ok: true,
    message: r.ok
      ? 'Installiert und eingeschaltet. Bitte einmal ab- und wieder anmelden, damit GNOME sie lädt.'
      : 'Installiert. Nach dem Ab- und Anmelden unter „Erweiterungen“ einschalten (oder: gnome-extensions enable aura-bridge@aura).'
  };
}

// ---------- Systemprüfung ----------

const IS_WIN = process.platform === 'win32';
const run = (cmd, args, timeout = 8000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() })
    );
  });
const which = async (name) => (await run(IS_WIN ? 'where' : 'which', [name])).ok;

// Windows: Chrome steht nicht im PATH; der Agent nimmt Chrome, sonst Edge (wie tools/browser.py).
function windowsBrowser() {
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const has = (...p) => bases.some((b) => fs.existsSync(path.join(b, ...p)));
  if (has('Google', 'Chrome', 'Application', 'chrome.exe')) return 'Chrome';
  if (has('Microsoft', 'Edge', 'Application', 'msedge.exe')) return 'Edge';
  return '';
}

async function doctor({ settings, bridge }) {
  const s = settings();
  const checks = [];
  const add = (name, state, detail, fix = '') => checks.push({ name, state, detail, fix });

  // Ollama und Modell
  try {
    const res = await fetch(`${s.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const tags = (await res.json()).models || [];
    add('Ollama', 'ok', `läuft unter ${s.ollamaUrl}`);
    const has = tags.some((m) => m.name === s.model || m.name === `${s.model}:latest`);
    add(
      'Modell',
      has ? 'ok' : 'bad',
      has ? `${s.model} ist installiert` : `${s.model} fehlt`,
      has ? '' : `ollama pull ${s.model}`
    );
  } catch {
    add('Ollama', 'bad', `nicht erreichbar unter ${s.ollamaUrl}`, 'Ollama starten (ollama.com)');
  }
  add(
    'Kontextlänge',
    s.numCtx >= 32768 ? 'ok' : 'warn',
    `${s.numCtx} Tokens`,
    s.numCtx >= 32768 ? '' : 'In den Einstellungen 32768 wählen; große Webseiten und lange Aufgaben brauchen das.'
  );

  // Agent selbst
  const py = bridge.pythonPath();
  add(
    'Agent v2',
    py ? 'ok' : 'bad',
    py ? `Python: ${py}` : 'nicht installiert',
    py ? '' : IS_WIN ? 'Aura-Setup.exe neu ausführen' : 'Aura-Paket neu installieren (make update)'
  );

  // Browser
  if (IS_WIN) {
    const b = windowsBrowser();
    add(
      'Browser',
      b ? 'ok' : 'warn',
      b ? `${b} wird benutzt` : 'weder Chrome noch Edge gefunden',
      b ? '' : 'Google Chrome installieren.'
    );
  } else {
    const chrome = (await which('google-chrome')) || (await which('google-chrome-stable'));
    add(
      'Chrome',
      chrome ? 'ok' : 'warn',
      chrome ? 'installiert' : 'nicht gefunden',
      chrome ? '' : 'Für den Browser-Spezialisten Google Chrome installieren.'
    );
  }
  const bundled = s.browserCommand && s.browserCommand.length;
  add(
    'Browser-Server',
    bundled || (await which('npx')) ? 'ok' : 'warn',
    bundled ? 'mitgeliefert' : 'über npx (Entwicklung)'
  );

  if (IS_WIN) {
    add('Programme bedienen (UI Automation)', 'ok', 'in Windows eingebaut');
    add('Medien (Windows-Mediensteuerung)', 'ok', 'in Windows eingebaut');
    add('Sitzung', 'ok', 'Windows');
    const pdf = await which('pdftotext');
    add(
      'pdftotext',
      pdf ? 'ok' : 'warn',
      pdf ? 'PDFs lesen' : 'fehlt (PDFs lesen)',
      pdf ? '' : 'winget install oschwartz10612.Poppler'
    );
    return checks;
  }

  // Barrierefreiheit
  const gi = await run('/usr/bin/python3', [
    '-c',
    "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi"
  ]);
  add(
    'Programme bedienen (AT-SPI)',
    gi.ok ? 'ok' : 'warn',
    gi.ok ? 'python3-gi und AT-SPI vorhanden' : 'fehlt',
    gi.ok ? '' : 'sudo apt install python3-gi gir1.2-atspi-2.0'
  );

  // Sitzung und Werkzeuge
  const session =
    process.env.XDG_SESSION_TYPE ||
    (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'unbekannt');
  if (session === 'wayland') {
    const bridge = await run('gdbus', [
      'introspect',
      '--session',
      '--dest',
      'org.aura.Bridge',
      '--object-path',
      '/org/aura/Bridge'
    ]);
    const installed = fs.existsSync(extTarget());
    add('Sitzung', 'ok', 'wayland');
    if (bridge.ok) add('Fenster unter Wayland', 'ok', 'Erweiterung „Aura Bridge“ läuft');
    else
      checks.push({
        name: 'Fenster unter Wayland',
        state: 'warn',
        action: 'installExtension',
        detail: installed ? 'Erweiterung installiert, aber nicht aktiv' : 'Erweiterung „Aura Bridge“ fehlt',
        fix: installed
          ? 'Ab- und anmelden; falls nötig: gnome-extensions enable aura-bridge@aura'
          : 'Knopf „Installieren“, danach ab- und anmelden'
      });
  } else {
    add(
      'Sitzung',
      session === 'x11' ? 'ok' : 'warn',
      session,
      session === 'x11' ? '' : 'Unbekannte Sitzung; Fenstersteuerung evtl. nicht verfügbar.'
    );
  }
  for (const [tool, why, pkg] of [
    ['gio', 'Programme starten, Papierkorb', 'libglib2.0-bin'],
    ['pactl', 'Lautstärke', 'pulseaudio-utils'],
    ['pdftotext', 'PDFs lesen', 'poppler-utils'],
    ['xdg-open', 'Webseiten und Dateien öffnen', 'xdg-utils']
  ]) {
    const ok = await which(tool);
    add(tool, ok ? 'ok' : 'warn', ok ? why : `fehlt (${why})`, ok ? '' : `sudo apt install ${pkg}`);
  }
  const mpris = await run('busctl', ['--user', 'list']);
  const players = (mpris.out.match(/org\.mpris\.MediaPlayer2\.\S+/g) || []).length;
  add(
    'Medienplayer (MPRIS)',
    'ok',
    players ? `${players} aktiv` : 'gerade keiner aktiv (das ist normal, wenn nichts spielt)'
  );
  return checks;
}

module.exports = {
  policy: () => ({ file: policyFile(), text: read(policyFile(), POLICY_TEMPLATE) }),
  savePolicy: (text) => {
    const problems = checkPolicy(text);
    if (problems.length) return { ok: false, problems };
    write(policyFile(), text);
    return { ok: true };
  },
  memory: () => ({ file: memoryFile(), text: read(memoryFile(), MEMORY_TEMPLATE) }),
  saveMemory: (text) => write(memoryFile(), text),
  audit: () => readAudit(),
  doctor,
  installExtension,
  checkPolicy
};
