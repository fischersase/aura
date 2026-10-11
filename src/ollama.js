// Lokale Modelle über Ollama (http://127.0.0.1:11434): Chat, Rambler-Nachbearbeitung, Live-Antworten.
const DEFAULT_URL = 'http://127.0.0.1:11434';

// Vorschläge für die Auswahl; alle außer DeepSeek verstehen Bilder (für Live und Bildschirm im Chat).
const RECOMMENDED = [
  { name: 'gemma4:e4b', label: 'Gemma 4 E4B (Google)', ram: '16 GB RAM oder 8 GB Grafikspeicher', vision: true },
  { name: 'gemma4:e2b', label: 'Gemma 4 E2B (Google, klein)', ram: '8 GB RAM', vision: true },
  { name: 'qwen3.5:9b', label: 'Qwen 3.5 9B (Alibaba)', ram: '16 GB RAM oder 8 GB Grafikspeicher', vision: true },
  { name: 'qwen3-vl:8b', label: 'Qwen3-VL 8B (Alibaba, stark beim Zeigen)', ram: '16 GB RAM oder 8 GB Grafikspeicher', vision: true },
  { name: 'gemma4:26b', label: 'Gemma 4 26B (Google, groß)', ram: '24 GB Grafikspeicher oder 32 GB RAM', vision: true },
  { name: 'qwen3.6:27b', label: 'Qwen 3.6 27B (Alibaba, stark als Agent)', ram: '24 GB Grafikspeicher', vision: true },
  { name: 'gemma4:31b', label: 'Gemma 4 31B (Google, stark als Agent)', ram: '24 GB Grafikspeicher', vision: true },
  { name: 'deepseek-r1:8b', label: 'DeepSeek R1 8B (nur Text)', ram: '16 GB RAM', vision: false }
];

class OllamaError extends Error {}

const base = (url) => String(url || DEFAULT_URL).replace(/\/+$/, '');

async function request(url, path, opts = {}) {
  let res;
  try {
    res = await fetch(base(url) + path, opts);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new OllamaError(`Ollama ist unter ${base(url)} nicht erreichbar. Läuft Ollama? (ollama.com)`);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new OllamaError(msg);
  }
  return res;
}

async function version(url) {
  const res = await request(url, '/api/version');
  return (await res.json()).version || '';
}

async function listModels(url) {
  const res = await request(url, '/api/tags');
  const j = await res.json();
  return (j.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details && m.details.family }));
}

async function* ndjson(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch {}
    }
  }
  if (buf.trim()) { try { yield JSON.parse(buf); } catch {} }
}

// Lädt ein Modell herunter; onProgress({ status, completed, total }).
async function pull(url, name, onProgress, signal) {
  const res = await request(url, '/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    signal
  });
  for await (const j of ndjson(res)) {
    if (j.error) throw new OllamaError(j.error);
    onProgress && onProgress(j);
  }
}

