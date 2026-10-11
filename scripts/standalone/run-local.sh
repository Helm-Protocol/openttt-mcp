#!/usr/bin/env bash
set -euo pipefail
bundle_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
: "${DEMO_TLS_CERT_FILE:?Set a customer-owned TLS certificate path}"
: "${DEMO_TLS_KEY_FILE:?Set the matching TLS private-key path}"
export DEMO_RUST_BIN="$bundle_dir/bin/openttt-draft13-reference"
export DEMO_HOST="${DEMO_HOST:-127.0.0.1}"
export DEMO_PORT="${DEMO_PORT:-8090}"
export DEMO_PUBLIC_URL="${DEMO_PUBLIC_URL:-https://localhost:$DEMO_PORT}"
reference_state_dir="${TTTPS_STATE_DIR:-$HOME/.local/state/tttps-v2-reference}"
mkdir -p -- "$reference_state_dir"
chmod 700 -- "$reference_state_dir"
export DEMO_HOLDER_KEY_FILE="$reference_state_dir/holder.pem"
export DEMO_EVENT_LOG="$reference_state_dir/events.jsonl"
export DEMO_STATS_FILE="$reference_state_dir/stats.json"
exec node "$bundle_dir/demo/gate_challenge.mjs"
