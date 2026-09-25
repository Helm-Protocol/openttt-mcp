#!/usr/bin/env bash
set -euo pipefail

IFACE="${1:-ens4}"
BASE="${2:-/opt/helm-protocol/openttt-mcp/infra/tttps-xdp}"
PIN="/sys/fs/bpf/tttps_xdp"

mkdir -p /sys/fs/bpf
make -C "$BASE"
ip link set dev "$IFACE" xdpgeneric off 2>/dev/null || true
rm -f "$PIN"
bpftool prog load "$BASE/tttps_xdp.o" "$PIN" type xdp
ip link set dev "$IFACE" xdpgeneric pinned "$PIN"
echo "tttps-xdp attached iface=$IFACE mode=generic pin=$PIN"
