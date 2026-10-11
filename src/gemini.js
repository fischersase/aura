// Gemini API (REST) für Text-Chat und Rambler.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiError extends Error {}

async function check(res) {
  if (res.ok) return;
  let msg = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    if (j.error && j.error.message) msg = j.error.message;
  } catch {}
  throw new GeminiError(msg);
}

// Streamt eine Chat-Antwort. onText erhält jeweils das neue Textstück.
async function streamChat({ apiKey, model, history, system, onText, signal }) {
  const res = await fetch(`${BASE}/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: history,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      tools: [{ googleSearch: {} }]
    }),
    signal
  });
  await check(res);
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5));
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        for (const p of parts) {
          if (p.text && !p.thought) {
            full += p.text;
            onText(p.text);
          }
        }
      } catch {}
    }
  }
  return full;
}

const RAMBLER_PROMPT = (language, selection) => selection
  ? `Du bist Rambler, eine Schreibhilfe. Der Nutzer hat folgenden Text markiert:\n"""\n${selection}\n"""\n` +
    'Die Audioaufnahme enthält eine gesprochene Anweisung, wie dieser Text verändert werden soll ' +
    '(z. B. kürzen, förmlicher, übersetzen, als Liste). Wende die Anweisung an. ' +
    'Gib in "transcript" die wörtliche Anweisung und in "text" nur den fertigen neuen Text zurück.'
  : 'Du bist Rambler, eine Diktierhilfe. Transkribiere die Audioaufnahme und mache daraus sauberen, gut lesbaren Text: ' +
    'entferne Füllwörter (ähm, also, halt), Versprecher und Wiederholungen, übernimm Selbstkorrekturen ' +
    '("nein, ich meine ..."), setze Satzzeichen und Absätze. Wenn der Nutzer Aufzählungen oder To-dos nennt, ' +
    'forme sie als Liste mit "- ". Behalte die Sprache(n) des Sprechers bei, auch wenn sie im Satz wechselt. ' +
    `Bevorzugte Sprache: ${language}. Erfinde nichts dazu. ` +
    'Gib in "transcript" das wörtliche Transkript und in "text" den bereinigten Text zurück.';

async function rambler({ apiKey, model, wavBase64, selection, language }) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: RAMBLER_PROMPT(language, selection) },
          { inlineData: { mimeType: 'audio/wav', data: wavBase64 } }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { transcript: { type: 'STRING' }, text: { type: 'STRING' } },
          required: ['transcript', 'text']
        }
      }
    })
  });
  await check(res);
  const j = await res.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const raw = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  try {
    const out = JSON.parse(raw);
    return { transcript: out.transcript || '', text: (out.text || '').trim() };
  } catch {
    return { transcript: raw, text: raw.trim() };
  }
}

async function testKey(apiKey) {
  const res = await fetch(`${BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey } });
  await check(res);
  return true;
}

module.exports = { streamChat, rambler, testKey, GeminiError };
