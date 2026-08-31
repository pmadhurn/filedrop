import { api, copyText, countdown, el, esc, formatBytes, formatDuration } from './common.js';
import { Uploader } from './uploader.js';

const STORE_KEY = 'filedrop.session';
let limits = { maxBatchBytes: 20e9, chunkSize: 16777216, expiryHours: 24, remainingBytes: 20e9, maxFiles: 500 };
let picked = [];         // File[]
let uploader = null;
let pending = null;      // resumable session found in storage

// --- staging -------------------------------------------------------------
function show(stage) {
  for (const id of ['pickStage', 'progressStage', 'doneStage']) {
    el(id).hidden = id !== stage;
  }
}

function setError(node, message) {
  const box = el(node);
  box.classList.toggle('hidden', !message);
  box.textContent = message || '';
}

// --- file selection ------------------------------------------------------
function totalOf(files) {
  return files.reduce((sum, f) => sum + f.size, 0);
}

function renderPicked() {
  const list = el('fileList');
  list.innerHTML = picked.map((f, i) => `
    <div class="file-row">
      <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="size">${formatBytes(f.size)}</span>
      <button class="remove" data-i="${i}" aria-label="Remove ${esc(f.name)}">✕</button>
    </div>`).join('');
  for (const btn of list.querySelectorAll('.remove')) {
    btn.addEventListener('click', () => {
      picked.splice(Number(btn.dataset.i), 1);
      renderPicked();
    });
  }
  const has = picked.length > 0;
  el('options').hidden = !has;
  el('actions').hidden = !has;
  const total = totalOf(picked);
  el('batchTotal').textContent = has ? `${picked.length} file${picked.length === 1 ? '' : 's'} · ${formatBytes(total)}` : '';
  validate();
}

function validate() {
  const total = totalOf(picked);
  if (picked.length > limits.maxFiles) {
    setError('pickError', `A batch may contain at most ${limits.maxFiles} files.`);
    el('uploadBtn').disabled = true;
    return false;
  }
  if (total > limits.maxBatchBytes) {
    setError('pickError', `That batch is ${formatBytes(total)}. The maximum is ${formatBytes(limits.maxBatchBytes)}.`);
    el('uploadBtn').disabled = true;
    return false;
  }
  if (total > limits.remainingBytes) {
    setError('pickError', `Only ${formatBytes(limits.remainingBytes)} of space is free right now.`);
    el('uploadBtn').disabled = true;
    return false;
  }
  setError('pickError', '');
  el('uploadBtn').disabled = picked.length === 0;
  return true;
}

function addFiles(files) {
  for (const f of files) picked.push(f);
  renderPicked();
}

// --- upload --------------------------------------------------------------
function readOptions() {
  const password = el('password').value;
  const mode = el('limitMode').value;
  let downloadLimit = null;
  if (mode === 'custom') {
    const n = Number(el('limitCustom').value);
    if (!Number.isInteger(n) || n < 1) throw new Error('Enter a whole number of downloads, or choose Unlimited.');
    downloadLimit = n;
  } else if (mode !== 'unlimited') {
    downloadLimit = Number(mode);
  }
  return { password: password.length ? password : null, downloadLimit };
}

function renderProgressFiles(entries) {
  el('progressFiles').innerHTML = entries.map((e) => `
    <div class="file-row${e.received.size >= e.chunkCount ? ' done' : ''}" data-id="${e.id}">
      <span class="name">${esc(e.file.name)}</span>
      <span class="size">${formatBytes(e.size)}</span>
      <span class="state">${e.received.size >= e.chunkCount ? 'done' : `${e.received.size}/${e.chunkCount || 1}`}</span>
    </div>`).join('');
}

function onProgress(p) {
  el('pct').textContent = `${p.percent.toFixed(p.percent >= 99.5 ? 2 : 0)}%`;
  el('barFill').style.width = `${Math.min(100, p.percent)}%`;
  el('bytesMeta').textContent = `${formatBytes(p.uploaded)} / ${formatBytes(p.total)}`;
  el('speedMeta').textContent = p.speed > 0 ? `${formatBytes(p.speed)}/s` : '—';
  el('etaMeta').textContent = p.paused ? 'paused' : p.etaMs ? `~${formatDuration(p.etaMs)} remaining` : '—';
  el('currentFile').textContent = p.currentName ? `Current file: ${p.currentName}` : '';
  const retry = el('retryMeta');
  retry.hidden = p.retries === 0;
  retry.textContent = `${p.retries} chunk retr${p.retries === 1 ? 'y' : 'ies'}`;
}

