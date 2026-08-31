// Lifecycle tests: expiry, hard deletion, storage release, ID reuse,
// abandoned uploads, in-flight downloads, and rate limiting.
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:8143';
const CONTAINER = process.env.CONTAINER || 'filedrop-life';
let pass = 0, fail = 0;

function ok(name, cond, detail = '') {
  const line = cond ? `  PASS  ${name}` : `  FAIL  ${name} ${detail}`;
  if (cond) pass++; else fail++;
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Credentials for the throwaway test container, from the environment so no
// literal password lives in the repo:
//   CREDS='{"username":"testadmin","password":"..."}'
const CREDS = JSON.parse(process.env.CREDS || '{"username":"testadmin","password":""}');


async function j(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body, headers: res.headers };
}

async function upload(files, opts = {}) {
  const created = await j('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: files.map(f => ({ name: f.name, size: f.data.length })), ...opts }),
  });
  if (created.status !== 200) return { status: created.status, error: created.body };
  const { sessionId, token, chunkSize } = created.body;
  for (const [i, f] of created.body.files.entries()) {
    const data = files[i].data;
    for (let c = 0; c * chunkSize < data.length; c++) {
      const slice = data.subarray(c * chunkSize, Math.min(data.length, (c + 1) * chunkSize));
      await fetch(`${BASE}/api/uploads/${sessionId}/files/${f.id}/chunks/${c}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-upload-token': token },
        body: slice,
      });
    }
  }
  const done = await j(`/api/uploads/${sessionId}/complete`, { method: 'POST', headers: { 'x-upload-token': token } });
  return { status: done.status, share: done.body, session: { sessionId, token } };
}

const dirsIn = (sub) => {
  try {
    return execSync(`docker exec ${CONTAINER} ls /data/${sub}`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { return []; }
};

// --- expiry ---------------------------------------------------------------
const r = await upload([{ name: 'ephemeral.bin', data: randomBytes(50 * 1024 * 1024) }]);
ok('share created', r.status === 200, JSON.stringify(r.error));
const id = r.share.id;
const fileId = (await j(`/api/s/${id}`)).body.files[0].id;
const usedBefore = (await j('/api/limits')).body.remainingBytes;
ok('storage accounting counts the new share', usedBefore < 20000000000);
const storedDirs = dirsIn('storage');
ok('files landed in permanent storage', storedDirs.length >= 1, JSON.stringify(storedDirs));

const lifetimeMs = Number(process.env.LIFETIME_MS || 12000);
ok('expiry is server-side (client cannot ask for longer)',
  Math.abs((r.share.expiresAt - Date.now()) - lifetimeMs) < 4000,
  `${r.share.expiresAt - Date.now()} vs ${lifetimeMs}`);

// A download that begins before expiry must be allowed to finish.
const slow = await fetch(`${BASE}/d/${id}/${fileId}`);
const reader = slow.body.getReader();
const firstChunk = await reader.read();
ok('download starts before expiry', slow.status === 200 && !firstChunk.done);

console.log(`  ...waiting ${Math.round(lifetimeMs / 1000)}s for the share to expire`);
await sleep(lifetimeMs + 6000);

let drained = firstChunk.value.length;
let readErr = null;
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    drained += value.length;
  }
} catch (err) { readErr = err; }
ok('download that started before expiry still finishes', readErr === null && drained === 50 * 1024 * 1024, `${drained} ${readErr}`);

ok('new access after expiry is blocked', (await j(`/api/s/${id}`)).status === 404);
ok('new download after expiry is blocked', (await fetch(`${BASE}/d/${id}/${fileId}`)).status === 404);
ok('share page after expiry is 404', (await fetch(`${BASE}/${id}`, { headers: { accept: 'text/html' } })).status === 404);
ok('expired files are hard-deleted from storage', dirsIn('storage').length === 0, JSON.stringify(dirsIn('storage')));
const freed = (await j('/api/limits')).body.remainingBytes;
ok('storage is released after expiry', freed === 20000000000, String(freed));

// --- ID reuse -------------------------------------------------------------
const dbRow = execSync(`docker exec ${CONTAINER} node -e "const D=require('better-sqlite3');const d=new D('/data/db/filedrop.db');console.log(JSON.stringify(d.prepare('SELECT count(*) n FROM shares').get()))"`, { encoding: 'utf8' });
ok('expired share row is gone from the database', JSON.parse(dbRow).n === 0, dbRow.trim());
// Force the ID to be reused and prove nothing carries over.
const reuse = await upload([{ name: 'brand-new.txt', data: Buffer.from('fresh content') }], { password: 'newpass1' });
execSync(`docker exec ${CONTAINER} node -e "const D=require('better-sqlite3');const d=new D('/data/db/filedrop.db');d.pragma('foreign_keys = OFF');d.prepare('UPDATE shares SET id=? WHERE id=?').run('${id}','${reuse.share.id}');d.prepare('UPDATE share_files SET share_id=? WHERE share_id=?').run('${id}','${reuse.share.id}')"`);
const reused = await j(`/api/s/${id}`);
ok('reused ID serves only the new share', reused.status === 200 && reused.body.protected === true);
const reusedFiles = await j(`/api/s/${id}/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'newpass1' }) });
ok('reused ID has no trace of the old files',
  reusedFiles.body.files.length === 1 && reusedFiles.body.files[0].name === 'brand-new.txt');
