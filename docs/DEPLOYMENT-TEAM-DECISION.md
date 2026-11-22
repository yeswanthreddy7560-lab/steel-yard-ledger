# Deployment Team Decision — Steel Yard Ledger

Reconciled final decision (the first `PERMANENT-URL-COMPARISON.md` table listed Fly.io first; the Cloudflare Tunnel team ranked Cloudflare Tunnel first; this is the reconciled decision: the best **permanent, free** URL).

## Final ranking (reconciled)

| # | Option | Permanent? | Free? | Always-on | Notes |
|---|--------|-----------|-------|-----------|-------|
| 1 | **Cloudflare Tunnel — Named Tunnel** (`https://steel-yard-ledger.yourdomain.com`) | Yes (your domain) | Free | Yes (app must be up) | Best free permanent URL; free DNS, free TLS. Requires owning a domain and running `cloudflared`. |
| 2 | **Fly.io Free** (`*.fly.dev` or custom domain) | Yes | Free tier (≈ $2.19/mo usage credits; card required) | Yes | Vendor-hosted, no idle shutdown. |
| 3 | **Vercel Free** (`*.vercel.app`) | Yes | Free | Mostly | Low effort; serverless timeouts, band caps; Firestore-backed sessions survive cold starts. |
| 4 | **Render free** (`*.onrender.com`) | Yes | Free | No — spins down after 15 min idle | Reference only. |
| 5 | **GitHub Pages** | Yes | Free | Static-only | Not viable for this app. |

## Primary runbook: Cloudflare Tunnel (`docs/DEPLOY-PERMANENT-URL.md`)

1. Run the app (`scripts/start-app.ps1` or `node start.js`).
2. Install `cloudflared` (`docs/permanent-url-cloudflare.md`).
3. Create the named tunnel + route DNS:
   ```powershell
   cloudflared tunnel login
   cloudflared tunnel create steel-yard-ledger
   cloudflared tunnel route dns steel-yard-ledger steel-yard-ledger.yourdomain.com
   ```
4. Write `cloudflared.yml` from the repo root; run `cloudflared tunnel --config cloudflared.yml run`.
5. Verify `https://steel-yard-ledger.yourdomain.com/api/health`.

## Secondary: Fly.io Free (`docs/PERMANENT-URL-COMPARISON.md` § Viability notes)

`fly launch --name steel-yard-ledger --remote-only`, set secrets, `fly deploy`.

## Team artifacts

- `docs/PERMANENT-URL-COMPARISON.md` — full comparison.
- `docs/DEPLOY-PERMANENT-URL.md` — primary runbook (Cloudflare Tunnel #1).
- `docs/permanent-url-cloudflare.md` — quick tunnel (not permanent) vs named tunnel.
- `scripts/start-app.ps1`, `scripts/run-cloudflare-tunnel.ps1`, `cloudflared.yml`.
- `render.yaml` kept as a Render reference (service renamed to `steel-yard-ledger`).
