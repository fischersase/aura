// Prometheus-Metriken im Headhunter- & Google-SRE-Stil (Golden Signals: Latency, Traffic, Errors, Saturation).
'use strict';

const client = require('prom-client');

function createMetricsRegistry() {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register, prefix: 'aura_admin_' });

  const httpRequestsTotal = new client.Counter({
    name: 'aura_http_requests_total',
    help: 'HTTP-Anfragen an das Aura Admin Backend nach Methode, Route und Status',
    labelNames: ['method', 'route', 'status'],
    registers: [register]
  });

  const httpRequestDurationSeconds = new client.Histogram({
    name: 'aura_http_request_duration_seconds',
    help: 'Antwortdauer des Aura Admin Backends in Sekunden',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.015, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [register]
  });

  const ingestEventsTotal = new client.Counter({
    name: 'aura_ingest_events_total',
    help: 'Eingegangene Aura-Client-Telemetrie-Events nach Typ, Feature und Status',
    labelNames: ['event_type', 'feature', 'status'],
    registers: [register]
  });

  const clientLatencyMs = new client.Histogram({
    name: 'aura_client_latency_ms',
    help: 'Client-seitig gemessene Latenz (Chat, Agent, Rambler, Tool) in Millisekunden',
    labelNames: ['feature', 'provider', 'model'],
    buckets: [100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000],
    registers: [register]
  });

  const toolCallsTotal = new client.Counter({
    name: 'aura_tool_calls_total',
    help: 'Ausgeführte Agent-Werkzeuge nach Tool, Betriebssystem und Status',
    labelNames: ['tool', 'os', 'status'],
    registers: [register]
  });

  const sessionsIngestedTotal = new client.Counter({
    name: 'aura_sessions_ingested_total',
    help: 'Eingegangene geschwärzte Chat-/Trace-Protokolle nach Modus, Anbieter und Bewertung',
    labelNames: ['mode', 'provider', 'rating'],
    registers: [register]
  });

  const feedbackSubmittedTotal = new client.Counter({
    name: 'aura_feedback_submitted_total',
    help: 'Eingegangene Nutzer-Rückmeldungen nach Art',
    labelNames: ['kind'],
    registers: [register]
  });

  const jiraExportsTotal = new client.Counter({
    name: 'aura_jira_exports_total',
    help: 'Ergebnisse der automatischen Jira-Feedback-Übertragung',
    labelNames: ['outcome'],
    registers: [register]
  });

  function middleware(req, res, next) {
    if (req.path === '/metrics') return next();
    const end = httpRequestDurationSeconds.startTimer();
    res.on('finish', () => {
      const route = (req.route && req.route.path) || req.path.replace(/\/[0-9a-f-]{8,}/gi, '/:id');
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      end(labels);
    });
    next();
  }

  return {
    register,
    middleware,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    ingestEventsTotal,
    clientLatencyMs,
    toolCallsTotal,
    sessionsIngestedTotal,
    feedbackSubmittedTotal,
    jiraExportsTotal
  };
}

module.exports = { createMetricsRegistry };