ok('reused ID has a fresh download count', reusedFiles.body.downloadsUsed === 0);
const oldFileProbe = await fetch(`${BASE}/d/${id}/${fileId}`);
ok('old file id is unreachable under the reused ID', oldFileProbe.status === 404 || oldFileProbe.status === 401, String(oldFileProbe.status));

// --- abandoned incomplete upload -----------------------------------------
const stale = await j('/api/uploads', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ files: [{ name: 'never-finished.bin', size: 5000000 }] }) });
await fetch(`${BASE}/api/uploads/${stale.body.sessionId}/files/${stale.body.files[0].id}/chunks/0`, {
  method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-upload-token': stale.body.token },
  body: randomBytes(5000000) });
ok('incomplete upload holds temp data', dirsIn('tmp').length >= 1);
ok('incomplete upload reserves quota', (await j('/api/limits')).body.remainingBytes < 20000000000);
const staleMs = Number(process.env.STALE_MS || 12000);
console.log(`  ...waiting ${Math.round(staleMs / 1000)}s for the abandoned upload to be swept`);
await sleep(staleMs + 6000);
ok('abandoned upload temp data is deleted', dirsIn('tmp').length === 0, JSON.stringify(dirsIn('tmp')));
ok('abandoned upload releases its reservation', (await j('/api/limits')).body.remainingBytes === 20000000000);
ok('abandoned session cannot be resumed', (await j(`/api/uploads/${stale.body.sessionId}`, { headers: { 'x-upload-token': stale.body.token } })).status === 404);

// --- orphan file cleanup ---------------------------------------------------
execSync(`docker exec ${CONTAINER} sh -c "mkdir -p /data/storage/deadbeefdeadbeef && echo x > /data/storage/deadbeefdeadbeef/f.bin"`);
execSync(`docker exec ${CONTAINER} node -e "fetch('http://127.0.0.1:8140/api/health')"`);
await sleep(1000);
// The hourly orphan pass also runs on demand from the admin dashboard; trigger it.
const login = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(CREDS) });
const cookie = (login.headers.getSetCookie?.() || []).join('; ').split(';')[0];
const csrf = (await login.json()).csrf;
await fetch(`${BASE}/api/admin/cleanup`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
await sleep(500);
ok('orphaned directory removed by cleanup', !dirsIn('storage').includes('deadbeefdeadbeef'), JSON.stringify(dirsIn('storage')));

// --- persistence across a container restart -------------------------------
const persist = await upload([{ name: 'persist.txt', data: Buffer.from('survives a restart') }]);
execSync(`docker restart ${CONTAINER}`, { stdio: 'ignore' });
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
  await sleep(1000);
}
const after = await j(`/api/s/${persist.share.id}`);
ok('share survives a container restart', after.status === 200 && after.body.files.length === 1, String(after.status));
const persistDl = await fetch(`${BASE}/d/${persist.share.id}/${after.body.files[0].id}`);
const persistBytes = Buffer.from(await persistDl.arrayBuffer());
ok('file contents survive a container restart', persistBytes.toString() === 'survives a restart');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
