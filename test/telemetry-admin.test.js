// Tests für Aura Telemetrie/DSGVO-PII-Scrubbing, Admin-Backend (Triage/Dedupe/Jira/Eval-Flywheel) & k8s/Grafana-Manifeste.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const redact = require('../src/redact');
const telemetry = require('../src/telemetry');
const adminRedact = require('../admin/backend/src/redact');
const { triageFeedback } = require('../admin/backend/src/services/feedbackTriage');
const { findDuplicateIssue } = require('../admin/backend/src/services/feedbackDedupe');
const { createJiraClient, normalizeBaseUrl, parseIssueTypeIds } = require('../admin/backend/src/services/jiraClient');
const { createFeedbackJiraWorker } = require('../admin/backend/src/services/feedbackJira');
const { scoreSessionHeuristic, buildGoldenEvalArtifact } = require('../admin/backend/src/services/improvementEngine');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('redact: scrubPii and scrubObject strip secrets, emails, IBANs, phone numbers and home paths', () => {
  const raw =
    'Key AIzaSyDummySecretKey123456789012345 für max.mustermann@example.de, IBAN DE89 3704 0044 0532 0130 00, Tel +49 170 1234567 in C:\\Users\\Sebastian\\Documents\\secret.txt und /home/sebastian/notes.md';
  const cleaned = redact.scrubPii(raw);
  assert.doesNotMatch(cleaned, /AIzaSy/);
  assert.doesNotMatch(cleaned, /max\.mustermann@example\.de/);
  assert.doesNotMatch(cleaned, /DE89/);
  assert.doesNotMatch(cleaned, /170 1234567/);
  assert.doesNotMatch(cleaned, /Sebastian/i);
  assert.match(cleaned, /\[EMAIL\]/);
  assert.match(cleaned, /\[IBAN\]/);
  assert.match(cleaned, /\[USER\]/);

  const obj = redact.scrubObject({
    prompt: 'Mail an anna@test.org',
    apiKey: 'secret-value',
    nested: { password: '123', path: 'C:\\Users\\Anna\\Desktop' }
  });
  assert.strictEqual(obj.apiKey, '***');
  assert.strictEqual(obj.nested.password, '***');
  assert.match(obj.prompt, /\[EMAIL\]/);
  assert.match(obj.nested.path, /\[USER\]/);

  // Server-side Defense-in-Depth Scrubber mirrors client scrubber
  const serverCleaned = adminRedact.scrubPii(raw);
  assert.doesNotMatch(serverCleaned, /max\.mustermann@example\.de/);
  assert.doesNotMatch(serverCleaned, /AIzaSy/);
});

