# Steel Yard Ledger — backend

Express 4 backend for the Steel Yard Ledger web app (catalogue, customers,
admin, auth, landing page). Everything runs locally against Firestore via
firebase-admin; there is no local database fallback.

## Requirements

- Node.js ≥ 22.5 (see `engines` in `package.json`)
- Firestore access via firebase-admin — provide one of:
  - `data/firebase-service-account.json` (default local location), or
  - `FIREBASE_SERVICE_ACCOUNT_PATH` / `FIREBASE_SERVICE_ACCOUNT_JSON`
    (hosting platforms), or
  - Application Default Credentials when running inside Google Cloud
    (`K_SERVICE`/`FUNCTION_TARGET`/`FIREBASE_CONFIG` set, e.g. Cloud Functions).

## Running

```bash
# From the app root:
cd steel-yard-ledger\builds\backend
npm start
```

or:

```bash
node builds\backend\server.js
```

- HTTP listener: `http://127.0.0.1:3000` (override with `HOST` and `PORT`).
- `node_modules` is included in the build — no `npm install` needed.
- On boot: Firestore data loads, the catalogue seeds from `data.js` when the
  database is empty, an administrator account is created/checked
  (`ADMIN_USERNAME`, or a generated password logged to the console on first
  boot) and the process announces the database summary.
- Graceful shutdown: SIGINT / SIGTERM flush pending writes and exit.

## Health and observability

- `GET /health` and `GET /api/health` — process, backing-store and metrics
  status (a live Firestore `get()` check, so a hung DB is reported as
  degraded).
- `GET /api/metrics` (admin) — request/error counters, per-route latency
  histograms (p50/p95/p99), all from `src/observability/metrics.js`.
- Every request emits a structured access log line (JSON) with the request ID.
- `X-Request-ID` response header on every response; error responses also
  carry a `requestId` field for correlation with the logs.

## Key backend features

- **Idempotency.** Mutating requests carry an `Idempotency-Key`; retries
  replay the stored response instead of re-executing the write (409 on key
  reuse with a different request). Without a client key, a key is
  auto-generated from the request hash so identical retries dedupe.
  Entries expire after 24 h (`IDEMPOTENCY_MAX_AGE_SECONDS`).
- **Pagination.** List endpoints paginate (`page`/`limit` params,
  `Link` response headers with `rel="next"`/`rel="prev"`/`rel="last"`, plus
  `total`/`hasMore`/`nextPage`/`prevPage` in the body). Implemented on
  `/api/materials` (flat `items` stream, plus the grouped `categories`
  view), `/api/customers`, `/api/admin/users` and `/api/admin/security-events`.
- **Caching.** Strong ETags + `If-None-Match` → 304 for GET/HEAD;
  `Cache-Control` policies per endpoint (catalogue public, customers
  private). Read-heavy catalog/admin responses are served from the
  in-memory TTL cache in `src/cache.js`.
- **Security headers.** Helmet (CSP with nonces, HSTS, frame protection,
  nosniff, …) plus CORS allowlist, same-origin guards for state changes,
  session-bound CSRF tokens, rate limiting with `Retry-After` /
  `X-RateLimit-*` headers, and fail2ban-style IP bans.
- **Observability.** Structured JSON logs (access + errors with request IDs
  and stacks), request metrics with latency histograms, and the admin
  `/api/metrics` endpoint.
- **Retry-safe writes.** `src/store.js` wraps commit with
  `withRetry()` (transient Firestore errors retried with backoff); the
  idempotency middleware makes client retries safe; writes update memory
  first and are flushed to Firestore in atomic batches.

## Environment

- `PORT`, `HOST` — listen address (default `127.0.0.1:3000`).
- `CORS_ORIGIN` — comma-separated allowlist for cross-origin requests.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — bootstrap admin account.
- `FIRESTORE_PREFIX` — test isolation for collections (per-collection prefix).
- `IDEMPOTENCY_MAX_AGE_SECONDS` — idempotency replay window (default 86400).
- `SMTP_*` — password-recovery mailer settings (optional; login codes may
  fail without it).

See `docs/api.md` and `docs/architecture.md` for the API surface and module
layout.
