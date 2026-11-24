# Deployment Guide — Firebase Hosting + Cloud Functions

The application has **no local database**. All state lives in Google Firestore,
so the server can run as a stateless Cloud Function and scale to zero when idle.
Runtime files in `data/` are limited to the service account key, TLS
certificates, the session secret, logs, and JSON backups for local runs.

Two deployment shapes are supported:

- **A. Firebase Hosting + Cloud Functions (primary).** One function in
  `asia-south1` serves every dynamic route; Hosting rewrites `**` to it and
  handles HTTPS automatically. Requires the **Blaze plan** (a card is required,
  but ordinary use stays inside the free monthly allowances).
- **B. This PC or a container host (fallback).** Useful while the cloud project
  is being set up or if you need to run offline. Never point the local server
  and the deployed function at the same Firestore data at the same time.

---

## 1. Firebase setup (once)

1. Create a project at <https://console.firebase.google.com>. The existing
   project id in `.firebaserc` is `saihardwareitems`.
2. Upgrade the project to **Blaze** (required for Cloud Functions). Set a budget
   alert if you want a warning before any charge.
3. Enable **Firestore** in production mode and choose `asia-south1` (the region
   hard-coded in `functions/index.js` and `firebase.json`).
4. For local runs, create a service account key (Project settings → **Service
   accounts** → **Generate new private key**) and save it as
   `data/firebase-service-account.json`, or pass its contents through
   `FIREBASE_SERVICE_ACCOUNT_JSON`. Cloud Functions uses Application Default
   Credentials and needs no key file.
5. Treat any key as a secret: owner-only file permissions, never commit it.

Firestore free tier: 50k document reads and 20k document writes per day. The
app reads from memory and throttles session touches, so normal use is far below
that. Test suites use throwaway collection prefixes and add a few thousand
writes when run.

> **Cloud Storage is not used.** Product images are stored as base64 chunks in
> Firestore, so the deployment needs only Firestore, Functions, and Hosting.

---

## 2. Secrets and environment

Generate and store these in a password manager:

```powershell
# Admin password (the app forces a change at first sign-in if generated)
node -e "console.log(require('node:crypto').randomBytes(18).toString('base64url'))"

# Session secret (anything 32+ random bytes; the app also generates one locally)
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

### Session secret (Secret Manager)

`functions/index.js` declares `SESSION_SECRET` with `defineSecret`, so it must
exist before the first deploy:

```powershell
npx firebase-tools@15.37.0 login
npx firebase-tools@15.37.0 use saihardwareitems
npx firebase-tools@15.37.0 functions:secrets:set SESSION_SECRET
```

Paste a 48-byte random hex string when prompted. Keep it stable: changing it
signs everyone out and invalidates outstanding emailed recovery codes.

### SMTP (password-recovery email)

Use a Gmail **app password** (Google Account → Security → 2-Step Verification →
App passwords) or any SMTP relay. Put the values in a root `.env` file for the
function; Firebase CLI loads `.env` from the functions source directory (the
project root, per `firebase.json`) and sets them on the deployed function. The
file is git-ignored.

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@gmail.com
SMTP_PASS=the-16-character-app-password
MAIL_FROM=you@gmail.com
```

For a local run, load the same file explicitly:

```powershell
node --env-file=.env server.js
```

Never commit `.env`. For Gmail, `MAIL_FROM` must normally equal `SMTP_USER`.
When a send fails, the code is cleared and a `password_reset_email_failed` alert
appears in the admin console.

### Canonical hostname

`CANONICAL_HOST` defaults to `steel-yard-ledger.fly.dev` for the Fly.io
deployment. If you deploy on Firebase Hosting, set it to the Hosting hostname
(for example `saihardwareitems.web.app`) so the preview stays coherent — it is
still marked `noindex` because it is not the canonical host:

```dotenv
CANONICAL_HOST=saihardwareitems.web.app
CANONICAL_ORIGIN=https://saihardwareitems.web.app
```

After attaching a custom domain, switch both values to that domain and
redeploy.

---

## 3. Deploy

```powershell
npx firebase-tools@15.37.0 deploy --only firestore:rules,functions,hosting
```

