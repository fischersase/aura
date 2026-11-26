// @ts-check
// Datenschutzfreundliche Telemetrie-, Trace- und Feedback-Anbindung an die Aura Admin Console.
// Stufe 0 (Standard): rein lokal, nichts verlässt den PC.
// Stufe 1 (telemetryMetricsOptIn): anonyme Nutzungs- & Performance-Metriken (keine Chat-Texte).
// Stufe 2 (telemetryTracesOptIn): clientseitig geschwärzte Chat- & Agent-Protokolle zur Verbesserung.
const crypto = require('crypto');
const redact = require('./redact');

const MAX_BATCH = 25;
const FLUSH_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_ADMIN_URL = 'https://aura-prod.tailc7b22c.ts.net';

/**
 * Validiert eine Admin-API-Basis-URL. Erlaubt HTTPS (z. B. Tailscale Funnel) oder Loopback-HTTP für lokale Tests.
 * @param {string} raw
 * @returns {string}
 */
function normalizeAdminUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password) return '';
    if (u.protocol === 'https:') return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    ) {
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Ermittelt die aktuelle Zustimmungsstufe.
 * @param {{ telemetryMetricsOptIn?: boolean, telemetryTracesOptIn?: boolean }} s
 * @returns {'none' | 'metrics' | 'traces'}
 */
function consentTierOf(s) {
  if (s && s.telemetryTracesOptIn) return 'traces';
  if (s && s.telemetryMetricsOptIn) return 'metrics';
  return 'none';
}

/**
 * Erstellt einen isolierten Telemetrie-Client (testbar mit gemocktem store & fetch).
 * @param {{
 *   getSettings: () => Record<string, any>,
 *   saveSettings: (patch: Record<string, any>) => any,
 *   getVersion: () => string,
 *   getHardware?: () => Promise<Record<string, any> | null>,
 *   fetchImpl?: typeof fetch,
 *   envAdminUrl?: string
 * }} deps
 */
function createTelemetryClient(deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  /** @type {Array<Record<string, any>>} */
  let queue = [];
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  function ensureInstallId() {
    const s = deps.getSettings() || {};
    if (typeof s.installId === 'string' && /^[0-9a-f-]{16,64}$/i.test(s.installId)) {
      return s.installId;
    }
    const id = crypto.randomUUID();
    try {
      deps.saveSettings({ installId: id });
    } catch {}
    return id;
  }

  function adminBaseUrl() {
    const s = deps.getSettings() || {};
    if (
      String(s.adminApiUrl || '')
        .trim()
        .toLowerCase() === 'off'
    )
      return '';
    const candidate = s.adminApiUrl || deps.envAdminUrl || process.env.AURA_ADMIN_URL || DEFAULT_ADMIN_URL;
    return normalizeAdminUrl(candidate);
  }

  /**
   * @param {string} method
   * @param {string} route
   * @param {Record<string, any> | null} body
   */
  async function sendJson(method, route, body) {
    const base = adminBaseUrl();
    if (!base) return { ok: false, skipped: true, reason: 'no_admin_url' };
    const installId = ensureInstallId();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}${route}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Aura-Install-Id': installId,
          'X-Aura-Version': String(deps.getVersion() || '0.0.0')
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(t);
    }
  }

  async function sendHeartbeat() {
    const s = deps.getSettings() || {};
    const tier = consentTierOf(s);
    if (tier === 'none' || !adminBaseUrl()) return { ok: false, skipped: true };
    const hw = deps.getHardware ? await deps.getHardware().catch(() => null) : null;
    const vram = hw && typeof hw.vramGb === 'number' ? hw.vramGb : null;
    const gpuTier = !vram ? 'cpu-only' : vram >= 16 ? 'high-vram' : vram >= 8 ? 'mid-vram' : 'entry-vram';
    return sendJson('POST', '/api/ingest/heartbeat', {
      installId: ensureInstallId(),
      osPlatform: process.platform,
      osArch: process.arch,
      appVersion: String(deps.getVersion() || '0.0.0'),
      ramGb: hw && typeof hw.ramGb === 'number' ? hw.ramGb : null,
      vramGb: vram,
      gpuTier,
      provider: String(s.provider || 'gemini'),
      consentTier: tier
    });
  }

  /** @param {Record<string, any>} ev */
  function recordEvent(ev) {
    const s = deps.getSettings() || {};
    if (consentTierOf(s) === 'none' || !adminBaseUrl()) return false;
    queue.push({
      eventType: String(ev.eventType || 'generic').slice(0, 64),
      feature: String(ev.feature || 'app').slice(0, 64),
      provider: String(ev.provider || s.provider || '').slice(0, 32),
      model: String(ev.model || '').slice(0, 80),
      toolName: ev.toolName ? String(ev.toolName).slice(0, 80) : null,
      latencyMs: Number.isFinite(Number(ev.latencyMs)) ? Math.max(0, Math.round(Number(ev.latencyMs))) : null,
      tokensIn: Number.isFinite(Number(ev.tokensIn)) ? Math.max(0, Math.round(Number(ev.tokensIn))) : null,
      tokensOut: Number.isFinite(Number(ev.tokensOut)) ? Math.max(0, Math.round(Number(ev.tokensOut))) : null,
      estCostUsd: Number.isFinite(Number(ev.estCostUsd)) ? Math.max(0, Number(ev.estCostUsd)) : null,
      status: String(ev.status || 'ok').slice(0, 32),
      errorCode: ev.errorCode ? String(ev.errorCode).slice(0, 80) : null,
      createdAt: new Date().toISOString()
    });
    if (queue.length >= MAX_BATCH) {
      flush().catch(() => {});
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush().catch(() => {});
      }, FLUSH_INTERVAL_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return true;
  }

  async function flush() {
    if (!queue.length) return { ok: true, sent: 0 };
    const s = deps.getSettings() || {};
    if (consentTierOf(s) === 'none' || !adminBaseUrl()) {
      queue = [];
      return { ok: false, skipped: true, sent: 0 };
    }
    const batch = queue.splice(0, MAX_BATCH);
    const res = await sendJson('POST', '/api/ingest/events', {
      installId: ensureInstallId(),
      osPlatform: process.platform,
      appVersion: String(deps.getVersion() || '0.0.0'),
      events: batch
    });
    return { ...res, sent: res.ok ? batch.length : 0 };
  }

  /**
   * Sendet ein clientseitig geschwärztes Chat- & Agent-Protokoll (nur bei Stufe 2 Opt-In oder expliziter Nutzerfreigabe).
   * @param {{
   *   sessionId: string,
   *   mode?: string,
   *   provider?: string,
   *   model?: string,
   *   messages?: Array<Record<string, any>>,
   *   spans?: Array<Record<string, any>>,
   *   totalLatencyMs?: number,
   *   totalTokens?: number,
   *   estCostUsd?: number,
   *   hasError?: boolean,
   *   userRating?: 'up' | 'down' | null,
   *   forceConsent?: boolean
   * }} trace
   */
  async function recordSessionTrace(trace) {
    const s = deps.getSettings() || {};
    if (!trace.forceConsent && !s.telemetryTracesOptIn) return { ok: false, skipped: true };
    if (!adminBaseUrl()) return { ok: false, skipped: true, reason: 'no_admin_url' };

    const safeMessages = (Array.isArray(trace.messages) ? trace.messages : []).slice(-60).map((m) => ({
      role: String(m.role || 'user').slice(0, 24),
      text: redact.scrubPii(String(m.text || m.content || '')).slice(0, 6000),
      ts: m.ts || null
    }));

    const safeSpans = (Array.isArray(trace.spans) ? trace.spans : []).slice(0, 120).map((sp) => ({
      spanId: String(sp.spanId || crypto.randomUUID()).slice(0, 64),
      parentSpanId: sp.parentSpanId ? String(sp.parentSpanId).slice(0, 64) : null,
      spanType: String(sp.spanType || 'tool').slice(0, 32),
      toolName: sp.toolName ? String(sp.toolName).slice(0, 80) : null,
      durationMs: Number.isFinite(Number(sp.durationMs)) ? Math.max(0, Math.round(Number(sp.durationMs))) : 0,
      status: String(sp.status || 'ok').slice(0, 32),
      errorType: sp.errorType ? redact.scrubPii(String(sp.errorType)).slice(0, 160) : null,
      redactedIo: redact.scrubObject(sp.io || sp.redactedIo || null),
      startedAt: sp.startedAt || new Date().toISOString()
    }));

    return sendJson('POST', '/api/ingest/sessions', {
      installId: ensureInstallId(),
      sessionId: String(trace.sessionId || crypto.randomUUID()).slice(0, 80),
      mode: String(trace.mode || 'chat').slice(0, 32),
      provider: String(trace.provider || s.provider || 'gemini').slice(0, 32),
      model: String(trace.model || '').slice(0, 80),
      appVersion: String(deps.getVersion() || '0.0.0'),
      osPlatform: process.platform,
      turnCount: safeMessages.filter((m) => m.role === 'user').length,
      totalLatencyMs: Number.isFinite(Number(trace.totalLatencyMs)) ? Math.round(Number(trace.totalLatencyMs)) : 0,
      totalTokens: Number.isFinite(Number(trace.totalTokens)) ? Math.round(Number(trace.totalTokens)) : 0,
      estCostUsd: Number.isFinite(Number(trace.estCostUsd)) ? Number(trace.estCostUsd) : 0,
      hasError: Boolean(trace.hasError),
      userRating: trace.userRating === 'up' || trace.userRating === 'down' ? trace.userRating : null,
      messages: safeMessages,
      spans: safeSpans
    });
  }

  /**
   * Sendet In-App-Feedback direkt an die Aura Admin Console (inkl. optionalem geschwärztem Trace).
   * @param {{
   *   kind?: string,
   *   title?: string,
   *   message: string,
   *   sessionId?: string | null,
   *   context?: Record<string, any> | null,
   *   trace?: Record<string, any> | null
   * }} payload
   */
  async function submitFeedbackToAdmin(payload) {
    if (!adminBaseUrl()) return { ok: false, skipped: true, reason: 'no_admin_url' };
    let linkedSessionId = payload.sessionId || null;
    if (payload.trace) {
      const tr = await recordSessionTrace({
        sessionId: linkedSessionId || crypto.randomUUID(),
        ...payload.trace,
        forceConsent: true
      });
      if (tr.ok && tr.data && tr.data.sessionId) linkedSessionId = tr.data.sessionId;
    }
    return sendJson('POST', '/api/ingest/feedback', {
      installId: ensureInstallId(),
      sessionId: linkedSessionId,
      kind:
        payload.kind === 'bug' || payload.kind === 'idea' || payload.kind === 'feature'
          ? payload.kind === 'feature'
            ? 'idea'
            : payload.kind
          : 'feedback',
      title: redact.scrubPii(String(payload.title || '')).slice(0, 140),
      message: redact.scrubPii(String(payload.message || '')).slice(0, 4000),
      clientContext: payload.context ? redact.scrubObject(payload.context) : null
    });
  }

  /** DSGVO Art. 17: Löscht alle auf dem Admin-Server gespeicherten Daten dieser Installation. */
  async function deleteMyRemoteData() {
    if (!adminBaseUrl()) return { ok: false, skipped: true, reason: 'no_admin_url' };
    const id = ensureInstallId();
    queue = [];
    return sendJson('DELETE', `/api/ingest/installations/${encodeURIComponent(id)}`, null);
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    ensureInstallId,
    adminBaseUrl,
    sendHeartbeat,
    recordEvent,
    flush,
    recordSessionTrace,
    submitFeedbackToAdmin,
    deleteMyRemoteData,
    stop
  };
}

module.exports = {
  normalizeAdminUrl,
  consentTierOf,
  createTelemetryClient
};