// Gemini-Verlauf ({ role, parts: [{ text } | { inlineData }] }) → Ollama-Nachrichten.
function toMessages(history, system) {
  const msgs = system ? [{ role: 'system', content: system }] : [];
  for (const c of history) {
    const text = [];
    const images = [];
    for (const p of c.parts || []) {
      if (p.text) text.push(p.text);
      else if (p.inlineData && /^image\//.test(p.inlineData.mimeType)) images.push(p.inlineData.data);
    }
    const m = { role: c.role === 'model' ? 'assistant' : 'user', content: text.join('\n') };
    if (images.length) m.images = images;
    msgs.push(m);
  }
  return msgs;
}

// /api/chat mit Streaming. "think: false" hält Qwen/DeepSeek kurz; Modelle ohne Denkmodus
// lehnen den Schalter teils ab, dann ohne ihn wiederholen.
async function chat(opts) {
  return (await chatFull(opts)).content;
}

// Wie chat, aber mit Werkzeugen: liefert Text und die Werkzeugaufrufe des Modells.
async function chatFull({ url, model, messages, format, tools, signal, onText }) {
  const body = { model, messages, stream: true, think: false, keep_alive: '30m' };
  if (format) body.format = format;
  if (tools && tools.length) body.tools = tools;
  let res;
  try {
    res = await request(url, '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (!(err instanceof OllamaError) || !/think/i.test(err.message)) throw err;
    delete body.think;
    res = await request(url, '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  }
  let full = '';
  const toolCalls = [];
  for await (const j of ndjson(res)) {
    if (j.error) throw new OllamaError(j.error);
    const t = j.message && j.message.content;
    if (t) {
      full += t;
      onText && onText(t);
    }
    if (j.message && j.message.tool_calls) toolCalls.push(...j.message.tool_calls);
  }
  return { content: full, toolCalls };
}

async function streamChat({ url, model, history, system, onText, signal }) {
  const text = await chat({ url, model, messages: toMessages(history, system), signal, onText });
  return { text, usage: null };
}

function parseJson(raw) {
  const s = String(raw || '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

const CLEAN_PROMPT = (language) =>
  'Du bist Rambler, eine Diktierhilfe. Du bekommst das rohe Transkript einer Spracheingabe. Mach daraus sauberen, gut lesbaren Text: ' +
  'entferne Füllwörter (ähm, also, halt), Versprecher und Wiederholungen, übernimm Selbstkorrekturen ("nein, ich meine ..."), ' +
  'setze Satzzeichen und Absätze. Nennt der Nutzer Aufzählungen oder To-dos, forme sie als Liste mit "- ". ' +
  `Behalte die Sprache(n) des Sprechers bei. Bevorzugte Sprache: ${language}. Erfinde nichts dazu und beantworte keine Fragen aus dem Text. ` +
  'Antworte nur mit JSON: {"text": "<bereinigter Text>"}';

const EDIT_PROMPT = (selection) =>
  `Du bist Rambler, eine Schreibhilfe. Der Nutzer hat diesen Text markiert:\n"""\n${selection}\n"""\n` +
  'Er sagt dir gleich, wie der Text verändert werden soll (z. B. kürzen, förmlicher, übersetzen, als Liste). ' +
  'Wende die Anweisung an. Antworte nur mit JSON: {"text": "<fertiger neuer Text>"}';

const TEXT_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

// Rambler: Transkript (von Whisper) bereinigen oder als Anweisung auf die Markierung anwenden.
async function rambler({ url, model, transcript, selection, language }) {
  const messages = selection
    ? [{ role: 'system', content: EDIT_PROMPT(selection) }, { role: 'user', content: transcript }]
    : [{ role: 'system', content: CLEAN_PROMPT(language) }, { role: 'user', content: transcript }];
  const raw = await chat({ url, model, messages, format: TEXT_SCHEMA });
  const j = parseJson(raw);
  const text = String((j && j.text) || '').trim();
  return { transcript, text: text || (selection ? '' : transcript) };
}

const LIVE_SYSTEM = (lang) =>
  `Du bist Aura, ein Live-Assistent auf dem Computer des Nutzers und sprichst ${lang}, außer der Nutzer spricht eine andere Sprache. ` +
  'Zu jeder Frage bekommst du ein aktuelles Bildschirmfoto. Antworte so, wie man es laut sagt: kurz (ein bis drei Sätze), natürlich, ohne Markdown, ohne Listen. ' +
  'Fragt der Nutzer, wo er klicken, tippen oder hinschauen soll, gib in "point" die Stelle im Bildschirmfoto an: x und y von 0 bis 1000 ' +
  '(0,0 = oben links, 1000,1000 = unten rechts) und ein sehr kurzes "label" wie "Hier auf Speichern klicken". Sonst ist "point" null. ' +
  'Bei mehreren Schritten nenne nur den nächsten. Du klickst nie selbst. Antworte nur mit JSON: {"say": "...", "point": {"x": 0, "y": 0, "label": "..."} | null}';

const LIVE_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    point: {
      anyOf: [
        { type: 'null' },
        { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } }, required: ['x', 'y'] }
      ]
    }
  },
  required: ['say', 'point']
};

// Ein Live-Durchgang: Frage (Text) + Bildschirmfoto → gesprochene Antwort und optional ein Zeige-Hinweis.
async function liveTurn({ url, model, language, history, question, jpeg, signal }) {
  const messages = [{ role: 'system', content: LIVE_SYSTEM(language) }];
  for (const h of history || []) messages.push({ role: h.role === 'you' ? 'user' : 'assistant', content: h.text });
  const user = { role: 'user', content: question };
  if (jpeg) user.images = [jpeg];
  messages.push(user);
  const raw = await chat({ url, model, messages, format: LIVE_SCHEMA, signal });
  const j = parseJson(raw) || { say: raw, point: null };
  let point = null;
  if (j.point && Number.isFinite(Number(j.point.x)) && Number.isFinite(Number(j.point.y))) {
    point = {
      x: Math.max(0, Math.min(1000, Number(j.point.x))),
      y: Math.max(0, Math.min(1000, Number(j.point.y))),
      label: String(j.point.label || '')
    };
  }
  return { say: String(j.say || '').trim(), point };
}

module.exports = { DEFAULT_URL, RECOMMENDED, OllamaError, version, listModels, pull, streamChat, chatFull, toMessages, rambler, liveTurn };
