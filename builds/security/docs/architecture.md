# Architecture

Sai Hardware Items (branded **Sri Sai Web — Sai Hardware Items**)
is a **modular monolith**: one Node.js process, one Firestore database, one
deployable — internally organized into domain modules. In production it runs as
a single Firebase Cloud Function (`functions/index.js`, `asia-south1`,
`maxInstances: 1`) behind Firebase Hosting; `server.js` remains the local
entrypoint. The decision and its tradeoffs are recorded in
[ADR 0001](adr/0001-modular-monolith-structure.md).

**Firestore is the only database.** There is no SQLite file, no local cache
database, and no fallback. The process keeps a small in-memory working set that
is loaded at boot and written back through a batched, retried queue.

## Component map

```
                    ┌──────────────────────────────────────────────┐
  HTTP(S) request   │                server.js (entrypoint)        │
 ──────────────────▶│  store.initialize() → createApp() → listen   │
                    └──────────────────────┬───────────────────────┘
                                           │ createApp()
                    ┌──────────────────────▼───────────────────────┐
                    │                src/app.js                    │
                    │  middleware pipeline, in fixed order:        │
                    │  helmet/CSP → body limits → IP-ban gate      │
                    │  → session → origin guard → identity         │
                    │  → password gate → rate limit → static       │
                    │  → routes → errors                           │
                    └──┬───────┬───────┬───────┬───────┬───────────┘
                       │       │       │       │       │
              pages    │  auth │ materials    │images │  admin /
                       │       │ customers    │export │  orders
                       ▼       ▼       ▼       ▼       ▼
                    src/routes/*.js        (domain APIs)
                       │       │       │       │       │
                       └───────┴───┬───┴───────┴───────┘
                                   ▼
          src/store.js  ◀──  src/security.js  ◀──  src/config.js
   (in-memory working     (CSRF, validation,   (env, paths, session
    set + write queue)     image sniffing)      secret)
                                   │
                                   ▼
                         src/firebase.js (Admin SDK)
                                   │
                                   ▼
                    Firestore: users, categories, items,
                    images_meta (+ chunks), customers,
                    security_events, ip_bans, sessions
```

Supporting modules: `src/paths.js` (`ROOT` / `DATA_DIR` shared by every module),
`src/firebase.js` (Admin SDK bootstrap), `src/store.js` (Firestore data layer,
write-behind queue, sessions), `src/session-store.js` (Firestore-backed
`express-session` store), `src/async-handler.js` (promise → Express error
middleware), `src/totp.js` (dependency-free TOTP two-factor authentication),
`src/mailer.js` (SMTP delivery of recovery codes; test outbox), and
`src/expiry.js` (customer register expiry engine).

## Request lifecycle (security-critical order)

1. **Headers** — Helmet sets CSP (`default-src 'self'`; a per-request nonce
   authorises only the landing page JSON-LD), frame denial, no-referrer;
   `Permissions-Policy` and `Cross-Origin-Resource-Policy` are added explicitly.
   A host gate then 301-redirects `www` to the canonical apex and marks every
   other hostname `X-Robots-Tag: noindex, nofollow`.
2. **Body limits** — JSON capped at 32 KB, form bodies at 16 KB.
3. **IP-ban gate** — banned IPs are rejected with a generic 403 before any
   parsing or session work.
4. **Session** — Firestore-backed store, `mh.sid` cookie (HttpOnly,
   `SameSite=Strict`, Secure in production, rolling 8-hour expiry).
5. **Origin guard** — cross-origin state-changing requests are rejected 403.
6. **Identity** — `loadCurrentUser` resolves `req.user` from the in-memory user
   map; stale user IDs are cleared. `enforcePasswordChange` then blocks every
   non-exempt write for accounts flagged `must_change_password`.
7. **Rate limit** — 600 requests / 15 min per IP across `/api`.
8. **Static** — `public/` assets only; protected HTML lives in `views/`.
9. **Routes** — each route applies its own guards (`requireAuth`,
   `requireAdmin`, CSRF token, per-route login/register/forgot/reset limiters)
   and its own `Cache-Control`.
10. **Errors** — generic 404 (JSON for `/api/*`), and a terminal error handler
    that never leaks internals (500s are logged, not echoed).

## Data model (Firestore collections)

