#!/bin/sh
# Builds the `trunkdb` command from exactly the revision this tool is pinned
# to (read from Cargo.lock), into target/pinned-cli. The CLI tests use it as
# an independent second process and implementation-side witness.
set -eu
cd "$(dirname "$0")/.."

source_line=$(grep -A2 '^name = "trunkdb"$' Cargo.lock | grep '^source = ')
url=$(printf '%s' "$source_line" | sed -E 's/^source = "git\+([^?#"]+).*/\1/')
rev=$(printf '%s' "$source_line" | sed -E 's/.*#([0-9a-f]+)"$/\1/')

echo "installing trunkdb CLI at $rev"
cargo install --quiet --git "$url" --rev "$rev" --root target/pinned-cli --locked trunkdb
target/pinned-cli/bin/trunkdb help >/dev/null
echo "target/pinned-cli/bin/trunkdb"
