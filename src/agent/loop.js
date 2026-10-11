// Agent-Schleife: Modell antwortet oder ruft Werkzeuge auf, die App führt sie aus
// (ändernde nur nach Freigabe), gibt die Ergebnisse zurück, bis das Modell fertig ist.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const gemini = require('../gemini');
const ollama = require('../ollama');
const { TOOLS } = require('./tools');
const skills = require('./skills');
const mcp = require('./mcp');

// Werkzeuge für einen Auftrag: eingebaute, activate_skill (falls Skills da) und MCP-Server.
async function toolset() {
  try { await mcp.sync(); } catch {}
  const list = [...TOOLS];
  const sk = skills.tool();
  if (sk) list.push(sk);
  list.push(...mcp.tools());
  return { list, byName: Object.fromEntries(list.map((t) => [t.name, t])) };
}

const MAX_STEPS = 30;
const IS_WIN = process.platform === 'win32';

const SYSTEM = (lang) => [BASE_SYSTEM(lang), skills.promptAddon()].filter(Boolean).join('\n\n');

const BASE_SYSTEM = (lang) => [
  `Du bist Aura, ein Assistent mit Zugriff auf den ${IS_WIN ? 'Windows' : 'Linux'}-PC des Nutzers (Benutzer ${os.userInfo().username}, Benutzerordner ${os.homedir()}).`,
  `Antworte kurz, klar und freundlich, standardmäßig auf ${lang}. Markdown sparsam.`,
  'Wenn der Nutzer etwas am PC erledigt haben will (Programm oder Ordner öffnen, Dateien finden, Befehle, Systeminfos), erledige es selbst mit deinen Werkzeugen, statt eine Anleitung zu schreiben.',
  'Ändernde Aktionen (Befehle, die etwas verändern, Dateien schreiben) zeigt die App dem Nutzer selbst zur Freigabe; frage dafür nicht zusätzlich im Chat nach, sondern rufe das Werkzeug direkt auf.',
  'Lehnt der Nutzer ab, akzeptiere das und schlage höchstens eine Alternative vor. Lösche oder überschreibe nichts, worum er nicht gebeten hat.',
  'Prüfe Ergebnisse kurz und sage am Ende in ein bis zwei Sätzen, was du getan hast. Gib keine Zugangsdaten oder Schlüssel aus Dateien wieder.',
  'Wenn ein Bildschirmfoto beiliegt, beziehe dich konkret darauf.',
  'Programme bedienen kannst du mit screenshot, click (Koordinaten 0 bis 1000 im Bildschirmfoto), type_text und press_keys. Nutze das nur, wenn es nicht einfacher mit open, run_command oder Dateien geht, und prüfe nach jedem Schritt das neue Bildschirmfoto.'
].join(' ');

// ---------- Aktionsprotokoll ----------

const logFile = () => path.join(app.getPath('userData'), 'agent-log.jsonl');

function log(entry) {
  try {
    const short = (v) => (typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v);
    const args = Object.fromEntries(Object.entries(entry.args || {}).map(([k, v]) => [k, short(v)]));
    fs.appendFileSync(logFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry, args }) + '\n');
  } catch {}
}

// ---------- Ein Werkzeug ausführen ----------

async function execute(name, args, { tools, approve, onStep, signal, ctx }) {
  const tool = tools.byName[name];
  const step = { id: Math.random().toString(36).slice(2), tool: name, label: '' };
  if (!tool) {
    return { result: { error: `Unbekanntes Werkzeug ${name}` } };
  }
  args = args || {};
  step.label = String(tool.label(args) || '');
  const changes = tool.changes(args);
  if (changes) {
    onStep({ ...step, state: 'ask' });
    const ok = await approve({ ...step, detail: tool.detail ? tool.detail(args) : '' });
    if (!ok) {
      onStep({ ...step, state: 'denied' });
      log({ tool: name, args, decision: 'abgelehnt' });
      return { result: { error: 'Der Nutzer hat diese Aktion abgelehnt.' } };
    }
  }
  onStep({ ...step, state: 'run' });
  let result;
  try {
    result = await tool.run(args, { signal, ...ctx });
  } catch (err) {
    result = { error: String(err.message || err) };
  }
  const failed = !!result.error || (result.exitCode != null && result.exitCode !== 0);
  onStep({ ...step, state: failed ? 'error' : 'ok' });
  log({ tool: name, args, decision: changes ? 'freigegeben' : 'automatisch', ok: !failed, error: result.error });
  let image = null;
  if (result.image) {
    image = result.image;
    result = { ...result, image: undefined, note: 'Bild liegt bei.' };
  }
  return { result, image };
}

