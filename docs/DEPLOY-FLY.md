# Deploy to Fly.io — Steel Yard Ledger — Alpha

This runbook produces the permanent public URL
**https://steel-yard-ledger.fly.dev** using the repository's `Dockerfile` and
`fly.toml`.

> Google Search Console does **not** create or host URLs. It only verifies and
> indexes a site that is already live. Deploy first, then follow
> [Search Console](#5-google-search-console) below.

## 1. Prerequisites

- A Fly.io account (<https://fly.io/app/sign-up>). New organisations may need a
  payment method even when usage stays inside the allowance.
- `flyctl` installed and authenticated:

```powershell
flyctl auth login
flyctl auth whoami
```

## 2. Create the app (once)

```powershell
flyctl apps create steel-yard-ledger
```

If the name is taken, choose another name and update `app`, `CANONICAL_HOST` and
`CANONICAL_ORIGIN` in `fly.toml` to match.

## 3. Set secrets

Never commit the service-account key. Minify it so the whole JSON fits in one
CLI argument:

```powershell
$json = Get-Content -Raw data/firebase-service-account.json |
  ConvertFrom-Json | ConvertTo-Json -Compress -Depth 20
$session = -join ((1..96) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
$admin = -join ((1..24) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }) + '#Aa1!'

flyctl secrets set --app steel-yard-ledger `
  "FIREBASE_SERVICE_ACCOUNT_JSON=$json" `
  "SESSION_SECRET=$session" `
  "ADMIN_PASSWORD=$admin"
```

`ADMIN_PASSWORD` only bootstraps an administrator when Firestore has none. The
existing `admin` account keeps its current password, so reset it after the first
deploy if you want a different one:

```powershell
# Stop the local app first; only one instance should write to Firestore.
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "<new 8-128 character password>"
npm run reset-admin
```

Optional password-recovery email:

```powershell
flyctl secrets set --app steel-yard-ledger `
  SMTP_HOST=smtp.gmail.com SMTP_PORT=587 `
  SMTP_USER=you@gmail.com SMTP_PASS="<gmail app password>" `
  MAIL_FROM=you@gmail.com
```

## 4. Deploy and verify

Stop the local server first. Firestore is the only database, and two running
instances keep separate in-memory copies of the same collections.

```powershell
flyctl deploy --app steel-yard-ledger
flyctl status --app steel-yard-ledger
```

Verify from the public internet:

```powershell
curl.exe -sS https://steel-yard-ledger.fly.dev/api/health
curl.exe -sS https://steel-yard-ledger.fly.dev/robots.txt
curl.exe -sS https://steel-yard-ledger.fly.dev/sitemap.xml
```

Expected: health `{"status":"ok",...}`, a sitemap reference to the `fly.dev`
origin, and a sitemap whose only `<loc>` is the homepage.

Sign in at <https://steel-yard-ledger.fly.dev/login>. The machine may take a few
seconds to start because `min_machines_running = 0` (scale to zero).

## 5. Google Search Console

1. Open <https://search.google.com/search-console/welcome> and sign in with the
   Google account that should own the property.
2. Choose **URL prefix** and enter `https://steel-yard-ledger.fly.dev/`.
3. Verify ownership with the **HTML file** method:
   - Download the file Google offers (named like `google1234abcd.html`).
   - Copy it into `public/` in this repository.
   - Redeploy: `flyctl deploy --app steel-yard-ledger`.
   - Return to Search Console and click **Verify**.
4. Open **Indexing → Sitemaps**, submit
   `https://steel-yard-ledger.fly.dev/sitemap.xml`.
5. Open **URL Inspection**, paste `https://steel-yard-ledger.fly.dev/`, and click
   **Request indexing**.
6. Use **Performance** after a few days for queries, impressions, CTR and
   position. Search Console reports data for queries Google already served; it
   is not a keyword-research tool. Use Google Keyword Planner for new keyword
   ideas.

The homepage is public and indexable. Internal pages (`/catalogue`, `/admin`,
`/customers`, `/orders`, `/api/`) stay `Disallow`ed in `robots.txt` and require
authentication.

### Verification file in the image

`public/` is copied into the container, so a verification file placed there is
served at `https://steel-yard-ledger.fly.dev/google<...>.html`. Commit it if you
want verification to survive future deploys.

## 5b. Password recovery email

The app emails a 6-digit code for `/forgot-password`. Delivery uses these Fly
secrets:

```
SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
```

`MAIL_FROM` defaults to `SMTP_USER`. If delivery fails, the code is cleared and
a `password_reset_email_failed` alert appears in the admin console — the
response to the user stays generic.

The current deployment uses a no-signup Ethereal test inbox. **Codes are
captured there and are not delivered to the recipient's Gmail.** View them by
signing in at <https://ethereal.email> with the `SMTP_USER` / `SMTP_PASS`
values stored in Fly secrets.

To deliver codes to a real mailbox, replace the SMTP secrets with a Gmail app
password (Google Account → Security → App passwords):

```powershell
flyctl secrets set --app steel-yard-ledger `
  SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_SECURE=false `
  SMTP_USER=you@gmail.com SMTP_PASS="<16-char app password>" `
  MAIL_FROM=you@gmail.com
flyctl deploy --app steel-yard-ledger
```

The admin account must also have a recovery email attached; an administrator
can set it from **Admin → Users → Edit email**, or the CLI:
`npm run set-email -- admin you@gmail.com`.

## 6. Redeploying

```powershell
flyctl deploy --app steel-yard-ledger
```

`fly.toml` keeps one shared-CPU machine with 512 MB RAM in Singapore (`sin`)
and lets it stop when idle. Change `primary_region` if the yard is closer to
another supported region (`flyctl platform regions` lists them; `bom` is no
longer accepting new machines).
