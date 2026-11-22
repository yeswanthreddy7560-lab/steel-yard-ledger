# Cloudflare Tunnel — public URL for Steel Yard Ledger

The app runs locally at `http://127.0.0.1:3000`. Cloudflare Tunnel publishes it to the internet through `cloudflared`. Two modes:

## Quick Tunnel (free, public, **not permanent**)

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

You will see output like:

```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
  https://my-app-name.trycloudflare.com
```

Notes:

- Save the printed `*.trycloudflare.com` URL — it is a free, public URL.
- **It is not permanent.** The name is provided by Cloudflare's free quick tunnels and may be reclaimed or changed at any time when the tunnel is unused or capacity is needed. Treat it as a temporary URL.
- The tunnel stays running; the URL is printed once and must be saved by you.
- Health check used by `scripts\run-cloudflare-tunnel.ps1`: `GET http://127.0.0.1:3000/api/health` (app route at `src/routes/pages.js:86`) through the tunnel URL, expecting `200 OK`.

## Named Tunnel (permanent, free with a Cloudflare account + your own domain)

For a URL you control — e.g. `https://steel-yard-ledger.yourdomain.com` — create a named tunnel and route your own domain to it:

```powershell
cloudflared tunnel login                       # one-time auth with your Cloudflare account
cloudflared tunnel create steel-yard-ledger    # creates the named tunnel and its token
```

Then add the public hostname in the Zero Trust dashboard (or via `cloudflared tunnel route dns`):

```
Network → Connectors → Tunnels → steel-yard-ledger → Public Hostnames
  hostname:  steel-yard-ledger.yourdomain.com
  service:   http://127.0.0.1:3000
```

Then keep it running:

```powershell
cloudflared tunnel run steel-yard-ledger
```

With the tunnel running, the URL under your own domain stays up as long as you maintain the tunnel and the domain — this is the closest Cloudflare offers to a permanent URL.

## Recommended scripts

- `scripts\start-app.ps1` — starts `node server.js` if nothing is listening on port 3000 (the app is already detected as running on this machine).
- `scripts\run-cloudflare-tunnel.ps1` — downloads the latest `cloudflared` if missing, starts `cloudflared tunnel --url http://127.0.0.1:3000`, parses the `*.trycloudflare.com` URL, health-checks `/api/health` through the tunnel, and prints the URL plus usage notes.

## Saving the URL

Write the URL into your password manager, docs, or a `urls.txt` file with the date. For the permanent option, save the domain you routed (e.g. `steel-yard-ledger.yourdomain.com`).