Document IDs are numeric strings for record collections (`"1"`, `"2"`, …) and
natural keys for the rest. Fields are snake_case in Firestore and camelCase in
the JSON API.

| Collection | Purpose |
|---|---|
| `users` | Accounts: unique lowercase email, role (`admin`/`viewer`), status (`pending`/`active`/`rejected`/`revoked`), bcrypt hash, lockout counters, TOTP secret + hashed recovery codes, reset-request timestamp, HMAC-hashed email code + expiry/attempts/sent-at, and hashed one-time reset token + expiry |
| `categories` | 11 categories, including the admin-only `order-tracking` category shown as **Orders** |
| `items` | 207 materials, ordered per category; `order_status` only for Orders |
| `images_meta` | Image metadata (`mime`, `bytes`, `chunk_count`) |
| `images_meta/{id}/chunks/{n}` | Base64 image bytes in ≤600k-character chunks (kept below the 1 MiB document limit) |
| `customers` | Customer register: per-user records with a one-calendar-month expiry (`src/expiry.js`) |
| `security_events` | Audit trail (30-day retention), numeric ids |
| `ip_bans` | Active fail2ban-style IP bans (document id = IP) |
| `sessions` | Server-side sessions so sign-ins survive restarts |

All reads go through `src/store.js`; route modules never talk to the SDK
directly. Images are the only exception that reads subcollections, and they do
so through store helpers.

## Consistency and write path

- **Boot** — `store.initialize()` loads every collection into memory (and
  prunes expired bans, old events, and expired sessions), then seeds the
  catalogue and bootstraps the administrator if needed. The listener starts
  only after this completes; a boot failure is fatal and loud.
- **Reads** — served from memory, so HTTP handlers never wait on the network.
- **Writes** — update memory first, then enter a single write queue. The queue
  coalesces later writes to the same document, commits batches of up to 400
  documents within ~100 ms, and retries failed commits. Graceful shutdown
  flushes the queue before exiting. On Cloud Functions (`K_SERVICE` set, or
  `FLUSH_ON_RESPONSE=true`) the queue is also flushed before each response, so
  a scale-to-zero instance cannot acknowledge a write that never lands; local
  bulk tests keep the faster write-behind path.
- **Ids** — numeric watermarks start at the highest id loaded at boot plus one.
  Firestore batches are atomic, so ids handed out by a crashed process either
  committed (and will be loaded next boot) or were never visible; committed
  ids are never reused.
- **Uniqueness** — username and per-owner bill number are enforced by in-memory
  indexes rebuilt at boot. This is valid because the deployment is a single
  process; the watchdog never starts a second server while one is healthy.
- **Sessions** — persisted in `sessions/{sid}` with an in-memory cache and a
  negative cache that prevents a revoked session from being resurrected by a
  late request. `touch` writes are throttled to one per five minutes per
  session to protect the free write quota. Revoking a user's sessions queries
  Firestore as well, so sessions created before a restart are revoked too.

## Test isolation

`FIRESTORE_PREFIX` prefixes every collection name (`<prefix>_users`,
`<prefix>_items`, …). `scripts/firestore-test-utils.js` generates a unique
prefix per suite/server, polls for writes to land, and wipes the prefixed
collections with `recursiveDelete` afterwards. Production collections are never
touched, and the suites can run in parallel.

## Trust boundaries

- **Anonymous visitors:** can reach the public landing page at `/`, `/login`,
  `/register`, `/forgot-password`, `/reset-password`, `/robots.txt`,
  `/sitemap.xml`, and `/api/health`. Catalogue pages redirect to `/login` and
  API routes return 401. Recovery codes and reset tokens are single-use and
  expiring; the request form returns a generic answer, and only a verified
  email code approves a pending account (rejected/revoked accounts stay
  blocked).
- **Viewers:** read-only; all writes and admin APIs return 403.
- **Administrator:** full control through the UI/API, but the admin account
  itself cannot be changed or deleted through the API — host-side recovery
  only (`npm run reset-admin`).
- **Filesystem:** only `public/` is statically served; `views/`, `src/`,
  `data/`, `data.js`, `scripts/`, and `legacy/` are not web-reachable. The
  service account key is never served.

## Deployment model