async function beginUpload(resumeSession) {
  let options;
  try {
    options = resumeSession ? { password: null, downloadLimit: null } : readOptions();
  } catch (err) {
    setError('pickError', err.message);
    return;
  }

  let session;
  let serverFiles;
  if (resumeSession) {
    session = resumeSession.session;
    serverFiles = resumeSession.files;
  } else {
    try {
      const created = await api('/api/uploads', {
        method: 'POST',
        body: JSON.stringify({
          files: picked.map((f) => ({ name: f.name, size: f.size })),
          password: options.password,
          downloadLimit: options.downloadLimit,
        }),
      });
      session = { sessionId: created.sessionId, token: created.token, chunkSize: created.chunkSize };
      serverFiles = created.files.map((f) => ({ ...f, received: [] }));
      localStorage.setItem(STORE_KEY, JSON.stringify({
        session,
        files: created.files.map((f) => ({ id: f.id, name: f.name, size: f.size, chunkCount: f.chunkCount })),
        at: Date.now(),
      }));
    } catch (err) {
      setError('pickError', err.message);
      return;
    }
  }

  // Pair each server-side file record with the local File object by name+size.
  const pool = picked.slice();
  const entries = [];
  for (const sf of serverFiles) {
    const i = pool.findIndex((f) => f.name === sf.name && f.size === sf.size);
    if (i === -1) {
      setError('pickError', 'The selected files do not match this upload. Select the same files, or discard it.');
      return;
    }
    entries.push({
      id: sf.id,
      file: pool.splice(i, 1)[0],
      size: sf.size,
      chunkCount: sf.chunkCount,
      received: new Set(sf.received || []),
    });
  }

  show('progressStage');
  setError('uploadError', '');
  renderProgressFiles(entries);

  uploader = new Uploader({
    session,
    entries,
    onProgress,
    onFile: () => renderProgressFiles(entries),
    onError: (err) => setError('uploadError', err.message),
  });

  await runUploader(session);
}

async function runUploader(session) {
  el('pauseBtn').textContent = 'Pause';
  const result = await uploader.start();
  if (!result.finished) {
    if (uploader.cancelled) return;
    el('pauseBtn').textContent = 'Resume';
    return;
  }
  try {
    const share = await api(`/api/uploads/${session.sessionId}/complete`, {
      method: 'POST',
      headers: { 'X-Upload-Token': session.token },
    });
    localStorage.removeItem(STORE_KEY);
    showResult(share);
  } catch (err) {
    setError('uploadError', err.message);
    el('pauseBtn').textContent = 'Resume';
  }
}

function showResult(share) {
  show('doneStage');
  const url = share.url;
  el('shareUrl').textContent = url;
  el('openLink').href = url;
  el('altUrl').textContent = share.alternateUrl ? `Also reachable at ${share.alternateUrl}` : '';

  const pills = [`<span class="pill good">Expires in ${countdown(share.expiresAt)}</span>`,
    `<span class="pill">${share.fileCount} file${share.fileCount === 1 ? '' : 's'} · ${formatBytes(share.totalBytes)}</span>`];
  if (share.hasPassword) pills.push('<span class="pill warn">🔒 Password protected</span>');
  pills.push(`<span class="pill">${share.downloadLimit ? `${share.downloadLimit} download${share.downloadLimit === 1 ? '' : 's'} allowed` : 'Unlimited downloads'}</span>`);
  el('sharePills').innerHTML = pills.join('');

  el('doneFiles').innerHTML = picked.map((f) => `
    <div class="file-row done">
      <span class="name">${esc(f.name)}</span>
      <span class="size">${formatBytes(f.size)}</span>
      <span class="state">uploaded</span>
    </div>`).join('');

  const tick = setInterval(() => {
    const left = countdown(share.expiresAt);
    const pill = el('sharePills').querySelector('.pill.good');
    if (pill) pill.textContent = left === 'expired' ? 'Expired' : `Expires in ${left}`;
    if (left === 'expired') clearInterval(tick);
  }, 1000);
}