This deploys:

- `firestore.rules` — deny all client SDK access; only the Admin SDK can read
  or write.
- `functions/index.js` — the `api` function, `asia-south1`, 512 MiB, 60 s
  timeout, `maxInstances: 1`, `concurrency: 40`, scale-to-zero.
- `hosting` — `public/` assets plus a rewrite of `**` to `api`.

The first deploy can take several minutes. The function flushes its write queue
before every response, so a scale-to-zero instance cannot acknowledge a write
that never lands.

### Custom domain

1. Register `saihardwareitems.com` (any registrar).
2. Firebase Console → **Hosting** → **Add custom domain** → enter the apex and
   `www` names, then create the shown DNS records at the registrar.
3. Wait for the managed certificate to become active (minutes to a few hours).
4. Set `CANONICAL_HOST=saihardwareitems.com` and
   `CANONICAL_ORIGIN=https://saihardwareitems.com`, then redeploy.
5. Submit `https://saihardwareitems.com/sitemap.xml` in Google Search Console
   and Bing Webmaster Tools and request indexing of `/`.

Hosting redirects HTTP to HTTPS automatically. Only the landing page is public;
`/catalogue` and every data page require sign-in.

---

## 4. Option B — this PC (fallback)

```powershell
npm install
npm run tls-cert    # one-time: self-signed certificate in data/tls/
npm run serve       # HTTPS on 0.0.0.0:443, production mode, secure cookies
```

Local verification (the certificate is self-signed, so ignore TLS errors
locally):

```powershell
node -e "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'; fetch('https://127.0.0.1:443/api/health').then(r=>r.json().then(console.log))"
```

Global access without opening router ports — Cloudflare quick tunnel:

```powershell
& "$env:LOCALAPPDATA\Temp\opencode\cloudflared\cloudflared.exe" tunnel --url https://localhost:443 --no-tls-verify
```

Quick-tunnel URLs change whenever cloudflared restarts; the watchdog writes the
current one to `data/global-url.txt` and appends cloudflared output to
`data/cloudflared.log`. Quick tunnels are preview-only and every response on
them is marked `X-Robots-Tag: noindex, nofollow`.

Background automation on this PC (stop these when the cloud deployment becomes
primary):

| Scheduled task | Schedule | Purpose |
|---|---|---|
| `SriSaiWeb Watchdog` | every minute (`watchdog.js --once`) | Checks `https://127.0.0.1:443/api/health`; restarts the server and/or cloudflared if either is down; refreshes `data/global-url.txt` |
| `SriSaiWeb Update Check` | daily 09:00 (`watch-updates.js --apply`) | Applies same-major security patches, runs both test gates, rolls back on failure |
| `SriSaiWeb Firestore Backup` | daily 09:30 (`firestore-backup.js`) | JSON export to `data/backups/firestore/`, 14-file rotation |

All three tasks run through `scripts/run-hidden.vbs` via `wscript.exe`, so
scheduled runs do not open a console window.

`npm run serve` uses `TRUST_PROXY=true` so client IPs come from Cloudflare's
`X-Forwarded-For` for rate limiting and IP bans.

Firewall (elevated, only needed for LAN/port forwarding — not for the tunnel):

```powershell
netsh advfirewall firewall add rule name="SriSaiWeb HTTPS" dir=in action=allow protocol=TCP localport=443
```

### Container host

1. Push the repository to Git (GitHub/GitLab). **Never commit** `data/` or
   `.env`.
2. Create a web service (Docker or Node buildpack) and set:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — the full service-account JSON
     (or mount the file and set `FIREBASE_SERVICE_ACCOUNT_PATH`)
   - `SESSION_SECRET` — fixed random string
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — bootstrap administrator
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
     `MAIL_FROM` — recovery email
   - `NODE_ENV=production`, `COOKIE_SECURE=true`
   - `TRUST_PROXY=true` if the platform terminates TLS in front of the app
   - `CANONICAL_HOST` and `CANONICAL_ORIGIN` for the public domain
3. No disk is required. The process loads Firestore at boot and seeds the
   catalogue if it is empty.
