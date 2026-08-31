import { config } from './../config.js';
import { logger } from './../logger.js';
import { AppError, claimDownload, getActiveShare, shareFile, shareFiles } from './../model.js';
import { fileStat, openFileStream } from './../storage.js';
import {
  clientIp, contentDisposition, normalizeShareId, rl, signToken, verifyPassword, verifyToken,
} from './../util.js';

const cookieName = (id) => `fd_s_${id}`;

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

// A share that does not exist, has expired or was deleted must be
// indistinguishable from the outside: same status, same message.
function notFound() {
  return new AppError(404, 'NOT_FOUND', 'This link is not available. It may have expired.');
}

function hasShareAccess(req, share) {
  if (!share.password_hash) return true;
  const raw = req.cookies?.[cookieName(share.id)];
  const payload = verifyToken(raw);
  return Boolean(payload && payload.sid === share.id && payload.iat >= share.created_at);
}

function describeShare(share, { withFiles }) {
  const base = {
    id: share.id,
    protected: Boolean(share.password_hash),
    expiresAt: share.expires_at,
    createdAt: share.created_at,
  };
  if (!withFiles) return base;
  return {
    ...base,
    totalBytes: share.total_bytes,
    fileCount: share.file_count,
    downloadLimit: share.download_limit,
    downloadsUsed: share.download_count,
    downloadsRemaining: share.download_limit === null
      ? null
      : Math.max(0, share.download_limit - share.download_count),
    files: shareFiles(share.id).map((f) => ({ id: f.id, name: f.name, size: f.size })),
  };
}

function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { invalid: true };
  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

export default async function shareRoutes(fastify) {
  // --- share metadata ------------------------------------------------------
  fastify.get('/api/s/:id', {
    config: rl(60, '1 minute'),
  }, async (req, reply) => {
    const id = normalizeShareId(req.params.id);
    if (!id) throw notFound();
    const share = getActiveShare(id);
    if (!share) throw notFound();
    reply.header('Cache-Control', 'no-store');
    return describeShare(share, { withFiles: hasShareAccess(req, share) });
  });

  // --- unlock a password protected share -----------------------------------
  fastify.post('/api/s/:id/auth', {
    config: rl(10, '5 minutes'),
  }, async (req, reply) => {
    const id = normalizeShareId(req.params.id);
    if (!id) throw notFound();
    const share = getActiveShare(id);
    if (!share) throw notFound();
    reply.header('Cache-Control', 'no-store');

    if (!share.password_hash) return describeShare(share, { withFiles: true });

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !verifyPassword(password, share.password_hash)) {
      logger.warn('share.auth_failed', { shareId: id, ip: clientIp(req) });
      throw new AppError(401, 'BAD_PASSWORD', 'Incorrect password.');
    }

    const ttl = Math.min(config.shareTokenMs, Math.max(60_000, share.expires_at - Date.now()));
    const token = signToken({ sid: id, iat: Date.now(), exp: Date.now() + ttl });
    reply.setCookie(cookieName(id), token, cookieOptions(ttl));
    logger.info('share.unlocked', { shareId: id, ip: clientIp(req) });
    return describeShare(share, { withFiles: true });
  });

  // --- download ------------------------------------------------------------
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/d/:id/:fileId',
    config: rl(120, '1 minute'),
    handler: async (req, reply) => {
      const id = normalizeShareId(req.params.id);
      if (!id) throw notFound();

      // Every check runs on every request: exists, active, unexpired,
      // authorised, within limit, and the file belongs to this share.
      const share = getActiveShare(id);
      if (!share) throw notFound();
      if (!hasShareAccess(req, share)) {
        throw new AppError(401, 'PASSWORD_REQUIRED', 'This share is password protected.');
      }
      const file = shareFile(share.id, String(req.params.fileId));
      if (!file) throw notFound();

      let stats;
      try {
        stats = await fileStat(share.storage_dir, file.filename);
      } catch {
        throw notFound();
      }

      const range = parseRange(req.headers.range, stats.size);
      if (range?.invalid) {
        reply.header('Content-Range', `bytes */${stats.size}`);
        throw new AppError(416, 'RANGE_NOT_SATISFIABLE', 'Requested range is not satisfiable.');
      }

      // A fresh download is one that starts at the beginning; range requests
      // that continue or seek within a file do not each cost a download.
      const isFresh = req.method === 'GET' && (!range || range.start === 0);
      if (isFresh) {
        if (!claimDownload(share.id)) {
          throw new AppError(403, 'LIMIT_REACHED', 'This share has reached its download limit.');
        }
      } else if (share.download_limit !== null && share.download_count >= share.download_limit) {
        throw new AppError(403, 'LIMIT_REACHED', 'This share has reached its download limit.');
      }

      reply
        .header('Content-Type', 'application/octet-stream')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', contentDisposition(file.name))
        .header('Accept-Ranges', 'bytes')
        // Private data must never be cached by Cloudflare or any proxy: an
        // expired share could otherwise stay reachable from a cache.
        .header('Cache-Control', 'private, no-store, max-age=0, must-revalidate')
        .header('CDN-Cache-Control', 'no-store')
        .header('Cloudflare-CDN-Cache-Control', 'no-store')
        .header('Pragma', 'no-cache');

      const length = range ? range.end - range.start + 1 : stats.size;
      if (range) {
        reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
      }
      reply.header('Content-Length', String(length));

      if (req.method === 'HEAD') return reply.send();

      logger.info('share.download', {
        shareId: share.id, fileId: file.id, bytes: length, partial: Boolean(range), ip: clientIp(req),
      });

      // Streamed straight from disk: a 20 GB file never lands in memory.
      const stream = openFileStream(
        share.storage_dir,
        file.filename,
        range ? { start: range.start, end: range.end } : undefined
      );
      stream.on('error', (err) => {
        logger.error('share.stream_failed', { shareId: share.id, err });
        reply.raw.destroy();
      });
      return reply.send(stream);
    },
  });
}
