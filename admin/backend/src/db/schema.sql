-- Aura Admin Console Schema (PostgreSQL 15/16)
-- Inspiriert von Headhunter: klare Trennung zwischen Admin-Steuerung, anonymen Metriken,
-- DSGVO-TTL-gesteuerten geschwärzten Session-Traces und Feedback-zu-Jira-Pipeline.

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  google_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

-- Pseudonyme Client-Installationen (DSGVO Art. 17: DELETE auf install_id löscht kaskadierend alle Daten)
CREATE TABLE IF NOT EXISTS installations (
  install_id TEXT PRIMARY KEY,
  os_platform TEXT NOT NULL DEFAULT 'unknown',
  os_arch TEXT NOT NULL DEFAULT 'unknown',
  app_version TEXT NOT NULL DEFAULT '0.0.0',
  ram_gb INTEGER,
  vram_gb INTEGER,
  gpu_tier TEXT NOT NULL DEFAULT 'unknown',
  provider TEXT NOT NULL DEFAULT 'gemini',
  consent_tier TEXT NOT NULL DEFAULT 'metrics' CHECK (consent_tier IN ('none', 'metrics', 'traces')),
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_installations_last_seen ON installations (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_installations_version ON installations (app_version, os_platform);

-- Stufe 1: Anonyme Nutzungs- & Performance-Events (keine Chat-Inhalte)
CREATE TABLE IF NOT EXISTS telemetry_events (
  id BIGSERIAL PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installations(install_id) ON DELETE CASCADE,
  os_platform TEXT NOT NULL DEFAULT 'unknown',
  app_version TEXT NOT NULL DEFAULT '0.0.0',
  event_type TEXT NOT NULL,
  feature TEXT NOT NULL DEFAULT 'app',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  est_cost_usd DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'ok',
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_created ON telemetry_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_feature ON telemetry_events (feature, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_tool ON telemetry_events (tool_name, os_platform, status) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_telemetry_events_install ON telemetry_events (install_id, created_at DESC);

-- Stufe 2: Redigierte Chat-History- & Agent-Protokolle (automatische TTL: 90 Tage)
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installations(install_id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'chat',
  provider TEXT NOT NULL DEFAULT 'gemini',
  model TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '0.0.0',
  os_platform TEXT NOT NULL DEFAULT 'unknown',
  turn_count INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  has_error BOOLEAN NOT NULL DEFAULT FALSE,
  user_rating TEXT CHECK (user_rating IN ('up', 'down') OR user_rating IS NULL),
  judge_score DOUBLE PRECISION,
  judge_dimensions JSONB,
  judge_summary TEXT,
  cluster_tag TEXT,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_created ON chat_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_rating ON chat_sessions (user_rating, has_error, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_cluster ON chat_sessions (cluster_tag) WHERE cluster_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires ON chat_sessions (expires_at);

CREATE TABLE IF NOT EXISTS trace_spans (
  span_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  parent_span_id TEXT,
  span_type TEXT NOT NULL DEFAULT 'tool',
  tool_name TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error_type TEXT,
  redacted_io JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trace_spans_session ON trace_spans (session_id, started_at ASC);
CREATE INDEX IF NOT EXISTS idx_trace_spans_tool ON trace_spans (tool_name, status) WHERE tool_name IS NOT NULL;

-- Nutzer-Feedback-Posteingang + Jira-Export-Zustandsmaschine (Headhunter-Muster, OpenClaw-ready)
CREATE TABLE IF NOT EXISTS user_feedback (
  id BIGSERIAL PRIMARY KEY,
  install_id TEXT REFERENCES installations(install_id) ON DELETE SET NULL,
  session_id TEXT REFERENCES chat_sessions(session_id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'feedback' CHECK (kind IN ('bug', 'idea', 'feedback')),
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'done')),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  jira_status TEXT NOT NULL DEFAULT 'pending' CHECK (jira_status IN ('pending', 'exporting', 'created', 'commented', 'rejected', 'failed')),
  jira_issue_key TEXT,
  jira_issue_url TEXT,
  jira_triage JSONB,
  jira_dedupe JSONB,
  jira_error TEXT,
  jira_exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_feedback_status ON user_feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_feedback_jira ON user_feedback (jira_status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_user_feedback_install_day ON user_feedback (install_id, created_at DESC);

-- Closed-Loop Improvement Engine: Golden Eval-Cases für agent/evals/
CREATE TABLE IF NOT EXISTS eval_cases (
  id BIGSERIAL PRIMARY KEY,
  source_session_id TEXT REFERENCES chat_sessions(session_id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'regression',
  title TEXT NOT NULL,
  prompt_redacted TEXT NOT NULL,
  expected_behavior TEXT NOT NULL DEFAULT '',
  tool_expectations JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported', 'verified')),
  exported_filename TEXT,
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_created ON eval_cases (created_at DESC);

-- Systemverbesserungen, Prompt-/Skill-/Policy-Proposals & Canary-Rollouts
CREATE TABLE IF NOT EXISTS improvement_proposals (
  id BIGSERIAL PRIMARY KEY,
  cluster_tag TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT 'system_prompt' CHECK (target_type IN ('system_prompt', 'skill', 'tool_policy', 'browser_rule', 'model_default')),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  config_patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollout_pct INTEGER NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'canary', 'active', 'rolled_back')),
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_improvement_proposals_status ON improvement_proposals (status, updated_at DESC);

-- Read-Only Rolle für Grafana & postgres-exporter (exakt wie Headhunter: KEIN Grant auf user_feedback.message oder admin_sessions!)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
    CREATE ROLE grafana_ro NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON TABLE installations, telemetry_events, trace_spans, eval_cases, improvement_proposals TO grafana_ro;
-- Spaltenweise Grants auf chat_sessions & user_feedback: Metadaten & Zähler ja, Freitext/Chat-Nachrichten NEIN!
GRANT SELECT (session_id, install_id, mode, provider, model, app_version, os_platform, turn_count, total_latency_ms, total_tokens, est_cost_usd, has_error, user_rating, judge_score, cluster_tag, created_at)
  ON TABLE chat_sessions TO grafana_ro;
GRANT SELECT (id, kind, status, jira_status, jira_issue_key, created_at, resolved_at, jira_exported_at)
  ON TABLE user_feedback TO grafana_ro;
