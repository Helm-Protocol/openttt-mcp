#!/usr/bin/env bash
set -euo pipefail
IFACE="${1:-ens4}"
PIN="/sys/fs/bpf/tttps_xdp"
ip link set dev "$IFACE" xdpgeneric off 2>/dev/null || true
rm -f "$PIN"
