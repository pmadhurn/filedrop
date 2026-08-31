import { config } from './config.js';
import { db, immediate, storageUsage } from './db.js';
import { generateShareId, isReservedId, randomId, randomToken, sha256 } from './util.js';

const S = {
  insertSession: db.prepare(`
    INSERT INTO upload_sessions
      (id, token_hash, storage_dir, created_at, updated_at, status, declared_bytes,
       reserved_bytes, chunk_size, password_hash, download_limit, share_id)
    VALUES (@id, @token_hash, @storage_dir, @created_at, @updated_at, 'CREATED', @declared_bytes,
            @reserved_bytes, @chunk_size, @password_hash, @download_limit, NULL)`),
  insertSessionFile: db.prepare(`
    INSERT INTO session_files (id, session_id, position, name, size, chunk_count, filename, complete)
    VALUES (@id, @session_id, @position, @name, @size, @chunk_count, @filename, @complete)`),
  getSession: db.prepare('SELECT * FROM upload_sessions WHERE id = ?'),
  getSessionFiles: db.prepare('SELECT * FROM session_files WHERE session_id = ? ORDER BY position'),
  getSessionFile: db.prepare('SELECT * FROM session_files WHERE id = ? AND session_id = ?'),
  touchSession: db.prepare('UPDATE upload_sessions SET updated_at = ?, status = ? WHERE id = ?'),
  setSessionStatus: db.prepare('UPDATE upload_sessions SET status = ?, updated_at = ? WHERE id = ?'),
  releaseSession: db.prepare("UPDATE upload_sessions SET reserved_bytes = 0, status = ?, updated_at = ? WHERE id = ?"),
  deleteSession: db.prepare('DELETE FROM upload_sessions WHERE id = ?'),
  upsertChunk: db.prepare('INSERT OR REPLACE INTO session_chunks (file_id, idx, size) VALUES (?, ?, ?)'),
  chunkIndexes: db.prepare('SELECT idx FROM session_chunks WHERE file_id = ? ORDER BY idx'),
  chunkStats: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM session_chunks WHERE file_id = ?'),
  markFileComplete: db.prepare('UPDATE session_files SET complete = 1 WHERE id = ?'),

  insertShare: db.prepare(`
    INSERT INTO shares (id, storage_dir, created_at, expires_at, status, total_bytes,
                        file_count, password_hash, download_limit, download_count)
    VALUES (@id, @storage_dir, @created_at, @expires_at, 'ACTIVE', @total_bytes,
            @file_count, @password_hash, @download_limit, 0)`),
  insertShareFile: db.prepare(`
    INSERT INTO share_files (id, share_id, position, name, size, filename, sha256)
    VALUES (@id, @share_id, @position, @name, @size, @filename, @sha256)`),
  shareExists: db.prepare('SELECT 1 FROM shares WHERE id = ?'),
  getShare: db.prepare('SELECT * FROM shares WHERE id = ?'),
  getShareFiles: db.prepare('SELECT * FROM share_files WHERE share_id = ? ORDER BY position'),
  getShareFile: db.prepare('SELECT * FROM share_files WHERE id = ? AND share_id = ?'),
  bumpDownload: db.prepare(`
    UPDATE shares SET download_count = download_count + 1
    WHERE id = ? AND status = 'ACTIVE' AND expires_at > ?
      AND (download_limit IS NULL OR download_count < download_limit)`),
  listActive: db.prepare("SELECT * FROM shares WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT ? OFFSET ?"),
  countActive: db.prepare("SELECT COUNT(*) AS n FROM shares WHERE status = 'ACTIVE'"),
  expiredShares: db.prepare("SELECT * FROM shares WHERE status = 'ACTIVE' AND expires_at <= ?"),
  deleteShare: db.prepare('DELETE FROM shares WHERE id = ?'),
  staleSessions: db.prepare("SELECT * FROM upload_sessions WHERE status != 'COMPLETED' AND updated_at < ?"),
  completedSessions: db.prepare("SELECT id FROM upload_sessions WHERE status = 'COMPLETED' AND updated_at < ?"),
  activeSessionCount: db.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE reserved_bytes > 0"),
  allShareDirs: db.prepare('SELECT storage_dir FROM shares'),
  allSessionDirs: db.prepare('SELECT storage_dir FROM upload_sessions'),
};

export class AppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Creates an upload session and reserves its full declared size against the
 * global quota in a single write transaction. Two concurrent creations can
 * therefore never both fit into the same free space.
 */
export function createUploadSession({ files, passwordHash, downloadLimit }) {
  const declared = files.reduce((sum, f) => sum + f.size, 0);
  if (declared > config.maxBatchBytes) {
    throw new AppError(413, 'BATCH_TOO_LARGE', 'This batch is larger than the maximum allowed size.');
  }

  const sessionId = randomId(16);
  const token = randomToken(32);
  const storageDir = randomId(16);
  const now = Date.now();

  const result = immediate(() => {
    const usage = storageUsage();
    if (declared > usage.remainingBytes) {
      throw new AppError(507, 'STORAGE_FULL', 'Not enough space is available right now.');
    }
    S.insertSession.run({
      id: sessionId,
      token_hash: sha256(token),
      storage_dir: storageDir,
      created_at: now,
      updated_at: now,
      declared_bytes: declared,
      reserved_bytes: declared,
      chunk_size: config.chunkSize,
      password_hash: passwordHash ?? null,
      download_limit: downloadLimit ?? null,
    });
    const created = files.map((f, position) => {
      const id = randomId(16);
      const chunkCount = f.size === 0 ? 0 : Math.ceil(f.size / config.chunkSize);
      S.insertSessionFile.run({
        id,
        session_id: sessionId,
        position,
        name: f.name,
        size: f.size,
        chunk_count: chunkCount,
        filename: `${id}.bin`,
        // An empty file has no chunks to wait for: allocateFile already created
        // it at exactly its declared size, so it is complete on arrival.
        complete: f.size === 0 ? 1 : 0,
      });
      return { id, name: f.name, size: f.size, chunkCount, filename: `${id}.bin` };
    });
    return { created };
  });

  return {
    sessionId,
    token,
    storageDir,
    chunkSize: config.chunkSize,
    declaredBytes: declared,
    files: result.created,
  };
}

