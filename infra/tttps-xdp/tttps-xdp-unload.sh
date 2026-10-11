#!/usr/bin/env bash
set -euo pipefail
IFACE="${1:?Supply the reviewed ingress interface}"
PIN="/sys/fs/bpf/tttps_xdp"
[[ "$IFACE" =~ ^[a-zA-Z0-9_.:-]+$ ]] || exit 1
[[ -e "$PIN" ]] || { echo 'No owned pin; no detach performed'; exit 0; }
owned=$(bpftool -j prog show pinned "$PIN" | python3 -c 'import json,sys; x=json.load(sys.stdin); print((x[0] if isinstance(x,list) else x)["id"])')
attached=$(ip -j -details link show dev "$IFACE" | python3 -c 'import json,sys; x=json.load(sys.stdin)[0].get("xdp",{}); print(x.get("prog",{}).get("id",x.get("prog_id",0)))')
[[ "$owned" == "$attached" ]] || { echo 'XDP owner mismatch; refusing detach' >&2; exit 1; }
ip link set dev "$IFACE" xdpgeneric off
rm -f -- "$PIN"
