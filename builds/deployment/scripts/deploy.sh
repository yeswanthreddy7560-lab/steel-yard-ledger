#!/usr/bin/env bash
# One-click blue/green deploy for Steel Yard Ledger.
#
#   1. Builds the new image (docker build -t steel-yard-ledger:app .).
#   2. Starts the new container; it must pass its /api/health check first.
#   3. Only after the new container is healthy, the old container is stopped
#      and the new one re-verified, then the old container is removed and the
#      new one is renamed to the canonical name.
#   4. If the new container is not healthy after cutover, the old container is
#      restarted (rollback) and the deploy is reported as failed.
#   5. Notifies via scripts/alert.sh (webhook when ALERT_WEBHOOK_URL is set).
#
# Zero-downtime note: while the new container is being health-checked the old
# one keeps serving through the edge; the old container is stopped only after
# the new one has passed /api/health and a confirmation window, so requests
# keep flowing to a verified backend throughout the handoff.
set -euo pipefail

APP_CONTAINER="steel-yard-ledger-app"
NEW_CONTAINER="${APP_CONTAINER}-new"
IMAGE="steel-yard-ledger:app"

log() { echo "[deploy] $*"; }

cd "$(dirname "$0")/.."

docker info >/dev/null 2>&1 || { echo "[deploy] docker is not available" >&2; exit 1; }

log "building image $IMAGE"
docker build -t "$IMAGE" .

OLD_ID=$(docker ps -aq -f "name=^/${APP_CONTAINER}$" || true)
if [ -n "$OLD_ID" ]; then
  NETWORK=$(docker inspect -f '{{range $net := .NetworkSettings.Networks}}{{$net}} {{end}}' \
    "$APP_CONTAINER" | awk '{print $1}')
else
  NETWORK=""
fi
[ -n "$NETWORK" ] || NETWORK="steel-yard-ledger_default"
docker network inspect "$NETWORK" >/dev/null 2>&1 || NETWORK="steel-yard-ledger_default"

if [ -n "$NETWORK" ]; then
  NETWORK_FLAG="--network $NETWORK"
else
  NETWORK_FLAG=""
fi

# Clean up any stale new container from a previous failed run.
docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true

log "starting new container $NEW_CONTAINER"
docker run -d \
  --name "$NEW_CONTAINER" \
  $NETWORK_FLAG \
  --restart unless-stopped \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e DATA_DIR=/data \
  -e TRUST_PROXY=true \
  -e COOKIE_SECURE=true \
  -v steel-yard-ledger-data:/data \
  --health-cmd "wget -qO- http://127.0.0.1:3000/api/health || exit 1" \
  --health-interval 5s \
  --health-retries 20 \
  --health-timeout 5s \
  --health-start-period 15s \
  --label "traefik.enable=true" \
  --label 'traefik.http.routers.app.rule=PathPrefix(`/`)' \
  "$IMAGE"

healthy=""
for _ in $(seq 1 60); do
  s=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$NEW_CONTAINER" 2>/dev/null || echo none)
  if [ "$s" = "healthy" ]; then healthy=1; break; fi
  sleep 2
done
if [ -z "$healthy" ]; then
  log "new container never became healthy; removing it"
  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  ./scripts/alert.sh "Deploy failed" "Steel Yard Ledger deploy: new container $NEW_CONTAINER never passed /api/health." critical
  exit 1
fi
log "new container is healthy"

if [ -n "$OLD_ID" ]; then
  log "stopping old container $APP_CONTAINER"
  docker stop "$APP_CONTAINER" >/dev/null || true
  sleep 4
  s=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$NEW_CONTAINER" 2>/dev/null || echo none)
  if [ "$s" != "healthy" ]; then
    log "new container unhealthy after cutover; rolling back"
    docker start "$APP_CONTAINER" >/dev/null || true
    ./scripts/alert.sh "Deploy rolled back" "Steel Yard Ledger deploy: new container $NEW_CONTAINER became unhealthy after cutover; the old container was restarted." critical
    exit 1
  fi
  log "removing old container $APP_CONTAINER"
  docker rm -f "$APP_CONTAINER" >/dev/null || true
fi

docker rename "$NEW_CONTAINER" "$APP_CONTAINER" 2>/dev/null || true

# Final in-container verification through the app's own health endpoint.
docker exec "$APP_CONTAINER" wget -qO- http://127.0.0.1:3000/api/health >/dev/null || {
  log "post-cutover health check failed"
  ./scripts/alert.sh "Deploy failed" "Steel Yard Ledger deploy: in-container /api/health failed after cutover." critical
  exit 1
}

log "deploy complete: $APP_CONTAINER runs $IMAGE"
./scripts/alert.sh "Deployed" "Steel Yard Ledger redeployed (image $IMAGE, container $APP_CONTAINER)." info
