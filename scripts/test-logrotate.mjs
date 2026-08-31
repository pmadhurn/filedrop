// Log rotation: the retained total must stay inside LOG_MAX_SIZE_MB.
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'filedrop-log-'));
process.env.LOG_MAX_SIZE_MB = '1';
process.env.ADMIN_USERNAME = 'a';
process.env.ADMIN_PASSWORD = 'b';

const { logger, logStats } = await import('/home/ubuntu/filedrop/src/logger.js');

for (let i = 0; i < 40000; i++) {
  logger.info('load.test', { i, payload: 'x'.repeat(120) });
}
await new Promise((r) => setTimeout(r, 1500));

const dir = join(process.env.DATA_DIR, 'logs');
const files = readdirSync(dir);
const total = files.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
const cap = 1024 * 1024;
let fail = 0;
const ok = (n, c, d = '') => { console.log(c ? `  PASS  ${n}` : `  FAIL  ${n} ${d}`); if (!c) fail++; };

ok('rotation happened', files.length > 1, files.join(','));
ok('retained total stays within LOG_MAX_SIZE_MB', total <= cap, `${total} > ${cap}`);
ok('generations are capped at 5 files', files.length <= 5, files.join(','));
ok('logStats agrees with the filesystem', Math.abs(logStats().totalBytes - total) < 4096, `${logStats().totalBytes} vs ${total}`);
console.log(`\n${4 - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