test('telemetry: enforces 3-tier DSGVO consent, URL allowlist, scrubbing and Art. 17 delete', async () => {
  assert.strictEqual(
    telemetry.normalizeAdminUrl('https://aura-admin-prod.tail123.ts.net/'),
    'https://aura-admin-prod.tail123.ts.net'
  );
  assert.strictEqual(telemetry.normalizeAdminUrl('http://127.0.0.1:8088/'), 'http://127.0.0.1:8088');
  assert.strictEqual(telemetry.normalizeAdminUrl('http://evil.example.com'), '');
  assert.strictEqual(telemetry.normalizeAdminUrl('https://user:pass@aura.example.com'), '');

  const calls = [];
  const state = {
    installId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
    adminApiUrl: 'https://aura-admin-prod.tail123.ts.net',
    provider: 'gemini',
    telemetryMetricsOptIn: false,
    telemetryTracesOptIn: false
  };
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 201, json: async () => ({ ok: true, id: 42, sessionId: 'sess-1' }) };
  };

  const client = telemetry.createTelemetryClient({
    getSettings: () => state,
    saveSettings: (p) => Object.assign(state, p),
    getVersion: () => '0.21.0',
    getHardware: async () => ({ ramGb: 32, vramGb: 12 }),
    fetchImpl: fakeFetch
  });

  // Stufe 0: nichts wird gesendet
  assert.strictEqual((await client.sendHeartbeat()).skipped, true);
  assert.strictEqual(client.recordEvent({ eventType: 'chat_turn', latencyMs: 500 }), false);
  assert.strictEqual((await client.recordSessionTrace({ sessionId: 's1', messages: [] })).skipped, true);
  assert.strictEqual(calls.length, 0);

  // Stufe 1: Heartbeat + Events erlaubt, aber Chat-Traces noch gesperrt
  state.telemetryMetricsOptIn = true;
  assert.strictEqual((await client.sendHeartbeat()).ok, true);
  assert.strictEqual(client.recordEvent({ eventType: 'chat_turn', feature: 'agent_v2', latencyMs: 820 }), true);
  assert.strictEqual((await client.flush()).sent, 1);
  assert.strictEqual((await client.recordSessionTrace({ sessionId: 's1', messages: [] })).skipped, true);
  assert.strictEqual(calls.length, 2);

  // Stufe 2: Traces erlaubt und clientseitig geschwärzt
  state.telemetryTracesOptIn = true;
  const tr = await client.recordSessionTrace({
    sessionId: 'sess-1',
    mode: 'agent_v2',
    messages: [{ role: 'user', text: 'Sende Mail an bob@example.com mit C:\\Users\\Bob\\a.txt' }]
  });
  assert.strictEqual(tr.ok, true);
  const tracePayload = calls[calls.length - 1].body;
  assert.doesNotMatch(tracePayload.messages[0].text, /bob@example\.com/);
  assert.doesNotMatch(tracePayload.messages[0].text, /\\Bob\\/);

  // Direktes Feedback an Admin Console inkl. optionalem Trace
  const fb = await client.submitFeedbackToAdmin({
    kind: 'bug',
    title: 'Kopfhörer-Problem',
    message: 'Verbindung bricht ab',
    context: { version: '0.21.0', platform: 'win32' }
  });
  assert.strictEqual(fb.ok, true);
  assert.strictEqual(calls[calls.length - 1].url, 'https://aura-admin-prod.tail123.ts.net/api/ingest/feedback');

  // DSGVO Art. 17: 1-Klick-Löschung
  const del = await client.deleteMyRemoteData();
  assert.strictEqual(del.ok, true);
  assert.strictEqual(calls[calls.length - 1].method, 'DELETE');
  assert.match(calls[calls.length - 1].url, /\/api\/ingest\/installations\/a1b2c3d4-1234-4567-89ab-cdef01234567$/);
  client.stop();
});

