// Jira REST API v3 Client (exakt nach Headhunter-Vorbild):
// - Basic Auth (JIRA_EMAIL + JIRA_API_TOKEN) gegen Atlassian Cloud /rest/api/3
// - Ohne Zugangsdaten komplett inaktiv (configured: false) — Normalfall statt Fehler!
// - Niemals Freitext oder Token ins Log; HTTPS-Zwang ohne eingebettete Zugangsdaten.
'use strict';

const REQUEST_TIMEOUT_MS = 15_000;
const FEEDBACK_LABEL = 'Feedback';
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,20}-\d{1,10}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function normalizeBaseUrl(raw) {
  if (!raw) return null;
  try {
    const parsed = new URL(String(raw).trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function parseIssueTypeIds(raw) {
  const out = {};
  for (const pair of String(raw || '').split(',')) {
    const [kind, id] = pair.split(':').map((s) => (s || '').trim());
    if (kind && /^\d+$/.test(id)) out[kind] = id;
  }
  return out;
}

function buildAdfDocument(paragraphs) {
  const content = [];
  for (const block of paragraphs) {
    if (!block) continue;
    if (typeof block === 'string') {
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: block.slice(0, 4000) }]
      });
    } else if (block.heading) {
      content.push({
        type: 'heading',
        attrs: { level: block.level || 3 },
        content: [{ type: 'text', text: String(block.heading).slice(0, 200) }]
      });
    } else if (block.code) {
      content.push({
        type: 'codeBlock',
        attrs: { language: block.language || 'json' },
        content: [{ type: 'text', text: String(block.code).slice(0, 8000) }]
      });
    }
  }
  return { version: 1, type: 'doc', content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

function createJiraClient(env = process.env, fetchImpl = fetch) {
  const baseUrl = normalizeBaseUrl(env.JIRA_BASE_URL);
  const email = String(env.JIRA_EMAIL || '').trim();
  const apiToken = String(env.JIRA_API_TOKEN || '').trim();
  const projectKey = String(env.JIRA_PROJECT_KEY || 'AURA')
    .trim()
    .toUpperCase();
  const issueTypeIds = parseIssueTypeIds(env.JIRA_ISSUE_TYPE_IDS || '');
  const configured = Boolean(baseUrl && email && apiToken && /^[A-Z][A-Z0-9_]{1,15}$/.test(projectKey));

  const authHeader = configured ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}` : '';

  async function request(method, apiPath, body) {
    if (!configured) {
      const err = new Error('Jira ist in dieser Umgebung nicht eingerichtet.');
      err.code = 'JIRA_NOT_CONFIGURED';
      throw err;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`Jira API Fehler HTTP ${res.status}`);
        err.code = res.status === 429 ? 'JIRA_RATE_LIMITED' : `JIRA_HTTP_${res.status}`;
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listFeedbackIssues({ maxResults = 50 } = {}) {
    const jql = `project = "${projectKey}" AND labels = "${FEEDBACK_LABEL}" AND statusCategory != Done ORDER BY updated DESC`;
    const data = await request('POST', '/rest/api/3/search/jql', {
      jql,
      maxResults,
      fields: ['summary', 'labels', 'status', 'issuetype', 'created', 'updated']
    });
    const issues = Array.isArray(data.issues) ? data.issues : [];
    return issues
      .filter((i) => i && ISSUE_KEY_RE.test(i.key || ''))
      .map((i) => ({
        key: i.key,
        url: `${baseUrl}/browse/${i.key}`,
        summary: String((i.fields && i.fields.summary) || ''),
        labels: Array.isArray(i.fields && i.fields.labels) ? i.fields.labels : []
      }));
  }

  function resolveIssueType(kind) {
    if (issueTypeIds[kind]) return { id: issueTypeIds[kind] };
    if (kind === 'bug') return { name: 'Bug' };
    if (kind === 'idea') return { name: 'Story' };
    return { name: 'Task' };
  }

  async function createIssue({ kind = 'feedback', summary, descriptionBlocks, labels = [] }) {
    const cleanLabels = [...new Set([FEEDBACK_LABEL, ...labels].filter((l) => typeof l === 'string' && LABEL_RE.test(l)))];
    const data = await request('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: projectKey },
        issuetype: resolveIssueType(kind),
        summary: String(summary || 'Aura Nutzer-Feedback').slice(0, 240),
        description: buildAdfDocument(descriptionBlocks || []),
        labels: cleanLabels
      }
    });
    if (!data || !ISSUE_KEY_RE.test(data.key || '')) {
      const err = new Error('Jira lieferte keinen gültigen Vorgangsschlüssel.');
      err.code = 'JIRA_INVALID_RESPONSE';
      throw err;
    }
    return {
      key: data.key,
      id: data.id,
      url: `${baseUrl}/browse/${data.key}`
    };
  }

  async function addComment(issueKey, blocks, extraLabels = []) {
    if (!ISSUE_KEY_RE.test(issueKey || '')) {
      const err = new Error('Ungültiger Jira-Key.');
      err.code = 'JIRA_INVALID_KEY';
      throw err;
    }
    await request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: buildAdfDocument(blocks || [])
    });
    const safeLabels = extraLabels.filter((l) => typeof l === 'string' && LABEL_RE.test(l));
    if (safeLabels.length) {
      await request('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        update: { labels: safeLabels.map((l) => ({ add: l })) }
      }).catch(() => {});
    }
    return { key: issueKey, url: `${baseUrl}/browse/${issueKey}` };
  }

  return {
    configured,
    info: () => ({ configured, baseUrl: configured ? baseUrl : null, projectKey: configured ? projectKey : null }),
    listFeedbackIssues,
    createIssue,
    addComment
  };
}

module.exports = {
  FEEDBACK_LABEL,
  normalizeBaseUrl,
  parseIssueTypeIds,
  buildAdfDocument,
  createJiraClient
};
