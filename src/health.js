import { access, constants, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { logStats } from './logger.js';
import { storageUsage } from './model.js';
import { diskStats } from './storage.js';

// Verifies the things the service cannot run without: database readable and
// writable, every required directory present and writable, and that storage
// accounting returns a sane answer.
export async function checkHealth() {
  const checks = {};
  let ok = true;

  try {
    db.prepare('SELECT 1').get();
    db.prepare("INSERT INTO counters (key, value) VALUES ('health', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .run(Date.now(), Date.now());
    checks.database = { ok: true };
  } catch (err) {
    ok = false;
    checks.database = { ok: false, error: err.message };
  }

  for (const [name, dir] of Object.entries(config.dirs)) {
    try {
      await access(dir, constants.R_OK | constants.W_OK);
      checks[`dir_${name}`] = { ok: true };
    } catch {
      ok = false;
      checks[`dir_${name}`] = { ok: false };
    }
  }

  try {
    const probe = join(config.dirs.tmp, '.health-probe');
    await writeFile(probe, 'ok');
    await unlink(probe);
    checks.storageWritable = { ok: true };
  } catch (err) {
    ok = false;
    checks.storageWritable = { ok: false, error: err.message };
  }

  let usage = null;
  try {
    usage = storageUsage();
    checks.accounting = { ok: Number.isFinite(usage.usedBytes) && usage.usedBytes >= 0 };
    if (!checks.accounting.ok) ok = false;
  } catch (err) {
    ok = false;
    checks.accounting = { ok: false, error: err.message };
  }

  const disk = await diskStats();
  return {
    ok,
    status: ok ? 'healthy' : 'degraded',
    checks,
    storage: usage,
    disk,
    logs: logStats(),
    uptimeSeconds: Math.round(process.uptime()),
  };
}
