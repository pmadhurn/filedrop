import { config } from './../config.js';
import { logger } from './../logger.js';
import {
  AppError, authorizeSession, completeSession, createUploadSession, dropSession, receivedChunks,
  recordChunk, releaseSession, sessionFile, sessionFiles, setSessionStatus, storageUsage,
} from './../model.js';
import {
  allocateFile, createSessionDir, promoteSession, removeSessionDir, syncFile, verifyFileSize,
  writeChunk,
} from './../storage.js';
import { clientIp, hashPassword, rl, sanitizeFilename } from './../util.js';

// One completion at a time per session; a double-clicked "finish" must not
// create two shares from one upload.
const completing = new Set();

function parseDownloadLimit(value) {
  if (value === null || value === undefined || value === '' || value === 'unlimited') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
    throw new AppError(400, 'BAD_REQUEST', 'Download limit must be a whole number of at least 1.');
  }
  return n;
}

function validateFiles(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError(400, 'BAD_REQUEST', 'Select at least one file.');
  }
  if (input.length > config.maxFilesPerBatch) {
    throw new AppError(400, 'TOO_MANY_FILES', `A batch may contain at most ${config.maxFilesPerBatch} files.`);
  }
  return input.map((f) => {
    const size = Number(f?.size);
    if (!Number.isInteger(size) || size < 0) {
      throw new AppError(400, 'BAD_REQUEST', 'Invalid file size.');
    }
    if (size > config.maxBatchBytes) {
      throw new AppError(413, 'BATCH_TOO_LARGE', 'This batch is larger than the maximum allowed size.');
    }
    return { name: sanitizeFilename(f?.name), size };
  });
}

