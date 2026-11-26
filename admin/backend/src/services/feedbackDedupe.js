// Duplikatprüfung (Headhunter-Leiter) gegen bestehende offene Jira-Feedback-Vorgänge:
// Verhindert 20 identische Tickets zum selben Thema — stattdessen wird die neue Rückmeldung
// als Kommentar an das bestehende Jira-Ticket gehängt.
'use strict';

const STOP_WORDS = new Set([
  'der',
  'die',
  'das',
  'und',
  'oder',
  'aber',
  'nicht',
  'kein',
  'keine',
  'ein',
  'eine',
  'einen',
  'mit',
  'von',
  'für',
  'auf',
  'bei',
  'aus',
  'ist',
  'sind',
  'war',
  'wird',
  'ich',
  'wir',
  'mir',
  'mich',
  'mein',
  'meine',
  'aura',
  'bitte',
  'wenn',
  'dass',
  'auch',
  'noch',
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'not',
  'bug',
  'fehler',
  'idee',
  'feedback'
]);

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

/**
 * Vergleicht ein neues Feedback gegen offene Jira-Vorgänge.
 * @param {{ title?: string, message: string }} feedback
 * @param {Array<{ key: string, url: string, summary: string }>} candidates
 * @returns {{ matched: boolean, issue: { key: string, url: string, summary: string } | null, stage: string, score: number, margin: number, topCandidates: Array<{ key: string, summary: string, score: number }> }}
 */
function findDuplicateIssue(feedback, candidates) {
  const inputText = `${feedback.title || ''} ${feedback.message || ''}`.trim();
  const inputNorm = inputText.toLowerCase().replace(/\s+/g, ' ');
  const inputTokens = tokenize(inputText);

  const scored = (Array.isArray(candidates) ? candidates : []).map((c) => {
    const sumNorm = String(c.summary || '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const exact = Boolean(sumNorm && (inputNorm === sumNorm || (sumNorm.length >= 16 && inputNorm.includes(sumNorm))));
    const score = exact ? 1.0 : jaccardSimilarity(inputTokens, tokenize(sumNorm));
    return { ...c, score: Number(score.toFixed(3)), exact };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0] || null;
  const second = scored[1] || null;
  const margin = top ? Number((top.score - (second ? second.score : 0)).toFixed(3)) : 0;
  const topCandidates = scored.slice(0, 5).map(({ key, summary, score }) => ({ key, summary, score }));

  if (top && top.exact) {
    return { matched: true, issue: top, stage: 'exact', score: top.score, margin, topCandidates };
  }
  // Hohe Wortüberlappung + klarer Vorsprung zum zweitbesten Kandidaten
  if (top && top.score >= 0.45 && (margin >= 0.1 || top.score >= 0.7)) {
    return { matched: true, issue: top, stage: 'lexical', score: top.score, margin, topCandidates };
  }
  return { matched: false, issue: null, stage: 'new', score: top ? top.score : 0, margin, topCandidates };
}

module.exports = { tokenize, jaccardSimilarity, findDuplicateIssue };
