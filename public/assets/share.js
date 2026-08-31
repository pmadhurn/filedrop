import { api, countdown, el, esc, formatBytes } from './common.js';

const shareId = location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
let expiryTimer = null;

function stage(id) {
  for (const s of ['loading', 'lockStage', 'filesStage', 'goneStage']) el(s).hidden = s !== id;
}

function startExpiryClock(expiresAt) {
  const paint = () => {
    const left = countdown(expiresAt);
    el('expiryNote').textContent = left === 'expired' ? 'Expired' : `Expires in ${left}`;
    if (left === 'expired') {
      clearInterval(expiryTimer);
      stage('goneStage');
      el('goneText').textContent = 'This share has expired and its files have been deleted.';
    }
  };
  paint();
  clearInterval(expiryTimer);
  expiryTimer = setInterval(paint, 1000);
}

function render(share) {
  startExpiryClock(share.expiresAt);
  if (share.protected && !share.files) { stage('lockStage'); return; }

  stage('filesStage');
  el('shareSummary').textContent =
    `${share.fileCount} file${share.fileCount === 1 ? '' : 's'} · ${formatBytes(share.totalBytes)}`;

  const pills = [`<span class="pill good" id="expPill">Expires in ${countdown(share.expiresAt)}</span>`];
  if (share.protected) pills.push('<span class="pill warn">🔒 Unlocked</span>');
  if (share.downloadLimit !== null && share.downloadLimit !== undefined) {
    pills.push(`<span class="pill">${share.downloadsRemaining} of ${share.downloadLimit} downloads left</span>`);
  } else {
    pills.push('<span class="pill">Unlimited downloads</span>');
  }
  el('sharePills').innerHTML = pills.join('');

  el('files').innerHTML = share.files.map((f) => `
    <div class="file-row">
      <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="size">${formatBytes(f.size)}</span>
      <a class="btn small primary" href="/d/${esc(share.id)}/${esc(f.id)}" download rel="noopener">Download</a>
    </div>`).join('');
}

async function load() {
  try {
    render(await api(`/api/s/${shareId}`));
  } catch (err) {
    stage('goneStage');
    if (err.status === 429) el('goneText').textContent = 'Too many requests. Wait a moment and reload.';
  }
}

el('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('pwBtn');
  btn.disabled = true;
  el('pwError').classList.add('hidden');
  try {
    render(await api(`/api/s/${shareId}/auth`, {
      method: 'POST',
      body: JSON.stringify({ password: el('pw').value }),
    }));
  } catch (err) {
    el('pwError').textContent = err.status === 429
      ? 'Too many attempts. Try again in a few minutes.'
      : err.message;
    el('pwError').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    el('pw').value = '';
  }
});

load();
