CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  write_token TEXT,
  lock_token TEXT,
  lock_owner TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(deleted, updated_at DESC);
-- Split snapshots keep long conversations below D1's per-value size limit.
CREATE TABLE IF NOT EXISTS session_chunks (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(session_id, part)
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  PRIMARY KEY(session_id, file_id)
);
