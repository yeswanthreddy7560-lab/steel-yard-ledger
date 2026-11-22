# Free Permanent URL Options for Steel Yard Ledger

The application is a Node 22 Express server (`server.js`, `src/`), the
database is Firestore, and sessions are Firestore-backed
(`src/session-store.js`) — it is designed to be stateless ("scales to zero",
see `docs/deploy.md`) and to run from the provided Dockerfile (`node:22-alpine`,
`CMD ["node", "start.js"]`, `HOST=0.0.0.0`, `PORT=3000`, `EXPOSE 3000`).
It binds `HOST` (default `127.0.0.1`), so public hosting requires `HOST=0.0.0.0`
(the Dockerfile already sets it).

Because the app is stateless and exposes a health endpoint (`/api/health`,
used by the Dockerfile HEALTHCHECK and `render.yaml`'s `healthCheckPath`),
the "free, long-running" options are all viable: nothing about the app
needs a fixed compute tier.

## Method

Ranked by the criteria you gave. The primary question for this app is
"what is the best free permanent URL?" — so:

1. **Free-ness** — the recurring cost must be zero. "Free tiers" with caps
   are free but marked as such.
2. **Permanence / stability** — the URL keeps serving the app over time.
   Permanent means: stable while you keep the app (or the domain); random
   `trycloudflare.com`-style URLs are not permanent.
3. **Custom domain support** — can you point your own domain at it for free.
4. **Operational complexity** — maintenance work (daemons, restarts,
   watchdogs, config files).
5. **Deployment effort** — one-time setup work; refactors count heavily.

## Comparison table

| # | Option | Free-ness | Permanence / stability | Custom domain | Operational complexity | Deployment effort | Viability for this app |
|---|--------|-----------|------------------------|---------------|------------------------|-------------------|------------------------|
| 1 | **Fly.io — free tier** (`*.fly.dev`) | Free — small shared apps via the free allowance (verify at `fly.io/pricing`) | **High** — `*.fly.dev` is stable while the app is deployed; Fly reserves app names | Yes, free | Low–medium — `fly.toml`, `fly secrets set`, `fly deploy` | Medium | **Viable — recommended** |
| 2 | **Cloudflare Tunnel (cloudflared) + Cloudflare DNS** | Free — Cloudflare Tunnel is free for all accounts; unmetered | **Medium** — with your own domain on Cloudflare DNS: `steel-yard-ledger.yourdomain.com`, permanent while you keep it; without a domain, `*.trycloudflare.com` URLs are random and change when cloudflared restarts (`docs/deploy.md`: "Quick tunnels are preview-only") | Yes — free with a Cloudflare-managed domain | Medium — always-on `cloudflared` daemon + DNS/health checks | Medium–high | Viable — **recommended if you own a domain** |
| 3 | **Vercel — free tier** (`*.vercel.app`) | Free — free tier with limits (verify at `vercel.com/pricing`; bandwidth caps, ~10 s serverless timeout) | **High** — `*.vercel.app` subdomains are reserved | Yes, free | Low — connect GitHub repo + `vercel.json` | Low–medium — some adaptation (routes become serverless functions; Firestore-backed sessions mean scale-to-zero is safe) | Viable with caveats |
| 4 | **Firebase Hosting — Spark (`*.web.app`) + Functions, Blaze caveat** | Free — default domain, static hosting, Functions free grants; **Blaze required for Functions** per `docs/deploy.md` ("Requires the Blaze plan — a card is required") | **High** — Google-managed `*.web.app` | Custom domains: Blaze/pay-as-you-go (verify in the Firebase console) | Medium–high — dual deploy (Hosting + Function), Secret Manager, `firebase.json` | High — the existing primary runbook; add the free `*.web.app` | Viable with caveats |
| 5 | **Netlify — free tier** (`*.netlify.app`) | Free — 300 build min/mo, ~100 GB bandwidth (verify at `netlify.com/pricing`) | Medium — default `netlify.app` subdomains are assigned randomly; treat as changeable | Yes on free plans (Netlify upsells custom domains) | Low | Low–medium — **static-only: adaptation needed** for this server-rendered app | Limited |
| 6 | **Oracle Cloud — Always Free** (permanent public IP) | Free forever — 2 AMD + 4 ARM Ampere instances (verify at `oracle.com/cloud/free`) | High — permanent public IP while the VM exists | Yes — DNS to the VM's public IP | High — VM setup, Node install, port/DNS config | High — the highest of the free options | Viable — "most permanent" of the free options |
| 7 | **Koyeb — free tier** (`*.koyeb.app`) | Free — 1 shared-cpu instance (verify at `koyeb.com/pricing`) | Medium–high — `*.koyeb.app` while the app runs | Paid plans; verify (custom domains often require Scale) | Low | Medium | Viable with caveats |
| 8 | **GitHub Pages** (`*.github.io`) | Free | High — GitHub-managed, permanent while the repo exists | Yes, free | Low | Low | **Not viable** — static hosting only; this app is server-side (sessions, admin portal) |

## Ranked summary

1. **Fly.io — free tier — #1 recommendation.** Best balance: a real,
   permanent `*.fly.dev` URL, free allowance for a small app like this,
   custom domains free, low–medium complexity and medium effort. It is the
   best "permanent URL you never have to think about" option.
2. **Cloudflare Tunnel (cloudflared) + Cloudflare DNS — #2.** If you already
   own a domain on Cloudflare, you get `steel-yard-ledger.yourdomain.com` —
   a truly permanent free URL. Trade-off: an always-on `cloudflared`
   process; without your own domain the `trycloudflare.com` URL is random.
3. **Vercel — free tier — #3.** Easiest to set up, permanent `*.vercel.app`;
   caveats: free bandwidth/limits and serverless timeouts — fine for an
   admin catalogue (Firestore-backed sessions survive cold starts).
4. **Firebase Hosting — Spark + Blaze caveat — #4.** Google-managed
   `*.web.app`; per the existing runbook (`docs/deploy.md`), Functions
   require Blaze, so "custom domain" is Blaze/pay-as-you-go.
5. **Netlify — free tier — #5.** Low complexity, but static-only: this app
   is server-rendered and would need adaptation (Functions) or a separate
   hosting plan.
6. **Oracle Cloud — Always Free — #6.** Permanently free with a public IP,
   but the highest operational complexity (VM management).
7. **Koyeb — free tier — #7.** A solid middle ground; verify the
   custom-domain caveat before relying on it.
8. **GitHub Pages — #8, not viable for this app** (static only).

## Excluded options (not viable, or not free-permanent)

| Option | Why excluded |
|--------|--------------|
| Railway | Not permanently free — pay-as-you-go with credits |
| AWS Amplify Hosting | Free tier is 12-month limited; bandwidth-limited |
| Azure App Service (F1) | Free tier caps at ~750 free hours/month |
| Cloudflare Workers / Workers for Platforms | V8 isolates — the Express app does not run as-is |
| Google App Engine (Flex) | Requires the paid tier; legacy Standard is static-only |
| Heroku | Free dynos discontinued in 2022 |
| Self-hosted VPS + port forwarding | Not a "free permanent URL" without an external host |

## Viability notes for Fly.io (#1)

- **No random URLs, no scale-to-zero pain:** the app runs persistently;
  `*.fly.dev` stays as long as the app is deployed.
- **Free allowance fits this app:** a small admin catalogue — verify the
  exact free numbers at `fly.io/pricing`.
- **Custom domains free:** point your DNS at Fly (or use their nameservers).
- **Deploy:** `fly launch --name steel-yard-ledger --remote-only` (uses the
  existing Dockerfile), then secrets via `fly secrets set`
  (`FIREBASE_SERVICE_ACCOUNT_JSON`, `SESSION_SECRET`, `ADMIN_PASSWORD`, SMTP
  vars — see `docs/deploy.md`), then `fly deploy`.
- **Health:** `https://steel-yard-ledger.fly.dev/api/health` — the app
  serves this and the Dockerfile HEALTHCHECK uses it.
- **Session safety:** sessions are Firestore-backed, so restarts and
  scale-to-zero do not sign people out.

## Note on data sources

Web search was unavailable in this tool session (search tool quota), so
per-vendor numbers above are from my knowledge of these services at the
time of writing (late 2026) and should be verified on each vendor's pricing
page before committing — "free" tiers change, so note the verification date
in your plan.
