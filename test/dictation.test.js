// Spracheingabe im Chat mit Gemini: Anfrage an das günstige Modell, Antwort ohne „Gedanken“. Aufruf: npm test
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

test('gemini.transcribe schickt WAV wörtlich zum Mitschreiben und liefert nur den Text', async () => {
  let seen = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = { url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'überlege …', thought: true }, { text: ' Hallo Aura, wie wird das Wetter morgen? ' }] } }],
        usageMetadata: { promptTokenCount: 320, candidatesTokenCount: 12 }
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.AURA_GEMINI_BASE = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('../src/gemini')];
  const gemini = require('../src/gemini');
  try {
    const out = await gemini.transcribe({ apiKey: 'k', model: 'gemini-3.5-flash-lite', wavBase64: 'UklGRg==', language: 'Deutsch' });
    assert.strictEqual(out.text, 'Hallo Aura, wie wird das Wetter morgen?');
    assert.strictEqual(out.usage.promptTokenCount, 320);
    assert.strictEqual(seen.url, '/models/gemini-3.5-flash-lite:generateContent');
    assert.strictEqual(seen.key, 'k');
    const parts = seen.body.contents[0].parts;
    assert.match(parts[0].text, /wörtlich/);
    assert.match(parts[0].text, /kein Auftrag an dich/);
    assert.deepStrictEqual(parts[1], { inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } });
  } finally {
    server.close();
    delete process.env.AURA_GEMINI_BASE;
  }
});