- **Primary:** Firebase Hosting rewrites `**` to the `api` Cloud Function.
  `functions/index.js` sets `asia-south1`, 512 MiB, 60 s timeout,
  `maxInstances: 1`, `concurrency: 40`, and binds `SESSION_SECRET` from Secret
  Manager. Application Default Credentials replace the key file. The function
  flushes queued writes before responding and scales to zero when idle.
- **Local / self-hosted fallback:** one process behind a TLS-terminating proxy
  (or native TLS via `HTTPS=true` + `TLS_KEY`/`TLS_CERT`).
- Configuration is environment-only (see `.env.example`); the server does not
  auto-load `.env`.
- Locally, the service account key is the only required secret besides
  `SESSION_SECRET`. On hosts without a persistent disk, pass it as
  `FIREBASE_SERVICE_ACCOUNT_JSON`; on Cloud Functions ADC needs neither.
- No persistent disk is required for application data; `data/` holds TLS
  material, logs, the session secret, and JSON backups.

## Operability

| Concern | Mechanism |
|---|---|
| Health | `GET /api/health` (no sensitive data) |
| Audit | `security_events` collection, visible in `/admin`; 30-day retention |
| Inventory | `npm run firestore-status` — project, credentials, prefix, per-collection counts |
| Recovery | `npm run reset-admin` (host access required; stop the server first) |
| 2FA recovery | `node scripts/reset-2fa.js <username>` |
| Verification | `npm run security-test` — 64 checks; `npm run customer-test` — 24 checks |
| Data backup | `npm run firestore-backup` — JSON export (all collections + decoded images) under `data/backups/firestore/`, 14-file rotation |
| Availability | Firebase Hosting + Cloud Functions scale to zero and cold-start on demand; locally, `scripts/watchdog.js` checks HTTPS health and restarts the server/tunnel |
| Email | SMTP via `SMTP_*` / `MAIL_FROM`; failed sends raise a `password_reset_email_failed` admin alert |

## What this architecture deliberately does NOT include

- **No SQLite or local database** — all state lives in Firestore; the
  in-memory working set is a cache, never a second source of truth.
- **No separate services** — the evidence for splitting (independent releases,
  separate scaling shapes, distinct ownership) does not exist; see ADR 0001.
- **No multi-instance horizontal scaling** — the working set, id watermarks,
  and uniqueness indexes assume one writer process. Scale up first; a
  multi-instance design would need transactional counters and distributed
  locks.
- **No Firebase Storage** — product images are chunked Firestore documents, so
  the deployment needs only Firestore, Functions, and Hosting. Cloud Functions
  requires Blaze; ordinary usage stays inside the free monthly allowances.
- **No third-party auth or email SaaS SDK** — recovery codes are sent through
  plain SMTP (a Gmail app password is enough). There is no dependency on a
  specific mail provider. TOTP two-factor authentication and one-time recovery
  codes are implemented for the administrator; a lost admin password still
  requires host/console access and `reset-admin`.

## Risks

| Risk | Mitigation |
|---|---|
| Middleware reorder silently weakens security | Order is documented here; the security suite covers its effects |
| Abrupt process kill loses the last ~100 ms of queued writes | Short flush interval, coalesced retries, graceful-shutdown flush; no acknowledged operation waits on the queue |
| Firestore free-tier quota (50k reads / 20k writes per day) | Reads are served from memory; session touches are throttled; tests use throwaway prefixes and are not meant to be run repeatedly in one day |
| Service account key compromise | Owner-only file permissions; `data/` git-ignored; prefer `FIREBASE_SERVICE_ACCOUNT_JSON` on hosts without disks; rotate in the Firebase console if leaked |
| Session secret loss | Persisted under `data/` (0600) locally; stored in Secret Manager on Cloud Functions. Back it up or expect everyone to sign in again (and outstanding OTP digests to stop matching) |
| Single-writer assumption violated (two servers) | The watchdog checks health before starting another process; do not run a second copy against the same project |
| Route modules accidentally coupling to each other | Conventional rule: routes depend only on `store`, `config`, `security`, and `middleware` |

## Success metrics

- `npm run security-test`: **64/64** checks pass after every change.
- `npm run customer-test`: **24/24** checks pass after every change.
- Any behavioral change (route, middleware, header) must land together with a
  passing suite run — the report date in `SECURITY-REPORT.md` is the record.