export function getSession(id) {
  return S.getSession.get(id);
}

export function authorizeSession(id, token) {
  const session = S.getSession.get(id);
  if (!session) throw new AppError(404, 'NOT_FOUND', 'Upload session not found.');
  if (!token || session.token_hash !== sha256(token)) {
    throw new AppError(403, 'FORBIDDEN', 'Not authorised for this upload.');
  }
  return session;
}

export function sessionFiles(sessionId) {
  return S.getSessionFiles.all(sessionId);
}

export function sessionFile(sessionId, fileId) {
  return S.getSessionFile.get(fileId, sessionId);
}

export function receivedChunks(fileId) {
  return S.chunkIndexes.all(fileId).map((r) => r.idx);
}

export function recordChunk(sessionId, fileId, idx, size) {
  immediate(() => {
    S.upsertChunk.run(fileId, idx, size);
    const file = S.getSessionFile.get(fileId, sessionId);
    if (file) {
      const stats = S.chunkStats.get(fileId);
      if (stats.n >= file.chunk_count && stats.bytes === file.size) {
        S.markFileComplete.run(fileId);
      }
    }
    S.touchSession.run(Date.now(), 'UPLOADING', sessionId);
  });
}

export function touchSession(sessionId, status) {
  S.touchSession.run(Date.now(), status, sessionId);
}

export function setSessionStatus(sessionId, status) {
  S.setSessionStatus.run(status, Date.now(), sessionId);
}

/**
 * Turns a fully uploaded session into an active share. Allocates the share ID,
 * moves the reservation into the share's own accounting and clears the session
 * reservation — all inside one transaction, so the global total is never
 * double counted and never momentarily over the limit.
 */
export function completeSession(session, files) {
  const now = Date.now();
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  return immediate(() => {
    let shareId = null;
    for (let attempt = 0; attempt < 200 && !shareId; attempt += 1) {
      // Widen the ID as the space fills up: 4 letters first, then 5, then 6.
      const length = attempt < 50 ? undefined : attempt < 120 ? 5 : 6;
      const candidate = generateShareId(length);
      if (isReservedId(candidate)) continue;
      if (S.shareExists.get(candidate)) continue;
      shareId = candidate;
    }
    if (!shareId) throw new AppError(503, 'ID_EXHAUSTED', 'Could not allocate a share link. Try again.');

    S.insertShare.run({
      id: shareId,
      storage_dir: session.storage_dir,
      created_at: now,
      expires_at: now + config.shareExpiryMs,
      total_bytes: totalBytes,
      file_count: files.length,
      password_hash: session.password_hash,
      download_limit: session.download_limit,
    });
    for (const [position, f] of files.entries()) {
      S.insertShareFile.run({
        id: randomId(16),
        share_id: shareId,
        position,
        name: f.name,
        size: f.size,
        filename: f.filename,
        sha256: f.sha256 ?? null,
      });
    }
    S.releaseSession.run('COMPLETED', now, session.id);
    db.prepare('UPDATE upload_sessions SET share_id = ? WHERE id = ?').run(shareId, session.id);
    return { shareId, expiresAt: now + config.shareExpiryMs, totalBytes };
  });
}

export function releaseSession(sessionId, status = 'FAILED') {
  S.releaseSession.run(status, Date.now(), sessionId);
}

export function dropSession(sessionId) {
  immediate(() => S.deleteSession.run(sessionId));
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------
export function getActiveShare(id) {
  const share = S.getShare.get(id);
  if (!share) return null;
  if (share.status !== 'ACTIVE') return null;
  if (share.expires_at <= Date.now()) return null;
  return share;
}

export function getShareRow(id) {
  return S.getShare.get(id);
}

export function shareFiles(shareId) {
  return S.getShareFiles.all(shareId);
}

export function shareFile(shareId, fileId) {
  return S.getShareFile.get(fileId, shareId);
}

/**
 * Atomically claims one download slot. Returns false when the share is gone,
 * expired or the limit is already reached — no read-then-write race.
 */
export function claimDownload(shareId) {
  const info = S.bumpDownload.run(shareId, Date.now());
  return info.changes === 1;
}

export function listActiveShares(limit, offset) {
  return S.listActive.all(limit, offset);
}

export function countActiveShares() {
  return S.countActive.get().n;
}

export function activeUploadCount() {
  return S.activeSessionCount.get().n;
}

export function expiredShares(now = Date.now()) {
  return S.expiredShares.all(now);
}

export function staleSessions(cutoff) {
  return S.staleSessions.all(cutoff);
}

export function completedSessionsBefore(cutoff) {
  return S.completedSessions.all(cutoff);
}

export function purgeShareRow(shareId) {
  immediate(() => S.deleteShare.run(shareId));
}

export function knownDirs() {
  return {
    shares: new Set(S.allShareDirs.all().map((r) => r.storage_dir)),
    sessions: new Set(S.allSessionDirs.all().map((r) => r.storage_dir)),
  };
}

export { storageUsage };
