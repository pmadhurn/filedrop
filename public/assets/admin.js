import { api, countdown, el, esc, formatBytes } from './common.js';

let csrf = null;
let timer = null;

function showDash(on) {
  for (const id of ['dash', 'sharesCard', 'healthCard', 'logsCard']) el(id).hidden = !on;
  el('loginStage').hidden = on;
  el('logoutBtn').classList.toggle('hidden', !on);
}

function stat(k, v) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
}

function when(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

async function refresh() {
  const [overview, shares, health, logs] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/shares'),
    api('/api/admin/health'),
    api('/api/admin/logs?limit=200'),
  ]);

  const s = overview.storage;
  el('stats').innerHTML = [
    stat('Active shares', overview.activeShares),
    stat('Uploads in flight', overview.activeUploads),
    stat('Storage used', formatBytes(s.usedBytes)),
    stat('Storage free', formatBytes(s.remainingBytes)),
    stat('Reserved by uploads', formatBytes(s.reservedBytes)),
    stat('Disk free (host volume)', formatBytes(overview.disk.freeBytes)),
    stat('Uptime', `${Math.floor(overview.uptimeSeconds / 3600)}h ${Math.floor((overview.uptimeSeconds % 3600) / 60)}m`),
    stat('Memory (RSS)', formatBytes(overview.memory.rssBytes)),
  ].join('');
  const pct = s.limitBytes ? (s.usedBytes / s.limitBytes) * 100 : 0;
  el('storageBar').style.width = `${Math.min(100, pct)}%`;
  el('storageText').textContent =
    `${formatBytes(s.usedBytes)} of ${formatBytes(s.limitBytes)} used (${pct.toFixed(1)}%) · ${formatBytes(s.shareBytes)} in active shares, ${formatBytes(s.reservedBytes)} reserved by uploads in progress`;

  el('shareCount').textContent = shares.total;
  el('noShares').hidden = shares.shares.length > 0;
  el('shareRows').innerHTML = shares.shares.map((sh) => `
    <tr>
      <td><a href="/${esc(sh.id)}" target="_blank" rel="noopener" class="mono">${esc(sh.id)}</a></td>
      <td title="${esc(sh.files.map((f) => f.name).join(', '))}">${sh.fileCount}</td>
      <td>${formatBytes(sh.totalBytes)}</td>
      <td>${esc(when(sh.createdAt))}</td>
      <td>${esc(countdown(sh.expiresAt))}</td>
      <td>${sh.downloadCount}${sh.downloadLimit ? ` / ${sh.downloadLimit}` : ''}</td>
      <td>${sh.hasPassword ? '🔒 password' : '—'}</td>
      <td><button class="small danger" data-del="${esc(sh.id)}">Delete</button></td>
    </tr>`).join('');
  for (const btn of el('shareRows').querySelectorAll('[data-del]')) {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      if (!confirm(`Delete share ${id} and its files? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/shares/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
        await refresh();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  }

  el('healthNote').textContent = health.ok ? '● healthy' : '● degraded';
  el('healthNote').style.color = health.ok ? 'var(--good)' : 'var(--bad)';
  el('healthGrid').innerHTML = Object.entries(health.checks)
    .map(([k, v]) => stat(k, v.ok ? 'ok' : 'FAILED')).join('')
    + stat('Log size', `${formatBytes(health.logs.totalBytes)} / ${formatBytes(health.logs.maxTotalBytes)}`);

  el('logStats').textContent = `${formatBytes(logs.stats.totalBytes)} of ${formatBytes(logs.stats.maxTotalBytes)} retained`;
  el('logs').textContent = logs.lines.map((line) => {
    try {
      const e = JSON.parse(line);
      const { ts, level, event, ...rest } = e;
      return `${ts}  ${level.toUpperCase().padEnd(5)} ${event}  ${JSON.stringify(rest)}`;
    } catch { return line; }
  }).join('\n');
}

async function boot() {
  try {
    const session = await api('/api/admin/session');
    csrf = session.csrf;
    showDash(true);
    await refresh();
    clearInterval(timer);
    timer = setInterval(() => refresh().catch(() => {}), 15000);
  } catch {
    showDash(false);
  }
}

el('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('loginBtn').disabled = true;
  el('loginError').classList.add('hidden');
  try {
    const res = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: el('u').value, password: el('p').value }),
    });
    csrf = res.csrf;
    el('p').value = '';
    showDash(true);
    await refresh();
    clearInterval(timer);
    timer = setInterval(() => refresh().catch(() => {}), 15000);
  } catch (err) {
    el('loginError').textContent = err.message;
    el('loginError').classList.remove('hidden');
  } finally {
    el('loginBtn').disabled = false;
  }
});

el('logoutBtn').addEventListener('click', async () => {
  clearInterval(timer);
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

el('refreshBtn').addEventListener('click', () => refresh().catch((err) => alert(err.message)));
el('cleanupBtn').addEventListener('click', async () => {
  el('cleanupBtn').disabled = true;
  try {
    await api('/api/admin/cleanup', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
    await refresh();
  } catch (err) { alert(err.message); } finally { el('cleanupBtn').disabled = false; }
});

boot();
