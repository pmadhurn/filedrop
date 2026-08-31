import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdir, rm, rename, stat, readdir, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

// Every path used by the application is built from server-generated hex names.
// safeJoin is the belt-and-braces check that nothing escapes its root anyway.
export function safeJoin(root, ...parts) {
  for (const part of parts) {
    if (typeof part !== 'string' || part === '.' || part === '..'
        || !/^[A-Za-z0-9._-]+$/.test(part)) {
      throw new Error('unsafe path component');
    }
  }
  const target = resolve(root, ...parts);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('path escapes root');
  }
  return target;
}

export const sessionDir = (dir) => safeJoin(config.dirs.tmp, dir);
export const shareDir = (dir) => safeJoin(config.dirs.storage, dir);

export async function createSessionDir(dir) {
  const path = sessionDir(dir);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

// Pre-allocate the destination file so chunks can be written straight to their
// final offset: no reassembly pass, no second copy of the data on disk.
export async function allocateFile(dir, filename, size) {
  const path = safeJoin(sessionDir(dir), filename);
  const handle = await open(path, 'w');
  try {
    if (size > 0) await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return path;
}

/**
 * Streams one chunk to its offset inside the pre-allocated file, hashing as it
 * goes. Never buffers more than a stream chunk in memory.
 * Returns { bytes, sha256 } or throws when the declared length is exceeded.
 */
export async function writeChunk({ dir, filename, offset, maxBytes, source }) {
  const path = safeJoin(sessionDir(dir), filename);
  const hash = createHash('sha256');
  let bytes = 0;
  // A path-based write stream owns its own descriptor. (A FileHandle-derived
  // stream would deadlock the handle's close until the stream closed itself.)
  const sink = createWriteStream(path, { flags: 'r+', start: offset });
  await pipeline(source, async function* (stream) {
    for await (const buf of stream) {
      bytes += buf.length;
      if (bytes > maxBytes) throw Object.assign(new Error('chunk too large'), { statusCode: 413 });
      hash.update(buf);
      yield buf;
    }
  }, sink);
  return { bytes, sha256: hash.digest('hex') };
}

// Flush a finished file to disk before it becomes part of a share.
export async function syncFile(dir, filename) {
  const handle = await open(safeJoin(sessionDir(dir), filename), 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Promote a completed upload from the temporary area to permanent storage.
// Both live on the same volume, so this is an atomic rename, not a copy.
export async function promoteSession(dir) {
  const from = sessionDir(dir);
  const to = shareDir(dir);
  await mkdir(config.dirs.storage, { recursive: true, mode: 0o700 });
  await rename(from, to);
  return to;
}

export async function removeSessionDir(dir) {
  await rm(sessionDir(dir), { recursive: true, force: true });
}

export async function removeShareDir(dir) {
  await rm(shareDir(dir), { recursive: true, force: true });
}

export function openFileStream(dir, filename, range) {
  const path = safeJoin(shareDir(dir), filename);
  return createReadStream(path, range);
}

export async function fileStat(dir, filename) {
  return stat(safeJoin(shareDir(dir), filename));
}

export async function listDirs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function diskStats() {
  try {
    const fs = await statfs(config.dirs.data);
    return {
      totalBytes: fs.blocks * fs.bsize,
      freeBytes: fs.bavail * fs.bsize,
    };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

export async function verifyFileSize(dir, filename, expected) {
  const s = await stat(safeJoin(sessionDir(dir), filename));
  return s.size === expected;
}
