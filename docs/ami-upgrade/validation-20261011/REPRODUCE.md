# Same-revision local validation

Tested implementation revision: `64736ed94598a358ed972f7d7fa477de50b26e12`.
The later evidence commit does not modify implementation or the published archive.
Result JSON binds source SHA256, rebuilt/packaged/running Rust SHA256, archive
SHA256, tests and log hashes. Included logs are from this execution, not reused.

Commands: `node --test scripts/no_cost_hardening.test.mjs`,
`cargo test --offline --locked --manifest-path rust-reference/Cargo.toml`,
`cargo build --release --offline --locked --manifest-path rust-reference/Cargo.toml`.

Privileged integration uses private mount/network namespaces. The XDP script
installs under private /etc overlay and libexec mounts, attaches to an isolated
dummy interface, executes two kernel packet runs, simulates a foreign attachment,
checks refusal and unloads the owned program. The gate script verifies the published
manifest, rejects overwrite/corruption, starts the installed wrapper on isolated
loopback with generated private test TLS material, executes the 21-case gate
regression, compares running Rust hash and restores a prior release's health.

Do not execute the privileged steps on a customer's live interface or without
namespace isolation. Raw private state and test keys are deliberately excluded.
Full systemd boot, AWS boot and managed MemoryDB integration remain outside this
local validation contract. An initial simulation harness error is recorded in
result.json; implementation source remained unchanged throughout validation.
