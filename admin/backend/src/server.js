// Einstiegspunkt für das Aura Admin Backend (k3s / Docker / Lokal).
'use strict';

const { createDb } = require('./db');
const { createAuth } = require('./auth');
const { createMetricsRegistry } = require('./metrics');
const { createJiraClient } = require('./services/jiraClient');
const { createFeedbackJiraWorker } = require('./services/feedbackJira');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3001);

async function start() {
  const db = createDb();
  await db.initSchema();
  const metrics = createMetricsRegistry();
  const auth = createAuth(db);
  const jiraClient = createJiraClient(process.env);
  const jiraWorker = createFeedbackJiraWorker({ db, jiraClient, metrics });
  const app = createApp({ db, auth, metrics, jiraClient, jiraWorker });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[aura-admin-backend] listening on :${PORT} (env=${process.env.AURA_ENV || 'development'}, jira=${jiraClient.configured})`);
  });

  // Boot-Sweep & stündlicher Sweep für ausstehende Jira-Feedback-Exporte (Headhunter-Muster)
  if (jiraClient.configured) {
    setTimeout(() => jiraWorker.sweepPendingExports().catch(() => {}), 5000);
    const jiraTimer = setInterval(() => jiraWorker.sweepPendingExports().catch(() => {}), 3600 * 1000);
    jiraTimer.unref();
  }

  // Tägliche DSGVO-TTL-Bereinigung abgelaufener Chat-Protokolle & Admin-Sessions
  const purgeTimer = setInterval(() => db.purgeExpiredSessions().catch(() => {}), 6 * 3600 * 1000);
  purgeTimer.unref();

  const shutdown = async () => {
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('[aura-admin-backend] fatal startup error:', err.message);
  process.exit(1);
});
