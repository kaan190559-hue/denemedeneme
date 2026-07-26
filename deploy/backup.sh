#!/usr/bin/env bash
# Günlük PostgreSQL yedeği — cron: 0 4 * * * /opt/bozok/deploy/backup.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
CONTAINER="${DB_CONTAINER:-bozok-db}"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M)"
FILE="$BACKUP_DIR/bozok_${STAMP}.sql.gz"

docker exec "$CONTAINER" pg_dump -U bozok bozok_dashboard | gzip > "$FILE"
find "$BACKUP_DIR" -name "bozok_*.sql.gz" -mtime +"$RETAIN_DAYS" -delete

echo "[$(date -Iseconds)] Backup OK: $FILE ($(du -h "$FILE" | cut -f1))"
