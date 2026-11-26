// Aura Admin Console Express-App:
// - Public Ingest API (Telemetrie, geschwärzte Session-Traces, Feedback, DSGVO Art. 17 Löschung)
// - Admin Auth (Google ID Token + ADMIN_BOOTSTRAP_EMAILS, non-admins erhalten 404)
// - Admin APIs: Product Analytics, SRE Golden Signals, Trace Explorer, Feedback Inbox + Jira, Improvement Flywheel
// - Prometheus /metrics + Healthcheck /api/health
'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { scrubPii, scrubObject } = require('./redact');
const { scoreSessionHeuristic, evaluateSession, buildGoldenEvalArtifact } = require('./services/improvementEngine');

const MAX_FEEDBACK_PER_DAY = Number(process.env.FEEDBACK_MAX_PER_DAY || 30);
const INSTALL_ID_RE = /^[0-9a-zA-Z_-]{8,80}$/;

function clampDays(raw, def = 30) {
  const n = Number.parseInt(String(raw || def), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(365, n));
}

function createApp({ db, auth, metrics, jiraClient, jiraWorker }) {
  const app = express();

  app.disable('x-powered-by');
  if (process.env.TRUSTED_PROXY_CIDRS) {
    const cidrs = process.env.TRUSTED_PROXY_CIDRS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    app.set('trust proxy', cidrs);
  } else {
    app.set('trust proxy', Number(process.env.TRUSTED_PROXY_HOPS || 1));
  }

  app.use(helmet());
  app.use(express.json({ limit: '512kb' }));
  if (metrics) app.use(metrics.middleware);

  const ingestLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.headers['x-aura-install-id'] || req.ip || 'anon')
  });

  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  });

  const adminLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  });

  const feedbackLimiter = rateLimit({
    windowMs: 60_000,
    max: 5, // Headhunter BURST_PER_MINUTE = 5
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.headers['x-aura-install-id'] || req.ip || 'anon'),
    message: { error: 'Zu viele Rückmeldungen in einer Minute – bitte kurz warten.', code: 'RATE_LIMITED' }
  });

  // ---------- Health & Prometheus Metrics ----------

  app.get('/api/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      return res.json({
        ok: true,
        env: process.env.AURA_ENV || 'development',
        jiraConfigured: Boolean(jiraClient && jiraClient.configured),
        grafanaUrl: process.env.GRAFANA_PUBLIC_URL || ''
      });
    } catch {
      return res.status(503).json({ ok: false, error: 'Database unavailable' });
    }
  });

  app.get('/metrics', async (_req, res) => {
    if (!metrics) return res.status(404).end();
    res.set('Content-Type', metrics.register.contentType);
    return res.end(await metrics.register.metrics());
  });

  // ---------- Auth Routes (Headhunter Google OAuth + Dev-Mode) ----------

  app.get('/api/auth/config', authLimiter, (_req, res) => {
    res.json({
      googleConfigured: auth.googleConfigured(),
      googleClientId: auth.googleClientId(),
      devLoginEnabled: auth.devLoginEnabled(),
      grafanaUrl: process.env.GRAFANA_PUBLIC_URL || ''
    });
  });

  app.get('/api/auth/me', authLimiter, async (req, res) => {
    const user = await auth.resolveUser(req);
    if (!user || !user.is_admin) return res.status(401).json({ authenticated: false });
    return res.json({
      authenticated: true,
      user: { email: user.email, name: user.name, avatarUrl: user.avatar_url || null, isAdmin: true }
    });
  });

  app.post('/api/auth/google', authLimiter, async (req, res) => {
    try {
      const credential = req.body && req.body.credential;
      if (!credential || typeof credential !== 'string') {
        return res.status(400).json({ error: 'Google-Token fehlt.' });
      }
      const profile = await auth.verifyGoogleCredential(credential);
      const user = await auth.upsertAdminUser(profile);
      if (!user || !user.is_admin) {
        return res.status(403).json({ error: 'Dieses Google-Konto hat keinen Admin-Zugang.' });
      }
      await auth.createSession(user.id, res);
      return res.json({
        authenticated: true,
        user: { email: user.email, name: user.name, avatarUrl: user.avatar_url || null, isAdmin: true }
      });
    } catch (err) {
      return res.status(401).json({ error: err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen.' });
    }
  });

  app.post('/api/auth/dev', authLimiter, async (req, res) => {
    if (!auth.devLoginEnabled()) return res.status(404).json({ error: 'Not found.' });
    const token = req.body && req.body.token;
    if (!auth.devTokenMatches(token)) return res.status(401).json({ error: 'Ungültiges Dev-Token.' });
    const user = await auth.upsertAdminUser({
      email: 'dev@aura.local',
      name: 'Local Dev Admin'
    });
    // In Dev-Modus automatisch Admin-Flag setzen
    await db.query('UPDATE admin_users SET is_admin = true WHERE id = $1', [user.id]);
    await auth.createSession(user.id, res);
    return res.json({ authenticated: true, user: { email: user.email, name: user.name, isAdmin: true } });
  });

  app.post('/api/auth/logout', authLimiter, async (req, res) => {
    await auth.destroySession(req, res);
    res.json({ ok: true });
  });

  // ---------- Public Client Ingest API ----------

  async function ensureInstallation(installId, meta = {}) {
    await db.query(
      `INSERT INTO installations (install_id, os_platform, os_arch, app_version, ram_gb, vram_gb, gpu_tier, provider, consent_tier, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (install_id) DO UPDATE SET
         os_platform = COALESCE(NULLIF(EXCLUDED.os_platform, 'unknown'), installations.os_platform),
         os_arch = COALESCE(NULLIF(EXCLUDED.os_arch, 'unknown'), installations.os_arch),
         app_version = COALESCE(NULLIF(EXCLUDED.app_version, '0.0.0'), installations.app_version),
         ram_gb = COALESCE(EXCLUDED.ram_gb, installations.ram_gb),
         vram_gb = COALESCE(EXCLUDED.vram_gb, installations.vram_gb),
         gpu_tier = COALESCE(NULLIF(EXCLUDED.gpu_tier, 'unknown'), installations.gpu_tier),
         provider = COALESCE(NULLIF(EXCLUDED.provider, ''), installations.provider),
         consent_tier = COALESCE(EXCLUDED.consent_tier, installations.consent_tier),
         last_seen = NOW()`,
      [
        installId,
        String(meta.osPlatform || 'unknown').slice(0, 32),
        String(meta.osArch || 'unknown').slice(0, 32),
        String(meta.appVersion || '0.0.0').slice(0, 32),
        Number.isFinite(Number(meta.ramGb)) ? Math.round(Number(meta.ramGb)) : null,
        Number.isFinite(Number(meta.vramGb)) ? Math.round(Number(meta.vramGb)) : null,
        String(meta.gpuTier || 'unknown').slice(0, 32),
        String(meta.provider || 'gemini').slice(0, 32),
        ['none', 'metrics', 'traces'].includes(meta.consentTier) ? meta.consentTier : 'metrics'
      ]
    );
  }

  app.post('/api/ingest/heartbeat', ingestLimiter, async (req, res) => {
    const b = req.body || {};
    const installId = String(b.installId || req.headers['x-aura-install-id'] || '').trim();
    if (!INSTALL_ID_RE.test(installId)) return res.status(400).json({ error: 'Ungültige installId.' });
    await ensureInstallation(installId, b);
    return res.status(200).json({ ok: true });
  });

  app.post('/api/ingest/events', ingestLimiter, async (req, res) => {
    const b = req.body || {};
    const installId = String(b.installId || req.headers['x-aura-install-id'] || '').trim();
    if (!INSTALL_ID_RE.test(installId)) return res.status(400).json({ error: 'Ungültige installId.' });
    const events = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    if (!events.length) return res.json({ ok: true, accepted: 0 });

    const osPlatform = String(b.osPlatform || 'unknown').slice(0, 32);
    const appVersion = String(b.appVersion || req.headers['x-aura-version'] || '0.0.0').slice(0, 32);
    await ensureInstallation(installId, { osPlatform, appVersion, consentTier: 'metrics' });

    for (const ev of events) {
      const eventType = String(ev.eventType || 'generic').slice(0, 64);
      const feature = String(ev.feature || 'app').slice(0, 64);
      const provider = String(ev.provider || '').slice(0, 32);
      const model = String(ev.model || '').slice(0, 80);
      const toolName = ev.toolName ? String(ev.toolName).slice(0, 80) : null;
      const latencyMs = Number.isFinite(Number(ev.latencyMs)) ? Math.max(0, Math.round(Number(ev.latencyMs))) : null;
      const tokensIn = Number.isFinite(Number(ev.tokensIn)) ? Math.max(0, Math.round(Number(ev.tokensIn))) : null;
      const tokensOut = Number.isFinite(Number(ev.tokensOut)) ? Math.max(0, Math.round(Number(ev.tokensOut))) : null;
      const estCostUsd = Number.isFinite(Number(ev.estCostUsd)) ? Math.max(0, Number(ev.estCostUsd)) : null;
      const status = String(ev.status || 'ok').slice(0, 32);
      const errorCode = ev.errorCode ? String(ev.errorCode).slice(0, 80) : null;

      await db.query(
        `INSERT INTO telemetry_events
           (install_id, os_platform, app_version, event_type, feature, provider, model, tool_name, latency_ms, tokens_in, tokens_out, est_cost_usd, status, error_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          installId,
          osPlatform,
          appVersion,
          eventType,
          feature,
          provider,
          model,
          toolName,
          latencyMs,
          tokensIn,
          tokensOut,
          estCostUsd,
          status,
          errorCode
        ]
      );

      if (metrics) {
        metrics.ingestEventsTotal.inc({ event_type: eventType, feature, status });
        if (latencyMs !== null) {
          metrics.clientLatencyMs.observe({ feature, provider: provider || 'unknown', model: model || 'unknown' }, latencyMs);
        }
        if (toolName) {
          metrics.toolCallsTotal.inc({ tool: toolName, os: osPlatform, status });
        }
      }
    }
    return res.status(201).json({ ok: true, accepted: events.length });
  });

  app.post('/api/ingest/sessions', ingestLimiter, async (req, res) => {
    const b = req.body || {};
    const installId = String(b.installId || req.headers['x-aura-install-id'] || '').trim();
    const sessionId = String(b.sessionId || '').trim();
    if (!INSTALL_ID_RE.test(installId) || !INSTALL_ID_RE.test(sessionId)) {
      return res.status(400).json({ error: 'Ungültige installId oder sessionId.' });
    }

    const osPlatform = String(b.osPlatform || 'unknown').slice(0, 32);
    const appVersion = String(b.appVersion || req.headers['x-aura-version'] || '0.0.0').slice(0, 32);
    const mode = String(b.mode || 'chat').slice(0, 32);
    const provider = String(b.provider || 'gemini').slice(0, 32);
    const model = String(b.model || '').slice(0, 80);
    const userRating = b.userRating === 'up' || b.userRating === 'down' ? b.userRating : null;

    await ensureInstallation(installId, { osPlatform, appVersion, provider, consentTier: 'traces' });

    // Zweite, serverseitige PII-/Secret-Schwärzung (Defense-in-Depth)
    const safeMessages = (Array.isArray(b.messages) ? b.messages : []).slice(-60).map((m) => ({
      role: String(m.role || 'user').slice(0, 24),
      text: scrubPii(String(m.text || '')).slice(0, 6000),
      ts: m.ts || null
    }));

    const safeSpans = (Array.isArray(b.spans) ? b.spans : []).slice(0, 120).map((sp, i) => ({
      span_id: String(sp.spanId || `${sessionId}-sp-${i}`).slice(0, 80),
      parent_span_id: sp.parentSpanId ? String(sp.parentSpanId).slice(0, 80) : null,
      span_type: String(sp.spanType || 'tool').slice(0, 32),
      tool_name: sp.toolName ? String(sp.toolName).slice(0, 80) : null,
      duration_ms: Number.isFinite(Number(sp.durationMs)) ? Math.max(0, Math.round(Number(sp.durationMs))) : 0,
      status: String(sp.status || 'ok').slice(0, 32),
      error_type: sp.errorType ? scrubPii(String(sp.errorType)).slice(0, 160) : null,
      redacted_io: scrubObject(sp.redactedIo || sp.io || null),
      started_at: sp.startedAt || new Date().toISOString()
    }));

    const sessionDraft = {
      session_id: sessionId,
      mode,
      provider,
      model,
      os_platform: osPlatform,
      total_latency_ms: Number.isFinite(Number(b.totalLatencyMs)) ? Math.max(0, Math.round(Number(b.totalLatencyMs))) : 0,
      has_error: Boolean(b.hasError) || safeSpans.some((s) => s.status !== 'ok'),
      user_rating: userRating,
      messages: safeMessages
    };
    const evalRes = scoreSessionHeuristic(sessionDraft, safeSpans);

    await db.query(
      `INSERT INTO chat_sessions
         (session_id, install_id, mode, provider, model, app_version, os_platform, turn_count, total_latency_ms, total_tokens, est_cost_usd, has_error, user_rating, judge_score, judge_dimensions, judge_summary, cluster_tag, messages, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         turn_count = EXCLUDED.turn_count,
         total_latency_ms = GREATEST(chat_sessions.total_latency_ms, EXCLUDED.total_latency_ms),
         total_tokens = GREATEST(chat_sessions.total_tokens, EXCLUDED.total_tokens),
         est_cost_usd = GREATEST(chat_sessions.est_cost_usd, EXCLUDED.est_cost_usd),
         has_error = chat_sessions.has_error OR EXCLUDED.has_error,
         user_rating = COALESCE(EXCLUDED.user_rating, chat_sessions.user_rating),
         judge_score = EXCLUDED.judge_score,
         judge_dimensions = EXCLUDED.judge_dimensions,
         judge_summary = EXCLUDED.judge_summary,
         cluster_tag = COALESCE(EXCLUDED.cluster_tag, chat_sessions.cluster_tag),
         messages = CASE WHEN jsonb_array_length(EXCLUDED.messages) > 0 THEN EXCLUDED.messages ELSE chat_sessions.messages END,
         updated_at = NOW()`,
      [
        sessionId,
        installId,
        mode,
        provider,
        model,
        appVersion,
        osPlatform,
        Number.isFinite(Number(b.turnCount)) ? Math.max(0, Math.round(Number(b.turnCount))) : safeMessages.filter((m) => m.role === 'user').length,
        sessionDraft.total_latency_ms,
        Number.isFinite(Number(b.totalTokens)) ? Math.max(0, Math.round(Number(b.totalTokens))) : 0,
        Number.isFinite(Number(b.estCostUsd)) ? Math.max(0, Number(b.estCostUsd)) : 0,
        sessionDraft.has_error,
        userRating,
        evalRes.score,
        JSON.stringify(evalRes.dimensions),
        evalRes.summary,
        evalRes.clusterTag,
        JSON.stringify(safeMessages)
      ]
    );

    for (const sp of safeSpans) {
      await db.query(
        `INSERT INTO trace_spans (span_id, session_id, parent_span_id, span_type, tool_name, duration_ms, status, error_type, redacted_io, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (span_id) DO NOTHING`,
        [
          sp.span_id,
          sessionId,
          sp.parent_span_id,
          sp.span_type,
          sp.tool_name,
          sp.duration_ms,
          sp.status,
          sp.error_type,
          sp.redacted_io ? JSON.stringify(sp.redacted_io) : null,
          sp.started_at
        ]
      );
      if (metrics && sp.tool_name) {
        metrics.toolCallsTotal.inc({ tool: sp.tool_name, os: osPlatform, status: sp.status });
      }
    }

    if (metrics) {
      metrics.sessionsIngestedTotal.inc({ mode, provider, rating: userRating || 'none' });
    }
    return res.status(201).json({ ok: true, sessionId, judgeScore: evalRes.score, clusterTag: evalRes.clusterTag });
  });

  app.post('/api/ingest/feedback', feedbackLimiter, async (req, res) => {
    const b = req.body || {};
    const installId = String(b.installId || req.headers['x-aura-install-id'] || '').trim();
    const validInstall = INSTALL_ID_RE.test(installId) ? installId : null;
    const rawMsg = String(b.message || '').trim();
    if (!rawMsg) return res.status(400).json({ error: 'Nachricht darf nicht leer sein.', code: 'EMPTY' });
    if (rawMsg.length > 4000) {
      return res.status(400).json({ error: 'Nachricht darf höchstens 4000 Zeichen lang sein.', code: 'TOO_LONG' });
    }

    // Rollierende Tagesgrenze pro Installation (Headhunter-Schutz)
    if (validInstall) {
      const dayCount = await db.query(
        `SELECT COUNT(*)::int AS n FROM user_feedback
         WHERE install_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
        [validInstall]
      );
      if (((dayCount.rows[0] && dayCount.rows[0].n) || 0) >= MAX_FEEDBACK_PER_DAY) {
        return res.status(429).json({
          error: 'Tageslimit für Rückmeldungen erreicht – morgen geht es weiter.',
          code: 'DAILY_LIMIT'
        });
      }
      await ensureInstallation(validInstall, {
        osPlatform: (b.clientContext && b.clientContext.platform) || 'unknown',
        appVersion: String(req.headers['x-aura-version'] || (b.clientContext && b.clientContext.version) || '0.0.0'),
        ramGb: b.clientContext && b.clientContext.ramGb,
        vramGb: b.clientContext && b.clientContext.vramGb,
        consentTier: 'metrics'
      });
    }

    const kind = b.kind === 'bug' || b.kind === 'idea' ? b.kind : 'feedback';
    const title = scrubPii(String(b.title || '')).slice(0, 140);
    const message = scrubPii(rawMsg).slice(0, 4000);
    const sessionId = b.sessionId && INSTALL_ID_RE.test(String(b.sessionId)) ? String(b.sessionId) : null;

    // Trennung client (Behauptung) vs. server (gesichert) wie in Headhunter docs/feedback.md
    const context = {
      client: b.clientContext ? scrubObject(b.clientContext) : null,
      server: {
        env: process.env.AURA_ENV || 'development',
        appVersionHeader: String(req.headers['x-aura-version'] || '').slice(0, 32),
        receivedAt: new Date().toISOString()
      }
    };

    const inserted = await db.query(
      `INSERT INTO user_feedback (install_id, session_id, kind, title, message, context)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, kind, status, jira_status, created_at`,
      [validInstall, sessionId, kind, title, message, JSON.stringify(context)]
    );
    const row = inserted.rows[0];
    if (metrics) metrics.feedbackSubmittedTotal.inc({ kind });

    // Asynchroner Jira-Export (nicht im Anfrage-Pfad awaited, genau wie Headhunter!)
    if (jiraWorker && jiraClient && jiraClient.configured) {
      setImmediate(() => {
        jiraWorker.exportOne(row.id, { force: false }).catch(() => {});
      });
    }

    return res.status(201).json({ ok: true, id: row.id, jiraStatus: row.jira_status });
  });

  // DSGVO Art. 17: 1-Klick-Löschen aller eigenen Daten dieser Installation
  app.delete('/api/ingest/installations/:installId', ingestLimiter, async (req, res) => {
    const id = String(req.params.installId || '').trim();
    const headerId = String(req.headers['x-aura-install-id'] || '').trim();
    if (!INSTALL_ID_RE.test(id) || id !== headerId) {
      return res.status(403).json({ error: 'Löschung nur mit passender installId zulässig.' });
    }
    await db.query('DELETE FROM user_feedback WHERE install_id = $1', [id]);
    const del = await db.query('DELETE FROM installations WHERE install_id = $1', [id]);
    return res.json({ ok: true, deleted: (del.rowCount || 0) > 0 });
  });

  // Öffentliche (read-only) aktive Remote-Config / Canary-Rollouts
  app.get('/api/config/remote', ingestLimiter, async (_req, res) => {
    const r = await db.query(
      `SELECT id, cluster_tag, target_type, title, config_patch, rollout_pct, status, updated_at
       FROM improvement_proposals
       WHERE status IN ('canary', 'active') AND rollout_pct > 0
       ORDER BY updated_at DESC`
    );
    return res.json({ version: 1, proposals: r.rows });
  });

  // ---------- Protected Admin Console APIs (404 für Nicht-Admins!) ----------

  const admin = express.Router();
  admin.use(adminLimiter);
  admin.use(auth.requireAdmin);

  // Modul 1: Executive & Product Analytics
  admin.get('/overview', async (req, res) => {
    const days = clampDays(req.query.days, 30);
    const [kpis, osSplit, versionSplit, hwSplit, modelSplit, featureSplit, dailyActivity, funnel, feedbackCounts] =
      await Promise.all([
        db.query(
          `SELECT
             (SELECT COUNT(*)::int FROM installations) AS total_installs,
             (SELECT COUNT(*)::int FROM installations WHERE last_seen >= NOW() - INTERVAL '1 day') AS dau,
             (SELECT COUNT(*)::int FROM installations WHERE last_seen >= NOW() - INTERVAL '7 days') AS wau,
             (SELECT COUNT(*)::int FROM installations WHERE last_seen >= NOW() - INTERVAL '30 days') AS mau,
             (SELECT COUNT(*)::int FROM chat_sessions WHERE created_at >= NOW() - ($1 || ' days')::interval) AS sessions_period,
             (SELECT COALESCE(ROUND(AVG(judge_score)::numeric, 2), 0)::float FROM chat_sessions WHERE judge_score IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::interval) AS avg_judge_score,
             (SELECT COUNT(*)::int FROM chat_sessions WHERE user_rating = 'up' AND created_at >= NOW() - ($1 || ' days')::interval) AS ratings_up,
             (SELECT COUNT(*)::int FROM chat_sessions WHERE user_rating = 'down' AND created_at >= NOW() - ($1 || ' days')::interval) AS ratings_down,
             (SELECT COALESCE(SUM(est_cost_usd), 0)::float FROM telemetry_events WHERE created_at >= NOW() - ($1 || ' days')::interval) AS est_cost_usd`,
          [days]
        ),
        db.query(`SELECT os_platform AS label, COUNT(*)::int AS count FROM installations GROUP BY os_platform ORDER BY count DESC`),
        db.query(`SELECT app_version AS label, COUNT(*)::int AS count FROM installations GROUP BY app_version ORDER BY count DESC LIMIT 12`),
        db.query(`SELECT gpu_tier AS label, COUNT(*)::int AS count, COALESCE(ROUND(AVG(ram_gb))::int, 0) AS avg_ram_gb, COALESCE(ROUND(AVG(vram_gb))::int, 0) AS avg_vram_gb FROM installations GROUP BY gpu_tier ORDER BY count DESC`),
        db.query(
          `SELECT COALESCE(NULLIF(model, ''), provider) AS label, provider, COUNT(*)::int AS count
           FROM telemetry_events
           WHERE created_at >= NOW() - ($1 || ' days')::interval AND (model != '' OR provider != '')
           GROUP BY label, provider ORDER BY count DESC LIMIT 12`,
          [days]
        ),
        db.query(
          `SELECT feature AS label, COUNT(*)::int AS count,
                  COUNT(*) FILTER (WHERE status = 'error')::int AS errors
           FROM telemetry_events
           WHERE created_at >= NOW() - ($1 || ' days')::interval
           GROUP BY feature ORDER BY count DESC LIMIT 12`,
          [days]
        ),
        db.query(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                  COUNT(DISTINCT install_id)::int AS active_users,
                  COUNT(*)::int AS events,
                  COUNT(*) FILTER (WHERE status = 'error')::int AS errors
           FROM telemetry_events
           WHERE created_at >= NOW() - ($1 || ' days')::interval
           GROUP BY 1 ORDER BY 1 ASC`,
          [days]
        ),
        db.query(
          `SELECT
             (SELECT COUNT(*)::int FROM installations) AS installed,
             (SELECT COUNT(*)::int FROM installations WHERE consent_tier IN ('metrics', 'traces')) AS opted_in,
             (SELECT COUNT(DISTINCT install_id)::int FROM telemetry_events WHERE event_type IN ('chat_turn', 'setup_complete')) AS first_chat,
             (SELECT COUNT(DISTINCT install_id)::int FROM telemetry_events WHERE feature = 'agent_v2') AS first_agent_task,
             (SELECT COUNT(DISTINCT install_id)::int FROM chat_sessions) AS shared_trace`
        ),
        db.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'new')::int AS open_feedback,
             COUNT(*) FILTER (WHERE status = 'done')::int AS done_feedback,
             COUNT(*) FILTER (WHERE jira_status IN ('created', 'commented'))::int AS in_jira,
             COUNT(*) FILTER (WHERE jira_status IN ('pending', 'failed') AND status != 'done')::int AS pending_jira
           FROM user_feedback`
        )
      ]);

    return res.json({
      days,
      kpis: kpis.rows[0] || {},
      osSplit: osSplit.rows,
      versionSplit: versionSplit.rows,
      hardwareSplit: hwSplit.rows,
      modelSplit: modelSplit.rows,
      featureSplit: featureSplit.rows,
      dailyActivity: dailyActivity.rows,
      funnel: funnel.rows[0] || {},
      feedbackCounts: feedbackCounts.rows[0] || {},
      jira: jiraClient ? jiraClient.info() : { configured: false }
    });
  });

  // Modul 2: SRE Performance & Golden Signals
  admin.get('/performance', async (req, res) => {
    const days = clampDays(req.query.days, 14);
    const [latencyByFeature, toolMatrix, latencyTrend, errorCodes, sessionStats] = await Promise.all([
      db.query(
        `SELECT feature,
                COUNT(*)::int AS requests,
                COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
                COALESCE(ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms))::int, 0) AS p50_ms,
                COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms))::int, 0) AS p95_ms,
                COALESCE(ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms))::int, 0) AS p99_ms
         FROM telemetry_events
         WHERE created_at >= NOW() - ($1 || ' days')::interval AND latency_ms IS NOT NULL
         GROUP BY feature ORDER BY requests DESC`,
        [days]
      ),
      db.query(
        `SELECT tool_name, os_platform,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ok')::int AS ok_count,
                COUNT(*) FILTER (WHERE status != 'ok')::int AS err_count,
                COALESCE(ROUND(AVG(latency_ms))::int, 0) AS avg_ms
         FROM (
           SELECT tool_name, os_platform, status, latency_ms FROM telemetry_events
           WHERE tool_name IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::interval
           UNION ALL
           SELECT sp.tool_name, cs.os_platform, sp.status, sp.duration_ms AS latency_ms
           FROM trace_spans sp JOIN chat_sessions cs ON cs.session_id = sp.session_id
           WHERE sp.tool_name IS NOT NULL AND sp.started_at >= NOW() - ($1 || ' days')::interval
         ) t
         GROUP BY tool_name, os_platform
         ORDER BY total DESC LIMIT 40`,
        [days]
      ),
      db.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS requests,
                COALESCE(ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms))::int, 0) AS p50_ms,
                COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms))::int, 0) AS p95_ms,
                ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'error') / GREATEST(COUNT(*), 1), 2)::float AS error_rate_pct
         FROM telemetry_events
         WHERE created_at >= NOW() - ($1 || ' days')::interval AND latency_ms IS NOT NULL
         GROUP BY 1 ORDER BY 1 ASC`,
        [days]
      ),
      db.query(
        `SELECT COALESCE(error_code, 'unknown') AS error_code, feature, COUNT(*)::int AS count
         FROM telemetry_events
         WHERE status = 'error' AND created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY 1, 2 ORDER BY count DESC LIMIT 15`,
        [days]
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS total_sessions,
           COUNT(*) FILTER (WHERE NOT has_error)::int AS error_free_sessions,
           COALESCE(ROUND(AVG(turn_count)::numeric, 1), 0)::float AS avg_turns,
           COALESCE(ROUND(AVG(total_tokens))::int, 0) AS avg_tokens,
           COALESCE(ROUND(SUM(est_cost_usd)::numeric, 4), 0)::float AS total_cost_usd
         FROM chat_sessions
         WHERE created_at >= NOW() - ($1 || ' days')::interval`,
        [days]
      )
    ]);

    return res.json({
      days,
      latencyByFeature: latencyByFeature.rows,
      toolMatrix: toolMatrix.rows,
      latencyTrend: latencyTrend.rows,
      errorCodes: errorCodes.rows,
      sessionStats: sessionStats.rows[0] || {},
      grafanaUrl: process.env.GRAFANA_PUBLIC_URL || ''
    });
  });

  // Modul 3: Chat-History & Agent-Trace Explorer
  admin.get('/sessions', async (req, res) => {
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || 40), 10) || 40));
    const where = [];
    const params = [];
    const add = (cond, val) => {
      params.push(val);
      where.push(cond.replace('$?', `$${params.length}`));
    };
    if (req.query.rating === 'up' || req.query.rating === 'down') add('cs.user_rating = $?', req.query.rating);
    if (req.query.onlyErrors === 'true') where.push('cs.has_error = true');
    if (req.query.os) add('cs.os_platform = $?', String(req.query.os));
    if (req.query.model) add('cs.model = $?', String(req.query.model));
    if (req.query.cluster) add('cs.cluster_tag = $?', String(req.query.cluster));
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      params.push(q);
      const p = `$${params.length}`;
      where.push(`(cs.messages::text ILIKE ${p} OR COALESCE(cs.judge_summary, '') ILIKE ${p} OR COALESCE(cs.cluster_tag, '') ILIKE ${p})`);
    }
    params.push(limit);
    const sql = `
      SELECT cs.session_id, cs.install_id, cs.mode, cs.provider, cs.model, cs.app_version, cs.os_platform,
             cs.turn_count, cs.total_latency_ms, cs.total_tokens, cs.est_cost_usd, cs.has_error,
             cs.user_rating, cs.judge_score, cs.judge_summary, cs.cluster_tag, cs.created_at,
             (cs.messages->0->>'text') AS first_prompt,
             (SELECT COUNT(*)::int FROM trace_spans sp WHERE sp.session_id = cs.session_id) AS span_count
      FROM chat_sessions cs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY cs.created_at DESC
      LIMIT $${params.length}`;
    const r = await db.query(sql, params);
    return res.json({ sessions: r.rows });
  });

  admin.get('/sessions/:sessionId', async (req, res) => {
    const id = String(req.params.sessionId || '');
    const s = await db.query('SELECT * FROM chat_sessions WHERE session_id = $1', [id]);
    if (!s.rows[0]) return res.status(404).json({ error: 'Session nicht gefunden.' });
    const [spans, evals, linkedFeedback] = await Promise.all([
      db.query('SELECT * FROM trace_spans WHERE session_id = $1 ORDER BY started_at ASC', [id]),
      db.query('SELECT id, title, category, status, exported_filename, created_at FROM eval_cases WHERE source_session_id = $1 ORDER BY created_at DESC', [id]),
      db.query('SELECT id, kind, title, message, status, jira_status, jira_issue_key, jira_issue_url, created_at FROM user_feedback WHERE session_id = $1 ORDER BY created_at DESC', [id])
    ]);
    return res.json({
      session: s.rows[0],
      spans: spans.rows,
      evalCases: evals.rows,
      feedback: linkedFeedback.rows
    });
  });

  admin.post('/sessions/:sessionId/evaluate', async (req, res) => {
    const id = String(req.params.sessionId || '');
    const s = await db.query('SELECT * FROM chat_sessions WHERE session_id = $1', [id]);
    if (!s.rows[0]) return res.status(404).json({ error: 'Session nicht gefunden.' });
    const spans = await db.query('SELECT * FROM trace_spans WHERE session_id = $1 ORDER BY started_at ASC', [id]);
    const result = await evaluateSession(s.rows[0], spans.rows);
    await db.query(
      `UPDATE chat_sessions
       SET judge_score = $2, judge_dimensions = $3, judge_summary = $4, cluster_tag = COALESCE($5, cluster_tag), updated_at = NOW()
       WHERE session_id = $1`,
      [id, result.score, JSON.stringify(result.dimensions), result.summary, result.clusterTag]
    );
    return res.json({ ok: true, evaluation: result });
  });

  admin.post('/sessions/:sessionId/export-eval', async (req, res) => {
    const id = String(req.params.sessionId || '');
    const s = await db.query('SELECT * FROM chat_sessions WHERE session_id = $1', [id]);
    if (!s.rows[0]) return res.status(404).json({ error: 'Session nicht gefunden.' });
    const spans = await db.query('SELECT * FROM trace_spans WHERE session_id = $1 ORDER BY started_at ASC', [id]);
    const artifact = buildGoldenEvalArtifact(s.rows[0], spans.rows, req.body || {});
    const ins = await db.query(
      `INSERT INTO eval_cases (source_session_id, category, title, prompt_redacted, expected_behavior, tool_expectations, status, exported_filename, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'exported',$7,$8)
       RETURNING *`,
      [
        id,
        artifact.spec.category,
        artifact.spec.title,
        artifact.spec.prompt,
        artifact.spec.expected_behavior,
        JSON.stringify(artifact.spec.expected_tools),
        artifact.filename,
        (req.adminUser && req.adminUser.email) || 'admin'
      ]
    );
    return res.status(201).json({ ok: true, evalCase: ins.rows[0], artifact });
  });

  // Modul 4: Feedback Inbox (Headhunter-Stil: Ungelesen/Erledigt/Alle + Jira Triage/Dedupe Status + Retry)
  admin.get('/feedback', async (req, res) => {
    const filter = String(req.query.status || 'new');
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || 50), 10) || 50));
    const where = [];
    const params = [];
    if (filter === 'new' || filter === 'in_progress' || filter === 'done') {
      params.push(filter);
      where.push(`status = $${params.length}`);
    }
    if (req.query.before) {
      params.push(Number.parseInt(String(req.query.before), 10) || 0);
      where.push(`id < $${params.length}`);
    }
    params.push(limit);

    const [items, counts] = await Promise.all([
      db.query(
        `SELECT * FROM user_feedback
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY id DESC
         LIMIT $${params.length}`,
        params
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'new')::int AS unread,
           COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
           COUNT(*) FILTER (WHERE status = 'done')::int AS done,
           COUNT(*) FILTER (WHERE jira_status IN ('created', 'commented'))::int AS jira_synced,
           COUNT(*) FILTER (WHERE jira_status = 'pending' AND status != 'done')::int AS jira_pending,
           COUNT(*) FILTER (WHERE jira_status = 'rejected')::int AS jira_rejected,
           COUNT(*) FILTER (WHERE jira_status = 'failed')::int AS jira_failed
         FROM user_feedback`
      )
    ]);

    return res.json({
      items: items.rows,
      counts: counts.rows[0] || {},
      jira: jiraClient ? jiraClient.info() : { configured: false }
    });
  });

  admin.put('/feedback/:id/status', async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    const status = String((req.body && req.body.status) || '');
    if (!Number.isFinite(id) || !['new', 'in_progress', 'done'].includes(status)) {
      return res.status(400).json({ error: 'Ungültiger Status.' });
    }
    const resolvedBy = status === 'done' ? (req.adminUser && req.adminUser.email) || 'admin' : null;
    const r = await db.query(
      `UPDATE user_feedback
       SET status = $2,
           resolved_at = CASE WHEN $2 = 'done' THEN NOW() ELSE NULL END,
           resolved_by = $3
       WHERE id = $1
       RETURNING *`,
      [id, status, resolvedBy]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Rückmeldung nicht gefunden.' });
    return res.json({ ok: true, item: r.rows[0] });
  });

  admin.post('/feedback/:id/jira-retry', async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID.' });
    if (!jiraWorker || !jiraClient || !jiraClient.configured) {
      return res.status(400).json({ error: 'Jira ist in dieser Umgebung nicht eingerichtet.' });
    }
    const force = Boolean(req.body && req.body.force);
    const result = await jiraWorker.exportOne(id, { force });
    const updated = await db.query('SELECT * FROM user_feedback WHERE id = $1', [id]);
    return res.json({ ok: result.ok, result, item: updated.rows[0] || null });
  });

  // Modul 5: Closed-Loop Improvement Engine (Top Pain Points, Golden Evals, Canary Proposals)
  admin.get('/improvements', async (_req, res) => {
    const [clusters, evalCases, proposals] = await Promise.all([
      db.query(
        `SELECT cluster_tag,
                COUNT(*)::int AS session_count,
                COALESCE(ROUND(AVG(judge_score)::numeric, 2), 0)::float AS avg_score,
                COUNT(*) FILTER (WHERE user_rating = 'down')::int AS thumbs_down,
                COUNT(*) FILTER (WHERE has_error)::int AS error_sessions,
                MAX(created_at) AS last_seen
         FROM chat_sessions
         WHERE cluster_tag IS NOT NULL
         GROUP BY cluster_tag
         ORDER BY session_count DESC, avg_score ASC
         LIMIT 20`
      ),
      db.query('SELECT * FROM eval_cases ORDER BY created_at DESC LIMIT 50'),
      db.query('SELECT * FROM improvement_proposals ORDER BY updated_at DESC LIMIT 50')
    ]);
    return res.json({
      clusters: clusters.rows,
      evalCases: evalCases.rows,
      proposals: proposals.rows
    });
  });

  admin.post('/improvements/proposals', async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 180);
    if (!title) return res.status(400).json({ error: 'Titel ist erforderlich.' });
    const targetType = ['system_prompt', 'skill', 'tool_policy', 'browser_rule', 'model_default'].includes(b.targetType)
      ? b.targetType
      : 'system_prompt';
    const rolloutPct = Math.max(0, Math.min(100, Number.parseInt(String(b.rolloutPct || 0), 10) || 0));
    const status = ['draft', 'canary', 'active', 'rolled_back'].includes(b.status)
      ? b.status
      : rolloutPct > 0
        ? rolloutPct === 100
          ? 'active'
          : 'canary'
        : 'draft';

    const r = await db.query(
      `INSERT INTO improvement_proposals (cluster_tag, target_type, title, rationale, config_patch, rollout_pct, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        String(b.clusterTag || '').slice(0, 64),
        targetType,
        title,
        String(b.rationale || '').slice(0, 2000),
        JSON.stringify(b.configPatch || {}),
        rolloutPct,
        status,
        (req.adminUser && req.adminUser.email) || 'admin'
      ]
    );
    return res.status(201).json({ ok: true, proposal: r.rows[0] });
  });

  admin.put('/improvements/proposals/:id', async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID.' });
    const b = req.body || {};
    const rolloutPct = Math.max(0, Math.min(100, Number.parseInt(String(b.rolloutPct ?? 0), 10) || 0));
    const status = ['draft', 'canary', 'active', 'rolled_back'].includes(b.status) ? b.status : 'draft';
    const r = await db.query(
      `UPDATE improvement_proposals
       SET rollout_pct = $2, status = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, rolloutPct, status]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    return res.json({ ok: true, proposal: r.rows[0] });
  });

  // Modul 6: Fleet & Installations
  admin.get('/installations', async (_req, res) => {
    const r = await db.query(
      `SELECT install_id, os_platform, os_arch, app_version, ram_gb, vram_gb, gpu_tier, provider, consent_tier, first_seen, last_seen
       FROM installations
       ORDER BY last_seen DESC
       LIMIT 100`
    );
    return res.json({ installations: r.rows });
  });

  app.use('/api/admin', admin);
  return app;
}

module.exports = { createApp };
