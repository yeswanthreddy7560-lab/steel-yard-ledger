# Steel Yard Ledger — Alpha

**Live:** <https://steel-yard-ledger.fly.dev> (Fly.io; `/api/health` returns `200`).

A **private** web application for the material and hardware master list (215
items in the seed data, 217 in the live Firestore catalogue). Nothing is
publicly readable: the catalogue is served only to signed-in users, and new
accounts stay locked until an administrator approves them or the registrant
proves control of the registered Gmail address with an emailed code.

The public homepage is indexable and submits `sitemap.xml`; every authenticated
page is `noindex` and blocked in `robots.txt`. Deployment and Google Search
Console steps are in [docs/DEPLOY-FLY.md](docs/DEPLOY-FLY.md).

The original static, browser-only version is preserved in `legacy/` for
reference. It is not served by the application.

**Firestore is the only database.** There is no SQLite file, no local database,
and no fallback: the process loads its working set from Firestore at boot and
writes changes back through a batched, retried queue.

## Contents

- [Agent team](docs/AGENTS.md)
- [Live deployment](docs/DEPLOY-FLY.md)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [First sign-in](#first-sign-in)
- [Access workflow](#access-workflow)
- [Features](#features)
- [Project layout](#project-layout)
- [Architecture](docs/architecture.md)
- [Configuration](#configuration)
- [Security](#security)
- [Testing](#testing)
- [Production checklist](#production-checklist)
- [Administrator recovery](#administrator-recovery)
- [Data and backups](#data-and-backups)
- [Detailed requirements (REQUIREMENTS.md)](REQUIREMENTS.md)

## Requirements

- **Node.js 22.5 or newer.** Tested on Node.js 25.8.
- A **Firebase project** with Firestore enabled. Running locally on the
  Firestore free quota is possible on the Spark plan; deploying the Node server
  to **Cloud Functions + Hosting** requires the **Blaze plan** (a card is
  required, but the free monthly allowances still apply to ordinary use).
- A Firebase **service account key** (Project settings → Service accounts →
  Generate new private key) placed at `data/firebase-service-account.json`, or
  supplied through `FIREBASE_SERVICE_ACCOUNT_PATH` /
  `FIREBASE_SERVICE_ACCOUNT_JSON`. On Cloud Functions the runtime uses
  Application Default Credentials automatically.
- An **SMTP mailbox** (a Gmail app password works) for self-service password
  recovery. Without it, recovery falls back to admin-issued links.
- Windows, macOS, or Linux. No build step.

## Quick start

```powershell
cd steel-yard-ledger
npm install
npm start
```

Then open <http://127.0.0.1:3000>. Anonymous visitors see the public landing
page; **Sign in** leads to the catalogue. Signed-in users see the catalogue at
`/` (and `/catalogue`).

On first run the server:

1. Connects to Firestore (it refuses to start without credentials).
2. Seeds the catalogue from `data.js` (10 categories / 207 items) and adds the
   admin-only **Orders** category, giving 11 categories / 207 items.
3. Creates the administrator account. If `ADMIN_PASSWORD` is not provided, a
   strong password is generated and printed **once** to the console. It is
   never written to disk, and the account must change it at first sign-in.

To choose the password up front instead:

```powershell
$env:ADMIN_PASSWORD = "YourStrongPassword#2026"
npm start
```

The password must be 8–128 characters. All symbols are allowed.

## First sign-in

1. Sign in as `admin` with the password from the console output or the
   `ADMIN_PASSWORD` you supplied.
2. Change the password immediately if it was generated.
3. Open **Administration** in the header and approve or reject pending access
   requests.
4. Enable two-factor authentication from the **Change password** dialog
   (administrators only) and store the recovery codes safely.

## Access workflow

| Step | Who | What happens |
|---|---|---|
| 1 | Visitor | Opens `/register` and submits a username, Gmail address, and strong password. |
| 2 | System | Account is created with status `pending`. Sign-in is refused with HTTP 403 until an administrator approves it or the user verifies the registered Gmail address on `/forgot-password`. |
| 3 | Administrator | Reviews the request under **Administration → Users & access requests** and approves, rejects, or later revokes it. |
| 4 | Approved viewer | Can sign in and browse/search/sort the catalogue. Cannot edit, upload, or reach `/admin`. |
| 5 | Administrator | Can add, edit, and delete items, upload product pictures, manage users and orders, and read the security event log. |

Revoking or deleting an account invalidates its sessions immediately, including
sessions stored in Firestore by an earlier process.

## Features

- Private catalogue with **no anonymous access** to pages, JSON, or images.
- Role-based access: `admin` (full control) and `viewer` (read-only).
- Admin-only **Orders** view backed by the `order-tracking` category.
- Registration with administrator approval; re-approval after revocation.
- Sessions persisted in Firestore, so sign-ins survive restarts and revocations
  are effective across restarts.
- Account lockout after 5 failed sign-ins, plus IP rate limiting and an
  automatic 24-hour IP ban after repeated failures.
- Self-service password recovery by **Gmail one-time code**: enter the
  registered address, receive a 6-digit code (valid 10 minutes, 5 attempts,
  60-second resend), verify it, and choose a new password on a **separate
  page**. This works for viewers and administrators alike; administrator
  sign-in still requires the authenticator code afterwards. A pending account
  is approved only after the code is verified, proving control of the mailbox;
  rejected and revoked accounts stay blocked. Administrator-issued single-use
  links remain available for viewer accounts without email.
- Sign-in accepts either the username or the registered Gmail address.
- Catalogue search, category filter chips, sorting, and responsive cards.
- Admin item editor shows the edited product's current category and remembers
  the last category used when adding new items.
- Admin item editor with optional product image upload (JPEG/PNG/WEBP, 2 MB).
  Photos are automatically centre-cropped to a 4:3 frame, and the catalogue
  renders every image in that same frame so cards stay aligned.
- Customer register with one-calendar-month expiry, search, filters, CSV export.
- Security event log (sign-ins, failures, approvals, changes, rate limits).
- Admin-only **AI assistant** (`/ai-agent`): an offline, in-process assistant
  that answers questions about the catalogue, customers, accounts, orders, sales
  and security events. No external API or API key. The page, navigation link and
  floating launcher are hidden from viewers, and both API routes reject them
  with `403`.
- Strict CSP, HSTS in HTTPS mode, `nosniff`, frame denial, no-referrer.
- Print-friendly catalogue styles.

## Project layout

```
steel-yard-ledger/
├── server.js               Entrypoint: load Firestore, HTTP(S) listener, shutdown
├── start.js                Compatibility launcher (requires server.js)
├── src/
│   ├── app.js              Application factory (middleware order, wiring)
│   ├── config.js           Environment, paths, session secret
│   ├── paths.js            ROOT / DATA_DIR
│   ├── firebase.js         Firebase Admin bootstrap
│   ├── store.js            Firestore data layer, write-behind queue, sessions
│   ├── security.js         CSRF, origin guard, validation, OTP hashing
│   ├── mailer.js           SMTP delivery (test outbox when NODE_ENV=test)
│   ├── session-store.js    Firestore-backed express-session store
│   ├── async-handler.js    Promise → Express error middleware helper
│   ├── expiry.js           Customer register expiry engine
│   ├── totp.js             TOTP + recovery codes
│   ├── middleware/
│   │   ├── auth.js         Authentication and RBAC guards
│   │   └── rate-limit.js   IP rate limiters
│   └── routes/
│       ├── pages.js        Pages + health endpoint
│       ├── auth.js         Authentication API
│       ├── materials.js    Catalogue API
│       ├── customers.js    Customer register API
│       ├── export.js       CSV exports
│       ├── images.js       Image upload/serve API
│       └── admin.js        Administration API
├── docs/
│   ├── architecture.md     Architecture blueprint (components, data, risks)
│   ├── api.md              Endpoint reference and environment variables
│   └── adr/
│       └── 0001-modular-monolith-structure.md   Structure decision record
├── functions/
│   └── index.js            Cloud Functions entry (asia-south1, maxInstances 1)
├── firebase.json           Hosting rewrite to the function, headers, rules
├── firestore.rules         Deny-all client access; Admin SDK only
├── views/                  HTML rendered by the app (public landing + protected pages)
├── public/                 Static assets (robots.txt, sitemap.xml, CSS, fonts)
├── scripts/
│   ├── security-test.js    Automated security suite (64 checks)
│   ├── customer-test.js    Customer register suite (24 checks)
│   ├── firestore-test-utils.js  Prefix isolation / credentials / cleanup
│   ├── firestore-backup.js Free JSON backup of Firestore
│   ├── firestore-migrate.js Connection + collection inventory
│   ├── reset-admin.js      Administrator password recovery
│   ├── reset-2fa.js        Emergency 2FA disable
│   ├── watchdog.js         Health watchdog + tunnel restart
│   ├── run-hidden.vbs      Hidden Windows launcher for scheduled tasks
│   └── serve.js            Hardened production launcher
├── data.js                 Seed dataset (read at startup, not served)
├── legacy/                 Original static app, kept for reference
├── data/                   Runtime data (service account, TLS, logs) — git-ignored
├── .env.example            Configuration reference
├── REQUIREMENTS.md         Functional, security, and operational requirements
└── SECURITY.md             Security model and known tradeoffs
```

## Configuration

All settings are environment variables. See `.env.example` for a full template.
`npm run serve` loads a root `.env` automatically (existing environment
variables win); `npm start` does not, so use `node --env-file=.env server.js`
there. Firebase Functions reads the same `.env` at deploy time.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP(S) port |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` only behind a trusted network/proxy |
| `NODE_ENV` | — | `production` enables secure-cookie defaults |
| `DATA_DIR` | `./data` | Directory for the service account, TLS certs, logs, and JSON backups |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `DATA_DIR/firebase-service-account.json` | Service account key file |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | — | Full service account JSON (hosting platforms) |
| `FIRESTORE_PREFIX` | — | Collection-name prefix; tests use it for isolation |
| `SESSION_SECRET` | auto-generated | 32+ char session signing secret; persisted to `DATA_DIR/session-secret` when omitted |
| `COOKIE_SECURE` | `true` in production | Require HTTPS for cookies |
| `HTTPS` | `false` | Serve TLS directly from Node |
| `TLS_KEY` / `TLS_CERT` | — | PEM files; enables HTTPS when both are set |
| `TRUST_PROXY` | `false` | Trust one reverse-proxy hop (needed for correct client IPs) |
| `APP_ORIGIN` | request-derived | Exact public origin expected on API writes |
| `CANONICAL_HOST` | `steel-yard-ledger.fly.dev` | Apex hostname that is indexable; `www` redirects here and other hosts get `X-Robots-Tag: noindex` |
| `CANONICAL_ORIGIN` | `https://CANONICAL_HOST` | Absolute origin used for canonical URLs, Open Graph, JSON-LD, and the sitemap |
| `REGISTRATION_ENABLED` | `true` | Allow new access requests |
| `ADMIN_USERNAME` | `admin` | Bootstrap administrator username |
| `ADMIN_PASSWORD` | generated | Bootstrap administrator password (8–128 characters, any symbols) |
| `API_RATE_LIMIT` / `LOGIN_RATE_LIMIT` / `REGISTER_RATE_LIMIT` | `600` / `10` / `5` | Per-IP limits |
| `FORGOT_RATE_LIMIT` / `RESET_RATE_LIMIT` | `5` / `10` | Password-reset request and attempt limits per IP |
| `RESET_OTP_TTL_SECONDS` | `600` | Lifetime of an emailed 6-digit code (1–3600) |
| `RESET_TOKEN_TTL_SECONDS` | `1800` | Lifetime of the one-time token exchanged for a verified code (or an admin link) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | — / `465` / `true` on 465 | SMTP relay; Gmail uses `smtp.gmail.com` with an app password |
| `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | — | SMTP login and From address; all three (plus host/port) are required for email |
| `IP_BAN_THRESHOLD` | `20` | Failed sign-ins in 24 h before the IP is banned |

> **Secure cookies:** if `COOKIE_SECURE=true` and you serve plain HTTP,
> sign-in will not work. Either run HTTPS or set `COOKIE_SECURE=false` for local
> testing only.

## Security

Highlights (details in [SECURITY.md](SECURITY.md)):

- bcrypt (cost 12) password hashing; passwords never stored or logged in plaintext.
- Firestore-backed sessions with HttpOnly, SameSite=Strict cookies and
  session-ID rotation on sign-in.
- CSRF token required on every state-changing API request, plus an Origin check.
- Validated input everywhere; no SQL is involved (Firestore documents only).
- Upload validation by magic bytes, not just MIME type; 2 MB cap; images served
  with `nosniff` only to authenticated users.
- Helmet CSP (`default-src 'self'`, no inline scripts), frame denial, no-referrer,
  `X-Content-Type-Options: nosniff`, `X-Powered-By` removed.
- Sign-in rate limit (10 per 15 min per IP) and per-account lockout (5 failures →
  15 minutes); registration limit (5 per hour per IP); reset-request and
  reset-attempt limits.
- Password-reset codes are 6 digits generated with `crypto.randomInt`, stored
  only as an HMAC-SHA256 digest keyed with `SESSION_SECRET`, valid for 10
  minutes, limited to five guesses and one send per minute. The request form
  returns the same generic answer for known and unknown addresses. A verified
  code is exchanged for a 256-bit one-time token (stored as a SHA-256 digest,
  30-minute lifetime); consuming it revokes every session. Admin-issued links
  use the same token path.
- Admin-only user management and audit logging; the sole admin cannot be deleted
  through the UI.
- Protected HTML lives in `views/` and is only sent after an auth check; `data.js`,
  `src/`, the service account key, and the legacy app are not web-accessible.
- The service account key is a secret: keep it private and never commit it.

## Testing

```powershell
npm run unit-test
npm run ai-test
npm run customer-test
npm run security-test
npm run smoke-test
```

Both suites start isolated servers and write to **unique Firestore collection
prefixes** (`FIRESTORE_PREFIX`), so production data is never touched; the prefix
is wiped afterwards. They require the same service account as the app.

- `unit-test` — 16 assertions for validators, CSRF helpers and the offline
  assistant.
- `ai-test.js` — admin-only enforcement: anonymous/viewer `401`/`403` on both
  assistant APIs and the page, admin `200` on all three.
- `customer-test.js` — 24 checks: expiry rules, duplicate bills, validation,
  filters, pagination with 1,000 records, IDOR, CSV export, injection payloads.
- `security-test.js` — 64 checks: public homepage/robots/sitemap, anonymous
  access, headers, CSRF, origin checks, RBAC, uploads, lockout, rate limiting,
  emailed reset codes and tokens, email-verified pending-account approval,
  2FA, session revocation, IP bans, stored-hash audit, bootstrap-password
  handling. It writes `SECURITY-REPORT.md`.

Latest result: **24/24 customer checks and 64/64 security checks passed**.

> **Free-tier budget:** each suite seeds ~218 documents per server, and the
> 1,000-record test adds ~2,000 writes. Running both suites uses a few thousand
> Firestore writes. The free Firestore allowance (20k document writes per day)
> applies to Blaze as well; avoid repeated full runs on the same day.

## Production checklist

1. Deploy the function, Hosting rewrite, and Firestore rules:
   `npx firebase-tools@15.37.0 deploy --only functions,hosting,firestore:rules`.
   Cloud Functions requires the Blaze plan. See [docs/deploy.md](docs/deploy.md).
2. Store `SESSION_SECRET` in Secret Manager (`firebase functions:secrets:set
   SESSION_SECRET`); do not bake it into source. Set `SMTP_HOST`, `SMTP_PORT`,
   `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` for the function.
3. Keep the service account key at `data/firebase-service-account.json` with
   restrictive filesystem permissions (owner-only) when running locally. Cloud
   Functions uses Application Default Credentials and needs no key file.
4. For a self-hosted instance, terminate TLS at a reverse proxy or use the
   built-in HTTPS mode (`npm run serve` with `data/tls/key.pem` + `cert.pem`),
   set `NODE_ENV=production`, `APP_ORIGIN=https://your.domain`,
   `TRUST_PROXY=true` (one hop), and `COOKIE_SECURE=true`.
5. Change any generated bootstrap password immediately; it is printed once and
   never stored on disk.
6. Keep registration enabled only if you want to accept access requests;
   otherwise set `REGISTRATION_ENABLED=false`.
7. Run `npm run firestore-backup` on a schedule (see below) and
   `npm run security-test` after upgrades.
8. Never run the laptop server and the deployed function against the same
   Firestore data at the same time: each process keeps its own in-memory cache.
9. Send a real test code from `/forgot-password` after configuring SMTP; the
   admin security alerts show `password_reset_email_failed` when delivery breaks.

## Administrator recovery

An administrator can attach or change the recovery Gmail from **Admin → Users**
(the **Set email** button) and then use `/forgot-password`. This is also
available from the host when the admin cannot sign in:

```powershell
npm run set-email -- admin you@gmail.com
```

Stop the server first, then restart it so the change is loaded.

If the administrator password is lost or the account is locked, **stop the
server first** (the running process keeps its own in-memory copy), then run:

```powershell
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "NewStrongPassword#2026"
npm run reset-admin
```

Without `ADMIN_PASSWORD`, a random one is generated and printed once. The
command unlocks the account, ensures the admin role, and revokes all of that
user's sessions. Start the server again afterwards.

If the authenticator device is lost and no recovery codes remain:

```powershell
node scripts/reset-2fa.js admin
```

This disables 2FA for the account (never touches the password) and records the
reset in the audit trail.

## Data and backups

- **Firestore is the single source of record.** Users, catalogue, customers,
  security events, IP bans, sessions, and image metadata live in Firestore.
- The process keeps an in-memory working set loaded at boot. Writes are queued,
  coalesced, and committed in batches of up to 400 documents within ~100 ms;
  failed commits are retried. Graceful shutdown flushes the queue.
- Numeric ids and uniqueness rules (username, per-owner bill number) are
  enforced in memory from the data loaded at boot. This is a single-process
  application: never run two servers against the same Firestore data.
- Product images are stored as base64 chunks under `images_meta/{id}/chunks/{n}`,
  so the deployment needs only Firestore, Functions, and Hosting (no Storage
  bucket).
- `npm run firestore-backup` writes a JSON export (all collections + decoded
  images) to `data/backups/firestore/`, keeping the 14 newest files.
- `npm run firestore-status` prints the project, credential status, prefix, and
  per-collection document counts.
- To reset the catalogue: delete the `categories`, `items`, and `orders` data in
  the Firebase console (or use a fresh project), then restart the server.
  Seeding only runs when the category collection is empty.
- No `app.db` or other local database is created at any point.

## License / data

Private internal project. The catalogue contents come from the supplied
`material_hardware_master_table.txt` dataset (`data.js`).

## Before you run this (important)

The `data/` folder ships empty on purpose. Put your Firebase service-account
key at `data/firebase-service-account.json` (or set
`FIREBASE_SERVICE_ACCOUNT_JSON`), then run `npm install` and `npm start`.
The key, TLS keys and session secret from the earlier zip were removed. Rotate
that Firebase key (Firebase console -> Project settings -> Service accounts ->
Generate new private key, then delete the old one) because it was shared in a zip.
