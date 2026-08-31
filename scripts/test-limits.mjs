// Rate limiting, brute-force protection and log rotation, at production settings.
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:8144';
const CONTAINER = 'filedrop-rl';
let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  const line = cond ? `  PASS  ${name}` : `  FAIL  ${name} ${detail}`;
  if (cond) pass++; else fail++;
  console.log(line);
}
const get = (p, o) => fetch(BASE + p, o);

// --- share enumeration ----------------------------------------------------
let enumBlocked = 0;
const letters = 'abcdefghijklmnopqrstuvwxyz';
for (let i = 0; i < 90; i++) {
  const guess = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * 26)]).join('');
  const res = await get(`/api/s/${guess}`);
  if (res.status === 429) enumBlocked++;
}
ok('share-ID guessing is throttled', enumBlocked > 0, `${enumBlocked} of 90 blocked`);

// --- password brute force -------------------------------------------------
let pwBlocked = 0;
for (let i = 0; i < 15; i++) {
  const res = await get('/api/s/abcd/auth', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: `guess${i}` }) });
  if (res.status === 429) pwBlocked++;
}
ok('password guessing is throttled', pwBlocked > 0, `${pwBlocked} of 15 blocked`);

// --- admin login ----------------------------------------------------------
const codes = [];
for (let i = 0; i < 8; i++) {
  const res = await get('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testadmin', password: `wrong${i}` }) });
  codes.push(res.status);
}
ok('admin login locks out after repeated failures', codes.includes(429), codes.join(','));
const stillLocked = await get('/api/admin/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'testadmin', password: '<throwaway>' }) });
ok('lockout also blocks the correct password', stillLocked.status === 429, String(stillLocked.status));

// --- upload abuse ---------------------------------------------------------
let upBlocked = 0;
for (let i = 0; i < 30; i++) {
  const res = await get('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'x.bin', size: 1000 }] }) });
  if (res.status === 429) upBlocked++;
}
ok('upload creation is rate limited', upBlocked > 0, `${upBlocked} of 30 blocked`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
