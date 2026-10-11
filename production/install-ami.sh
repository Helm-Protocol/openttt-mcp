#!/usr/bin/env bash
# Run on the explicitly approved AMI build instance with /opt/openttt/v2 staged.
set -euo pipefail
base=/opt/openttt/v2
install -d -m 750 -o root -g openttt /etc/openttt/v2
install -m 755 "$base/production/first-boot.sh" /usr/local/libexec/openttt-v2-first-boot
install -m 644 "$base/production/openttt-v2.service" "$base/production/openttt-v2-init.service" "$base/production/openttt-v2-metering.service" "$base/production/tttps-legacy-guard.service" /etc/systemd/system/
install -m 644 "$base/production/legacy-guard.nft" /etc/openttt/v2/legacy-guard.nft
install -m 755 "$base/infra/tttps-xdp/tttps-xdp-load.sh" /usr/local/libexec/tttps-xdp-load
install -m 755 "$base/infra/tttps-xdp/tttps-xdp-unload.sh" /usr/local/libexec/tttps-xdp-unload
install -m 644 "$base/infra/tttps-xdp/tttps-xdp.service" /etc/systemd/system/
install -d -m 755 /etc/systemd/system/tttps-xdp.service.d
cat > /etc/systemd/system/tttps-xdp.service.d/customer-init.conf <<'EOF'
[Unit]
After=openttt-v2-init.service
Requires=openttt-v2-init.service

[Service]
ExecStartPre=/usr/bin/mountpoint -q /sys/fs/bpf
EOF
mountpoint -q /sys/fs/bpf || mount -t bpf bpf /sys/fs/bpf
if ! grep -q '^[^#].*[[:space:]]/sys/fs/bpf[[:space:]]' /etc/fstab; then printf '\nbpf /sys/fs/bpf bpf defaults 0 0\n' >> /etc/fstab; fi
test -f /usr/share/zoneinfo/right/UTC
if ! grep -q '^leapsectz ' /etc/chrony.conf; then
  printf '\nleapsectz right/UTC\n' >> /etc/chrony.conf
  systemctl restart chronyd
fi
systemctl daemon-reload
systemctl enable --now tttps-legacy-guard openttt-v2-init tttps-xdp openttt-v2 openttt-v2-metering
