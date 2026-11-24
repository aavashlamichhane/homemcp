CREATE TABLE IF NOT EXISTS alert_rules (
  rule TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  threshold_json TEXT NOT NULL,
  pending_seconds INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT 'ntfy',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  pending_since TEXT,
  resolved_at TEXT,
  acked_by TEXT,
  acked_at TEXT,
  snoozed_until TEXT,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state, last_seen DESC);

CREATE TABLE IF NOT EXISTS outbound_notifications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  priority INTEGER NOT NULL,
  tags_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_pending ON outbound_notifications(sent_at, created_at ASC);
