# Security Model

This document describes the security controls of the private Sai Hardware Items
Catalogue, the assumptions behind them, and the known limitations. The latest
automated results are in [SECURITY-REPORT.md](SECURITY-REPORT.md).

## Goal

The catalogue is private. Only two kinds of people can read it:

1. The administrator account.
2. Viewer accounts that the administrator approved, or that were approved after
   the registrant verified the registered email address.

Everyone else — including anyone who knows a URL — gets the public landing
page at `/`, a redirect to `/login` for catalogue pages, and `401` for API
calls. No catalogue data, images, source files, or database files are reachable
anonymously.

## Assets

- Catalogue contents (207 items, 11 categories) and uploaded product images.
- User accounts, password hashes, roles, and approval status.
- Session identifiers and the session signing secret.
- The security event log.
- The Firebase service account key and the Firestore data it can read/write.

## Controls

### Authentication

- Passwords hashed with **bcrypt, cost 12**. Plaintext is never written to the
  database, logs, or API responses.
- Password policy: 12–128 characters, at least three of lowercase/uppercase/
  digits/symbols, enforced server-side (and mirrored in the UI).
- Usernames: 3–32 characters from `[A-Za-z0-9_.-]`, case-insensitive uniqueness.
- New registrations require a unique, valid email address (stored lowercase);
  sign-in accepts either the username or that address.
- Unknown-user sign-ins run a dummy bcrypt comparison to reduce timing leaks and
  return the same generic error as a wrong password.
- **Account lockout:** 5 consecutive failures lock the account for 15 minutes.
  A successful sign-in clears the counter.
- **Rate limiting:** 10 sign-in attempts per 15 minutes per IP (successful
  requests skipped), 5 registrations per hour per IP, 5 reset requests per hour
  per IP, 10 reset-token attempts per 15 minutes per IP, and 600 API requests
  per 15 minutes per IP.
- Session fixation is prevented by regenerating the session ID on sign-in.
- Password changes require the current password and revoke every other session
  of that user.
- **Password recovery:** `/forgot-password` returns the same generic answer for
  known and unknown email addresses. For a real account it emails a 6-digit
  code generated with `crypto.randomInt`. Only an HMAC-SHA256 digest keyed with
  `SESSION_SECRET` is stored, so a Firestore leak cannot be brute-forced
  offline. Codes expire after 10 minutes, allow five attempts, and resend at
  most once per minute; a failed send clears the code. Verifying the code
  proves mailbox control and is the **only** point where a pending account is
  approved; rejected and revoked accounts are never reactivated. The verified
  code is exchanged for a 256-bit one-time token whose SHA-256 digest is stored
  for 30 minutes. Consuming it clears the lockout and revokes every existing
  session. Administrators can still issue a link from `/admin` for viewer
  accounts without email. Administrator accounts may also use the emailed-code
  flow (an admin can attach the address from **Admin → Users** or with
  `npm run set-email`); sign-in still requires the authenticator code, so
  mailbox control alone cannot open an admin session. The host-side
  `reset-admin` command remains the fallback when no mailbox is reachable.

### Sessions

- Server-side sessions in Firestore (`sessions` collection) via a custom store
  with a short in-memory cache, so sessions survive restarts and are not kept
  only in process memory. Session touches are throttled to one Firestore write
  per five minutes per session.
- Cookie: `mh.sid`, `HttpOnly`, `SameSite=Strict`, `Secure` when configured,
  rolling 8-hour expiry. The cookie carries only an opaque ID.
- Sign-out destroys the server-side record and clears the cookie. A negative
  cache prevents a destroyed session from being recreated by a late request.
- Revoking or deleting a user, changing their password, or completing a
  password reset deletes that user's sessions immediately — including sessions
  written by an earlier process.

### Authorization

- Two roles, enforced in middleware on every route:
  - `admin`: catalogue edits, image uploads/deletes, user management, audit log.
  - `viewer`: read-only catalogue and image access.
- Anonymous `/` serves the public landing page; catalogue pages redirect
  (`/catalogue` → `/login`, `/admin` → `/login` or `/`), and API routes return
  `401`/`403`. UI hiding is cosmetic; the server is authoritative.
- Administrator accounts cannot be deleted, rejected, or revoked through the
  user-management API. Recovery is via `npm run reset-admin` on the host.

