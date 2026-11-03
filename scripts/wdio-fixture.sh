#!/bin/sh
# Prepares a UI test run in an empty folder: a fresh sample database, and a
# state folder whose recent files list it, so a test opens it from the
# start screen without the native file dialog (which WebDriver can't
# reach). Prints the variable to start the test build with:
#
#   TRUNKDB_ADMIN_STATE_DIR=<folder>/state
#
# Only the test build (scripts/build-wdio-test.sh) reads that variable.
set -eu
dir=${1:?usage: scripts/wdio-fixture.sh <empty folder>}
cd "$(dirname "$0")/.."

mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
if [ -n "$(ls -A "$dir")" ]; then
  echo "$dir is not empty" >&2
  exit 1
fi
mkdir "$dir/state"
cargo run --quiet -p trunkdb-admin-core --example make_sample -- "$dir/sample.trunkdb" >&2
node -e '
  const [file, database] = process.argv.slice(1);
  require("fs").writeFileSync(file, JSON.stringify({ paths: [database], read_only: [] }));
' "$dir/state/recent-files.json" "$dir/sample.trunkdb"
echo "TRUNKDB_ADMIN_STATE_DIR=$dir/state"
