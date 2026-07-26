#!/usr/bin/env bash
# Render'daki son ortak kaydı indirir.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RENDER_URL="${RENDER_URL:-https://bozok-financial-dashboard.onrender.com}"
OUT="${1:-$ROOT_DIR/dashboard-state-import.json}"

echo "==> Render state indiriliyor: $RENDER_URL"
TMP="$(mktemp)"
curl -fsSL "${RENDER_URL%/}/api/dashboard-state" -o "$TMP"

if docker ps --format '{{.Names}}' | grep -qx bozok-app; then
  docker cp "$TMP" bozok-app:/tmp/render-export.json
  docker exec bozok-app node -e "
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('/tmp/render-export.json', 'utf8'));
const state = raw.state || raw;
fs.writeFileSync('/data/dashboard-state-import.json', JSON.stringify(state, null, 2));
console.log('state bytes:', Buffer.byteLength(JSON.stringify(state)));
"
  docker cp bozok-app:/data/dashboard-state-import.json "$OUT"
else
  node -e "
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
fs.writeFileSync(process.argv[2], JSON.stringify(raw.state || raw, null, 2));
" "$TMP" "$OUT" 2>/dev/null || python3 -c "
import json, sys
raw = json.load(open(sys.argv[1], encoding='utf-8'))
json.dump(raw.get('state') or raw, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
" "$TMP" "$OUT"
fi

rm -f "$TMP"
echo "==> Kaydedildi: $OUT"
