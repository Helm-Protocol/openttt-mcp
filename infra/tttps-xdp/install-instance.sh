#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} == 0 ]] || { echo 'Run as root for local file installation' >&2; exit 1; }
IFACE="${1:?Supply the customer-approved ingress interface}"
[[ "$IFACE" =~ ^[a-zA-Z0-9_.:-]+$ ]] || { echo 'Invalid interface' >&2; exit 1; }
ip link show dev "$IFACE" >/dev/null
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
: "${TTTPS_XDP_BASE:?Set a new absolute release directory}"
[[ "$TTTPS_XDP_BASE" =~ ^/[a-zA-Z0-9_./-]+$ && ! -e "$TTTPS_XDP_BASE" ]] || { echo 'Release path must be absolute and unused' >&2; exit 1; }
for f in /etc/tttps-xdp.conf /etc/systemd/system/tttps-xdp.service /etc/systemd/system/tttps-epi.service /usr/local/libexec/tttps-xdp-load /usr/local/libexec/tttps-xdp-unload; do
 [[ ! -e "$f" ]] || { echo "Existing installation: $f; no overwrite performed" >&2; exit 1; }
done
# Compile before installing files. This does not attach or detach XDP.
make -C "$src"
install -d -m 755 "$TTTPS_XDP_BASE" /usr/local/libexec
cp -a -- "$src/." "$TTTPS_XDP_BASE/"
install -m 755 "$src/tttps-xdp-load.sh" /usr/local/libexec/tttps-xdp-load
install -m 755 "$src/tttps-xdp-unload.sh" /usr/local/libexec/tttps-xdp-unload
install -m 644 "$src/tttps-xdp.service" /etc/systemd/system/tttps-xdp.service
sed "s|/opt/helm-protocol/openttt-mcp/infra/tttps-xdp|$TTTPS_XDP_BASE|g" "$src/tttps-epi.service" > /etc/systemd/system/tttps-epi.service
printf 'TTTPS_XDP_IFACE=%s\nTTTPS_XDP_BASE=%s\n' "$IFACE" "$TTTPS_XDP_BASE" > /etc/tttps-xdp.conf
chmod 600 /etc/tttps-xdp.conf
printf 'Installed local files only. Review config, mount bpffs if needed, then explicitly daemon-reload and activate services.\n'
