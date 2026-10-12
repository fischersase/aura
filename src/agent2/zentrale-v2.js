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
  try { return require('electron').app.getPath('userData'); } catch { return process.env.AURA_TEST_USERDATA || ''; }
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

const MEMORY_TEMPLATE = '# Aura-Gedächtnis\n\nDinge, die Aura sich über dich und deinen Rechner gemerkt hat. Du kannst die Datei frei bearbeiten.\n';

const read = (f, fallback = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return fallback; } };
function write(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, String(text ?? ''));
  return true;
}

// Sehr einfache Prüfung der TOML-Regeln: jede [[rule]] braucht tool und decision.
function checkPolicy(text) {
  const problems = [];
  const blocks = String(text).split(/^\s*\[\[rule\]\]\s*$/m).slice(1);
  blocks.forEach((b, i) => {
    const body = b.split(/^\s*\[/m)[0].replace(/^\s*#.*$/gm, '');
    if (!/^\s*tool\s*=/m.test(body)) problems.push(`Regel ${i + 1}: tool fehlt`);
    const d = body.match(/^\s*decision\s*=\s*["']?(\w+)/m);
    if (!d) problems.push(`Regel ${i + 1}: decision fehlt`);
    else if (!['allow', 'ask', 'deny'].includes(d[1])) problems.push(`Regel ${i + 1}: decision muss allow, ask oder deny sein`);
  });
  return problems;
}

// Audit-Ereignisse der letzten Monate, neueste zuerst, in lesbarer Form.
const KINDS = {
  task_start: 'Auftrag', task_end: 'Fertig', approval: 'Freigabe', blocked: 'Gesperrt', tool_start: 'Werkzeug',
  tool_result: 'Ergebnis', tool_error: 'Fehler', tool_unknown: 'Unbekanntes Werkzeug', memory_saved: 'Gemerkt',
  rule_added: 'Regel angelegt', skill_activated: 'Skill', loop_detected: 'Schleife gestoppt', verify_rejected: 'Erfolg korrigiert',
  empty_answer_nudge: 'Leere Antwort', task_cancel: 'Not-Aus', missing_args: 'Ziel fehlte'
};
function readAudit(limit = 400) {
  let files = [];
  try { files = fs.readdirSync(auditDir()).filter((f) => f.endsWith('.jsonl')).sort().slice(-3); } catch { return []; }
  const rows = [];
  for (const f of files) {
    for (const line of read(path.join(auditDir(), f)).split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === 'tool_start') continue; // „Ergebnis“ reicht
        rows.push({
          ts: e.ts, kind: KINDS[e.kind] || e.kind, tool: e.tool || '',
          detail: e.text || e.reason || e.rule || e.fact || e.skill || (e.args ? JSON.stringify(e.args).slice(0, 300) : '') || e.error || '',
          result: e.kind === 'approval' ? e.decision : e.kind === 'tool_result' ? (e.ok ? (e.verified === false ? 'nicht bestätigt' : 'ok') : (e.error || 'Fehler'))
            : e.kind === 'task_end' ? (e.cancelled ? 'abgebrochen' : e.ok ? `ok, ${e.steps} Schritte, ${Math.round((e.ms || 0) / 100) / 10} s` : (e.error || 'Fehler')) : '',
          bad: e.kind === 'blocked' || e.kind === 'tool_error' || (e.kind === 'tool_result' && !e.ok) || (e.kind === 'approval' && e.decision === 'deny')
        });
      } catch {}
    }
  }
  return rows.slice(-limit).reverse();
}

// ---------- Systemprüfung ----------

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() }));
});
const which = async (name) => (await run('which', [name])).ok;

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
    add('Modell', has ? 'ok' : 'bad', has ? `${s.model} ist installiert` : `${s.model} fehlt`, has ? '' : `ollama pull ${s.model}`);
  } catch {
    add('Ollama', 'bad', `nicht erreichbar unter ${s.ollamaUrl}`, 'Ollama starten (ollama.com)');
  }
  add('Kontextlänge', s.numCtx >= 32768 ? 'ok' : 'warn', `${s.numCtx} Tokens`, s.numCtx >= 32768 ? '' : 'In den Einstellungen 32768 wählen; große Webseiten und lange Aufgaben brauchen das.');

  // Agent selbst
  const py = bridge.pythonPath();
  add('Agent v2', py ? 'ok' : 'bad', py ? `Python: ${py}` : 'nicht installiert', py ? '' : 'Aura-Paket neu installieren (make update)');

  // Browser
  const chrome = (await which('google-chrome')) || (await which('google-chrome-stable'));
  add('Chrome', chrome ? 'ok' : 'warn', chrome ? 'installiert' : 'nicht gefunden', chrome ? '' : 'Für den Browser-Spezialisten Google Chrome installieren.');
  const bundled = s.browserCommand && s.browserCommand.length;
  add('Browser-Server', bundled || (await which('npx')) ? 'ok' : 'warn', bundled ? 'mitgeliefert' : 'über npx (Entwicklung)');

  // Barrierefreiheit
  const gi = await run('/usr/bin/python3', ['-c', "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi"]);
  add('Programme bedienen (AT-SPI)', gi.ok ? 'ok' : 'warn', gi.ok ? 'python3-gi und AT-SPI vorhanden' : 'fehlt', gi.ok ? '' : 'sudo apt install python3-gi gir1.2-atspi-2.0');

  // Sitzung und Werkzeuge
  const session = process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'unbekannt');
  add('Sitzung', session === 'x11' ? 'ok' : 'warn', session,
    session === 'x11' ? '' : 'Unter Wayland gehen Fensterliste und Fenstersteuerung noch nicht; Programme, Browser, Dateien und Musik schon.');
  for (const [tool, why, pkg] of [['gio', 'Programme starten, Papierkorb', 'libglib2.0-bin'], ['pactl', 'Lautstärke', 'pulseaudio-utils'],
    ['pdftotext', 'PDFs lesen', 'poppler-utils'], ['xdg-open', 'Webseiten und Dateien öffnen', 'xdg-utils']]) {
    const ok = await which(tool);
    add(tool, ok ? 'ok' : 'warn', ok ? why : `fehlt (${why})`, ok ? '' : `sudo apt install ${pkg}`);
  }
  const mpris = await run('busctl', ['--user', 'list']);
  const players = (mpris.out.match(/org\.mpris\.MediaPlayer2\.\S+/g) || []).length;
  add('Medienplayer (MPRIS)', 'ok', players ? `${players} aktiv` : 'gerade keiner aktiv (das ist normal, wenn nichts spielt)');
  return checks;
}

module.exports = {
  policy: () => ({ file: policyFile(), text: read(policyFile(), POLICY_TEMPLATE) }),
  savePolicy: (text) => { const problems = checkPolicy(text); if (problems.length) return { ok: false, problems }; write(policyFile(), text); return { ok: true }; },
  memory: () => ({ file: memoryFile(), text: read(memoryFile(), MEMORY_TEMPLATE) }),
  saveMemory: (text) => write(memoryFile(), text),
  audit: () => readAudit(),
  doctor,
  checkPolicy
};
