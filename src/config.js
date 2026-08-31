import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid numeric value for ${name}`);
  }
  return Math.floor(value);
}

// Same, but keeps fractions — the expiry windows are configured in hours and
// a test deployment needs to be able to say 0.002 of one.
function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid numeric value for ${name}`);
  }
  return value;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const DATA_DIR = str('DATA_DIR', '/data');
const dirs = {
  data: DATA_DIR,
  db: join(DATA_DIR, 'db'),
  storage: join(DATA_DIR, 'storage'),
  tmp: join(DATA_DIR, 'tmp'),
  logs: join(DATA_DIR, 'logs'),
};

for (const dir of Object.values(dirs)) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Session secret: from the environment when provided, otherwise generated once
// and persisted in the data volume so sessions survive container restarts.
function resolveSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const keyFile = join(dirs.data, 'session.key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  const generated = randomBytes(48).toString('base64url');
  writeFileSync(keyFile, generated, { mode: 0o600 });
  return generated;
}

const adminUsername = str('ADMIN_USERNAME', '');
const adminPassword = str('ADMIN_PASSWORD', '');
if (!adminUsername || !adminPassword) {
  throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be set');
}

// Paths that must never be handed out as a share ID: this application's own
// routes plus the routes already served by madhur.dev. Share IDs are 4-6
// letters, so only same-shaped names can ever collide.
const BUILTIN_RESERVED = [
  'admin', 'api', 'health', 'assets', 'static', 'public', 'files', 'file',
  'share', 'shares', 'upload', 'uploads', 'download', 'downloads', 'login',
  'logout', 'robots', 'sitemap', 'humans', 'favicon', 'manifest', 'index',
  'chat', 'about', 'blog', 'work', 'home', 'resume', 'contact', 'projects',
  'rss', 'feed', 'well', 'cdn', 'img', 'css', 'js', 'help', 'legal', 'terms',
  'privacy', 'status', 'metrics', 'debug', 'test', 'null', 'undefined',
];

const reserved = new Set(
  BUILTIN_RESERVED.concat(
    str('RESERVED_IDS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )
);

export const config = {
  port: int('PORT', 8140),
  host: str('HOST', '0.0.0.0'),
  dirs,
  sessionSecret: resolveSecret(),
  admin: {
    username: adminUsername,
    password: adminPassword,
    sessionMs: Math.round(num('ADMIN_SESSION_HOURS', 8) * 3600_000),
    maxAttempts: int('ADMIN_MAX_LOGIN_ATTEMPTS', 5),
    lockoutMs: int('ADMIN_LOCKOUT_MINUTES', 15) * 60_000,
  },
  maxBatchBytes: int('MAX_BATCH_BYTES', 20_000_000_000),
  storageLimitBytes: int('STORAGE_LIMIT_BYTES', 20_000_000_000),
  shareExpiryMs: Math.round(num('SHARE_EXPIRY_HOURS', 24) * 3600_000),
  incompleteTimeoutMs: Math.round(num('INCOMPLETE_UPLOAD_TIMEOUT_HOURS', 2) * 3600_000),
  chunkSize: int('CHUNK_SIZE_BYTES', 16 * 1024 * 1024),
  shareTokenMs: Math.round(num('SHARE_TOKEN_HOURS', 6) * 3600_000),
  maxFilesPerBatch: int('MAX_FILES_PER_BATCH', 500),
  maxFilenameLength: 255,
  log: {
    maxTotalBytes: int('LOG_MAX_SIZE_MB', 50) * 1024 * 1024,
    files: 5,
    level: str('LOG_LEVEL', 'info'),
  },
  publicBaseUrl: str('PUBLIC_BASE_URL', 'https://link.madhur.dev').replace(/\/+$/, ''),
  secondaryBaseUrl: str('SECONDARY_BASE_URL', '').replace(/\/+$/, ''),
  reserved,
  cleanupIntervalMs: Math.round(num('CLEANUP_INTERVAL_SECONDS', 60) * 1000),
  // Multiplies every rate-limit ceiling. Stays at 1 in production; raised only
  // to run the acceptance suite, which makes far more requests than a person.
  rateFactor: Math.max(1, int('RATE_LIMIT_FACTOR', 1)),
  isProduction: str('NODE_ENV', 'production') === 'production',
};
