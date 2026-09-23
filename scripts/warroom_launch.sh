#!/usr/bin/env bash
# Build Day war room launcher. Left screen. Reads the live verdict stream.
set -euo pipefail
REDIS="${TTTPS_REDIS:-redis://127.0.0.1:6380}"
STREAM="${TTTPS_AUDIT_STREAM:-tttps:audit:v2}"
if [[ "${1:-}" == "--reset" ]]; then
  redis-cli -u "$REDIS" DEL "$STREAM" >/dev/null 2>&1 || true
  redis-cli -u "$REDIS" --scan --pattern 'tttps:v2:replay:*' 2>/dev/null | xargs -r redis-cli -u "$REDIS" DEL >/dev/null 2>&1 || true
  echo "baseline reset."
fi
exec env REDIS_URL="$REDIS" node "$(dirname "$0")/war_room.mjs" --stream "$STREAM"