// --- resume after a refresh ---------------------------------------------
async function checkPending() {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return;
  let stored;
  try { stored = JSON.parse(raw); } catch { localStorage.removeItem(STORE_KEY); return; }
  try {
    const state = await api(`/api/uploads/${stored.session.sessionId}`, {
      headers: { 'X-Upload-Token': stored.session.token },
    });
    if (state.status === 'COMPLETED') { localStorage.removeItem(STORE_KEY); return; }
    const uploaded = state.files.reduce((sum, f) => sum + f.received.length, 0);
    const totalChunks = state.files.reduce((sum, f) => sum + f.chunkCount, 0);
    pending = { session: { ...stored.session, chunkSize: state.chunkSize }, files: state.files };
    el('resumePanel').classList.remove('hidden');
    el('resumeText').textContent = ` ${state.files.length} file(s), ${uploaded} of ${totalChunks} parts already uploaded.`;
  } catch {
    localStorage.removeItem(STORE_KEY);
  }
}

// --- wiring --------------------------------------------------------------
async function loadLimits() {
  try {
    limits = await api('/api/limits');
  } catch { /* defaults */ }
  el('maxSize').textContent = formatBytes(limits.maxBatchBytes);
  el('expiryHours').textContent = limits.expiryHours;
  el('topNote').textContent = `Links expire after ${limits.expiryHours} hours`;
  el('remaining').textContent = `${formatBytes(limits.remainingBytes)} free right now`;
}

async function init() {
  await loadLimits();

  const drop = el('drop');
  const input = el('fileInput');
  el('pickBtn').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('dragging'); });
  }
  drop.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  el('limitMode').addEventListener('change', () => {
    el('limitCustom').hidden = el('limitMode').value !== 'custom';
  });
  el('clearBtn').addEventListener('click', () => { picked = []; renderPicked(); });
  el('uploadBtn').addEventListener('click', () => { if (validate()) beginUpload(null); });

  el('pauseBtn').addEventListener('click', async () => {
    if (!uploader) return;
    if (uploader.paused) {
      uploader.paused = false;
      await runUploader(uploader.session);
    } else {
      uploader.pause();
      el('pauseBtn').textContent = 'Resume';
    }
  });

  el('cancelBtn').addEventListener('click', async () => {
    if (!uploader) return;
    await uploader.cancel();
    try {
      await api(`/api/uploads/${uploader.session.sessionId}`, {
        method: 'DELETE',
        headers: { 'X-Upload-Token': uploader.session.token },
      });
    } catch { /* the cleanup sweep will collect it */ }
    localStorage.removeItem(STORE_KEY);
    uploader = null;
    picked = [];
    renderPicked();
    show('pickStage');
  });

  el('copyBtn').addEventListener('click', async () => {
    const ok = await copyText(el('shareUrl').textContent);
    el('copyBtn').textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { el('copyBtn').textContent = 'Copy link'; }, 1800);
  });

  el('againBtn').addEventListener('click', () => {
    picked = [];
    renderPicked();
    el('password').value = '';
    show('pickStage');
    loadLimits();
  });

  el('resumePick').addEventListener('click', () => {
    const input2 = el('fileInput');
    const once = () => {
      input2.removeEventListener('change', once);
      picked = [...input2.files];
      input2.value = '';
      el('resumePanel').classList.add('hidden');
      beginUpload(pending);
    };
    input2.addEventListener('change', once);
    input2.click();
  });

  el('resumeDiscard').addEventListener('click', async () => {
    if (pending) {
      try {
        await api(`/api/uploads/${pending.session.sessionId}`, {
          method: 'DELETE',
          headers: { 'X-Upload-Token': pending.session.token },
        });
      } catch { /* ignore */ }
    }
    localStorage.removeItem(STORE_KEY);
    el('resumePanel').classList.add('hidden');
    pending = null;
  });

  window.addEventListener('beforeunload', (e) => {
    if (uploader && !uploader.done && !uploader.cancelled) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  await checkPending();
}

init();
