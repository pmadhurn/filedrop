import { config } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import {
  completedSessionsBefore, dropSession, expiredShares, knownDirs, purgeShareRow, staleSessions,
} from './model.js';
import { listDirs, removeSessionDir, removeShareDir } from './storage.js';

const markExpired = db.prepare("UPDATE shares SET status = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'");

/**
 * Expire, then hard-delete. Marking first is what makes this safe to interrupt:
 * an EXPIRED share is already invisible and already released from the storage
 * quota, so a crash between the two steps can only leave files for the next
 * sweep to remove — never a live share whose bytes are gone.
 *
 * Downloads already in flight keep their open file descriptor and finish; on
 * Linux the unlink only removes the name.
 */
async function sweepExpiredShares() {
  const rows = expiredShares();
  for (const share of rows) {
    try {
      markExpired.run(share.id);
      await removeShareDir(share.storage_dir);
      purgeShareRow(share.id);
      logger.info('share.expired', { shareId: share.id, bytes: share.total_bytes, files: share.file_count });
    } catch (err) {
      logger.error('cleanup.share_failed', { shareId: share.id, err });
    }
  }
  return rows.length;
}

// Incomplete uploads that went quiet: free their reservation and temp data.
async function sweepStaleSessions() {
  const cutoff = Date.now() - config.incompleteTimeoutMs;
  const rows = staleSessions(cutoff);
  for (const session of rows) {
    try {
      await removeSessionDir(session.storage_dir);
      dropSession(session.id);
      logger.info('upload.abandoned', { sessionId: session.id, reserved: session.reserved_bytes });
    } catch (err) {
      logger.error('cleanup.session_failed', { sessionId: session.id, err });
    }
  }
  // Completed sessions hold no data; drop their bookkeeping once the share
  // they created has itself expired.
  for (const row of completedSessionsBefore(Date.now() - config.shareExpiryMs - 3600_000)) {
    dropSession(row.id);
  }
  return rows.length;
}

// Directories on disk with no row pointing at them (crash between rename and
// commit, manual meddling, an interrupted delete).
async function sweepOrphans() {
  const known = knownDirs();
  let removed = 0;
  for (const [root, set, remove] of [
    [config.dirs.storage, known.shares, removeShareDir],
    [config.dirs.tmp, known.sessions, removeSessionDir],
  ]) {
    for (const dir of await listDirs(root)) {
      if (set.has(dir)) continue;
      try {
        await remove(dir);
        removed += 1;
        logger.warn('cleanup.orphan_removed', { root, dir });
      } catch (err) {
        logger.error('cleanup.orphan_failed', { root, dir, err });
      }
    }
  }
  return removed;
}

let running = false;

// Idempotent: safe to run at any time, concurrently with traffic, repeatedly.
export async function runCleanup({ orphans = false } = {}) {
  if (running) return null;
  running = true;
  const started = Date.now();
  try {
    const shares = await sweepExpiredShares();
    const sessions = await sweepStaleSessions();
    const orphaned = orphans ? await sweepOrphans() : 0;
    if (shares || sessions || orphaned) {
      logger.info('cleanup.done', { shares, sessions, orphaned, ms: Date.now() - started });
    }
    return { shares, sessions, orphaned };
  } catch (err) {
    logger.error('cleanup.failed', { err });
    return null;
  } finally {
    running = false;
  }
}

export function startCleanup() {
  let ticks = 0;
  // First pass includes the orphan scan so a crashed restart self-heals.
  runCleanup({ orphans: true });
  const timer = setInterval(() => {
    ticks += 1;
    // Orphan scan touches the filesystem; hourly is enough.
    runCleanup({ orphans: ticks % Math.max(1, Math.round(3600_000 / config.cleanupIntervalMs)) === 0 });
  }, config.cleanupIntervalMs);
  timer.unref();
  return timer;
}
