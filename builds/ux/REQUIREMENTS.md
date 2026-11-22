# REQUIREMENTS — Sai Hardware Items (Steel Yard Ledger)

Version 2.0.0 · Node.js ≥ 22.5 · Express · Firestore · Firebase Functions/Hosting (Blaze, free allowances).

## 1. Catalogue (materials)

- R1.1 The catalogue is seeded once from a trusted local file (`data.js`, 10 categories / 207 items) only when the Firestore category collection is empty; the app adds the admin-only Orders category (11 categories / 207 items). User data is never overwritten.
- R1.2 Categories: id, name, ordering; one admin-only category **Orders** (display name; stable id `order-tracking`) with the statuses `to_order` / `completed`. Orders has its own `/orders` page in the top bar, like Customers/Admin.
- R1.3 Items: product, size/spec, price, unit, notes, image, per-category ordering. CRUD is admin-only; reads are open to signed-in users.
- R1.4 CSV export of the full catalogue (admin), guarded against CSV formula injection (`=`, `+`, `-`, `@` prefixed cells are neutralized), with UTF-8 BOM and audit logging.

## 2. Customers (register)

- R2.1 Per-user customer register: name, amount, bill number, date, village, book number, phone; one-calendar-month expiry computed server-side with month-end clamping.
- R2.2 Each signed-in user manages only their own records; admins can read every register (`?scope=all`) but mutations stay owner-checked.
- R2.3 CSV export of the register (own data; admins may export all), injection-guarded and audited.

## 3. Authentication & accounts

- R3.1 Session auth: HTTP-only cookies, opaque server-side sessions persisted in Firestore with an in-memory cache; signing secret from `SESSION_SECRET` or `data/session-secret`.
- R3.2 Passwords: bcrypt (cost ≥ 12), strength validation, rejection of passwords found in breach lists (top-N common-password check in `src/security.js`).
- R3.3 Brute-force defence: per-account lockout (5 failures → temporary lock), per-IP login rate limit, generic error messages, timing-equalized unknown-user path (dummy hash compare).
- R3.4 Forced first-login password change (`must_change_password`); generated/bootstrap passwords always have the flag set.
- R3.5 Remember-me extends session lifetime; show-password toggle in the UI.
- R3.6 Session management: revoke-all (kills every session incl. current); password changes and account revocation destroy the target's other sessions.
- R3.7 Registration requires a unique Gmail/email address; sign-in accepts either the username or that address.
- R3.8 Self-service password recovery asks for the registered email only, emails a 6-digit code (10-minute lifetime, 5 attempts, 60-second resend), verifies it, and then shows the new-password form. Codes are stored as an HMAC-SHA256 digest keyed with `SESSION_SECRET`; a verified code is exchanged for the existing single-use reset token. Responses are identical for known and unknown addresses.
- R3.9 A pending account is approved only after its emailed code is verified. Rejected and revoked accounts are never reactivated. Admin-issued reset links remain available for accounts without email.

## 4. Multi-admin management

- R4.1 Admins can promote/demote/disable/delete other users, but **never themselves** and never the last active admin.
- R4.2 Demotion/deletion/disabling destroys the target's sessions immediately.
- R4.3 Bootstrap admin is created from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env (or a generated password printed once to the console, never written to disk); legacy plaintext password files are deleted on boot.

## 5. Two-factor authentication (2FA)

- R5.1 TOTP (RFC 6238, SHA-1, 30 s, verified against the RFC test vector) implemented dependency-free in `src/totp.js`; secrets are stored in the user's Firestore document, which only the service account can read.
- R5.2 Enrollment flow: setup (QR/otpauth URI) → enable (verify a live code) → disable (password + TOTP re-confirmation).
- R5.3 Recovery codes: 8 single-use codes, stored as SHA-256 hashes, burned on use, regenerated on enable.
- R5.4 Escape hatch: `npm run reset-2fa` for a locked-out admin (requires server access; stop the server first).

## 6. Network hardening

- R6.1 CSRF: per-session token, required on every non-GET API call; same-origin guard on all mutating requests.
- R6.2 Helmet: strict CSP (`default-src 'self'`), `frame-ancestors 'none'`, no-referrer, HSTS when serving TLS.
- R6.3 Rate limits (env-configurable): API 600/min, login 10/15 min, register 5/h (defaults tightened in serve mode).
- R6.4 Fail2ban-style persistent IP bans: `IP_BAN_THRESHOLD` (default 20) auth failures within 24 h → 24 h ban persisted in Firestore (`ip_bans`); enforced by a first-of-pipeline guard; admin can list and lift bans. `0` disables.
- R6.5 Hardened server mode `npm run serve`: production NODE_ENV, binds 0.0.0.0:443, HTTPS from `data/tls/`, secure cookies, tighter defaults.
- R6.6 TLS certificate generator `npm run tls-cert` (self-signed, covers localhost, LAN IPv4 addresses, and `saihardwareitems.com`).

## 7. Data safety

- R7.1 Firestore is the only database; no local database file exists at rest.
- R7.2 Daily JSON export of every collection plus decoded images via `npm run firestore-backup`, rotation keeps 14 files under `data/backups/firestore/`.
- R7.3 Boot fails loudly when credentials are missing or Firestore is unreachable; writes are batched, retried, and flushed on graceful shutdown.
- R7.4 Recovery from a JSON export is performed through the Firebase Admin SDK/console; the export is a portable disaster-recovery artifact.

## 8. Observability

- R8.1 Security event log (30-day retention): logins, failures, 2FA events, exports, bans.
- R8.2 Admin alerts endpoint: suspected brute force (≥10 failures/IP/24 h), admin sign-ins from new IPs, recovery-code use, exports.
- R8.3 Admin summary with 2FA enrollment stats (`twoFactorAdmins` / `totalAdmins`).

## 9. Testing gates

- R9.1 `npm run customer-test` — 24 tests (register, ordering, exports, CSRF) must stay green.
- R9.2 `npm run security-test` — 64 tests (public homepage/SEO, auth, lockouts, email-code password reset, email-verified account approval, Gmail sign-in, 2FA, roles, bans, breach passwords, sessions) must stay green.

## 10. Deployment (all free)

- Primary: Firebase Cloud Functions (`asia-south1`, `maxInstances: 1`) behind Firebase Hosting at `https://saihardwareitems.web.app` (custom domain later). Hosting rewrites every request to the function; only the landing page is public.
- Local fallback: `npm run tls-cert && npm run serve` on port 443, or a container host (`Dockerfile` + `render.yaml`). Never run local and cloud instances against the same Firestore data at once.
- Email: SMTP relay configured through environment variables/secrets; Gmail app passwords are supported.