export default async function uploadRoutes(fastify) {
  // --- create session ------------------------------------------------------
  fastify.post('/api/uploads', {
    config: rl(20, '5 minutes'),
  }, async (req, reply) => {
    const body = req.body ?? {};
    const files = validateFiles(body.files);
    const downloadLimit = parseDownloadLimit(body.downloadLimit);

    let passwordHash = null;
    if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length < 4 || body.password.length > 200) {
        throw new AppError(400, 'BAD_REQUEST', 'Password must be between 4 and 200 characters.');
      }
      passwordHash = hashPassword(body.password);
    }

    const session = createUploadSession({ files, passwordHash, downloadLimit });
    try {
      await createSessionDir(session.storageDir);
      for (const f of session.files) {
        await allocateFile(session.storageDir, f.filename, f.size);
      }
    } catch (err) {
      releaseSession(session.sessionId, 'FAILED');
      await removeSessionDir(session.storageDir).catch(() => {});
      logger.error('upload.create_failed', { err });
      throw new AppError(500, 'SERVER_ERROR', 'Could not start the upload.');
    }

    logger.info('upload.created', {
      sessionId: session.sessionId,
      files: session.files.length,
      bytes: session.declaredBytes,
      ip: clientIp(req),
    });

    reply.header('Cache-Control', 'no-store');
    return {
      sessionId: session.sessionId,
      token: session.token,
      chunkSize: session.chunkSize,
      inactivityTimeoutMs: config.incompleteTimeoutMs,
      files: session.files.map((f) => ({ id: f.id, name: f.name, size: f.size, chunkCount: f.chunkCount })),
    };
  });

  // --- resume: what has already arrived -----------------------------------
  fastify.get('/api/uploads/:id', {
    config: rl(120, '1 minute'),
  }, async (req, reply) => {
    const token = req.headers['x-upload-token'] ?? req.query?.token;
    const session = authorizeSession(req.params.id, token);
    const files = sessionFiles(session.id);
    reply.header('Cache-Control', 'no-store');
    return {
      sessionId: session.id,
      status: session.status,
      chunkSize: session.chunk_size,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        chunkCount: f.chunk_count,
        complete: f.complete === 1,
        received: receivedChunks(f.id),
      })),
    };
  });

  // --- one chunk -----------------------------------------------------------
  fastify.put('/api/uploads/:id/files/:fileId/chunks/:index', {
    bodyLimit: config.chunkSize + 1024 * 1024,
    config: rl(1200, '1 minute'),
  }, async (req, reply) => {
    const session = authorizeSession(req.params.id, req.headers['x-upload-token']);
    if (session.status === 'COMPLETED') {
      throw new AppError(409, 'ALREADY_COMPLETE', 'This upload has already been finished.');
    }
    const file = sessionFile(session.id, req.params.fileId);
    if (!file) throw new AppError(404, 'NOT_FOUND', 'Unknown file for this upload.');

    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= file.chunk_count) {
      throw new AppError(400, 'BAD_REQUEST', 'Invalid chunk index.');
    }

    const offset = index * session.chunk_size;
    const expected = Math.min(session.chunk_size, file.size - offset);

    let written;
    try {
      written = await writeChunk({
        dir: session.storage_dir,
        filename: file.filename,
        offset,
        maxBytes: expected,
        source: req.body,
      });
    } catch (err) {
      if (err?.statusCode === 413) {
        throw new AppError(413, 'CHUNK_TOO_LARGE', 'Chunk exceeds its declared length.');
      }
      logger.error('upload.chunk_write_failed', { sessionId: session.id, err });
      throw new AppError(500, 'SERVER_ERROR', 'Could not store this chunk.');
    }

    if (written.bytes !== expected) {
      throw new AppError(400, 'CHUNK_SIZE_MISMATCH', 'Chunk length does not match the declared size.');
    }

    const claimed = req.headers['x-chunk-sha256'];
    if (typeof claimed === 'string' && claimed.length === 64 && claimed.toLowerCase() !== written.sha256) {
      logger.warn('upload.chunk_checksum_mismatch', { sessionId: session.id, index });
      throw new AppError(422, 'CHECKSUM_MISMATCH', 'Chunk failed its integrity check.');
    }

    recordChunk(session.id, file.id, index, written.bytes);
    reply.header('Cache-Control', 'no-store');
    return { ok: true, index, bytes: written.bytes };
  });

  // --- finish --------------------------------------------------------------
  fastify.post('/api/uploads/:id/complete', {
    config: rl(30, '5 minutes'),
  }, async (req, reply) => {
    const session = authorizeSession(req.params.id, req.headers['x-upload-token'] ?? req.body?.token);
    if (session.share_id) {
      return { id: session.share_id, url: `${config.publicBaseUrl}/${session.share_id}` };
    }
    if (completing.has(session.id)) {
      throw new AppError(409, 'IN_PROGRESS', 'This upload is already being finished.');
    }
    completing.add(session.id);
    try {
      setSessionStatus(session.id, 'PROCESSING');
      const files = sessionFiles(session.id);

      // Nothing becomes a share until every byte is present and the file on
      // disk is exactly the size that was declared.
      for (const f of files) {
        if (f.complete !== 1) {
          setSessionStatus(session.id, 'UPLOADING');
          throw new AppError(409, 'INCOMPLETE', 'Some parts of the upload are still missing.');
        }
        if (!(await verifyFileSize(session.storage_dir, f.filename, f.size))) {
          setSessionStatus(session.id, 'UPLOADING');
          throw new AppError(409, 'INCOMPLETE', 'A file did not pass verification.');
        }
        await syncFile(session.storage_dir, f.filename);
      }

      await promoteSession(session.storage_dir);
      let share;
      try {
        share = completeSession(session, files.map((f) => ({
          name: f.name, size: f.size, filename: f.filename,
        })));
      } catch (err) {
        setSessionStatus(session.id, 'FAILED');
        throw err;
      }

      logger.info('share.created', {
        shareId: share.shareId,
        files: files.length,
        bytes: share.totalBytes,
        hasPassword: Boolean(session.password_hash),
        downloadLimit: session.download_limit,
        ip: clientIp(req),
      });

      reply.header('Cache-Control', 'no-store');
      return {
        id: share.shareId,
        url: `${config.publicBaseUrl}/${share.shareId}`,
        alternateUrl: config.secondaryBaseUrl ? `${config.secondaryBaseUrl}/${share.shareId}` : null,
        expiresAt: share.expiresAt,
        totalBytes: share.totalBytes,
        fileCount: files.length,
        hasPassword: Boolean(session.password_hash),
        downloadLimit: session.download_limit,
      };
    } finally {
      completing.delete(session.id);
    }
  });

  // --- abandon an unfinished upload ---------------------------------------
  fastify.delete('/api/uploads/:id', {
    config: rl(60, '5 minutes'),
  }, async (req, reply) => {
    const session = authorizeSession(req.params.id, req.headers['x-upload-token']);
    if (session.share_id) {
      throw new AppError(409, 'ALREADY_COMPLETE', 'This upload has already been finished.');
    }
    await removeSessionDir(session.storage_dir).catch(() => {});
    dropSession(session.id);
    logger.info('upload.cancelled', { sessionId: session.id });
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });

  // --- what the upload form needs to know ---------------------------------
  fastify.get('/api/limits', {
    config: rl(60, '1 minute'),
  }, async (req, reply) => {
    const usage = storageUsage();
    reply.header('Cache-Control', 'no-store');
    return {
      maxBatchBytes: config.maxBatchBytes,
      chunkSize: config.chunkSize,
      expiryHours: Math.round(config.shareExpiryMs / 3600_000),
      remainingBytes: usage.remainingBytes,
      maxFiles: config.maxFilesPerBatch,
    };
  });
}
