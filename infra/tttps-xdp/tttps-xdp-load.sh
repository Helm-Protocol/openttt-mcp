#!/usr/bin/env bash
set -euo pipefail
IFACE="${1:?Supply the reviewed ingress interface; no provider-specific default}"
BASE="${2:-/opt/helm-protocol/openttt-mcp/infra/tttps-xdp}"
PIN="/sys/fs/bpf/tttps_xdp"
[[ "$IFACE" =~ ^[a-zA-Z0-9_.:-]+$ ]] || { echo 'Invalid interface' >&2; exit 1; }
command -v bpftool >/dev/null
command -v ip >/dev/null
mountpoint -q /sys/fs/bpf || { echo 'Mount bpffs before activation' >&2; exit 1; }
# Never detach an existing program, even when its name matches. Stop its owner first.
existing=$(ip -j -details link show dev "$IFACE" | python3 -c 'import json,sys; x=json.load(sys.stdin)[0].get("xdp",{}); print(x.get("prog",{}).get("id",x.get("prog_id",0)))')
[[ "$existing" == 0 ]] || { echo "Interface already has XDP id=$existing; refusing replacement" >&2; exit 1; }
[[ ! -e "$PIN" ]] || { echo 'Existing XDP pin; reconcile its owner before activation' >&2; exit 1; }
[[ -f "$BASE/tttps_xdp.o" ]] || { echo 'Build the XDP object before activation' >&2; exit 1; }
bpftool prog load "$BASE/tttps_xdp.o" "$PIN" type xdp
if ! ip link set dev "$IFACE" xdpgeneric pinned "$PIN"; then
    rm -f -- "$PIN"
    exit 1
fi
echo "tttps-xdp attached iface=$IFACE mode=generic pin=$PIN"
