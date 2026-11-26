// Closed-Loop Improvement Engine ("Gemini Dev Flywheel"):
// 1. Bewertet Session-Traces automatisch (Deterministische Heuristik + optional Gemini LLM-as-a-Judge)
// 2. Clustert wiederkehrende Fehler & Daumen-runter-Sessions zu priorisierten "Top Pain Points"
// 3. Exportiert jede echte Session per 1-Klick als Golden Eval-Case (kompatibel mit agent/evals/)
// 4. Verwaltet Systemverbesserungen (System-Prompt, Skill, Tool-Policy, Browser-Regel) inkl. Canary-Rollout-%
'use strict';

const { scrubPii } = require('../redact');

/**
 * Schnelle, kostenfreie Basis-Qualitätsbewertung (1.0 - 5.0) anhand von Tool-Fehlern, Retries, Latenz & Nutzer-Rating.
 */
function scoreSessionHeuristic(session, spans = []) {
  let taskCompletion = 4.2;
  let toolEfficiency = 4.5;
  let reliability = 4.6;
  const reasons = [];

  if (session.user_rating === 'down') {
    taskCompletion = Math.min(taskCompletion, 2.0);
    reasons.push('Nutzer hat die Antwort negativ bewertet (👎).');
  } else if (session.user_rating === 'up') {
    taskCompletion = Math.max(taskCompletion, 4.8);
    reasons.push('Nutzer hat die Antwort positiv bewertet (👍).');
  }

  if (session.has_error) {
    reliability = Math.min(reliability, 1.8);
    taskCompletion = Math.min(taskCompletion, 2.2);
    reasons.push('Während der Session ist mindestens ein Fehler aufgetreten.');
  }

  const failedSpans = spans.filter((s) => s.status && s.status !== 'ok');
  if (failedSpans.length > 0) {
    reliability = Math.max(1.0, reliability - failedSpans.length * 0.9);
    const failedTools = [...new Set(failedSpans.map((s) => s.tool_name || s.span_type))];
    reasons.push(`Fehlgeschlagene Werkzeugaufrufe: ${failedTools.join(', ')}.`);
  }

  if (spans.length >= 10) {
    toolEfficiency = Math.max(1.5, toolEfficiency - (spans.length - 8) * 0.25);
    reasons.push(`Hohe Schrittzahl (${spans.length} Spans) – möglicher Agent-Loop.`);
  }

  if (Number(session.total_latency_ms || 0) > 25_000) {
    toolEfficiency = Math.max(1.5, toolEfficiency - 0.8);
    reasons.push(`Hohe Gesamtdauer (${Math.round(session.total_latency_ms / 1000)} s).`);
  }

  const overall = Number(((taskCompletion * 0.45 + reliability * 0.35 + toolEfficiency * 0.2)).toFixed(2));
  const clusterTag = deriveClusterTag(session, spans);

  return {
    score: overall,
    dimensions: {
      taskCompletion: Number(taskCompletion.toFixed(2)),
      reliability: Number(reliability.toFixed(2)),
      toolEfficiency: Number(toolEfficiency.toFixed(2)),
      mode: 'heuristic'
    },
    clusterTag,
    summary: reasons.length ? reasons.join(' ') : 'Unauffälliger, erfolgreicher Ablauf.'
  };
}

function deriveClusterTag(session, spans = []) {
  const failed = spans.find((s) => s.status && s.status !== 'ok' && s.tool_name);
  if (failed) {
    return `${failed.tool_name}:${failed.error_type ? String(failed.error_type).slice(0, 32) : failed.status}:${session.os_platform || 'any'}`
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, '-');
  }
  const text = (Array.isArray(session.messages) ? session.messages : [])
    .map((m) => String(m.text || ''))
    .join(' ')
    .toLowerCase();
  if (session.has_error || session.user_rating === 'down') {
    if (/cookie|banner|popup|consent|akzeptier/.test(text)) return 'browser:cookie-overlay';
    if (/bluetooth|kopfhörer|audio|helligkeit|wlan|wifi/.test(text)) return `device-control:${session.os_platform || 'win32'}`;
    if (/flug|reise|mydealz|preis|angebot|hotel/.test(text)) return 'deep-research:deals';
    if (/rambler|diktat|mikrofon|stimme/.test(text)) return `rambler:${session.os_platform || 'win32'}`;
    return `general-issue:${session.mode || 'chat'}`;
  }
  return null;
}

