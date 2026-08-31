import Database from 'better-sqlite3';
import { join } from 'node:path';
import { config } from './config.js';

export const db = new Database(join(config.dirs.db, 'filedrop.db'));

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');

db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id             TEXT PRIMARY KEY,
  storage_dir    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  status         TEXT NOT NULL,              -- ACTIVE | EXPIRED | DELETED
  total_bytes    INTEGER NOT NULL,
  file_count     INTEGER NOT NULL,
  password_hash  TEXT,
  download_limit INTEGER,                    -- NULL = unlimited
  download_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shares_status  ON shares(status);
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);

CREATE TABLE IF NOT EXISTS share_files (
  id        TEXT PRIMARY KEY,
  share_id  TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,                   -- sanitized display name
  size      INTEGER NOT NULL,
  filename  TEXT NOT NULL,                   -- server-generated on-disk name
  sha256    TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_files_share ON share_files(share_id);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL,
  storage_dir    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  status         TEXT NOT NULL,              -- CREATED | UPLOADING | PROCESSING | COMPLETED | FAILED
  declared_bytes INTEGER NOT NULL,
  reserved_bytes INTEGER NOT NULL,           -- counts against the global quota while > 0
  chunk_size     INTEGER NOT NULL,
  password_hash  TEXT,
  download_limit INTEGER,
  share_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON upload_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON upload_sessions(updated_at);

CREATE TABLE IF NOT EXISTS session_files (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  complete     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);

CREATE TABLE IF NOT EXISTS session_chunks (
  file_id  TEXT NOT NULL REFERENCES session_files(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  PRIMARY KEY (file_id, idx)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  first_at     INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`);

// ---------------------------------------------------------------------------
// Storage accounting
//
// Active bytes = bytes held by ACTIVE shares + bytes reserved by in-flight
// upload sessions. Reserving up front is what makes concurrent uploads safe:
// two sessions can never both be told "there is room" for the same bytes.
// Every mutation of either side runs inside a BEGIN IMMEDIATE transaction.
// ---------------------------------------------------------------------------
const usedStmt = db.prepare(`
  SELECT
    (SELECT COALESCE(SUM(total_bytes), 0) FROM shares WHERE status = 'ACTIVE') AS shareBytes,
    (SELECT COALESCE(SUM(reserved_bytes), 0) FROM upload_sessions WHERE reserved_bytes > 0) AS reservedBytes
`);

export function storageUsage() {
  const row = usedStmt.get();
  const used = row.shareBytes + row.reservedBytes;
  return {
    shareBytes: row.shareBytes,
    reservedBytes: row.reservedBytes,
    usedBytes: used,
    limitBytes: config.storageLimitBytes,
    remainingBytes: Math.max(0, config.storageLimitBytes - used),
  };
}

// Runs fn inside an immediate (write-locked) transaction.
export function immediate(fn) {
  return db.transaction(fn).immediate();
}

// Same, but returns a reusable function that takes arguments.
export function immediateFn(fn) {
  const t = db.transaction(fn);
  return (...args) => t.immediate(...args);
}
