/* Chunked, resumable upload engine.
 *
 * A file is split into fixed-size chunks that are uploaded independently, so a
 * dropped connection only costs the chunks that were in flight. The server
 * remembers which chunks arrived, so a resumed session re-sends nothing that
 * already landed. Nothing larger than one chunk is ever held in memory.
 */
const MAX_ATTEMPTS = 6;
const CONCURRENCY = 3;

export class Uploader {
  constructor({ session, entries, onProgress, onFile, onError }) {
    this.session = session;              // { sessionId, token, chunkSize }
    this.entries = entries;              // [{ id, file, size, chunkCount, received:Set }]
    this.onProgress = onProgress || (() => {});
    this.onFile = onFile || (() => {});
    this.onError = onError || (() => {});
    this.paused = false;
    this.cancelled = false;
    this.inflight = new Set();
    this.retries = 0;
    this.partial = new Map();            // key -> bytes currently in flight
    this.samples = [];
    this.done = false;
  }

  get uploadedBytes() {
    let total = 0;
    for (const entry of this.entries) {
      for (const idx of entry.received) total += this._chunkSize(entry, idx);
    }
    for (const bytes of this.partial.values()) total += bytes;
    return total;
  }

  get totalBytes() {
    return this.entries.reduce((sum, e) => sum + e.size, 0);
  }

  _chunkSize(entry, idx) {
    const offset = idx * this.session.chunkSize;
    return Math.min(this.session.chunkSize, entry.size - offset);
  }

  _tasks() {
    const list = [];
    for (const entry of this.entries) {
      for (let idx = 0; idx < entry.chunkCount; idx += 1) {
        if (!entry.received.has(idx)) list.push({ entry, idx });
      }
    }
    return list;
  }

  _emit(currentName) {
    const uploaded = this.uploadedBytes;
    const now = Date.now();
    this.samples.push({ t: now, bytes: uploaded });
    while (this.samples.length > 2 && now - this.samples[0].t > 8000) this.samples.shift();
    const first = this.samples[0];
    const span = (now - first.t) / 1000;
    const speed = span > 0.5 ? Math.max(0, (uploaded - first.bytes) / span) : 0;
    const remaining = this.totalBytes - uploaded;
    this.onProgress({
      uploaded,
      total: this.totalBytes,
      percent: this.totalBytes ? (uploaded / this.totalBytes) * 100 : 100,
      speed,
      etaMs: speed > 0 ? (remaining / speed) * 1000 : null,
      currentName,
      retries: this.retries,
      paused: this.paused,
    });
  }

  async start() {
    this.cancelled = false;
    this.paused = false;
    this.samples = [];
    const queue = this._tasks();
    let cursor = 0;
    this._emit();

    const worker = async () => {
      while (!this.cancelled && !this.paused) {
        const task = queue[cursor];
        cursor += 1;
        if (!task) return;
        await this._uploadChunk(task);
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker);
    await Promise.all(workers);

    if (this.cancelled || this.paused) return { finished: false };
    const outstanding = this._tasks().length;
    if (outstanding > 0) return { finished: false, outstanding };
    this.done = true;
    return { finished: true };
  }

  pause() { this.paused = true; }

  async cancel() {
    this.cancelled = true;
    for (const xhr of this.inflight) { try { xhr.abort(); } catch { /* ignore */ } }
    this.inflight.clear();
  }

  async _uploadChunk({ entry, idx }) {
    const key = `${entry.id}:${idx}`;
    const offset = idx * this.session.chunkSize;
    const size = this._chunkSize(entry, idx);
    const blob = entry.file.slice(offset, offset + size);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (this.cancelled || this.paused) return;
      try {
        const headers = {};
        // Integrity: the server recomputes this and rejects a corrupted chunk.
        if (globalThis.crypto?.subtle) {
          try {
            const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
            headers['X-Chunk-SHA256'] = [...new Uint8Array(digest)]
              .map((b) => b.toString(16).padStart(2, '0')).join('');
          } catch { /* fall back to size verification only */ }
        }
        await this._put(entry, idx, blob, headers, key);
        entry.received.add(idx);
        this.partial.delete(key);
        this.onFile(entry);
        this._emit(entry.file.name);
        return;
      } catch (err) {
        this.partial.delete(key);
        if (this.cancelled || this.paused) return;
        // A rejected chunk is fatal; a network failure is worth retrying.
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          this.onError(err);
          this.cancelled = true;
          return;
        }
        this.retries += 1;
        this._emit(entry.file.name);
        if (attempt === MAX_ATTEMPTS) {
          this.onError(new Error('A part of the upload kept failing. It will resume when you retry.'));
          this.paused = true;
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(15000, 2 ** attempt * 500 + Math.random() * 400)));
      }
    }
  }

  _put(entry, idx, blob, headers, key) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/uploads/${this.session.sessionId}/files/${entry.id}/chunks/${idx}`, true);
      xhr.setRequestHeader('X-Upload-Token', this.session.token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.timeout = 0;
      xhr.upload.onprogress = (e) => {
        this.partial.set(key, e.loaded);
        this._emit(entry.file.name);
      };
      xhr.onload = () => {
        this.inflight.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        const err = new Error('Chunk rejected');
        err.status = xhr.status;
        try { err.message = JSON.parse(xhr.responseText)?.message || err.message; } catch { /* ignore */ }
        reject(err);
      };
      xhr.onerror = () => { this.inflight.delete(xhr); reject(new Error('Network error')); };
      xhr.onabort = () => { this.inflight.delete(xhr); reject(new Error('Aborted')); };
      xhr.ontimeout = () => { this.inflight.delete(xhr); reject(new Error('Timed out')); };
      this.inflight.add(xhr);
      xhr.send(blob);
    });
  }
}
