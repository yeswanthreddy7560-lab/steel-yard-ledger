#!/usr/bin/env bash
# Run a Firestore JSON backup of the Steel Yard Ledger data.
#
# The export is done by the app itself (node scripts/firestore-backup.js), which
# writes JSON files to data/backups/firestore/ and keeps the 14 newest. This
# script adds failure alerting and an extra safety-net retention pass.
#
# For a daily cron, add to `crontab -e`:
#   @daily cd <path-to>/steel-yard-ledger/builds/deployment && .\scripts\backup.sh
set -uo pipefail

cd "$(dirname "$0")/.."

log() { echo "[backup] $*"; }

if ! command -v node >/dev/null 2>&1; then
  echo "[backup] node is required to run backups" >&2
  exit 1
fi

log "starting Firestore backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/firestore-backup.js || {
  ./scripts/alert.sh "Backup failed" "Firestore JSON backup failed." critical
  exit 1
}

# Safety net retention: keep at most 30 files (the app keeps 14 by default).
BACKUP_DIR="data/backups/firestore"
if [ -d "$BACKUP_DIR" ]; then
  i=0
  ls -t "$BACKUP_DIR"/*.json 2>/dev/null | while IFS= read -r f; do
    [ -z "$f" ] && continue
    i=$((i + 1))
    if [ "$i" -gt 30 ]; then
      [ -f "$f" ] && rm -f "$f"
    fi
  done
fi

log "backup finished at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
./scripts/alert.sh "Backup completed" "Firestore backup completed (see data/backups/firestore)." info
exit 0