4. Free instances may sleep; the first request after sleep is slow while the
   working set reloads, but no data is lost.

---

## 5. Post-deploy checklist (5 minutes)

- [ ] `GET https://<host>/api/health` returns 200 over HTTPS.
- [ ] Anonymous `GET /` shows the public landing page; `GET /catalogue`
      redirects to `/login` and exposes no catalogue data.
- [ ] `GET /robots.txt` and `GET /sitemap.xml` name the canonical domain.
- [ ] Sign in with the admin password; change it if it was generated.
- [ ] Enroll 2FA from **Change password** and store the 8 recovery codes
      (shown once).
- [ ] Admin console loads; pending access requests appear.
- [ ] Register a test account with a real mailbox, request a code on
      `/forgot-password`, confirm it arrives, verify it, set a new password, and
      sign in with the Gmail address. This exercises SMTP end to end.
- [ ] `npm run firestore-status` shows the project, credentials, and expected
      collection counts (users 1, categories 11, items 207, …).
- [ ] `npm run firestore-backup` writes a JSON export under
      `data/backups/firestore/`.
- [ ] Create an expired customer record, delete it, upload/read/delete a small
      image — this exercises the full Firestore write path.
- [ ] When the team's accounts exist, set `REGISTRATION_ENABLED=false`.
- [ ] Stop the local server/watchdog/update tasks before treating the cloud URL
      as primary.

---

## 6. Upgrading later

- Cloud: `npx firebase-tools@15.37.0 deploy --only firestore:rules,functions,hosting`.
  Firestore data is untouched; `SESSION_SECRET` stays in Secret Manager.
- This PC: the daily update task applies same-major patches, runs
  `customer-test` + `security-test`, and rolls back on failure. To deploy
  manually: stop the server, pull the code, `npm install`, start `npm run serve`.
- Container host: push a commit and redeploy.
- After any upgrade, check the gates:

  ```powershell
  npm run customer-test   # 24 checks
  npm run security-test   # 64 checks, writes SECURITY-REPORT.md
  ```

---

## 7. Emergency runbook

| Situation | Action |
|---|---|
| Suspected break-in | Account menu → sign out on all devices, then change the password; review Admin → Security alerts/events and active IP bans |
| Lost admin password | Stop the server, run `npm run reset-admin` (set `ADMIN_PASSWORD` for a chosen password), start it again. For the cloud deployment, run it locally with the service-account key and the same Firestore project |
| Lost 2FA device | Use a recovery code; if none remain: `node scripts/reset-2fa.js admin` (same project credentials), then restart |
| Recovery email not arriving | Check `SMTP_*` / `MAIL_FROM`, Gmail app-password status, and the `password_reset_email_failed` admin alert. Confirm the account has an email (`npm run set-email -- <username> <gmail>`); use `npm run reset-admin` as the last resort |
| Firestore quota exhausted | Wait for the daily reset; reads are served from memory while the instance stays warm. Do not run the test suites repeatedly |
| Bad deployment | Roll back in the Firebase Console (Hosting release history / function revision), or deploy the previous commit; Firestore keeps the data |
| Restore from a JSON export | The backup contains every collection plus decoded images; re-import it with the Firebase Admin SDK or the console |
| Rate-limit false positives | Raise `API_RATE_LIMIT` / `LOGIN_RATE_LIMIT` / `REGISTER_RATE_LIMIT` |

---

## 8. Local container test (optional)

```bash
docker build -t mh-catalogue .
docker run --rm -p 3000:3000 \
  -e FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' \
  -e ADMIN_PASSWORD="YourStrong#2026!Pass" \
  -e SESSION_SECRET="replace-with-48-random-bytes" \
  -e SMTP_HOST=smtp.gmail.com -e SMTP_PORT=465 -e SMTP_SECURE=true \
  -e SMTP_USER=you@gmail.com -e SMTP_PASS=app-password \
  -e MAIL_FROM=you@gmail.com \
  mh-catalogue
```

Then open <http://localhost:3000>. No volume is required; data lives in
Firestore. Mount `data/` only if you want TLS files, logs, and backups to
persist across container restarts.
