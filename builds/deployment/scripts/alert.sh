#!/usr/bin/env bash
# Post an alert to any configured webhook (Slack, PagerDuty, Opsgenie, ...).
# No-op when no webhook URL is configured.
# Usage: scripts/alert.sh <title> <message> [severity]
set -uo pipefail

TITLE="${1:-Alert}"
MESSAGE="${2:-}"
SEVERITY="${3:-info}"

URL="${ALERT_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-${PAGERDUTY_INTEGRATION_URL:-}}}"
[ -z "$URL" ] && exit 0

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

if command -v curl >/dev/null 2>&1; then
  PAYLOAD=$(printf '{"title": "%s", "message": "%s", "severity": "%s", "time": "%s"}' \
    "$(json_str "$TITLE")" "$(json_str "$MESSAGE")" "$SEVERITY" "$TS")
  if curl -fsS -X POST -H 'Content-Type: application/json' --data "$PAYLOAD" "$URL"; then
    echo "[alert] ${SEVERITY}: ${TITLE}"
  else
    echo "[alert] failed to deliver: ${TITLE}" >&2
  fi
elif command -v node >/dev/null 2>&1; then
  node -e '
    const [title, message, severity, url, time] = process.argv.slice(1);
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, message, severity, time })
    })
      .then(() => console.log("[alert] " + severity + ": " + title))
      .catch((e) => {
        console.error("[alert] failed to deliver: " + (e && e.message ? e.message : e));
        process.exit(1);
      });
  ' "$TITLE" "$MESSAGE" "$SEVERITY" "$URL" "$TS"
else
  echo "[alert] no curl/node to deliver: ${TITLE}" >&2
fi

exit 0
