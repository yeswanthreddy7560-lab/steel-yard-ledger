#!/usr/bin/env bash
# Poll the app health endpoint; print the result and exit 0 when healthy.
# Usage: scripts/healthcheck.sh [url]   (default: http://127.0.0.1:3000/api/health)
set -uo pipefail

URL="${1:-http://127.0.0.1:3000/api/health}"
TIMEOUT="${HEALTHCHECK_TIMEOUT:-5}"

status=""
latency=""
body=""
rc=0

if command -v curl >/dev/null 2>&1; then
  raw=$(curl -sS --max-time "$TIMEOUT" -w 'STATUS=%{http_code} LATENCY=%{time_total}' "$URL" 2>&1); rc=$?
  status=$(printf '%s' "$raw" | sed -n 's/^STATUS=\([0-9]*\).*/\1/p')
  latency=$(printf '%s' "$raw" | sed -n 's/^.*LATENCY=\([0-9.]*\).*/\1/p')
  body=$(printf '%s' "$raw" | sed '/^STATUS=/d; /LATENCY=/d')
elif command -v node >/dev/null 2>&1; then
  raw=$(node -e '
    const url = process.argv[1];
    const timeoutMs = Number(process.argv[2]) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal })
      .then(async (r) => {
        console.log("STATUS=" + r.status);
        console.log(await r.text());
      })
      .catch((e) => {
        console.log("STATUS=000");
        console.error(String(e && e.message ? e.message : e));
      })
      .finally(() => clearTimeout(timer));
  ' "$URL" "$TIMEOUT" 2>/dev/null); rc=$?
  status=$(printf '%s' "$raw" | sed -n 's/^STATUS=\([0-9]*\).*/\1/p')
  body=$(printf '%s' "$raw" | sed '/^STATUS=/d')
else
  echo "healthcheck: neither curl nor node is available" >&2
  exit 1
fi

if [ "$rc" -ne 0 ] || [ -z "$status" ] || [ "$status" != "200" ]; then
  echo "unhealthy: $URL -> status ${status:-none}"
  [ -n "$body" ] && echo "  body: $(printf '%s' "$body" | head -c 160)"
  exit 1
fi

echo "healthy: $URL -> $status (latency ${latency:-?}s)"
