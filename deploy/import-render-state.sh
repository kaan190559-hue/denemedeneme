#!/usr/bin/env bash
# dashboard-state-import.json -> Postgres
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FILE="${1:-$ROOT_DIR/dashboard-state-import.json}"

if [ ! -f "$FILE" ]; then
  echo "Dosya yok: $FILE — once: bash deploy/migrate-from-render.sh"
  exit 1
fi

echo "==> Dosya container'a kopyalaniyor..."
docker cp "$FILE" bozok-app:/data/dashboard-state-import.json

echo "==> Postgres'e yaziliyor..."
docker exec bozok-app node -e "
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('/data/dashboard-state-import.json', 'utf8'));
fetch('http://127.0.0.1:10000/api/dashboard-state', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ state, actor: 'RenderImport', forceReplace: true })
}).then(async r => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  console.log('Import OK, updatedAt:', data.state?.updatedAt || data.updatedAt);
}).catch(e => { console.error(e.message); process.exit(1); });
"

echo "==> Import tamam."
