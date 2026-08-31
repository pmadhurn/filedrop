# FileDrop

Personal, self-hosted temporary file sharing. Upload a batch of files, get a
short link, and everything is hard-deleted 24 hours later.

- Public entry point: `https://link.madhur.dev`
- Secondary entry point: `https://madhur.dev/<id>` (only where the path does not
  collide with an existing route on the main site)
- All public traffic arrives through Cloudflare + Cloudflare Tunnel. No inbound
  port is forwarded; both containers publish on `127.0.0.1` only.

## Architecture

```
Browser
  │  https
  ▼
Cloudflare  ──► Cloudflare Tunnel (cloudflared on the host)
                   │
                   ├── link.madhur.dev ─► 127.0.0.1:8140   FileDrop (docker)
                   │
                   └── madhur.dev ──────► 127.0.0.1:8141   nginx shim (docker)
                                             ├─ /^[A-Za-z]{4,6}$/ ─► FileDrop
                                             │     404/5xx fall through ─┐
                                             └─ everything else ─────────┴─► 127.0.0.1:8090 (existing site)
```

Inside the app container:

| Path | Contents |
| --- | --- |
| `/data/db` | SQLite metadata (WAL) |
| `/data/storage` | Completed shares, one directory per share |
| `/data/tmp` | In-progress uploads, one directory per session |
| `/data/logs` | Rotating JSON-line logs, capped at `LOG_MAX_SIZE_MB` |

File bytes never go into the database, and the database is never reachable from
the web.

## How the guarantees are enforced

