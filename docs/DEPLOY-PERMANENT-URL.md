# Deploy — Permanent URL (Steel Yard Ledger)

Decision made by the deployment team: **recommended primary option = Cloudflare Tunnel (#1)**
— a free, always-on public URL with automatic TLS. Render is **not the primary
choice**; it is a secondary reference in `render.yaml`/`Dockerfile`/`docker-compose.yml`.

If you want a vendor-hosted origin instead of running `cloudflared` on a laptop/spare
machine, the team's second choice is **Fly.io Free** (`*.flydns.net`, ~$2.19/mo, credit card required, no idle shutdown).

## Final ranking (from `docs/PERMANENT-URL-COMPARISON.md`)

| # | Option | URL | Free? | Always-on | Custom domain | Notes |
|---|--------|-----|-------|-----------|---------------|-------|
| 1 | **Cloudflare Tunnel** | `https://steel-yard-ledger.yourdomain.com` (or `https://<name>.trycloudflare.com`) | $0 forever | yes | free (on a Cloudflare-managed domain, or quick-tunnel name) | best permanent free URL; caveat: the origin machine must run |
| 2 | **Fly.io Free** | `https://steel-yard-ledger.<region>.flydns.net` or custom | $5/mo credits ≈ $2.19/mo compute | yes | free custom domain | credit card required, short-term machine needed |
| 3 | **Render free (Hobby)** – secondary reference | `https://your-app.onrender.com` | $0 forever | no – spins down 15 min idle | 2 free domains included on free tier | reference only; wake-up on demand |
| 4 | **Railway Free** | `https://steel-yard-ledger.up.railway.app` | $0, expires never | no – sleeps 5–10 min idle | 0 on Free plan | reference only |

## Recommended next steps — Cloudflare Tunnel (#1)

### 1. Run the app (PowerShell)

```powershell
cd C:\Users\yeswa\Documents\steel-yard-ledger-fixed\steel-yard-ledger
$env:PORT=3000; $env:HOST=0.0.0.0; $env:DATA_DIR="$PWD\data"
$env:NODE_ENV=production; $env:TRUST_PROXY=true; $env:COOKIE_SECURE=true
$env:FIREBASE_SERVICE_ACCOUNT_JSON="<paste full JSON from your Firebase console>"
node start.js
```

Verify: `curl http://localhost:3000/api/health` → `{"status":"ok","version":2.1.0,...}`.
(Alternative: `docker run -d -p 3000:3000 steel-yard-ledger` with the same env.)

### 2. Install cloudflared

https://developers.cloudflare.com/cloudflare-one/connections/connectors/cloudflare-tunnel/downloads/

### 3. Create the tunnel (if you have a Cloudflare-managed domain)

```
cloudflared tunnel login
cloudflared tunnel create steel-yard-ledger
cloudflared tunnel route dns steel-yard-ledger steel-yard-ledger.yourdomain.com
```

If you don’t have a domain yet, quick-tunnel fallback (public URL, not "permanent"):

```
cloudflared tunnel --url http://localhost:3000
# → https://<name>.trycloudflare.com
```

### 4. Write `cloudflared.yml` (custom domain version — recommended)

```yaml
tunnel: steel-yard-ledger
credentials-file: C:\Users\yeswa\.cloudflared\steel-yard-ledger.json
ingress:
  - hostname: steel-yard-ledger.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

### 5. Run the tunnel

```
cloudflared tunnel --config cloudflared.yml run
```

Keep it running (background task, scheduled task, or on a spare machine).

### 6. Verify the public URL

```
curl https://steel-yard-ledger.yourdomain.com/api/health
```

Then visit https://steel-yard-ledger.yourdomain.com — anonymous: `/` is the public
landing page; sign in works end-to-end.

## Secondary: Fly.io (#2, vendor-hosted)

```powershell
fly launch --name steel-yard-ledger --region iad --no-deploy
$env:PORT=3000; $env:HOST=0.0.0.0; $env:DATA_DIR="/data"; $env:NODE_ENV=production
$env:TRUST_PROXY=true; $env:COOKIE_SECURE=true; $env:FIREBASE_SERVICE_ACCOUNT_JSON="<json>"
fly deploy
```

Free plan: $5/mo usage credits, credit card required, no idle shutdown.
URL: `https://steel-yard-ledger.<region>.flydns.net` or your domain (`fly certs add`).

## What I can do next in this environment

I can generate the `cloudflared.yml` template and final docs here, but creating an
account/domain on Cloudflare/Fly and issuing the URL requires you to log in in your
browser — the steps above are ready to copy/paste.

Tell me whether you want me to:
1. Write `cloudflared.yml` + a `scripts/start-app.ps1` into the repo (do it), or
2. Package the tunnel + Fly.io comparison into a single “DEPLOYMENT-TEAM-DECISION.md”.
