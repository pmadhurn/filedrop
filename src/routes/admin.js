import { config } from './../config.js';
import { db } from './../db.js';
import { logger, logStats, readRecentLogs } from './../logger.js';
import {
  activeUploadCount, AppError, countActiveShares, getShareRow, listActiveShares, purgeShareRow,
  shareFiles, storageUsage,
} from './../model.js';
import { diskStats, removeShareDir } from './../storage.js';
import { runCleanup } from './../cleanup.js';
import { clientIp, constantTimeEquals, normalizeShareId, randomToken, rl } from './../util.js';

const ADMIN_COOKIE = 'fd_admin';

const A = {
  insert: db.prepare('INSERT INTO admin_sessions (id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  get: db.prepare('SELECT * FROM admin_sessions WHERE id = ?'),
  del: db.prepare('DELETE FROM admin_sessions WHERE id = ?'),
  purge: db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?'),
  attempts: db.prepare('SELECT * FROM login_attempts WHERE key = ?'),
  upsertAttempt: db.prepare(`
    INSERT INTO login_attempts (key, count, first_at, locked_until) VALUES (@key, 1, @now, 0)
    ON CONFLICT(key) DO UPDATE SET count = count + 1, locked_until = @locked`),
  clearAttempt: db.prepare('DELETE FROM login_attempts WHERE key = ?'),
  markExpired: db.prepare("UPDATE shares SET status = 'DELETED' WHERE id = ? AND status = 'ACTIVE'"),
};

function requireAdmin(req) {
  A.purge.run(Date.now());
  const sid = req.cookies?.[ADMIN_COOKIE];
  const session = sid ? A.get.get(sid) : null;
  if (!session || session.expires_at <= Date.now()) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required.');
  }
  return session;
}

// Any state-changing admin call must carry the CSRF token that was issued with
// the session; the cookie alone is never enough.
function requireCsrf(req, session) {
  const token = req.headers['x-csrf-token'];
  if (typeof token !== 'string' || token !== session.csrf) {
    throw new AppError(403, 'CSRF', 'Invalid request token.');
  }
}

export default async function adminRoutes(fastify) {
  fastify.post('/api/admin/login', {
    config: rl(10, '15 minutes'),
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ip = clientIp(req);
    const now = Date.now();
    const record = A.attempts.get(ip);

    if (record && record.locked_until > now) {
      logger.warn('admin.login_locked', { ip });
      throw new AppError(429, 'LOCKED', 'Too many attempts. Try again later.');
    }
    if (record && now - record.first_at > config.admin.lockoutMs) {
      A.clearAttempt.run(ip);
    }

    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    // Both comparisons always run, so a wrong username and a wrong password
    // cost the same amount of time.
    const okUser = constantTimeEquals(username, config.admin.username);
    const okPass = constantTimeEquals(password, config.admin.password);

    if (!okUser || !okPass) {
      const attempts = (A.attempts.get(ip)?.count ?? 0) + 1;
      const locked = attempts >= config.admin.maxAttempts ? now + config.admin.lockoutMs : 0;
      A.upsertAttempt.run({ key: ip, now, locked });
      logger.warn('admin.login_failed', { ip, attempts });
      throw new AppError(401, 'BAD_CREDENTIALS', 'Invalid credentials.');
    }

    A.clearAttempt.run(ip);
    const sid = randomToken(32);
    const csrf = randomToken(24);
    A.insert.run(sid, csrf, now, now + config.admin.sessionMs);
    reply.setCookie(ADMIN_COOKIE, sid, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor(config.admin.sessionMs / 1000),
    });
    logger.info('admin.login', { ip });
    return { ok: true, csrf, expiresAt: now + config.admin.sessionMs };
  });

  fastify.post('/api/admin/logout', async (req, reply) => {
    const sid = req.cookies?.[ADMIN_COOKIE];
    if (sid) A.del.run(sid);
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });

  fastify.get('/api/admin/session', async (req, reply) => {
    const session = requireAdmin(req);
    reply.header('Cache-Control', 'no-store');
    return { ok: true, csrf: session.csrf, expiresAt: session.expires_at };
  });

  fastify.get('/api/admin/overview', async (req, reply) => {
    requireAdmin(req);
    reply.header('Cache-Control', 'no-store');
    const usage = storageUsage();
    const disk = await diskStats();
    return {
      storage: usage,
      disk,
      activeShares: countActiveShares(),
      activeUploads: activeUploadCount(),
      logs: logStats(),
      limits: {
        maxBatchBytes: config.maxBatchBytes,
        chunkSize: config.chunkSize,
        expiryHours: Math.round(config.shareExpiryMs / 3600_000),
        incompleteTimeoutHours: Math.round(config.incompleteTimeoutMs / 3600_000),
      },
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rssBytes: process.memoryUsage().rss },
      now: Date.now(),
    };
  });

  fastify.get('/api/admin/shares', async (req, reply) => {
    requireAdmin(req);
    reply.header('Cache-Control', 'no-store');
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 100));
    const offset = Math.max(0, Number(req.query?.offset) || 0);
    const rows = listActiveShares(limit, offset);
    return {
      total: countActiveShares(),
      shares: rows.map((s) => ({
        id: s.id,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        totalBytes: s.total_bytes,
        fileCount: s.file_count,
        hasPassword: Boolean(s.password_hash),
        downloadLimit: s.download_limit,
        downloadCount: s.download_count,
        files: shareFiles(s.id).map((f) => ({ name: f.name, size: f.size })),
      })),
    };
  });

  fastify.delete('/api/admin/shares/:id', async (req, reply) => {
    const session = requireAdmin(req);
    requireCsrf(req, session);
    reply.header('Cache-Control', 'no-store');
    const id = normalizeShareId(req.params.id);
    if (!id) throw new AppError(404, 'NOT_FOUND', 'Share not found.');
    const share = getShareRow(id);
    if (!share) throw new AppError(404, 'NOT_FOUND', 'Share not found.');
    // Same order as expiry: block access first, then destroy the bytes.
    A.markExpired.run(id);
    await removeShareDir(share.storage_dir).catch(() => {});
    purgeShareRow(id);
    logger.info('admin.share_deleted', { shareId: id, ip: clientIp(req) });
    return { ok: true };
  });

  fastify.get('/api/admin/logs', async (req, reply) => {
    requireAdmin(req);
    reply.header('Cache-Control', 'no-store');
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 200));
    return { lines: readRecentLogs(limit), stats: logStats() };
  });

  fastify.post('/api/admin/cleanup', async (req, reply) => {
    const session = requireAdmin(req);
    requireCsrf(req, session);
    reply.header('Cache-Control', 'no-store');
    const result = await runCleanup({ orphans: true });
    logger.info('admin.cleanup_run', { ip: clientIp(req) });
    return { ok: true, result };
  });

  fastify.get('/api/admin/health', async (req, reply) => {
    requireAdmin(req);
    reply.header('Cache-Control', 'no-store');
    const { checkHealth } = await import('./../health.js');
    return checkHealth();
  });
}
