import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import { AppError, getActiveShare } from './model.js';
import { startCleanup } from './cleanup.js';
import { checkHealth } from './health.js';
import { clientIp, normalizeShareId, rl } from './util.js';
import uploadRoutes from './routes/uploads.js';
import shareRoutes from './routes/shares.js';
import adminRoutes from './routes/admin.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const page = (name) => readFileSync(join(publicDir, name), 'utf8');

const app = Fastify({
  logger: false,
  trustProxy: true,
  bodyLimit: 1024 * 1024,
  disableRequestLogging: true,
  requestIdHeader: false,
  exposeHeadRoutes: false,
  // A 20 GB transfer over a slow link must not be cut off mid-stream.
  connectionTimeout: 0,
  keepAliveTimeout: 72_000,
  requestTimeout: 0,
});

// Raw pass-through for chunk bodies: the request stream is written straight to
// disk, so nothing is ever buffered whole in memory. JSON keeps Fastify's own
// parser, bounded by the 1 MB global body limit set above.
app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
app.addContentTypeParser('*', (req, payload, done) => done(null, payload));

await app.register(cookie, { secret: config.sessionSecret });

await app.register(rateLimit, {
  global: true,
  max: 300 * config.rateFactor,
  timeWindow: '1 minute',
  keyGenerator: (req) => clientIp(req),
  addHeadersOnExceeding: { 'x-ratelimit-remaining': false },
  // statusCode has to travel with the payload: the error handler below reads
  // it to answer 429 instead of falling through to a generic 500.
  errorResponseBuilder: () => ({ statusCode: 429, error: 'RATE_LIMITED', message: 'Too many requests. Slow down.' }),
});

app.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Permissions-Policy', 'interest-cohort=(), geolocation=(), camera=(), microphone=()');
  if (!reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  return payload;
});

// Production errors are deliberately minimal: no stack traces, no paths, no
// query text, nothing about what exists internally.
app.setErrorHandler((err, req, reply) => {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many requests. Slow down.' });
  }
  if (err.statusCode === 413) {
    return reply.code(413).send({ error: 'TOO_LARGE', message: 'Request body is too large.' });
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: 'BAD_REQUEST', message: 'The request could not be processed.' });
  }
  logger.error('request.failed', { method: req.method, path: req.routeOptions?.url ?? 'unknown', err });
  return reply.code(500).send({ error: 'SERVER_ERROR', message: 'Something went wrong.' });
});

app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
  if (req.headers.accept?.includes('text/html')) {
    return reply.code(404).type('text/html; charset=utf-8').send(page('notfound.html'));
  }
  return reply.code(404).send({ error: 'NOT_FOUND', message: 'Not found.' });
});

await app.register(fastifyStatic, {
  root: join(publicDir, 'assets'),
  prefix: '/assets/',
  index: false,
  dotfiles: 'deny',
  cacheControl: true,
  maxAge: '1h',
});

await app.register(uploadRoutes);
await app.register(shareRoutes);
await app.register(adminRoutes);

// Internal health endpoint (also used by the container health check).
app.get('/api/health', { config: rl(120, '1 minute') }, async (req, reply) => {
  const result = await checkHealth();
  reply.code(result.ok ? 200 : 503);
  return { status: result.status, ok: result.ok, uptimeSeconds: result.uptimeSeconds };
});

app.get('/', async (req, reply) => reply.type('text/html; charset=utf-8').send(page('index.html')));
app.get('/admin', async (req, reply) => reply.type('text/html; charset=utf-8').send(page('admin.html')));

// Share pages. An unknown ID returns 404 so that the madhur.dev reverse proxy
// can fall through to the existing site instead of swallowing its routes.
app.get('/:id', { config: rl(60, '1 minute') }, async (req, reply) => {
  const id = normalizeShareId(req.params.id);
  if (!id || !getActiveShare(id)) {
    return reply.code(404).type('text/html; charset=utf-8').send(page('notfound.html'));
  }
  return reply.type('text/html; charset=utf-8').send(page('share.html'));
});

startCleanup();

const close = async (signal) => {
  logger.info('server.stopping', { signal });
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => close('SIGTERM'));
process.on('SIGINT', () => close('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandled_rejection', { err }));
process.on('uncaughtException', (err) => logger.error('uncaught_exception', { err }));

await app.listen({ port: config.port, host: config.host });
logger.info('server.started', {
  port: config.port,
  storageLimitBytes: config.storageLimitBytes,
  chunkSize: config.chunkSize,
});
