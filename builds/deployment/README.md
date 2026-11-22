# Steel Yard Ledger — Deployment Package

A **private** web application for the material and hardware master catalogue —
the catalogue is served only to signed-in users, new accounts stay locked
until an administrator approves them, and everything an operator cares about
is in this deployment package: one-click deploys, Docker, CI/CD, observability,
backups, alerts, and zero-downtime upgrades.

The app itself is a copy of thesteel-yard-ledger app, extended with:

- **`src/routes/metrics.js`** — a Prometheus endpoint at `GET /api/metrics`
  exposing app summary counts (users, items, customers, events, ...),
  in-process request counters, and a latency histogram.
- **`docker-compose.yml`** — production stack: Traefik edge proxy, the app,
  and node-exporter, plus a `monitoring` profile (Prometheus, Grafana,
  Alertmanager).
- **`Makefile`** — one-command operations (`make up`, `make deploy`,
  `make backup`, `make monitoring`, `make status`, ...).
- **`scripts/`** — `healthcheck.sh`, `deploy.sh` (blue/green one-click
  deploy), `backup.sh`, `alert.sh` (webhook alerts).
- **`monitoring/`** — Prometheus config + alert rules, a Grafana dashboard
  ("Steel Yard Ledger"), Alertmanager routing, Grafana provisioning.
- **`.github/workflows/`** — CI (syntax checks, `npm run ci` with isolated
  Firestore prefixes, Docker build + smoke test) and CD (blue/green deploy on
  push to `main`).
- **`scripts/healthcheck.sh`** polling `/api/health` — used by the app's own
  health checks, the deploy script, and `make status`.

The `data/` folder holds the Firebase service account (`firebase-service-account.json`)
and the session secret, so the package runs out of the box. **Treat the
service account as a secret**: do not commit it, and rotate it in the
Firebase console after copying (Project settings → Service accounts →
Generate new private key, then delete the old one).

## Quick start (one-click)

```powershell
cd builds\deployment
make up                  # docker compose up --build --wait (edge proxy + app + node-exporter)
```

Then open the app through the edge proxy: <http://127.0.0.1/> (Traefik routes
to the app; `/api/health` answers through it).

Useful one-liners:

```powershell
make deploy              # Blue/green one-click deploy (scripts\deploy.sh)
make backup              # Firestore JSON backup (scripts\backup.sh)
make monitoring          # Prometheus + Grafana + Alertmanager + node-exporter
make status              # Container status + health check
make logs                # Tail app logs
make test-app            # App test suites (npm run ci)
```

Without Docker, run the app directly:

```powershell
cd builds\deployment
npm start                # http://127.0.0.1:3000 (serves /api/health, catalogue, admin, ...)
```

Requires Node 22.5+ and the service account at `data\firebase-service-account.json`
(already present in the package).

## Architecture

```
Traefik (edge, :80)          edge proxy; routes only to healthy backends
  └── app (internal, :3000)  Express app — /api/health, /api/metrics,
                             /catalogue, /admin, /customers, /orders, ...
  └── node-exporter (:9100)  host metrics (optional)
Prometheus (:9090) ──► app + node-exporter (scraped every 15s)
Grafana (:3010)    ◄── dashboards from monitoring\grafana\dashboards\
Alertmanager (:9093) ◄── routes alerts to your webhook (Slack, PagerDuty, ...)
```

## Zero-downtime deploys

`make deploy` runs `scripts\deploy.sh`, a **blue/green** handoff:

1. Builds the new image (`steel-yard-ledger:app`).
2. Starts the new container and waits until its `/api/health` passes.
3. Only after the new container is healthy, stops the old one and verifies the
   new one stays healthy.
4. Removes the old container and renames the new one to the canonical name.

If the new container is not healthy after cutover, the script restarts the old
container (rollback) and alerts via `scripts\alert.sh`. During the short
handoff window Traefik routes to both backends while the new one is verified,
so there is no failed request on the edge.

## Observability (Prometheus + Grafana + Alertmanager)

`make monitoring` starts the monitoring stack on the same compose project.

- **App metrics** (`GET /api/metrics`): `steel_yard_ledger_up`, version,
  uptime, users/categories/items/customers/security_events/ip_bans/images/
  pending_writes, `http_requests_total`, `http_server_errors_total`, and a
  latency histogram (`http_request_duration_seconds_bucket`/`_sum`/`_count`).
