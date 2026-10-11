# Frozen AMI instance upgrade package

This package upgrades an explicitly selected launched Linux x86_64 instance.
It does not change an existing AMI snapshot, register/copy an image, launch an
instance, change launch permissions or create MemoryDB resources. Existing
AMI storage and already-running instance costs remain; no additional AWS
resources are required merely to prepare these files. Instance installation
uses its existing disk, CPU and operator-approved access.

## Reference gate

Node18+, compatible Linux x86_64/glibc and customer TLS certificate/key are
required. The reference gate contains an ephemeral issuer and in-memory canary
balances. It is not a customer business DB or durable production replay store.
The declared Unix-us timing profile is not full TAI/Roughtime synthesis.

1. Extract the archive to a new directory. Obtain the manifest SHA256 through
   a separately trusted release/handoff channel; a checksum alone is not a signature.
2. Set `TTTPS_EXPECTED_MANIFEST_SHA256` and run `./install-local.sh` as the
   selected local user. It verifies files, creates a new versioned release,
   and neither starts nor enables a service.
3. Set customer `DEMO_TLS_CERT_FILE`, `DEMO_TLS_KEY_FILE`, `TTTPS_STATE_DIR`,
   `DEMO_HOST`, `DEMO_PORT`, `DEMO_PUBLIC_URL`. Rehearse on an unused loopback port.
4. Start the installed `run-local.sh` explicitly. `/health` identifies the Rust
   reference and `/v2/verify`; `/v1/legacy` returns 410. The TLS terminator derives
   the exporter from the live socket, not an HTTP request header. Remote clients
   use the instance's private address, not their own localhost.
5. Preserve the existing service until a reviewed explicit cutover. Rollback
   stops this release and restores the prior routing. Do not transfer old tokens
   by padding or replay-state reset. Local replay/issuer state resets on restart.

## Optional L4 XDP

Read `infra/tttps-xdp/README.md`. Supply the actual ingress interface explicitly.
Installation and activation are separate; existing services/programs are not
silently replaced. Generic XDP filters IPv4 TCP 8090/8443; it does not validate
TLS-encrypted holder proofs or GRG, protect every port or guarantee volumetric
DDoS immunity. The Epi controller changes rate ceilings only when separately enabled.

## MemoryDB preparation only

The adapter and Terraform template are included as onboarding preparation.
No network connection or resource is activated by import, packaging or installation.
The reference gate does not automatically select MemoryDB from an environment
variable. Paid customer onboarding supplies primary routing, noeviction policy,
credentials and durable business idempotency/recovery integration. See
`infra/memorydb/README.md`; no self-hosted Redis dependency is introduced.

## Build provenance

From a checkout with local dependencies/build outputs already available:
`python3 scripts/standalone/build-bundle.py --rust-bin /reviewed/reference --output /new/output`
The builder consumes reviewed artifacts, makes no cloud calls and records their
hashes. Build Rust with `cargo build --release --offline --locked --manifest-path
rust-reference/Cargo.toml` only when relevant source changes require it. Node
outputs come from `npm run build` using installed dependencies. No secret keys,
certificates, real TLS exporters or production event logs belong in the archive.

## Evidence and limitations

Historical local evidence (2026-10-10) covered strict decoded JSON duplicates,
replay freshness lifetime, isolated/offline installation and TLS boundary cases.
The new portable deployment scripts require actual customer kernel/attachment
verification after explicit installation; historical tests do not cover these
new scripts. No AWS boot test or MemoryDB service integration is asserted.
Draft13 baseline tags remain frozen; no Draft14 work is included in this release.
