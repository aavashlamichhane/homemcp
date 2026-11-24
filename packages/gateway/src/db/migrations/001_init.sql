CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  token_kind TEXT NOT NULL,
  token_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_redacted TEXT NOT NULL,
  tier TEXT NOT NULL,
  plan_id TEXT,
  confirmation_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  duration_ms INTEGER NOT NULL,
  job_id TEXT,
  resources TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit(tool);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_kind_ts ON metric_snapshots(kind, ts DESC);