/**
 * Optionaler Gemini LLM-as-a-Judge (nur wenn GEMINI_JUDGE_API_KEY im Admin-Backend gesetzt ist).
 * Fällt bei fehlendem Key oder Fehler automatisch auf scoreSessionHeuristic zurück.
 */
async function evaluateSession(session, spans = [], { geminiApiKey = process.env.GEMINI_JUDGE_API_KEY || '', model = process.env.GEMINI_JUDGE_MODEL || 'gemini-2.5-flash', fetchImpl = fetch } = {}) {
  const fallback = scoreSessionHeuristic(session, spans);
  if (!geminiApiKey) return fallback;

  const prompt = [
    'Du bist ein Google-DeepMind-Qualitätsprüfer für den Desktop-KI-Agenten Aura.',
    'Bewerte die folgende bereits geschwärzte Session streng als JSON-Objekt mit den Feldern:',
    '{ "score": 1.0..5.0, "taskCompletion": 1..5, "reliability": 1..5, "toolEfficiency": 1..5, "clusterTag": "kurz-slug-oder-null", "summary": "max 2 Sätze auf Deutsch mit konkreter Ursache und Verbesserungsidee" }',
    '',
    `Kontext: mode=${session.mode}, provider=${session.provider}, model=${session.model}, os=${session.os_platform}, rating=${session.user_rating || 'none'}, hasError=${session.has_error}, latencyMs=${session.total_latency_ms}`,
    'Spans:',
    JSON.stringify(spans.slice(0, 25).map((s) => ({ tool: s.tool_name, type: s.span_type, status: s.status, ms: s.duration_ms, err: s.error_type }))),
    'Konversation (geschwärzt):',
    JSON.stringify((session.messages || []).slice(0, 12))
  ].join('\n');

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const rawText =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
    if (!rawText) return fallback;
    const parsed = JSON.parse(rawText);
    const clamp = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? Number(Math.max(1, Math.min(5, n)).toFixed(2)) : d;
    };
    return {
      score: clamp(parsed.score, fallback.score),
      dimensions: {
        taskCompletion: clamp(parsed.taskCompletion, fallback.dimensions.taskCompletion),
        reliability: clamp(parsed.reliability, fallback.dimensions.reliability),
        toolEfficiency: clamp(parsed.toolEfficiency, fallback.dimensions.toolEfficiency),
        mode: `gemini-judge:${model}`
      },
      clusterTag:
        typeof parsed.clusterTag === 'string' && parsed.clusterTag.trim()
          ? parsed.clusterTag.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 64)
          : fallback.clusterTag,
      summary: String(parsed.summary || fallback.summary).slice(0, 500)
    };
  } catch {
    return fallback;
  }
}

/**
 * Erzeugt ein sauberes, direkt in agent/evals/ ablegbares Golden-Eval-JSON aus einer Session.
 */
function buildGoldenEvalArtifact(session, spans = [], overrides = {}) {
  const firstUserMsg = (Array.isArray(session.messages) ? session.messages : []).find((m) => m.role === 'user');
  const promptRedacted = scrubPii(overrides.promptRedacted || (firstUserMsg && firstUserMsg.text) || '');
  const usedTools = [...new Set(spans.map((s) => s.tool_name).filter(Boolean))];
  const slug = String(overrides.title || session.cluster_tag || session.session_id || 'eval')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  return {
    filename: `eval_${slug || 'case'}.json`,
    spec: {
      schema_version: 'aura-eval-v1',
      source_session_id: session.session_id,
      category: overrides.category || (session.cluster_tag ? session.cluster_tag.split(':')[0] : 'regression'),
      title: overrides.title || `Regression: ${promptRedacted.slice(0, 72) || session.session_id}`,
      os_platform: session.os_platform || 'any',
      mode: session.mode || 'agent_v2',
      prompt: promptRedacted,
      expected_behavior:
        overrides.expectedBehavior ||
        'Aufgabe vollständig, robust und ohne Endlosschleife oder unbehandelte Fehler abschließen.',
      expected_tools: Array.isArray(overrides.toolExpectations) ? overrides.toolExpectations : usedTools,
      original_failure: session.judge_summary || (session.has_error ? 'Session hatte Fehler' : 'Nutzer-Feedback 👎')
    }
  };
}

module.exports = {
  scoreSessionHeuristic,
  deriveClusterTag,
  evaluateSession,
  buildGoldenEvalArtifact
};
