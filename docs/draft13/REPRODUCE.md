# Draft-13 baseline

This baseline freezes protocol artifacts, not the npm package version (0.4.7).
AMI IDs and customer installations are unchanged. No AMI bootstrap or automatic
Git pull claim is made. Use an explicit checkout; `git pull` alone does not select
a frozen tag.

```sh
git clone https://github.com/helm-protocol/openttt-mcp.git
cd openttt-mcp
git checkout --detach draft-13-baseline
npm ci
npm run build
npm test -- --runInBand
cargo test --locked --manifest-path rust-reference/Cargo.toml
node scripts/export_draft13_vectors.mjs > /tmp/draft13-ts.json
cargo run --locked --manifest-path rust-reference/Cargo.toml --bin export-vectors > /tmp/draft13-rust.json
python3 - <<'PY'
import json
a=json.load(open('/tmp/draft13-ts.json'))
b=json.load(open('/tmp/draft13-rust.json'))
assert a['vectors']==b['vectors']
assert a['exporter_fixture']==b['exporter_fixture']
print('TypeScript / Rust / published Appendix B: byte-identical')
PY
```

The published text is vendored as `published-draft13.txt` from
https://www.ietf.org/archive/id/draft-helmprotocol-tttps-13.txt.
The extraction command independently generates the records, signatures, hashes,
direction-bound context, binding input, holder proof and presentation, and
compares every published Ed25519 and PSK field before producing JSON. Public
deterministic seeds and exporter fixtures are test data. They do not reproduce
TLS handshake secrets. Actual TLS exporters never appear in these artifacts.
Published Appendix B already matches; no alteration or new IETF submission is required.

## Public verification boundary

| Route | Contract |
| --- | --- |
| `https://api.kenosian.com:8090/v2/verify` | Default 180B v2 Rust cryptographic verifier, then replay claim and canary commitment |
| `/mcp/db-write` on the same TLS service | Compatibility alias to the same Rust path; never a legacy verifier |
| `/v1/legacy` and descendants on the same service | HTTP 410; 143B requires reissuance, no padding or implicit conversion |
| Core Rust service `/api/v1/tttps/seal_143b[_bin]` | Explicit existing v1/143B service; unchanged frozen customer interfaces |

The demo TLS terminator is Node, and a persistent Rust child checks the 180B
record, pinned issuer and holder, action context, freshness and direction-bound
proof. The terminator obtains the exporter from the request's live TLS socket;
it ignores any exporter/issuer supplied by the HTTP caller. Exporters only cross
anonymous local parent-child pipes, never a public HTTP bridge or disk log.
Replay claim and canary DB commitment are serialized at the Node application
boundary. `/v2/verify` includes that commitment, rather than claiming ACCEPT on
cryptographic validation alone. Health identifies the engine and default route.

This is a bounded in-memory canary with an explicit legacy Unix-us timing
profile, not full Draft-13 TAI synthesis or source-evidence conformance. It does
not establish volumetric DDoS resistance. The reference crate is self-contained
and avoids the original Rust server's private absolute path dependencies.

## Live gate reproduction

Build `cargo build --release --locked --manifest-path rust-reference/Cargo.toml`.
Set `DEMO_TLS_CERT_FILE`, `DEMO_TLS_KEY_FILE`, and a private
`DEMO_HOLDER_KEY_FILE` before `node demo/gate_challenge.mjs`.
The holder key is local test equipment and must not be published.
Run `TEST_GATE_PORT=8090 TEST_GATE_HOST=api.kenosian.com
TEST_HOLDER_KEY=/private/local/holder.pem node scripts/gate_integrity_check.mjs`
as one shell command. It checks cross-session theft, direction reflection,
signature/argument mutation, canonical encoding, replay and DB non-mutation on
rejection, plus one authorized canary write and transport rejection.
