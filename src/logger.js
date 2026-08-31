import {
  closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

// Minimal size-rotating JSON-line logger. Total retained size across all files
// stays within LOG_MAX_SIZE_MB: `files` generations of maxTotalBytes/files.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.log.level] ?? LEVELS.info;
// files * perFile stays at or under the configured ceiling, so the retained
// total can never exceed LOG_MAX_SIZE_MB.
const perFileBytes = Math.max(64 * 1024, Math.floor(config.log.maxTotalBytes / config.log.files));
const logFile = join(config.dirs.logs, 'app.log');

mkdirSync(config.dirs.logs, { recursive: true });

// Writes are synchronous on purpose: an asynchronously opened stream would let
// a burst of lines queue up behind an unopened file descriptor, and rotation
// would then rename files that do not exist yet. Log volume here is a few
// lines per request, so the cost is negligible.
let fd = openSync(logFile, 'a');
let written = existsSync(logFile) ? statSync(logFile).size : 0;

function rotate() {
  try {
    closeSync(fd);
    const oldest = `${logFile}.${config.log.files - 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = config.log.files - 2; i >= 1; i -= 1) {
      const from = `${logFile}.${i}`;
      if (existsSync(from)) renameSync(from, `${logFile}.${i + 1}`);
    }
    if (existsSync(logFile)) renameSync(logFile, `${logFile}.1`);
  } catch {
    // Rotation must never take the application down.
  }
  fd = openSync(logFile, 'a');
  written = 0;
}

// Values that must never reach the log, whatever a caller passes in.
const REDACT = /^(password|passwd|pass|pwd|secret|token|authorization|cookie|hash|credential|csrf)/i;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value instanceof Error) return { message: value.message, code: value.code };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  return value;
}

function write(level, event, fields) {
  if ((LEVELS[level] ?? 0) < threshold) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...sanitize(fields || {}) })}\n`;
  if (written + line.length > perFileBytes) rotate();
  written += Buffer.byteLength(line);
  try {
    writeSync(fd, line);
  } catch {
    // A failed log write must never fail the request it belongs to.
  }
  if (level === 'error' || level === 'warn') process.stderr.write(line);
  else if (!config.isProduction) process.stdout.write(line);
}

export const logger = {
  debug: (event, fields) => write('debug', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};

// Used by the admin dashboard to tail recent operational log lines. Only the
// tail of the current file is read so a large log never lands in memory.
export function readRecentLogs(limit = 200) {
  const TAIL_BYTES = 256 * 1024;
  let fd;
  try {
    if (!existsSync(logFile)) return [];
    const size = statSync(logFile).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length === 0) return [];
    const buf = Buffer.allocUnsafe(length);
    fd = openSync(logFile, 'r');
    readSync(fd, buf, 0, length, start);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (start > 0) lines.shift(); // drop the partial first line
    return lines.slice(-limit).reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function logStats() {
  let total = 0;
  let files = 0;
  try {
    for (const name of readdirSync(config.dirs.logs)) {
      if (!name.startsWith('app.log')) continue;
      total += statSync(join(config.dirs.logs, name)).size;
      files += 1;
    }
  } catch {
    // ignore
  }
  return { totalBytes: total, files, maxTotalBytes: config.log.maxTotalBytes };
}