- **Node metrics**: CPU, memory, disk, network usage of the host.
- **Dashboards**: "Steel Yard Ledger" in Grafana (port 3010) — health stats,
  counts, HTTP requests/errors/p95 latency, and node graphs.
- **Alert rules** (`monitoring/prometheus/alerts.yml`): app down, server-error
  rate, p95 latency, low host disk.
- **Alerting**: configure `ALERT_WEBHOOK_URL` (or `SLACK_WEBHOOK_URL` /
  `PAGERDUTY_INTEGRATION_URL`) so Grafana alerts reach you, and edit the
  placeholder URL in `monitoring/alertmanager/alertmanager.yml` for the
  Alertmanager route.

## Backups

`make backup` runs `scripts\backup.sh` → `node scripts\firestore-backup.js`:
a JSON export of Firestore (users, catalogue, customers, events, images, ...)
to `data\backups\firestore\` (the app keeps the 14 newest). For a daily run:

```powershell
crontab -e
#   @daily cd C:\path\to\steel-yard-ledger\builds\deployment && .\scripts\backup.sh
```

Restore = put the desired export back into Firestore (see `docs\deploy.md`),
or use the app's `npm run firestore-status` for inventory/counts.

## Alerting summary

- Deploy script notifies on success/failure/rollback via `scripts\alert.sh`.
- Prometheus alert rules cover: app down (critical), server-error rate
  (warning), p95 latency (warning), low disk (critical).
- Configure a webhook URL (Slack incoming webhook, PagerDuty, Opsgenie, ...).
  `scripts\alert.sh` posts JSON `{title, message, severity, time}` and is a
  no-op when no webhook is configured.

## Configuration

Key environment variables (see `.env.example` and `docs/api.md` for the rest):

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3000` | App bind address/port (container) |
| `NODE_ENV` | `production` | Secure-cookie defaults, logging |
| `DATA_DIR` | `/data` | Volume mount (service account, session secret, logs, backups) |
| `APP_ORIGIN` | request-derived | Exact origin expected on API writes |
| `TRUST_PROXY` / `COOKIE_SECURE` | `true` in production | Behind the edge proxy |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | generated | Bootstrap admin account |
| `REGISTRATION_ENABLED` | `true` | Allow new access requests |
| `SMTP_*` / `MAIL_FROM` | — | Self-service password recovery (needs an SMTP relay) |
| `ALERT_WEBHOOK_URL` | — | Where alerts go (deploy script + ops) |

## Security notes

- The Firebase service account in `data\` is a live secret — never commit it;
  rotate it after copying.
- `data/session-secret` should stay stable across restarts so sign-ins and
  recovery codes survive redeploys.
- `npm run ci` (CI + local) runs the app suites; `security-test` and
  `customer-test` write only to **isolated Firestore collection prefixes**
  (wiped afterwards) — production data is never touched. They need the
  service account (set `FIREBASE_SERVICE_ACCOUNT_PATH` or pass
  `FIREBASE_SERVICE_ACCOUNT_JSON`).

## Project layout (deployment package)

```
builds/deployment/
├── src/                        App source (catalogue, customers, admin, auth,
│   └── routes/metrics.js         landing; + new Prometheus metrics endpoint)
├── data/                       Runtime files (service account, session secret)
├── Dockerfile                  Non-root, healthchecked container image
├── docker-compose.yml          Edge proxy + app + node-exporter
│                               (+ `monitoring` profile: Prometheus, Grafana,
│                                  Alertmanager)
├── Makefile                    One-command operations
├── README.md                   This file
├── scripts/                    App scripts + deployment scripts
│   ├── healthcheck.sh            Poll /api/health with latency report
│   ├── deploy.sh                 Blue/green one-click deploy
│   ├── backup.sh                 Firestore backup + retention
│   └── alert.sh                  Webhook alerting helper
├── monitoring/
│   ├── prometheus/prometheus.yml, alerts.yml
│   ├── grafana/dashboards/steel-yard-ledger.json
│   │   └── provisioning/dashboards/app.yaml
│   └── alertmanager/alertmanager.yml
├── .github/workflows/ci.yml, cd.yml
└── (app docs, docs/, views/, public/, functions/, data.js, ...)
```

## Testing

```powershell
make test-app                # smoke + customer + security suites (npm run ci)
```

`scripts/smoke-test.js` boots the app and checks the health endpoint, public
landing/`/catalogue`/`/customers` redirects, and 404s. The other suites need
Firestore access (see the security notes).
