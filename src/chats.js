// Gespeicherte Chats (userData/chats/<id>.json): Verlauf zum Wiederaufnehmen.
// Bildschirmfotos werden nicht gespeichert, nur ein Hinweis darauf.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_CHATS = 200;
const dir = () => path.join(app.getPath('userData'), 'chats');
const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

function stripImages(history) {
  return (history || []).map((c) => ({
    role: c.role === 'model' ? 'model' : 'user',
    parts: (c.parts || []).map((p) => (p.text != null ? { text: String(p.text) } : p.inlineData ? { text: '[Bildschirmfoto]' } : null)).filter(Boolean)
  })).filter((c) => c.parts.length);
}

function titleOf(history) {
  const first = history.find((c) => c.role === 'user');
  const text = first ? first.parts.map((p) => p.text).filter((t) => t && t !== '[Bildschirmfoto]').join(' ') : '';
  return (text.replace(/\s+/g, ' ').trim() || 'Chat').slice(0, 80);
}

function save({ id, history }) {
  const sid = safeId(id);
  if (!sid) return null;
  const h = stripImages(history);
  if (!h.length) return null;
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), sid + '.json');
  let created = Date.now();
  try { created = JSON.parse(fs.readFileSync(file, 'utf8')).created || created; } catch {}
  const chat = { id: sid, title: titleOf(h), created, updated: Date.now(), history: h };
  fs.writeFileSync(file, JSON.stringify(chat));
  prune();
  return { id: sid, title: chat.title, updated: chat.updated };
}

function list() {
  let files = [];
  try { files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
      const last = [...c.history].reverse().find((x) => x.role === 'model');
      out.push({ id: c.id, title: c.title, updated: c.updated, preview: last ? last.parts.map((p) => p.text).join(' ').replace(/\s+/g, ' ').slice(0, 120) : '' });
    } catch {}
  }
  return out.sort((a, b) => b.updated - a.updated);
}

function get(id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(), safeId(id) + '.json'), 'utf8')); } catch { return null; }
}

function remove(id) {
  try { fs.rmSync(path.join(dir(), safeId(id) + '.json'), { force: true }); } catch {}
}

function prune() {
  const all = list();
  for (const c of all.slice(MAX_CHATS)) remove(c.id);
}

module.exports = { save, list, get, remove };
