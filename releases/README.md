# Instance reference package

`tttps-instance-reference-20261011.tar.gz` is the Linux x86_64 local reference
package with portable explicit XDP installation and inert MemoryDB preparation.
See docs/ami-upgrade/README.md for prerequisites, activation boundaries and limits.

Manifest SHA256 inside the archive:
`96acfd2bbf28a5a07acc481a777b89866a12d345baeb3d86d97d620ebddf0e6f`

Obtain this hash from a trusted repository revision/handoff. The archive does
not upgrade an AMI snapshot or start services. The included Rust executable is
reused from the previously verified 2026-10-10 reference artifact; no new AWS
boot validation is claimed. New XDP scripts have syntax/build checks only.