### CSRF and cross-origin writes

- Every state-changing API request requires an `X-CSRF-Token` header matching a
  per-session token (`crypto.randomBytes(32)`), compared in constant time.
- If an `Origin` header is present on a write, it must equal the configured
  `APP_ORIGIN` (or the request origin) exactly; otherwise `403`.
- Combined with `SameSite=Strict`, this blocks cross-site request forgery and
  drive-by form submissions.

### Input handling and injection

- All database access goes through Firestore document APIs with validated
  fields; no SQL exists in the codebase.
- Item input is trimmed, length-capped, type-checked, and range-checked
  (price 0–1,000,000,000, known category IDs, UUID image IDs).
- IDs are validated against strict numeric/UUID patterns before use.
- JSON bodies are limited to 32 KB, form bodies to 16 KB.

### Output handling and XSS

- API responses are JSON; catalogue rendering uses an `escapeHtml()` helper for
  every interpolated field, and admin DOM is built with `textContent`.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
  data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none';
  base-uri 'self'; form-action 'self'`. No inline scripts or event handlers.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY` (via frame-ancestors/frameguard),
  `Cross-Origin-Resource-Policy: same-origin`, restrictive `Permissions-Policy`.
- Pages are `Cache-Control: no-store`; authenticated images are `private`.

### File uploads

- Admin-only, one file per request, 2 MB limit, max 4 fields.
- Accepted types: JPEG, PNG, WEBP — verified by **magic bytes**, not the
  client-supplied MIME type or extension.
- Images stored as base64 chunks in Firestore (`images_meta/{id}/chunks/{n}`)
  with generated UUID ids; never written to a web-served directory and never
  executed.
- Read requires authentication; responses set the detected `Content-Type` and
  `nosniff`; image IDs are strict UUIDs (no traversal).

### Transport and headers

- Helmet with a strict CSP, HSTS when HTTPS mode is enabled, no `X-Powered-By`.
- Direct HTTPS support (`HTTPS=true` + `TLS_KEY`/`TLS_CERT`, TLS ≥ 1.2), or run
  behind a TLS-terminating reverse proxy.
- In production, cookies require HTTPS (`COOKIE_SECURE=true` by default).
- `TRUST_PROXY` must be enabled only when exactly one trusted proxy is in front,
  so client IPs (and therefore rate limits) are correct.

### Auditing and data protection

- Security events recorded with timestamp, type, username, IP, and detail:
  sign-in success/failure/lockout/block, logout, registration, approvals,
  rejections, revocations, deletions, item/image changes, password changes,
  rate limiting.
- Events older than 30 days and expired sessions are pruned automatically.
- The service account key, session secret, TLS material, and backups live under
  `data/` (git-ignored, owner-only permissions for secret files). `data.js`,
  `src/`, `views/`, `scripts/`, and `legacy/` are not served by Express.

## Tested

`npm run security-test` runs an isolated server against uniquely prefixed
Firestore collections and executes 64 checks covering:

- Public homepage (no catalogue data), canonical/robots/sitemap metadata,
  anonymous catalogue redirects, API 401s, generic 404s, health data hygiene.
- CSP, `nosniff`, no-referrer, `Permissions-Policy`, no `X-Powered-By`.
- Non-exposure of `data.js`, server source, `views/`, and database paths
  (including encoded traversal attempts).
- No inline scripts/handlers in protected markup.
- Generic sign-in errors for wrong password vs. unknown user.
- HttpOnly/SameSite cookies, session-ID rotation, remember-me lifetime.
- CSRF and cross-origin rejection.
- Admin CRUD, input validation, viewer 403s on writes and admin APIs.
- Order Tracking visibility, defaults, toggles, and invalid-status rejection.
- Image upload/read, anonymous image 401, magic-byte rejection, 413 oversize,
  traversal in image IDs.
- Registration validation, breached-password rejection, pending lockout,
  admin-only approval, viewer read-only access, admin-console redirect,
  immediate revocation, promote/demote rules.
- Account lockout after 5 failures, password change with session revocation,
  logout invalidation, revoke-all, login rate limiting.
