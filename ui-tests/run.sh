#!/bin/sh
# Runs TrunkDB Admin's UI test cases with GroundworkTH, each on a fresh
# sample database (the prepare command in groundwork.config.json).
#
#   ui-tests/run.sh                      all tests, as one run
#   ui-tests/run.sh admin-overview ...   just these
#   ui-tests/run.sh --suite admin-smoke  a suite
#
# Needs groundwork-th beside this repository (GROUNDWORK_TH to point
# elsewhere) and the admin's test build (groundwork build).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
groundwork=${GROUNDWORK_TH:-$here/../../groundwork-th}
exec "$groundwork/bin/groundwork.mjs" run --project "$here" "$@"
