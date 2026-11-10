#!/bin/sh
# The fresh start before every test: trunkdb-admin's fixture (a new sample
# database, listed in the recent files), plus a second recent entry,
# gone.trunkdb, whose file doesn't exist, for the "File not found" test.
set -eu
dir=${1:?usage: prepare.sh <empty folder>}
here=$(cd "$(dirname "$0")" && pwd)
"$here/../scripts/wdio-fixture.sh" "$dir"
node -e '
  const fs = require("fs");
  const [file, gone] = process.argv.slice(1);
  const recent = JSON.parse(fs.readFileSync(file, "utf-8"));
  recent.paths.push(gone);
  fs.writeFileSync(file, JSON.stringify(recent));
' "$dir/state/recent-files.json" "$dir/gone.trunkdb"
