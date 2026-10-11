#!/usr/bin/env bash
set -euo pipefail
bundle_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
: "${TTTPS_EXPECTED_MANIFEST_SHA256:?Supply the manifest SHA256 from the reviewed handoff}"
[[ "$TTTPS_EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid manifest hash' >&2; exit 1; }
actual_manifest_sha=$(sha256sum "$bundle_dir/MANIFEST.sha256")
[[ "${actual_manifest_sha%% *}" == "$TTTPS_EXPECTED_MANIFEST_SHA256" ]] || { echo 'Manifest does not match reviewed handoff' >&2; exit 1; }
(cd -- "$bundle_dir" && sha256sum --check --strict MANIFEST.sha256)
local_release_base="${TTTPS_INSTALL_ROOT:-$HOME/.local/lib/tttps-v2-reference}"
release_dir="$local_release_base/$TTTPS_EXPECTED_MANIFEST_SHA256"
[[ ! -e "$release_dir" ]] || { echo 'Release path already exists; no overwrite performed' >&2; exit 1; }
mkdir -p -- "$local_release_base"
staging_dir=$(mktemp -d "$local_release_base/.staging.XXXXXX")
trap 'rm -rf -- "$staging_dir"' EXIT
cp -a -- "$bundle_dir/." "$staging_dir/"
(cd -- "$staging_dir" && sha256sum --check --strict MANIFEST.sha256)
mv -- "$staging_dir" "$release_dir"
trap - EXIT
printf 'Installed reference bundle: %s\nStart explicitly with customer TLS files using run-local.sh; no service enabled.\n' "$release_dir"
