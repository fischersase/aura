// Serverseitige Defense-in-Depth-Schwärzung (spiegelt src/redact.js, sodass auch ältere Clients keine Secrets/PII ablegen).
'use strict';

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
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=(?!\*\*\*)\S+/g, '$1=***'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/([A-Za-z]:\\Users\\)[^\\/\s'"]+/gi, '$1[USER]'],
  [/(\/(?:home|Users)\/)[^\\/\s'"]+/g, '$1[USER]'],
  [/(?:^|[\s(:])(?:\+|00)\d{1,3}[\s.-]?\d{2,5}[\s.-]?\d{3,8}\b/g, ' [PHONE]']
];

function entropy(s) {
  const counts = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  return -Object.values(counts).reduce((sum, n) => sum + (n / s.length) * Math.log2(n / s.length), 0);
}

function scrubPii(text) {
  let t = String(text ?? '');
  t = t.replace(/\b[A-Z]{2}\d{2}[A-Z0-9 -]{11,30}[A-Z0-9]\b/g, (m) => {
    const compact = m.replace(/[ -]/g, '');
    return compact.length >= 15 && compact.length <= 34 && /\d{6}/.test(compact) ? '[IBAN]' : m;
  });
  for (const [re, repl] of PATTERNS) t = t.replace(re, repl);
  return t.replace(/[A-Za-z0-9+/=_-]{32,}/g, (m) => (entropy(m) > 4.3 ? '***' : m));
}

function scrubObject(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubPii(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => scrubObject(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie)/i.test(k)
        ? '***'
        : scrubObject(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

module.exports = { scrubPii, scrubObject };
