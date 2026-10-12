// Geschätzte Kosten des laufenden Monats, lokal mitgezählt.
// Google bietet keine API, um die echten Kosten abzufragen; maßgeblich bleibt
// die Spend-Seite in AI Studio (https://aistudio.google.com/spend).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// USD pro 1 Mio. Tokens (bzw. pro Minute bei Live), Stand: ai.google.dev/gemini-api/docs/pricing, Okt. 2026.
function tokenPrices(model, now = new Date()) {
  const y2027 = now.getFullYear() >= 2027;
  if (/flash-lite/.test(String(model))) return { input: 0.30, output: 2.50 }; // Audio-Eingabepreis, vorsichtig auch für Text
  // gemini-3.8-flash; für andere Modelle dieselben Preise als vorsichtige Schätzung
  return { input: y2027 ? 1.5 : 0.75, output: y2027 ? 7.5 : 3.75 };
}

const LIVE_PER_MIN = { audioIn: 0.005, videoIn: 0.002, audioOut: 0.018 };

let cache = null;
const file = () => path.join(app.getPath('userData'), 'usage.json');
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function load() {
  if (!cache) {
    try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { cache = {}; }
  }
  if (cache.month !== monthKey()) cache = { month: monthKey(), costUsd: 0, requests: 0, liveMinutes: 0 };
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function addCost(usd, { request = true, liveMinutes = 0 } = {}) {
  const u = load();
  u.costUsd += Math.max(0, usd || 0);
  if (request) u.requests += 1;
  u.liveMinutes += liveMinutes;
  save();
  return u;
}

// usageMetadata aus generateContent / streamGenerateContent
function addTokens(model, meta) {
  if (!meta) return load();
  const p = tokenPrices(model);
  const inTok = meta.promptTokenCount || 0;
  const outTok = (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  return addCost((inTok * p.input + outTok * p.output) / 1e6);
}

// Live: nach Minuten (Mikrofon offen, Bildschirm geteilt, gesprochene Antwort)
function addLive({ micSec = 0, screenSec = 0, speechSec = 0 }) {
  const usd = (micSec * LIVE_PER_MIN.audioIn + screenSec * LIVE_PER_MIN.videoIn + speechSec * LIVE_PER_MIN.audioOut) / 60;
  return addCost(usd, { request: false, liveMinutes: micSec / 60 });
}

function summary(budgetUsd) {
  const u = load();
  const budget = Number(budgetUsd) || 0;
  return {
    month: u.month,
    costUsd: u.costUsd,
    requests: u.requests,
    budgetUsd: budget,
    ratio: budget > 0 ? u.costUsd / budget : 0,
    overBudget: budget > 0 && u.costUsd >= budget
  };
}

module.exports = { addTokens, addLive, summary };