test('admin feedback pipeline: triage rejects junk, dedupe attaches comments, Jira creates issues & stays inert unconfigured', async () => {
  // 1. Triage
  assert.strictEqual(triageFeedback({ message: 'asdf' }).keep, false);
  assert.strictEqual(triageFeedback({ message: '!!!!!!!!' }).keep, false);
  assert.strictEqual(triageFeedback({ message: 'test' }).keep, false);
  assert.strictEqual(
    triageFeedback({ title: 'Bluetooth', message: 'Kopfhörer trennen sich auf Windows 11.' }).keep,
    true
  );

  // 2. Dedupe
  const openIssues = [
    {
      key: 'AURA-12',
      url: 'https://site.atlassian.net/browse/AURA-12',
      summary: '[Fehler] Bluetooth Kopfhörer trennen sich unter Windows 11'
    },
    {
      key: 'AURA-19',
      url: 'https://site.atlassian.net/browse/AURA-19',
      summary: '[Idee] Dunkles Design für Einstellungen'
    }
  ];
  const dup = findDuplicateIssue(
    { title: 'Bluetooth Kopfhörer Windows 11', message: 'Bluetooth Kopfhörer trennen sich unter Windows 11 dauernd' },
    openIssues
  );
  assert.strictEqual(dup.matched, true);
  assert.strictEqual(dup.issue.key, 'AURA-12');

  const unique = findDuplicateIssue(
    { title: 'Flugsuche', message: 'Bei Skyscanner hängt das Cookie-Banner im Browser-Modus fest.' },
    openIssues
  );
  assert.strictEqual(unique.matched, false);

  // 3. Jira Client URL/Type Parsing & Inert Mode
  assert.strictEqual(normalizeBaseUrl('https://demo.atlassian.net/'), 'https://demo.atlassian.net');
  assert.strictEqual(normalizeBaseUrl('http://demo.atlassian.net'), null);
  assert.deepStrictEqual(parseIssueTypeIds('bug:10049,idea:10047,other:10046'), {
    bug: '10049',
    idea: '10047',
    other: '10046'
  });
  const inert = createJiraClient({});
  assert.strictEqual(inert.configured, false);

  // 4. End-to-End Feedback-to-Jira Worker with mocked DB & Jira API
  const rows = new Map([
    [1, { id: 1, kind: 'bug', title: 'Test', message: 'asdf', status: 'new', jira_status: 'pending', context: {} }],
    [
      2,
      {
        id: 2,
        kind: 'bug',
        title: 'Bluetooth Kopfhörer Windows 11',
        message: 'Bluetooth Kopfhörer trennen sich unter Windows 11 sofort',
        status: 'new',
        jira_status: 'pending',
        context: { client: { version: '0.21.0' } }
      }
    ],
    [
      3,
      {
        id: 3,
        kind: 'idea',
        title: 'Flight Deal Alert',
        message: 'Bitte tägliche Benachrichtigung für Japan-Flug-Deals in der Kirschblütenzeit.',
        status: 'new',
        jira_status: 'pending',
        context: { client: { version: '0.21.0' } }
      }
    ]
  ]);
  const fakeDb = {
    query: async (sql, params = []) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
      if (sql.startsWith('SELECT * FROM user_feedback WHERE id = $1')) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('UPDATE user_feedback')) {
        const row = rows.get(params[0]);
        if (row) {
          if (sql.includes("jira_status = 'rejected'")) row.jira_status = 'rejected';
          else if (sql.includes("jira_status = 'commented'")) {
            row.jira_status = 'commented';
            row.jira_issue_key = params[1];
          } else if (sql.includes("jira_status = 'created'")) {
            row.jira_status = 'created';
            row.jira_issue_key = params[1];
          }
        }
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const jiraCalls = [];
  const fakeJiraFetch = async (url, init) => {
    jiraCalls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/search/jql')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          issues: openIssues.map((i) => ({ key: i.key, fields: { summary: i.summary, labels: ['Feedback'] } }))
        })
      };
    }
    if (url.endsWith('/comment')) return { ok: true, status: 201, json: async () => ({ id: 'c1' }) };
    if (url.endsWith('/rest/api/3/issue'))
      return { ok: true, status: 201, json: async () => ({ key: 'AURA-201', id: '201' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const jira = createJiraClient(
    {
      JIRA_BASE_URL: 'https://site.atlassian.net',
      JIRA_EMAIL: 'dev@example.com',
      JIRA_API_TOKEN: 'tok-test',
      JIRA_PROJECT_KEY: 'AURA'
    },
    fakeJiraFetch
  );
  const worker = createFeedbackJiraWorker({ db: fakeDb, jiraClient: jira, envName: 'production' });

  const r1 = await worker.exportOne(1);
  assert.strictEqual(r1.outcome, 'rejected');
  assert.strictEqual(rows.get(1).jira_status, 'rejected');

  const r2 = await worker.exportOne(2);
  assert.strictEqual(r2.outcome, 'commented');
  assert.strictEqual(r2.key, 'AURA-12');

  const r3 = await worker.exportOne(3);
  assert.strictEqual(r3.outcome, 'created');
  assert.strictEqual(r3.key, 'AURA-201');
  const createCall = jiraCalls.find((c) => c.url.endsWith('/rest/api/3/issue'));
  assert.ok(createCall.body.fields.labels.includes('Feedback'));
  assert.ok(createCall.body.fields.labels.includes('env-production'));
});

test('improvementEngine: heuristic scoring, clustering and 1-click agent/evals Golden Eval export', () => {
  const session = {
    session_id: 'sess-fail-42',
    mode: 'agent_v2',
    os_platform: 'win32',
    total_latency_ms: 14_000,
    has_error: true,
    user_rating: 'down',
    messages: [
      { role: 'user', text: 'Finde günstige Flüge nach Japan für max@example.de' },
      { role: 'assistant', text: 'Cookie-Banner blockiert Klick.' }
    ]
  };
  const spans = [
    { tool_name: 'browser_navigate', status: 'ok', duration_ms: 1200 },
    { tool_name: 'browser_click', status: 'error', error_type: 'cookie_overlay_blocked', duration_ms: 4200 }
  ];

  const scored = scoreSessionHeuristic(session, spans);
  assert.ok(scored.score < 2.5);
  assert.match(scored.clusterTag, /browser_click:cookie_overlay_blocked:win32/);

  const artifact = buildGoldenEvalArtifact(
    { ...session, cluster_tag: scored.clusterTag, judge_summary: scored.summary },
    spans
  );
  assert.match(artifact.filename, /^eval_.*\.json$/);
  assert.strictEqual(artifact.spec.schema_version, 'aura-eval-v1');
  assert.doesNotMatch(artifact.spec.prompt, /max@example\.de/);
  assert.deepStrictEqual(artifact.spec.expected_tools, ['browser_navigate', 'browser_click']);
});

test('UI & Headhunter K8s/Grafana/Tailscale wiring integrity checks', () => {
  // Desktop UI opt-ins + DSGVO Art. 17 + Feedback Trace attachment
  const setupHtml = read('src/renderer/setup.html');
  assert.match(setupHtml, /id="optMetrics"/);
  assert.match(setupHtml, /id="optTraces"/);

  const zentraleHtml = read('src/renderer/zentrale.html');
  assert.match(zentraleHtml, /id="cfgTelemetryMetrics"/);
  assert.match(zentraleHtml, /id="cfgTelemetryTraces"/);
  assert.match(zentraleHtml, /id="cfgAdminApiUrl"/);
  assert.match(zentraleHtml, /id="cfgDeleteRemoteData"/);
  assert.match(zentraleHtml, /id="fbAttachTrace"/);

  // Admin Frontend Modern Web Guidance checks
  const adminHtml = read('admin/frontend/index.html');
  assert.match(adminHtml, /<meta name="color-scheme" content="light dark">/);
  assert.match(adminHtml, /<dialog id="proposalDialog"[^>]*closedby="any"/);
  assert.match(adminHtml, /<dialog id="evalDialog"[^>]*closedby="any"/);
  assert.match(adminHtml, /tabindex="0" role="region"/);

  // Nginx blocks /metrics publicly
  const nginxConf = read('admin/frontend/nginx.conf');
  assert.match(nginxConf, /location = \/metrics[\s\S]*return 404/);

  // PostgreSQL schema: grafana_ro never gets SELECT on user_feedback.message or admin_sessions
  const schemaSql = read('admin/backend/src/db/schema.sql');
  assert.doesNotMatch(schemaSql, /GRANT SELECT ON TABLE[^;]*admin_sessions/i);
  assert.doesNotMatch(schemaSql, /GRANT SELECT ON TABLE[^;]*user_feedback/i);
  assert.match(schemaSql, /GRANT SELECT \(id, kind, status, jira_status/i);

  // Grafana Dashboards are valid JSON
  for (const dash of [
    'k8s/monitoring/grafana/dashboards/aura-api-performance.json',
    'k8s/monitoring/grafana/dashboards/aura-product-analytics.json',
    'k8s/monitoring/grafana/dashboards/aura-agent-reliability.json'
  ]) {
    const parsed = JSON.parse(read(dash));
    assert.ok(parsed.uid && Array.isArray(parsed.panels) && parsed.panels.length >= 4, dash);
  }

  // Tailscale Funnel proxies to suffixed prod/int frontend service with aura-prod / aura-int hostnames
  const prodFunnel = read('k8s/overlays/prod/tailscale-funnel.yaml');
  const intFunnel = read('k8s/overlays/int/tailscale-funnel.yaml');
  assert.match(prodFunnel, /frontend-service-prod:80/);
  assert.match(prodFunnel, /value:\s*aura-prod\b/);
  assert.match(intFunnel, /frontend-service-int:80/);
  assert.match(intFunnel, /value:\s*aura-int\b/);
  assert.match(read('k8s/overlays/prod/patches/env.yaml'), /backend-service-prod:3001/);
  assert.match(read('k8s/overlays/int/patches/env.yaml'), /backend-service-int:3001/);
  assert.match(read('src/store.js'), /https:\/\/aura-prod\.tailc7b22c\.ts\.net/);
});
