// PostgreSQL-Pool, automatische Schema-Initialisierung und Rotation der grafana_ro-Leserolle (Headhunter-Muster).
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function createDb(config = {}) {
  const connectionString = config.databaseUrl || process.env.DATABASE_URL || '';
  const migrationUrl = config.migrationDatabaseUrl || process.env.MIGRATION_DATABASE_URL || connectionString;
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 15),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });

  async function query(text, params) {
    return pool.query(text, params);
  }

  async function initSchema() {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const migPool = migrationUrl === connectionString ? pool : new Pool({ connectionString: migrationUrl, max: 2 });
    try {
      await migPool.query(sql);
      await ensureGrafanaRoLogin(migPool);
    } finally {
      if (migPool !== pool) await migPool.end();
    }
  }

  async function ensureGrafanaRoLogin(targetPool) {
    const pw = process.env.GRAFANA_DB_PASSWORD || '';
    if (!pw) return false;
    // Parametrisierte Password-Setzung per format(%L) in DO-Block verhindert SQL-Injection zuverlässig.
    await targetPool.query(
      `DO $$
       BEGIN
         EXECUTE format('ALTER ROLE grafana_ro WITH LOGIN PASSWORD %L', $1);
       END $$;`,
      [pw]
    );
    return true;
  }

  async function purgeExpiredSessions() {
    const res = await pool.query('DELETE FROM chat_sessions WHERE expires_at < NOW()');
    await pool.query('DELETE FROM admin_sessions WHERE expires_at < NOW()');
    return res.rowCount || 0;
  }

  async function close() {
    await pool.end();
  }

  return { pool, query, initSchema, purgeExpiredSessions, close };
}

module.exports = { createDb };
