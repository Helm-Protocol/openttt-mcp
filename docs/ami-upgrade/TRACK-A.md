# Track A: post-launch instance update, frozen AMI and listing

## What is updated

Keep the existing AMI ID and launch permissions. Install the versioned reference
package into an explicitly selected instance after launch, validate it on an
unused local port, and then perform an operator-approved routing cutover.
This changes that instance, not the source AMI or Marketplace catalog version.
Future launches need the same explicit installation; existing snapshots are not
rewritten. No automatic service change or automatic billing-resource creation
is performed by the package.

## AWS documentation and review boundary

AWS documents updating running AL2023 instances independently of new AMI releases:
https://aws.amazon.com/linux/amazon-linux-2023/faqs/

Marketplace adding a new AMI version invokes scanning/review. Changing an AMI
associated with a catalog version requires a new version; even updating listing
usage instructions is a submitted change request:
https://docs.aws.amazon.com/marketplace/latest/userguide/single-ami-versions.html

This Track A procedure invokes none of those catalog/image change operations.
That is the basis for proceeding without submitting a new AMI version. It is
not an AWS promise that review probability is zero: continuing Marketplace
requirements and compliance scans still apply:
https://docs.aws.amazon.com/marketplace/latest/userguide/product-and-ami-policies.html

## Correct current package

Use `releases/tttps-instance-reference-20261011-musl.tar.gz`.
The earlier bounded-flood archive and first GNU instance-reference archive
contain a Rust executable requiring GLIBC_2.39, and must not be described as
immediately compatible with the older AL2023 base. They remain historical
artifacts. The new Rust executable is static MUSL, with no ELF interpreter or
shared-library dependency. Node18+ and customer TLS configuration remain
prerequisites; actual AWS kernel/boot compatibility is not yet measured.

Archive SHA256: fa5831e02f71dbf5b3f847b41d35093704be1ea7f7b8afdf2efd1f96bf74d340
Manifest SHA256: 8b126deabb4057efc9e31b1a13763a64889a124966c3f0e36602f5d9eff926d9

After transferring the reviewed archive to the selected instance:

```sh
printf '%s  %s
' 'fa5831e02f71dbf5b3f847b41d35093704be1ea7f7b8afdf2efd1f96bf74d340' 'tttps-instance-reference-20261011-musl.tar.gz' | sha256sum --check --strict
mkdir tttps-upgrade-review
# Extract only after authenticating the handoff/release revision and checksum.
tar -xzf tttps-instance-reference-20261011-musl.tar.gz -C tttps-upgrade-review
cd tttps-upgrade-review/tttps-instance-reference
export TTTPS_EXPECTED_MANIFEST_SHA256=8b126deabb4057efc9e31b1a13763a64889a124966c3f0e36602f5d9eff926d9
./install-local.sh
```

The installer prints the new release path and does not start services. Supply
customer certificate/key paths, private state path, loopback host and an unused
port, then start its `run-local.sh` explicitly. Perform health and actual holder
proof verification before cutover. The new and old service must not both accept
writes for the same business/replay domain. Customer transaction/idempotency
integration is outside the reference canary contract. Do not reset replay state
or pad legacy143B records to admit old tokens; use fresh v2 issuance.

For XDP, follow `infra/tttps-xdp/README.md` using the actual instance ingress
interface. Installation does not activate it. Reconcile pre-existing attachment
owners before activation; the loader refuses replacement. Retain the previous
release/service and routing record for rollback. Restore routing only with the
appropriate live claim/business-state transition, not an unconditional switch.

## Cost and measured scope

Preparing/distributing/installing the package creates no new AWS resource.
Launching a new EC2 instance incurs EC2/storage charges; stopping does not remove
all storage charges. An existing instance's existing charges also remain. No
MemoryDB resource or connection is started by this procedure.

Local same-source MUSL tests: Rust codec3 and replay/JSON7; frozen Draft13 vectors;
installed real TLS21; checksum install/overwrite and corruption refusal; prior
reference release health restored. See `track-a-evidence/result.json` for source,
binary, archive and log binding. Historical477 assertions are a separate baseline,
not a claim that477 tests were rerun on AWS or this new native target.