- Generic forgot-password responses, email-code verification, approval of
  pending accounts only after the code is verified, Gmail sign-in, duplicate
  email rejection, admin-only reset-link issuance, single-use and expired
  tokens, reset-driven session revocation, and reset rate limits. The suite
  writes messages to a temporary outbox instead of sending real email.
- TOTP RFC 6238 vector, 2FA enrollment, enforced codes, one-time recovery
  codes, and password + code required to disable.
- IP auto-ban after repeated failures and admin unban.
- bcrypt-only credential storage in Firestore and presence of audit events.
- Generated admin passwords force a change and are never written to disk.

`npm run customer-test` adds 24 checks for the register and expiry engine,
including a 1,000-record pagination test, ownership isolation, CSV export, and
injection payload handling. Both suites wipe their prefixed collections when
they finish.

## Known limitations and accepted tradeoffs

- **Username enumeration on registration:** `409` reveals that a username is
  taken. This is a usability tradeoff for an invite/approval workflow; it does
  not reveal passwords or grant access.
- **Pending accounts are approved after email-code verification.** This is a
  deliberate policy: a registration plus control of the submitted mailbox is
  treated as sufficient proof. Someone who can read that mailbox can therefore
  activate an account without an administrator. Rejected and revoked accounts
  are never reactivated. If approval must remain a manual gate, change this
  policy before exposing registration publicly.
- **IP-based rate limits** can affect users behind a shared NAT, and a
  determined attacker with many IPs can still cause lockouts. Per-account
  lockout limits credential stuffing; monitor the event log.
- **Single-process design:** the in-memory working set, numeric id watermarks,
  and uniqueness indexes assume one writer process. Running multiple instances
  against the same Firestore project is not supported.
- **Write-behind window:** acknowledged writes are queued and flushed within
  ~100 ms; an abrupt process kill can lose the last uncommitted operations.
  Graceful shutdown flushes the queue.
- **Firestore free-tier quota:** 50k reads / 20k writes per day. Normal use is
  well below this; the test suites should not be run repeatedly in one day.
- **Password reset depends on SMTP:** if email delivery is down, self-service
  recovery stops and `password_reset_email_failed` alerts appear in the admin
  console. The administrator can issue a one-time link for accounts that have no
  email. If the sole administrator loses their password, host (or Cloud
  Functions console) access and `npm run reset-admin` are required.
- **Admin UI protects the sole admin** from deletion/demotion. If that password
  is lost, host access and `reset-admin` are required.
- **Audit log retention is 30 days** and the admin UI shows the latest 100
  events; use `npm run firestore-backup` if longer retention is required.
- **Uploaded images are not re-encoded server-side.** Magic-byte checks plus
  `nosniff` and authenticated delivery prevent browser execution, but image
  metadata (e.g. EXIF) is preserved.
- **No virus scanning** of uploaded images; uploads are admin-only.
- **Generated bootstrap passwords are printed once and never written to disk.**
  Copy the password from the console before it scrolls away.

## Deployment requirements

1. TLS termination with a valid certificate; HTTP redirected to HTTPS.
2. `NODE_ENV=production`, `COOKIE_SECURE=true`, fixed `SESSION_SECRET`,
   `APP_ORIGIN=https://your.domain`, `TRUST_PROXY=true` for one proxy hop.
3. Bind the app to loopback (`HOST=127.0.0.1`) behind the proxy, or firewall the
   app port.
4. OS-level access control on the project directory and `data/`; run as a
   dedicated low-privilege service account.
5. Owner-only permissions on the Firebase service account key; rotate it in the
   Firebase console if leaked.
6. Scheduled `npm run firestore-backup` exports and a copy of
   `data/session-secret`; test restores. On Cloud Functions, keep
   `SESSION_SECRET` in Secret Manager so sessions survive redeploys.
7. SMTP credentials (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
   `SMTP_PASS`, `MAIL_FROM`) belong in environment/secret configuration, never
   in source. Use an app password, not the mailbox's main password.
8. Deploy with Hosting rewrites and Firestore rules; run the function with
   `maxInstances: 1` because the store keeps a single-writer in-memory cache.
9. Keep Node.js and dependencies patched (`npm audit`, `npm outdated`).

## Reporting

This is a private internal application. Report suspected issues to the
administrator/owner directly; do not open public issues containing exploit
details, credentials, or catalogue data.