**Storage limit (never above `STORAGE_LIMIT_BYTES`).** Creating an upload
session reserves the batch's full declared size inside a `BEGIN IMMEDIATE`
transaction. Active bytes = bytes in `ACTIVE` shares + bytes reserved by
in-flight sessions, so two simultaneous uploads can never both be told there is
room for the same space. The reservation is released when the upload completes
(it becomes the share's own accounting), is cancelled, or is swept away after
`INCOMPLETE_UPLOAD_TIMEOUT_HOURS` of inactivity.

**Chunked, resumable uploads.** A file is split into `CHUNK_SIZE_BYTES` pieces
(16 MiB by default — well under Cloudflare's request body limit). Each chunk is
`PUT` separately with its SHA-256, and is written straight to its final offset
inside a pre-allocated file. There is no reassembly pass, so a 20 GB upload
never needs 40 GB of disk, and nothing bigger than a stream buffer is ever held
in memory. The server records which chunks arrived; a resumed session re-sends
only what is missing. Browser refreshes are recoverable: the session handle is
kept in `localStorage` and the page offers to resume once the same files are
selected again.

**Expiry.** The 24-hour clock starts when the batch finishes. The client cannot
influence it. A background sweep marks the share expired (which immediately hides
it and releases its quota), unlinks its directory, then deletes the row. A
download already in flight keeps its file descriptor and finishes; any new
request is refused.

**Share IDs.** 4–6 random lowercase letters, no digits. Lookups are
case-insensitive and canonicalised to lowercase. Generation retries on collision
with an existing share or with any reserved name (this app's routes plus the
existing madhur.dev routes), and widens from 4 to 6 letters as the space fills.
After a share is deleted its ID can be handed out again; nothing from the old
share — files, password, download count — survives.

**Downloads.** Every request re-checks that the share exists, is active, has not
expired, has satisfied its password requirement, is under its download limit,
and that the requested file belongs to that share. Files stream from disk with
range support and are served only through this endpoint — nothing under
`/data` is exposed as a static path. Responses carry `Cache-Control: private,
no-store` plus `CDN-Cache-Control`/`Cloudflare-CDN-Cache-Control: no-store`, so
Cloudflare will not retain content past expiry. A download counts against the
limit only when it starts at byte 0, so a media player seeking inside a file
does not burn the allowance.

**Filenames.** A user-supplied name is only ever a display label; on-disk names
are server-generated hex. Names are stripped of path components, NUL and control
characters, direction overrides and reserved device names before storage.

**Admin.** One administrator, credentials from the environment, compared in
constant time. Sessions are httpOnly + Secure + SameSite=strict cookies with a
CSRF token required on every mutation, and repeated failures lock the source IP
out for `ADMIN_LOCKOUT_MINUTES`.

## Deploy

```bash
cp .env.example .env      # then edit: set ADMIN_PASSWORD and SESSION_SECRET
docker compose up -d
```

That brings up two containers: `filedrop` (the app, on 127.0.0.1:8140) and
`filedrop-shim` (nginx for the apex domain, on 127.0.0.1:8141).

Cloudflare Tunnel ingress (`/etc/cloudflared/config.yml` on the host):

```yaml
  - hostname: link.madhur.dev
    service: http://localhost:8140
  - hostname: madhur.dev
    service: http://localhost:8141      # was :8090, now via the shim
  - hostname: www.madhur.dev
    service: http://localhost:8141
```

and the DNS record:

```bash
# TUNNEL_ID and the origin certificate path come from your own cloudflared
# setup: `cloudflared tunnel list` and the `origincert:` line in config.yml.
sudo cloudflared --origincert /path/to/cert.pem \
  tunnel route dns "$TUNNEL_ID" link.example.com
sudo systemctl restart cloudflared
```

To keep Cloudflare from caching share content, add a Cache Rule for
`link.madhur.dev` (and `madhur.dev/d/*`) with caching bypassed. The origin
already sends `no-store`, so this is defence in depth.

## Configuration

Every setting is an environment variable; see `.env.example`. The ones that
matter most:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | The single administrator account |
| `SESSION_SECRET` | generated | Signs admin sessions and share tokens |
| `MAX_BATCH_BYTES` | `20000000000` | Largest single batch |
| `STORAGE_LIMIT_BYTES` | `20000000000` | Ceiling on all active data at once |
| `SHARE_EXPIRY_HOURS` | `24` | Share lifetime |
| `INCOMPLETE_UPLOAD_TIMEOUT_HOURS` | `2` | Idle time before an unfinished upload is swept |
| `CHUNK_SIZE_BYTES` | `16777216` | Upload chunk size |
| `LOG_MAX_SIZE_MB` | `50` | Total retained log size across all generations |
| `RATE_LIMIT_FACTOR` | `1` | Multiplies every rate-limit ceiling; raise only to run the test suite |

`.env` is git-ignored and must never be committed.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/uploads` | Declare a batch, receive a session + token |
| `GET` | `/api/uploads/:id` | Which chunks have arrived (resume) |
| `PUT` | `/api/uploads/:id/files/:fileId/chunks/:index` | Upload one chunk |
| `POST` | `/api/uploads/:id/complete` | Verify and publish the share |
| `DELETE` | `/api/uploads/:id` | Abandon an unfinished upload |
| `GET` | `/api/s/:id` | Share metadata (files hidden until unlocked) |
| `POST` | `/api/s/:id/auth` | Unlock a password-protected share |
| `GET` | `/d/:id/:fileId` | Download one file (ranges supported) |
| `GET` | `/api/health` | Liveness + dependency check |
| `/api/admin/*` | | Dashboard: overview, shares, delete, logs, health, cleanup |

## Tests

The acceptance suite lives outside the image and runs against a disposable
container. Start one with `RATE_LIMIT_FACTOR=500` (the suite makes far more
requests than a person would) and point the scripts at it:

```bash
docker run -d --name filedrop-test -p 127.0.0.1:8142:8140 \
  -e ADMIN_USERNAME=testadmin -e ADMIN_PASSWORD='<throwaway>' \
  -e RATE_LIMIT_FACTOR=500 -v filedrop-test-data:/data filedrop:latest

BASE=http://127.0.0.1:8142 CREDS='{"username":"testadmin","password":"<throwaway>"}' \
  node scripts/test.mjs        # uploads, downloads, limits, security, admin
node scripts/test-expiry.mjs   # expiry, hard delete, ID reuse, restart persistence
node scripts/test-limits.mjs   # rate limiting and brute-force lockout
node scripts/test-logrotate.mjs
node scripts/test-bigfile.mjs   # 5 GB round trip against the production instance
```

`test-bigfile.mjs` pushes a real 5 GB file through the chunk pipeline and hashes
it back. Last run: 320 chunks at ~61 MB/s, container RSS peaked at 99 MB of its
1 GB limit, verify+fsync 0.5 s, byte-for-byte match, and a range read at the
5 GB mark. Set `SIZE` to try a different size — a full 20 GB run would take the
host disk close to full without testing anything the 5 GB run does not.

`test-expiry.mjs` expects a container started with short windows
(`SHARE_EXPIRY_HOURS=0.00333333`, `INCOMPLETE_UPLOAD_TIMEOUT_HOURS=0.00333333`,
`CLEANUP_INTERVAL_SECONDS=3`) so a full lifecycle fits into a minute.

## Not included (v1.0)

User accounts, ZIP downloads, user-initiated deletion, end-to-end or at-rest
encryption, file-type restrictions, a public API, email notifications, and
multiple administrators.
