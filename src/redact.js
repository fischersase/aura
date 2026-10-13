// @ts-check
// Zugangsdaten in Texten schwärzen, bevor sie in ein Protokoll geschrieben werden (AURA-17).
// Gleiche Regeln wie agent/src/aura_agent/harness/audit.py (scrub).
/** @type {Array<[RegExp, string]>} */
const PATTERNS = [
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: one optional prefix, then a negated class
  [/\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s'"]+/gi, '$1***'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '***'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, '***'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***'],
  [/\b(?:glpat|hf)_[A-Za-z0-9_-]{20,}/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***'],
  [/(--?(?:password|passwd|pass|token|api[-_]?key|secret|client-secret)(?:=|\s+))\S+/gi, '$1***'],
  [/\b((?:mysql|mysqldump|mariadb)\b[^|;\n]*?\s-p)(?!\s)\S+/gi, '$1***'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=(?!\*\*\*)\S+/g, '$1=***']
];

/** @param {string} s */
function entropy(s) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  return -Object.values(counts).reduce((sum, n) => sum + (n / s.length) * Math.log2(n / s.length), 0);
}

/**
 * @param {unknown} text
 * @returns {string}
 */
function scrub(text) {
  let t = String(text);
  for (const [re, repl] of PATTERNS) t = t.replace(re, repl);
  // Lange Zufallsfolgen gelten als Schlüssel; Hex-Hashes (höchstens 4 Bit/Zeichen) bleiben lesbar.
  return t.replace(/[A-Za-z0-9+/=_-]{32,}/g, (m) => (entropy(m) > 4.3 ? '***' : m));
}

module.exports = { scrub };
