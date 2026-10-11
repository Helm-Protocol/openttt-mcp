# Explicit Linux instance XDP deployment

These files install into a launched instance, not an AMI image. No AWS API,
cloud resource, AMI registration or permission change occurs. The current public
AMI state is preserved by leaving its snapshot and launch permissions untouched.
Existing AMI launches do not automatically receive this package.

The program limits IPv4 TCP packets targeting 8090 and 8443, with source-IP
and port buckets. It is generic XDP, not native/NIC offload and not GRG or TLS
payload validation. IPv6, other ports, volumetric link saturation and hard
multicore rate ceilings are outside the established contract. Shared bucket
increments are not an atomic global exact packet budget.

Prerequisites: Linux with generic XDP/BPF support, root capabilities, mounted
bpffs, clang with BPF backend, make, Linux headers, iproute2, bpftool and Python3.
Use the distribution's approved installation process for missing tools. The
installer does not download packages or create infrastructure.

1. Identify the real ingress interface with `ip route` and `ip -details link`.
   AWS names vary; do not assume ens4 or select an interface based solely on provider.
2. Review existing services and XDP attachments. Existing installations are
   rejected rather than overwritten. Arrange a separate transition if present.
3. From this directory, set an unused release path and install files:
   `sudo TTTPS_XDP_BASE=/opt/tttps-xdp/release-20261011 ./install-instance.sh ens5`
   Replace ens5 with the reviewed interface. This command does not start services.
4. Review `/etc/tttps-xdp.conf` and ensure bpffs is mounted. Explicit activation:
   `sudo systemctl daemon-reload`
   `sudo systemctl enable --now tttps-xdp.service`
5. Confirm the program identity using `ip -details link` and `bpftool prog show`.
   Enable tttps-epi only after reviewing its adaptive port-limit policy. It reads
   source-distribution counters and changes rate ceilings, not application proofs.
6. Stop Epi first, then XDP for rollback. Unload refuses a foreign program ID.
   Instance activation and kernel compatibility must be verified on the actual
   customer's kernel; file installation alone is not evidence of attachment.

TLS ends at the authorized Node gate; its live exporter and the Rust holder
verification determine application admission. Never replace that boundary with
caller-supplied exporter HTTP headers. Legacy services remain until explicit
operator cutover. Replay MemoryDB activation is a separate paid onboarding step.
