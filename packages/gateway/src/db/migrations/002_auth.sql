CREATE TABLE IF NOT EXISTS oauth_kv (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  grant_id TEXT,
  user_code TEXT,
  uid TEXT,
  expires_at INTEGER,
  consumed_at INTEGER,
  PRIMARY KEY (model, id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_kv_grant ON oauth_kv(grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_kv_uid ON oauth_kv(uid);
CREATE INDEX IF NOT EXISTS idx_oauth_kv_user_code ON oauth_kv(user_code);
CREATE INDEX IF NOT EXISTS idx_oauth_kv_expires ON oauth_kv(expires_at);

CREATE TABLE IF NOT EXISTS auth_owner (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  totp_secret_enc TEXT,
  bootstrapped_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_passkeys (
  credential_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_recovery_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_bootstrap_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_lockouts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS pats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  toolsets_json TEXT,
  cidrs_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pats_prefix ON pats(prefix);

CREATE TABLE IF NOT EXISTS cimd_cache (
  client_id_url TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_keys (
  kid TEXT PRIMARY KEY,
  alg TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  private_jwk_enc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
