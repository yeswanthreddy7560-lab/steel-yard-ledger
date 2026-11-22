# Sai Hardware Items — Security Build

A hardened variant of the **Sai Hardware Items** private material & hardware
catalogue app (Node.js + Express, Firestore backend). This build targets
production deployments with a zero-trust, defense-in-depth posture.

Key hardening highlights:

- **Encryption at rest** — AES-256-GCM envelope encryption of the Firebase
  service-account key, admin/user TOTP secrets, customer phone numbers and
  the audit-chain key (master key file, mode 0600).
- **Secure defaults** — registration off, Secure cookies, strict origin
  enforcement, trusted-host (DNS-rebinding) guard, canonical-host policy.
- **Origin checks** — browser requests with mismatched `Origin` headers are
  rejected on every state-changing `/api` call; CSRF tokens are required and
  session-bound.
- **Rate limiting** — per-account sign-in limits (10/15 min), IP backstops,
  tighter API limits (300/15 min), per-email limits for recovery/reset.
- **Account lockout** — tiered escalation (5/15/30/60/… up to 24h) after
  failed password/second-factor attempts, plus randomized timing equalization.
- **Security headers** — strict CSP with per-request nonces, HSTS (preload),
  COOP/ORP, `X-Permitted-Cross-Domain-Policies: none`, `Origin-Agent-Cluster`,
  `nosniff`, `no-store` on all `/api` responses.
- **Tamper-evident audit log** — append-only, HMAC-chained log of all security
  events plus data mutations, verifiable via `scripts/audit.js verify`.
- **Audit tooling** — `node scripts/audit.js export|count|verify`,
  admin API `GET /api/security/audit`, `GET /api/security/chain`.
- **Secret hygiene** — `.env` support, never-logged secret redaction helper,
  password-strength policy, timing-safe token comparisons, one-time
  password-reset tokens (SHA-256 digests), session revocation on logout and
  password change.

## How to run

```bash
# 1. Install dependencies (or copy node_modules from the base app).
npm install

# 2. Generate the envelope-encryption master key (recommended).
#    Writes data/encryption.key with mode 0600; the key is never printed.
node scripts/keygen.js

# 3. Encrypt the service-account file at rest (recommended).
#    Overwrites data/firebase-service-account.json with ciphertext.
node scripts/encrypt-sa.js

# 4. Optional: set a strong SESSION_SECRET (32+ chars), SMTP settings for
#    self-service password recovery, and review .env.example.

# 5. Start the server.
npm start            # development (HTTP on 127.0.0.1:3000)
npm run serve        # hardened production mode (NODE_ENV=production,
                     # HTTPS if data/tls/key.pem + cert.pem exist, port 443)
```

### First run

- If no admin exists, a random bootstrap admin is created. Its password is
  printed once in the console (never on disk) and users are forced to change
  it at first sign-in. Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` (12+ chars)
  before first boot to control this; otherwise delete `data/users` documents
  and restart to re-bootstrap.
- Visit `/login` to sign in, or `/register` if `REGISTRATION_ENABLED=true`
  (off by default in this build).
- Two-factor authentication is available for administrators via
  `/api/auth/2fa/*` and the codes in the authenticator app.

## Security notes for the operator

- **Master key rotation**: provide a new `FIREBASE_SA_ENCRYPTION_KEY` and
  restart; old encrypted values remain decryptable only while the old key is
  present. Store the key in a password manager, not in `.env` (except for
  short-lived dev use — `.env` is covered by `.gitignore`).
- **Audit log**: append-only by design. Export with
  `node scripts/audit.js export --limit 100`; verify integrity with
  `node scripts/audit.js verify` (exit code 1 = chain broken).
- **Lockout behavior**: 5th failed password attempt locks the account for
  15 minutes, then escalates (30/60/120/240/480 min, capped at 24h).
- **Origin enforcement**: `STRICT_ORIGIN=0` disables origin matching for
  exotic clients (browser JS always sends a correct Origin on writes).
- **Password recovery**: requires SMTP; `REQUIRE_SMTP_IN_PRODUCTION=1`
  (default) prints a startup warning when it is unconfigured.

## Files

- `src/encryption.js` — envelope encryption (AES-256-GCM, HKDF-style keys).
- `src/security.js` — host allowlist, log redaction, timing equalization.
- `src/store.js` — encrypted-at-rest secrets, tiered account lockout,
  tamper-evident audit log.
- `src/routes/security.js` — CSP-report sink, audit endpoints (admin).
- `scripts/audit.js` — audit CLI (`export`/`count`/`verify`).
- `scripts/keygen.js`, `scripts/encrypt-sa.js` — key & service-account setup.

The base app this build was derived from: `steel-yard-ledger/` (Sai Hardware
Items). See `SECURITY.md` in the base app for the upstream threat model.
