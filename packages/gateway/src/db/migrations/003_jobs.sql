CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  steps_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_redacted TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  diff TEXT NOT NULL,
  side_effects_json TEXT NOT NULL,
  rollback_json TEXT NOT NULL,
  tier TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plans_status_expires ON plans(status, expires_at);

CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  auth_time INTEGER,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_confirmations_plan ON confirmations(plan_id);

CREATE TABLE IF NOT EXISTS music_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  playlist_id TEXT,
  playlist_name TEXT NOT NULL,
  video_id TEXT NOT NULL,
  naviload_track_id TEXT,
  state TEXT NOT NULL,
  song_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_music_jobs_job ON music_jobs(job_id);