// ---------- Gemini ----------

const geminiDecls = (tools) => tools.list.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
let geminiCombined = true; // Google-Suche und eigene Funktionen zusammen; fällt zurück, falls das Modell es nicht kann

async function runGemini({ apiKey, model, history, language, onText, onStep, onUsage, approve, signal, ctx }) {
  const contents = JSON.parse(JSON.stringify(history));
  const set = await toolset();
  const system = SYSTEM(language);
  for (let i = 0; i < MAX_STEPS; i++) {
    const tools = [{ functionDeclarations: geminiDecls(set) }];
    if (geminiCombined) tools.push({ googleSearch: {} });
    let res;
    try {
      res = await gemini.streamChat({ apiKey, model, history: contents, system, tools, onText, signal });
    } catch (err) {
      if (geminiCombined && /tool|search|function/i.test(String(err.message))) {
        geminiCombined = false;
        i--;
        continue;
      }
      throw err;
    }
    onUsage && onUsage(res.usage);
    const calls = res.parts.filter((p) => p.functionCall);
    contents.push({ role: 'model', parts: res.parts.length ? res.parts : [{ text: res.text || '' }] });
    if (!calls.length) return;
    onText('\n\n');
    const replies = [];
    const images = [];
    for (const c of calls) {
      const { result, image } = await execute(c.functionCall.name, c.functionCall.args, { tools: set, approve, onStep, signal, ctx });
      if (signal.aborted) return;
      replies.push({ functionResponse: { name: c.functionCall.name, ...(c.functionCall.id ? { id: c.functionCall.id } : {}), response: result } });
      if (image) images.push({ inlineData: { mimeType: image.startsWith('iVBOR') ? 'image/png' : 'image/jpeg', data: image } });
    }
    contents.push({ role: 'user', parts: [...replies, ...images.slice(-1)] }); // nur das neueste Bild
  }
  onText('\n\n_(Abgebrochen: zu viele Schritte.)_');
}

// ---------- Ollama ----------

const ollamaTools = (tools) => tools.list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

async function runOllama({ url, model, numCtx, history, language, onText, onStep, approve, signal, ctx }) {
  const messages = ollama.toMessages(history, SYSTEM(language));
  const set = await toolset();
  for (let i = 0; i < MAX_STEPS; i++) {
    let res;
    try {
      res = await ollama.chatFull({ url, model, messages, tools: ollamaTools(set), numCtx, signal, onText });
    } catch (err) {
      // Modelle ohne Werkzeug-Unterstützung (z. B. deepseek-r1): normal antworten.
      if (/does not support tools/i.test(String(err.message))) {
        await ollama.chatFull({ url, model, messages, signal, onText });
        onText(`\n\n_(${model} kann keine Aktionen ausführen; für den Agenten z. B. qwen3.6 oder gemma4 wählen.)_`);
        return;
      }
      throw err;
    }
    messages.push({ role: 'assistant', content: res.content, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
    if (!res.toolCalls.length) return;
    onText('\n\n');
    const images = [];
    for (const c of res.toolCalls) {
      const fn = c.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const { result, image } = await execute(fn.name, args, { tools: set, approve, onStep, signal, ctx });
      if (signal.aborted) return;
      messages.push({ role: 'tool', tool_name: fn.name, content: JSON.stringify(result) });
      if (image) images.push(image);
    }
    if (images.length) messages.push({ role: 'user', content: 'Bildschirmfoto:', images: images.slice(-1) }); // nur das neueste
  }
  onText('\n\n_(Abgebrochen: zu viele Schritte.)_');
}

module.exports = { runGemini, runOllama, logFile, SYSTEM, toolset };
