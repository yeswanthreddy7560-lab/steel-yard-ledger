# API Reference — Steel Yard Ledger — Alpha v2

Base URL: `http://localhost:3000` locally, `https://steel-yard-ledger.fly.dev`
in production (or the hostname configured through `CANONICAL_ORIGIN`).
All routes are same-origin; there is no version prefix.

## Conventions

- **JSON** — every `/api/*` route exchanges JSON unless noted (CSV export routes return `text/csv`).
- **CSRF** — every state-changing request (`POST`/`PUT`/`DELETE`) must send the token from
  `GET /api/auth/session` as an `X-CSRF-Token` header. Missing/invalid token → `403`.
- **Sessions** — an `HttpOnly`, `SameSite=Strict` session cookie, persisted in
  Firestore. Default lifetime is short; passing `rememberMe: true` at login
  extends it to **30 rolling days**.
- **Roles** — `admin` (full control) and `viewer` (read-only). `requireAuth` routes accept both;
  admin-only routes return `403` for viewers.
- **Errors** — `{ "error": "<message>" }` with appropriate status (`400` invalid input,
  `401` unauthenticated, `403` forbidden/CSRF, `404` not found, `429` rate-limited).
- **Rate limits** — login, registration, and password-reset attempts are separately limited;
  general API traffic is capped by `API_RATE_LIMIT` (default 600 requests per 15-minute window).

---

## Authentication — `src/routes/auth.js`

| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/api/auth/session` | none | Returns `{ authenticated, csrfToken, user?, mustChangePassword? }`. Call first to obtain the CSRF token. |
| POST | `/api/auth/login` | CSRF + limiter | Body `{ username, password, rememberMe?, totpCode? }`; `username` may be the username **or** the registered Gmail address (case-insensitive). `rememberMe: true` → 30-day session. Admin accounts with 2FA enabled must send `totpCode` (6-digit authenticator code or a one-time recovery code); without it the response is `401 { code: "totp_required" }`. Returns `{ user, mustChangePassword, csrfToken }`. |
| POST | `/api/auth/logout` | CSRF | Destroys the session. |
| POST | `/api/auth/register` | CSRF + limiter | Body `{ username, email, password }`. Requires a unique valid email address; creates a **pending** account unless registration is disabled. Passwords must be 8–128 characters; all letters, digits, and symbols are accepted. |
| POST | `/api/auth/forgot-password` | CSRF + limiter | Body `{ email }`. Always returns the same generic message for known and unknown addresses. For a real account, emails a 6-digit code (10-minute lifetime, 5 attempts, 60-second resend) and flags `resetRequestedAt` in the admin list. No token or code is returned. |
| POST | `/api/auth/verify-reset-code` | CSRF + limiter | Body `{ email, code }`. Verifies the emailed code and returns `{ resetToken, expiresInMinutes, message }` once. The code is consumed; wrong guesses count toward the five-attempt cap. If the account was **pending**, verification approves it (the mailbox is proven); rejected/revoked accounts stay blocked. |
| POST | `/api/auth/reset-password` | CSRF + limiter | Body `{ token, password }`. Consumes the token returned by `/verify-reset-code` or an administrator-issued link, enforces password strength, clears lockouts, and revokes every session. Invalid, used, or expired tokens → `400` with the same message. |
| POST | `/api/auth/change-password` | auth + CSRF | Body `{ currentPassword, newPassword }`. Enforces strength; revokes other sessions; clears the forced-change flag. |
| POST | `/api/auth/2fa/setup` | auth + CSRF | (Admins) Generates a TOTP secret; returns `{ secret, otpauthUri }`. Not active until verified. |
| POST | `/api/auth/2fa/enable` | auth + CSRF | (Admins) Body `{ code }`. Activates 2FA; returns `{ recoveryCodes }` — shown exactly once. |
| POST | `/api/auth/2fa/disable` | auth + CSRF | (Admins) Body `{ password, totpCode }`. Both required. |
| GET | `/api/auth/2fa/status` | auth | `{ enabled }`. |
| POST | `/api/auth/sessions/revoke-all` | auth + CSRF | Destroys **all** of the user's sessions (use after a suspected compromise). |

Wrong credentials return a generic `401` (no user enumeration). Five failed attempts lock the
account temporarily (`429`). Accounts whose password was generated at bootstrap carry
`mustChangePassword` and are blocked from everything except changing it (`403 { code:
"password_change_required" }`). Lost authenticator? Run `node scripts/reset-2fa.js <username>`
on the server.

Password recovery is self-service by Gmail one-time code. A user submits `/forgot-password`
with the registered address; the server emails a 6-digit code (valid 10 minutes, 5 attempts,
one send per minute) and the user exchanges it on `/api/auth/verify-reset-code` for a one-time
token. That token, and administrator-issued links from the Users panel, are stored only as
SHA-256 digests, expire after 30 minutes, and work once. Only code verification approves a
pending account; rejected and revoked accounts remain blocked. Email delivery uses the
`SMTP_*` / `MAIL_FROM` settings (a Gmail app password works); tests write to a temporary
outbox instead. Administrator accounts can use the same emailed-code flow; their
next sign-in still requires the authenticator code. Host-side recovery remains
available with `npm run reset-admin` when no mailbox can be reached.

---

## Customer Register — `src/routes/customers.js`

All records are **owned** by the signed-in user; owners never see another user's records
(cross-owner access returns `404`). Statuses are computed server-side in `Asia/Kolkata`:
`active`, `expiring_soon` (expiry ≤ 5 days away), `expired`.

Expiry rule: one calendar month from each record's own date, with month-end clamping
(`2026-01-31` → `2026-02-28`).

| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/api/customers` | auth | List + dashboard. Query: `search`, `status` (`all`/`active`/`expiring_soon`/`expired`), `from`, `to`, `page`, `pageSize`. Returns `{ records, page, pageSize, totalPages, totalFiltered, summary: { total, active, expiringSoon, expired }, today, canDeleteExpiredOnly }`. |
| POST | `/api/customers` | auth + CSRF | Body `{ name, amount, billNo, date, village?, bookNo?, phone }`. Validation: name ≤ 100 chars; amount ≥ 0; **phone = 10 digits starting 6–9**; bill no alphanumeric with `-`/`/`, unique per owner; date ≤ today. Returns `201 { record }` with computed `expiryDate` and `status`. |
| PUT | `/api/customers/:id` | auth + CSRF | Same validation. Changing `date` recomputes `expiryDate`; editing never changes ownership. |
| DELETE | `/api/customers/:id` | auth + CSRF | **Only allowed for expired records.** Unexpired → `409 { error: "Only expired records can be deleted." }`. Never auto-deletes. |

