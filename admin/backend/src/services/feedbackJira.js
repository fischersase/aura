// Hintergrund-Export von Nutzer-Feedback aus PostgreSQL nach Jira (Headhunter-Muster, OpenClaw-ready):
// - Vorprüfung (feedbackTriage.js): sortiert Spam/Testeingaben aus -> jira_status='rejected'
// - Duplikatprüfung (feedbackDedupe.js): hängt gleiche Themen als Kommentar an bestehendes Ticket
// - Neuer Vorgang trägt Labels: Feedback, aura-admin, env-<production|integration|development>
// - Tagesdeckel über alle Nutzer (MAX_EXPORTS_PER_DAY) schützt Jira vor Flutungen
// - Ohne Jira-Zugangsdaten passiert schlicht nichts; sobald konfiguriert, holt sweepPendingExports() alles nach.
'use strict';

const { triageFeedback } = require('./feedbackTriage');
const { findDuplicateIssue } = require('./feedbackDedupe');

const MAX_EXPORTS_PER_DAY = Number(process.env.JIRA_MAX_EXPORTS_PER_DAY || 40);

function kindPrefix(kind) {
  if (kind === 'bug') return '[Fehler]';
  if (kind === 'idea') return '[Idee]';
  return '[Feedback]';
}

function buildSummary(row) {
  const base = String(row.title || '').trim() || String(row.message || '').split(/\r?\n/)[0].trim().slice(0, 90);
  return `${kindPrefix(row.kind)} ${base}`.slice(0, 220);
}

function buildDescriptionBlocks(row, { adminPublicUrl = '' } = {}) {
  const blocks = [
    { heading: `Nutzer-Rückmeldung (#${row.id})`, level: 3 },
    String(row.message || '')
  ];
  if (row.session_id) {
    const traceLink = adminPublicUrl
      ? `${adminPublicUrl.replace(/\/+$/, '')}/#sessions/${encodeURIComponent(row.session_id)}`
      : row.session_id;
    blocks.push(`Verknüpfter Trace / Session: ${traceLink}`);
  }
  const clientCtx = (row.context && row.context.client) || null;
  if (clientCtx && Object.keys(clientCtx).length) {
    blocks.push({ heading: 'Technischer Kontext (Client, geschwärzt)', level: 4 });
    blocks.push({ code: JSON.stringify(clientCtx, null, 2), language: 'json' });
  }
  return blocks;
}

