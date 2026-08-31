// Large-file run: 5 GB through the real chunk pipeline, watching memory.
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8140';
const SIZE = Number(process.env.SIZE || 5 * 1024 * 1024 * 1024);

const rss = () => {
  const out = execSync('docker stats --no-stream --format "{{.MemUsage}}" filedrop', { encoding: 'utf8' }).trim();
  return out;
};

const j = async (p, o = {}) => {
  const res = await fetch(BASE + p, o);
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log('container memory before:', rss());

const created = await j('/api/uploads', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ files: [{ name: 'huge.bin', size: SIZE }] }),
});
if (created.status !== 200) { console.log('FAIL create', created.status, created.body); process.exit(1); }
const { sessionId, token, chunkSize } = created.body;
const fileId = created.body.files[0].id;
const chunks = Math.ceil(SIZE / chunkSize);
console.log(`uploading ${(SIZE / 1e9).toFixed(1)} GB in ${chunks} chunks of ${(chunkSize / 1e6).toFixed(0)} MB`);

// One reusable random block, hashed as we go so the whole file's digest is known
// without ever holding more than a chunk in this process either.
const block = randomBytes(chunkSize);
const whole = createHash('sha256');
const started = Date.now();
let peak = '';

for (let c = 0; c < chunks; c++) {
  const len = Math.min(chunkSize, SIZE - c * chunkSize);
  const slice = len === chunkSize ? block : block.subarray(0, len);
  whole.update(slice);
  const res = await fetch(`${BASE}/api/uploads/${sessionId}/files/${fileId}/chunks/${c}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'x-upload-token': token,
      'x-chunk-sha256': createHash('sha256').update(slice).digest('hex'),
    },
    body: slice,
  });
  if (!res.ok) { console.log('FAIL chunk', c, res.status, await res.text()); process.exit(1); }
  if (c % 50 === 0 || c === chunks - 1) {
    peak = rss();
    const mb = ((c + 1) * chunkSize) / 1e6;
    console.log(`  chunk ${c + 1}/${chunks}  ${(mb / 1000).toFixed(1)} GB  ${(mb / ((Date.now() - started) / 1000)).toFixed(0)} MB/s  container mem ${peak}`);
  }
}

const completeStart = Date.now();
const share = await j(`/api/uploads/${sessionId}/complete`, { method: 'POST', headers: { 'x-upload-token': token } });
console.log('complete:', share.status, share.body?.id, `(verify+fsync took ${((Date.now() - completeStart) / 1000).toFixed(1)}s)`);
if (share.status !== 200) process.exit(1);

const meta = await j(`/api/s/${share.body.id}`);
const dlFileId = meta.body.files[0].id;

// Stream the download back and hash it without buffering.
const dl = await fetch(`${BASE}/d/${share.body.id}/${dlFileId}`);
const back = createHash('sha256');
let got = 0;
for await (const buf of dl.body) { back.update(buf); got += buf.length; }
console.log('downloaded', (got / 1e9).toFixed(2), 'GB; container memory after:', rss());
const same = back.digest('hex') === whole.digest('hex');
console.log(same && got === SIZE ? '  PASS  5 GB file round-trips byte-for-byte' : `  FAIL  ${got} bytes, digest match ${same}`);

// Range read from deep inside the file.
const deep = await fetch(`${BASE}/d/${share.body.id}/${dlFileId}`, { headers: { range: `bytes=${SIZE - 10}-` } });
const tail = Buffer.from(await deep.arrayBuffer());
console.log(deep.status === 206 && tail.length === 10 ? '  PASS  range read at the 5 GB mark' : `  FAIL  range ${deep.status} ${tail.length}`);

console.log('share id:', share.body.id);