The UI derives `S.No` from display order (never the database id).

---

## Catalogue (Materials) — `src/routes/materials.js`

Categories with `admin_only: 1` (currently **Order Tracking**, id `order-tracking`) are
filtered out of `GET /api/materials` for viewers.

| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/api/materials` | auth | Full catalogue: `{ canEdit, categories: [{ id, name, adminOnly, items: [...] }] }`. Each item: `{ id, categoryId, product, size, price, unit, notes, imageId, orderStatus }` (`orderStatus` only for Order Tracking items). |
| POST | `/api/materials` | admin + CSRF | Body `{ categoryId, product, size?, price?, unit?, notes?, imageId, orderStatus? }`. `orderStatus` (`to_order`/`completed`) is only accepted for the Order Tracking category (defaults to `to_order`). `201 { item }`. |
| PUT | `/api/materials/:id` | admin + CSRF | Same payload; replaces the item. Changing category away from Order Tracking rejects `orderStatus`. |
| DELETE | `/api/materials/:id` | admin + CSRF | Deletes the item and its orphaned image. |
| POST | `/api/materials/:id/order-status` | admin + CSRF | One-click toggle `to_order` ⇄ `completed`. Optional body `{ orderStatus }` for an explicit value. Returns `{ id, orderStatus }`. Non-Order-Tracking items → `400`. |

---

## Images — `src/routes/images.js`

| Method | Path | Guard | Description |
|---|---|---|---|
| POST | `/api/images` | admin + CSRF | Multipart upload (field `image`); stores metadata in `images_meta` and bytes as base64 chunks under `images_meta/{id}/chunks/{n}`. `201 { id, mime, bytes }`. |
| GET | `/api/images/:id` | auth | Serves the image bytes. Path traversal and non-UUID ids rejected. |
| DELETE | `/api/images/:id` | admin + CSRF | Removes the image metadata and its chunks; item references are cleared. |

---

## Administration — `src/routes/admin.js`

All admin routes require the `admin` role (`403` otherwise).

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users` | `{ users: [{ id, username, email, role, status, createdAt, ..., resetRequestedAt }] }`. `email` is shown to administrators for recovery support; `resetRequestedAt` is set when the user asked for a password reset. |
| PATCH | `/api/admin/users/:id/email` | Attaches or changes the recovery email on any account, including an administrator's own. Body `{ email }`; a duplicate address returns `409`. Audited as `user_email_updated`. |
| POST | `/api/admin/users/:id/password-reset` | Issues a single-use reset link for an active non-admin account. Returns `{ resetUrl, expiresAt }` **once**; only the token digest is stored. |
| POST | `/api/admin/users/:id/:action` | Actions: `approve`, `reject`, `revoke` (status changes) and `promote`, `demote` (role changes). Safety rails: an admin **cannot change their own role**; the **last administrator cannot be demoted**; `promote`/`demote` on an already-correct role → `400`. Demotion immediately destroys the demoted user's sessions. |
| DELETE | `/api/admin/users/:id` | Permanently deletes a non-admin account (admin accounts rejected). |
| GET | `/api/admin/security-events` | Audit trail: `data_exported`, `order_status_changed`, `role_changed`, `login_failed`, `login_2fa_failed`, etc. Query `limit` supported. |
| GET | `/api/admin/alerts` | Login-security alerts from the last 24 h: suspected brute force (≥10 failures per IP), admin sign-ins from **new** IP addresses, 2FA recovery-code usage, data exports. |
| GET | `/api/admin/ip-bans` | Active fail2ban-style IP bans (persisted, auto-expiring). |
| DELETE | `/api/admin/ip-bans/:ip` | Lifts a ban (e.g. if you banned yourself). |
| GET | `/api/admin/summary` | Dashboard counts, including `twoFactorAdmins` / `totalAdmins`. |

