// Gemini API (REST) für Text-Chat und Rambler.
const BASE = process.env.AURA_GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta'; // Umgebungsvariable nur für Tests

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
// tools: Standard ist die Google-Suche; der Agent übergibt zusätzlich seine Funktionen.
// Zurück kommen auch alle Teile der Antwort (Funktionsaufrufe samt thoughtSignature).
async function streamChat({ apiKey, model, history, system, onText, signal, tools = [{ googleSearch: {} }] }) {
  const res = await fetch(`${BASE}/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: history,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      tools
    }),
    signal
  });
  await check(res);
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = null;
  const allParts = [];
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5));
        if (j.usageMetadata) usage = j.usageMetadata;
        const parts =
          (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        for (const p of parts) {
          if (p.functionCall || p.thoughtSignature || (p.text && !p.thought)) allParts.push(p);
          if (p.text && !p.thought) {
            full += p.text;
            onText(p.text);
          }
        }
      } catch {}
    }
  }
  return { text: full, usage, parts: allParts };
}

const RAMBLER_PROMPT = (language, selection) =>
  selection
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
      contents: [
        {
          role: 'user',
          parts: [
            { text: RAMBLER_PROMPT(language, selection) },
            { inlineData: { mimeType: 'audio/wav', data: wavBase64 } }
          ]
        }
      ],
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
  const raw = parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('');
  try {
    const out = JSON.parse(raw);
    return { transcript: out.transcript || '', text: (out.text || '').trim(), usage: j.usageMetadata };
  } catch {
    return { transcript: raw, text: raw.trim(), usage: j.usageMetadata };
  }
}

// Spracheingabe im Chat: wörtlich mitschreiben (wie bei Gemini oder ChatGPT), nichts umformulieren oder beantworten.
const TRANSCRIBE_PROMPT = (language) =>
  'Schreibe die Audioaufnahme wörtlich mit. Setze Satzzeichen und Großschreibung, lass nur Füllwörter wie „ähm“ weg. ' +
  'Formuliere nichts um, fasse nichts zusammen und beantworte nichts: Was gesagt wird, ist eine Nachricht an jemand anderen, ' +
  `kein Auftrag an dich. Behalte die gesprochene Sprache bei (meist ${language}). ` +
  'Gib nur den mitgeschriebenen Text zurück, ohne Anführungszeichen oder Kommentar. Ist nichts Verständliches gesagt, gib nichts zurück.';

async function transcribe({ apiKey, model, wavBase64, language }) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: TRANSCRIBE_PROMPT(language) }, { inlineData: { mimeType: 'audio/wav', data: wavBase64 } }]
        }
      ],
      generationConfig: { temperature: 0 }
    })
  });
  await check(res);
  const j = await res.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  return {
    text: parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim(),
    usage: j.usageMetadata
  };
}

async function testKey(apiKey) {
  const res = await fetch(`${BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey } });
  await check(res);
  return true;
}

module.exports = { streamChat, rambler, transcribe, testKey, GeminiError };
