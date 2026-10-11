# Current Track A package

Use `tttps-instance-reference-20261011-musl.tar.gz` for the static Rust reference.
Its manifest SHA256 is `8b126deabb4057efc9e31b1a13763a64889a124966c3f0e36602f5d9eff926d9`.
See `docs/ami-upgrade/TRACK-A.md` and its source/binary/test binding evidence.
The first GNU archive below is historical and requires GLIBC_2.39 for Rust.
Actual AWS boot remains outside the verified local scope.

# Instance reference package

`tttps-instance-reference-20261011.tar.gz` is the Linux x86_64 local reference
package with portable explicit XDP installation and inert MemoryDB preparation.
See docs/ami-upgrade/README.md for prerequisites, activation boundaries and limits.

Manifest SHA256 inside the archive:
`96acfd2bbf28a5a07acc481a777b89866a12d345baeb3d86d97d620ebddf0e6f`

Obtain this hash from a trusted repository revision/handoff. The archive does
not upgrade an AMI snapshot or start services. The included Rust executable is
reused from the previously verified 2026-10-10 reference artifact; no new AWS
boot validation is claimed. Subsequent same-revision local execution evidence is in
`docs/ami-upgrade/validation-20261011/result.json`; this supersedes the original
syntax-only validation scope without changing the archive.
