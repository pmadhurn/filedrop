import { createHash, randomBytes, randomInt, timingSafeEqual, scryptSync, createHmac } from 'node:crypto';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Share IDs: 4-6 lowercase letters, no digits, cryptographically random.
// ---------------------------------------------------------------------------
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

export function generateShareId(length) {
  const len = length ?? randomInt(4, 7); // 4, 5 or 6
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

export function normalizeShareId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return /^[a-z]{4,6}$/.test(id) ? id : null;
}

export function isReservedId(id) {
  return config.reserved.has(id);
}

export function randomId(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// Filenames
//
// A user-supplied name is only ever a display label. On-disk names are always
// server generated, so nothing a client sends can influence a filesystem path.
// ---------------------------------------------------------------------------
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeFilename(raw) {
  let name = typeof raw === 'string' ? raw : '';
  // Strip any path component, both separators, before anything else.
  name = name.split(/[/\\]/).pop() || '';
  // Remove NUL and every other control character.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  // Unicode direction overrides can disguise an extension.
  name = name.replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  name = name.normalize('NFC').trim();
  // Leading dots / dashes and pure traversal names.
  name = name.replace(/^[.\s]+/, '');
  if (name === '' || name === '.' || name === '..') name = 'file';
  if (RESERVED_WINDOWS.test(name)) name = `file_${name}`;
  if (name.length > config.maxFilenameLength) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, config.maxFilenameLength - ext.length) + ext;
  }
  return name;
}

// Value safe to place in a Content-Disposition header.
export function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, from the standard library — no native dependency)
// ---------------------------------------------------------------------------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const saltBuf = Buffer.from(salt, 'base64');
    const keyBuf = Buffer.from(key, 'base64');
    const n = Number(N);
    const test = scryptSync(password, saltBuf, keyBuf.length, {
      N: n, r: Number(r), p: Number(p), maxmem: 128 * n * Number(r) * 2,
    });
    return timingSafeEqual(test, keyBuf);
  } catch {
    return false;
  }
}

export function constantTimeEquals(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// Signed tokens (share access). Payload is not secret, only authenticated.
// ---------------------------------------------------------------------------
export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// Per-route rate limit, scaled by RATE_LIMIT_FACTOR.
export function rl(max, timeWindow) {
  return { rateLimit: { max: max * config.rateFactor, timeWindow } };
}

// Client IP as seen behind Cloudflare + the local reverse proxy.
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0 && cf.length < 64) return cf;
  return req.ip || '0.0.0.0';
}
