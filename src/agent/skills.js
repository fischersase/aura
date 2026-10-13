// Skills im Agent-Skills-Format (agentskills.io): Ordner mit SKILL.md, oben name + description.
// Das Modell sieht nur Name und Beschreibung und lädt den Rest bei Bedarf mit activate_skill.
// Eigene Anweisungen für Aura stehen in ~/.aura/AGENTS.md.
const fs = require('fs');
const os = require('os');
const path = require('path');

const auraDir = () => path.join(os.homedir(), '.aura');
const skillDirs = () => [path.join(auraDir(), 'skills'), path.join(os.homedir(), '.agents', 'skills')];
const agentsFile = () => path.join(auraDir(), 'AGENTS.md');

function frontmatter(text) {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].replace(/^["']|["']$/g, '').replace(/^[>|]-?$/, '');
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = (meta[key] ? meta[key] + ' ' : '') + line.trim(); // mehrzeiliger Wert
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

function list() {
  const seen = new Map();
  for (const dir of skillDirs()) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      try {
        const { meta } = frontmatter(fs.readFileSync(file, 'utf8'));
        const name = (meta.name || e.name).trim();
        if (!seen.has(name)) seen.set(name, { name, description: (meta.description || '').trim().slice(0, 500), dir: path.join(dir, e.name), file });
      } catch {}
    }
  }
  return [...seen.values()];
}

function filesIn(dir, base = dir, depth = 0, out = []) {
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (out.length >= 50) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 2) filesIn(full, base, depth + 1, out);
    else if (e.isFile() && e.name !== 'SKILL.md') out.push(path.relative(base, full));
  }
  return out;
}

function activate(name) {
  const s = active().find((x) => x.name === name);
  if (!s) return { error: `Skill „${name}“ gibt es nicht. Verfügbar: ${active().map((x) => x.name).join(', ') || 'keine'}` };
  const { body } = frontmatter(fs.readFileSync(s.file, 'utf8'));
  return {
    skill: s.name,
    folder: s.dir,
    instructions: body.slice(0, 30000),
    files: filesIn(s.dir),
    note: 'Pfade in den Anweisungen beziehen sich auf den Skill-Ordner. Weitere Dateien mit read_file lesen; Skripte nur über run_command.'
  };
}

// HTML-Kommentare entfernen, wiederholt bis nichts mehr übrig ist (auch verschachtelte wie "<!-<!-- -->-->").
function stripComments(t) {
  let prev;
  do { prev = t; t = t.replace(/<!--[\s\S]*?-->/g, ''); } while (t !== prev);
  return t;
}

function agentsMd() {
  try {
    const t = stripComments(fs.readFileSync(agentsFile(), 'utf8')).trim();
    return t.replace(/^#.*$/gm, '').trim() ? t.slice(0, 20000) : ''; // nur Überschrift = leer
  } catch {
    return '';
  }
}

// In der Zentrale ausgeschaltete Skills sieht das Modell nicht.
function active() {
  const off = new Set(require('../store').load().disabledSkills || []);
  return list().filter((s) => !off.has(s.name));
}

// Ergänzung für den System-Prompt.
function promptAddon() {
  const parts = [];
  const md = agentsMd();
  if (md) parts.push('Anweisungen des Nutzers (AGENTS.md):\n' + md);
  const skills = active();
  if (skills.length) {
    parts.push('Verfügbare Skills (vor Gebrauch mit activate_skill laden, wenn einer zur Aufgabe passt):\n' +
      skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'));
  }
  return parts.join('\n\n');
}

function tool() {
  const skills = active();
  if (!skills.length) return null;
  return {
    name: 'activate_skill',
    description: 'Lädt die vollständige Anleitung eines Skills, wenn er zur Aufgabe passt.',
    parameters: { type: 'object', properties: { name: { type: 'string', enum: skills.map((s) => s.name) } }, required: ['name'] },
    changes: () => false,
    label: (a) => a.name,
    run: async (a) => activate(a.name)
  };
}

function ensureFiles() {
  fs.mkdirSync(path.join(auraDir(), 'skills'), { recursive: true });
  if (!fs.existsSync(agentsFile())) {
    fs.writeFileSync(agentsFile(), '# Anweisungen für Aura\n\n<!-- Schreib hier, was Aura immer wissen oder beachten soll, z. B.:\n' +
      '- Meine Dokumente liegen in ~/Dokumente/Ablage.\n- Antworte per Du und kurz.\nText in diesen Kommentarklammern wird ignoriert. -->\n');
  }
}

module.exports = { list, active, activate, promptAddon, tool, ensureFiles, auraDir, agentsFile, frontmatter };
