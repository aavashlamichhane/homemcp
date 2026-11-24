CREATE TABLE IF NOT EXISTS cf_ingress_history (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  ts TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cf_ingress_ts ON cf_ingress_history(ts DESC);