---

## CSV Exports — `src/routes/export.js`

Both routes return `text/csv; charset=utf-8` with a UTF-8 BOM (Excel-friendly) and
`Content-Disposition: attachment`. They are never cached and every export is recorded as a
`data_exported` security event. Cells beginning with `= + - @` TAB or CR are prefixed with
`'` (CSV formula-injection guard).

| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/api/export/customers.csv` | auth | Own register by default. Columns: `S.No, Id, Name, Amount, Bill.No, Date, Village, Book No, Phone.No, Expiry Date, Status`. Admins may pass `?scope=all` to export every user's records (adds an `Owner` column instead of `S.No`). Non-admins silently get their own records regardless of `scope`. |
| GET | `/api/export/materials.csv` | admin | Full catalogue. Columns: `Category, Id, Product, Size, Price, Unit, Notes, Order Status, Admin Only`. |

---

## Health & Pages — `src/routes/pages.js`

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{ status, version, time }` only — no sensitive data. |
| GET | `/` | Public landing page for anonymous visitors; signed-in users get the catalogue. |
| GET | `/catalogue` | Catalogue page (redirects anonymous users to `/login`). |
| GET | `/robots.txt`, `/sitemap.xml` | Crawler rules and the canonical homepage entry. |
| GET | `/login`, `/login/verify`, `/register` | Auth pages. |
| GET | `/forgot-password` | Public three-step recovery page: Gmail address → 6-digit email code → new password. Generic response for unknown addresses; verifying the code approves a pending account. |
| GET | `/reset-password?token=…` | One-time link destination; accepts a new password and revokes existing sessions. |
| GET | `/admin` | Admin console (viewers redirected to `/`). |
| GET | `/orders` | Orders page, admin-only (`order-tracking` category). |
| GET | `/customers` | Customer register page (auth required). |
| GET | `/ai-agent` | Admin-only assistant page (viewers redirected to `/`). |

## Admin AI assistant team — `src/routes/ai.js`

Twelve offline, in-process specialist agents under `src/ai/agents/`: `catalogue`,
`customers`, `users`, `orders`, `security`, `sales`, `mail`, `seo`, `deployment`,
`inspector`, `change` and `improver`, plus a `help` fallback. The Inspector checks
the public origin; the Change Agent proposes allowed data actions; the
Improvement Agent proposes code fixes for Git + Fly redeploy. No external API.
All routes require an administrator session; viewers receive `403`.

| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/api/ai/status` | admin | `{ available, mode, agents: [...], actions: [...], suggestions }`. |
| POST | `/api/ai/ask` | admin + CSRF + limiter | Body `{ question, agentId? }` (question 1–300 chars). Returns `{ answer, intent, agent, agentName, suggestions, inspection?, proposal?, confirmation?, codeProposal? }`. Omit `agentId` to auto-route, or pin an agent ID. Rate limit `AI_RATE_LIMIT` (default 60/15 min). |
| POST | `/api/ai/action` | admin + CSRF + limiter | Two-step data change. Without `confirmToken`: body `{ action, params }` returns `{ requiresConfirmation, preview, confirmToken, expiresAt }`. With `confirmToken`: applies the change. Allowed actions: `approveUser`, `revokeUser`, `unbanIp`, `setOrderStatus`, `updateStock`. Tokens expire in 5 minutes, are bound to the admin id, and cannot be replayed. Rate limit `AI_ACTION_RATE_LIMIT` (default 20/15 min). |

Questions are answered from the in-memory Firestore working set: catalogue
counts and rates, category breakdowns, customer expiry status, pending user
approvals, pending orders, recent security events, bans and sales analytics.
No password hashes, tokens or cookies are ever returned.

---

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Server binding. |
| `DATA_DIR` | `data/` | Runtime files: service account, TLS, session secret, logs, JSON backups. |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `DATA_DIR/firebase-service-account.json` | Service account key file. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | unset | Full service account JSON (hosting platforms). |
| `FIRESTORE_PREFIX` | unset | Prefix for every collection name; used by tests for isolation. |
| `SESSION_SECRET` | generated | Session signing key, persisted to `DATA_DIR/session-secret`. |
| `COOKIE_SECURE` | auto | Set `false` for local HTTP testing. |
| `HTTPS` / `TLS_KEY` / `TLS_CERT` | off | Native TLS mode. |
| `TRUST_PROXY` | `false` | Trust one reverse-proxy hop (Cloudflare tunnel). |
| `APP_ORIGIN` | request-derived | Exact public origin expected on API writes. |
| `CANONICAL_HOST` | `steel-yard-ledger.fly.dev` | Apex hostname that is indexable; `www` 301s here, other hosts get `X-Robots-Tag: noindex`. |
| `CANONICAL_ORIGIN` | `https://CANONICAL_HOST` | Absolute origin used in canonical URLs, Open Graph, JSON-LD, and the sitemap. |
| `API_RATE_LIMIT` | `600` | General API requests per 15-minute window. |
| `AI_RATE_LIMIT` | `60` | Admin assistant questions per 15-minute window. |
| `AI_ACTION_RATE_LIMIT` | `20` | Admin assistant data-action requests per 15-minute window. |
| `LOGIN_RATE_LIMIT` / `REGISTER_RATE_LIMIT` | `10` / `5` | Auth attempt limits. |
| `FORGOT_RATE_LIMIT` / `RESET_RATE_LIMIT` | `5` / `10` | Reset-request (per hour) and reset-token (per 15 min) limits per IP. |
| `RESET_OTP_TTL_SECONDS` | `600` | Lifetime of the emailed 6-digit code (1–3600). |
| `RESET_TOKEN_TTL_SECONDS` | `1800` | Lifetime of the one-time token exchanged for a verified code or issued by an administrator (1–86400). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | unset / `465` / `true` on 465 | SMTP relay used for recovery codes. |
| `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | unset | SMTP login and From address. All are required for delivery; tests use `MAIL_OUTBOX_DIR` instead. |
| `REGISTRATION_ENABLED` | `true` | Allow self-registration. |
| `IP_BAN_THRESHOLD` | `20` | Failed sign-ins per IP within 24 h before an automatic 24 h ban (`0` disables). Bans persist in Firestore across restarts. |

Boot loads Firestore into memory and fails loudly if credentials are missing or
the database is unreachable. It never creates a local database file.

## Test suites

- `npm run security-test` — 64 checks covering the public homepage and SEO metadata, auth, CSRF, 2FA, roles, Order Tracking, exports, forced password changes, emailed reset codes and tokens, email-verified account approval, Gmail sign-in, permissive password policy, and IP auto-bans.
- `npm run customer-test` — 24 checks covering the register, expiry engine, and ownership.
- `npm run ai-test` — 15 access checks proving the assistant is admin-only (anonymous/viewer 401/403, admin 200).
- `npm run reset-users-test` — 16 checks proving recovery works for approved viewers and pending accounts.
