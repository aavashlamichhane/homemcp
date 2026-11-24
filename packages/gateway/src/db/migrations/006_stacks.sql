CREATE TABLE IF NOT EXISTS stack_meta (
  name TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 1,
  template TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  policy_overrides_json TEXT
);