function createFeedbackJiraWorker({ db, jiraClient, metrics, envName = process.env.AURA_ENV || 'development', adminPublicUrl = process.env.ADMIN_PUBLIC_URL || '' }) {
  const envLabel = `env-${String(envName).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'development'}`;

  async function exportedTodayCount() {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM user_feedback
       WHERE jira_status IN ('created', 'commented')
         AND jira_exported_at >= NOW() - INTERVAL '24 hours'`
    );
    return (r.rows[0] && r.rows[0].n) || 0;
  }

  async function exportOne(feedbackId, { force = false } = {}) {
    if (!jiraClient || !jiraClient.configured) {
      return { ok: false, skipped: true, reason: 'jira_not_configured' };
    }
    const r = await db.query('SELECT * FROM user_feedback WHERE id = $1', [feedbackId]);
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (!force && row.status === 'done') return { ok: false, skipped: true, reason: 'already_done' };
    if (!force && (row.jira_status === 'created' || row.jira_status === 'commented')) {
      return { ok: true, skipped: true, key: row.jira_issue_key };
    }

    if (!force) {
      const today = await exportedTodayCount();
      if (today >= MAX_EXPORTS_PER_DAY) {
        return { ok: false, skipped: true, reason: 'daily_cap_reached' };
      }
    }

    await db.query(`UPDATE user_feedback SET jira_status = 'exporting', jira_error = NULL WHERE id = $1`, [feedbackId]);

    try {
      // 1. Vorprüfung (überspringbar bei force=true durch Admin „Trotzdem übertragen“)
      const triage = force
        ? { keep: true, stage: 'admin_override', reason: 'Vom Admin manuell freigegeben.' }
        : triageFeedback({ title: row.title, message: row.message });

      if (!triage.keep) {
        await db.query(
          `UPDATE user_feedback
           SET jira_status = 'rejected', jira_triage = $2, jira_error = NULL
           WHERE id = $1`,
          [feedbackId, JSON.stringify(triage)]
        );
        if (metrics) metrics.jiraExportsTotal.inc({ outcome: 'rejected' });
        return { ok: true, outcome: 'rejected', triage };
      }

      // 2. Duplikatprüfung gegen offene Jira-Feedback-Vorgänge
      const candidates = await jiraClient.listFeedbackIssues({ maxResults: 50 });
      const dedupe = findDuplicateIssue({ title: row.title, message: row.message }, candidates);
      const blocks = buildDescriptionBlocks(row, { adminPublicUrl });

      if (dedupe.matched && dedupe.issue) {
        const commented = await jiraClient.addComment(dedupe.issue.key, blocks, [envLabel]);
        await db.query(
          `UPDATE user_feedback
           SET jira_status = 'commented',
               jira_issue_key = $2,
               jira_issue_url = $3,
               jira_triage = $4,
               jira_dedupe = $5,
               jira_error = NULL,
               jira_exported_at = NOW()
           WHERE id = $1`,
          [feedbackId, commented.key, commented.url, JSON.stringify(triage), JSON.stringify(dedupe)]
        );
        if (metrics) metrics.jiraExportsTotal.inc({ outcome: 'commented' });
        return { ok: true, outcome: 'commented', key: commented.key, url: commented.url };
      }

      // 3. Neuen Jira-Vorgang erstellen (bereit für spätere OpenClaw-Abarbeitung)
      const created = await jiraClient.createIssue({
        kind: row.kind,
        summary: buildSummary(row),
        descriptionBlocks: blocks,
        labels: ['aura-admin', envLabel]
      });
      await db.query(
        `UPDATE user_feedback
         SET jira_status = 'created',
             jira_issue_key = $2,
             jira_issue_url = $3,
             jira_triage = $4,
             jira_dedupe = $5,
             jira_error = NULL,
             jira_exported_at = NOW()
         WHERE id = $1`,
        [feedbackId, created.key, created.url, JSON.stringify(triage), JSON.stringify(dedupe)]
      );
      if (metrics) metrics.jiraExportsTotal.inc({ outcome: 'created' });
      return { ok: true, outcome: 'created', key: created.key, url: created.url };
    } catch (err) {
      const code = (err && err.code) || 'JIRA_EXPORT_FAILED';
      const msg = err instanceof Error ? err.message : String(err);
      await db.query(
        `UPDATE user_feedback SET jira_status = 'failed', jira_error = $2 WHERE id = $1`,
        [feedbackId, `${code}: ${msg}`.slice(0, 400)]
      );
      if (metrics) metrics.jiraExportsTotal.inc({ outcome: 'failed' });
      return { ok: false, outcome: 'failed', error: msg, code };
    }
  }

  async function sweepPendingExports({ limit = 15 } = {}) {
    if (!jiraClient || !jiraClient.configured) return { swept: 0, skipped: true };
    const r = await db.query(
      `SELECT id FROM user_feedback
       WHERE status != 'done' AND jira_status IN ('pending', 'failed')
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit]
    );
    let swept = 0;
    for (const row of r.rows) {
      const res = await exportOne(row.id, { force: false });
      if (res.reason === 'daily_cap_reached') break;
      swept++;
    }
    return { swept, skipped: false };
  }

  return { exportOne, sweepPendingExports };
}

module.exports = { createFeedbackJiraWorker, buildSummary, buildDescriptionBlocks };
