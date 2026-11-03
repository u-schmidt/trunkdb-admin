#!/bin/sh
# Builds TrunkDB Admin WITH an embedded WebDriver server, for UI tests
# through WebDriver only. Never use this build for anything else: the server
# takes JavaScript and full control of the window from anyone on this
# machine, on every launch.
#
# Kept apart from the normal build on every side:
# - the `wdio-test` Cargo feature, off by default, links the plugin;
# - the permission for it is given here, through TAURI_CONFIG, never by a
#   file in src-tauri/capabilities (Tauri reads every file there);
# - its own build folder, target/wdio-test, so `npm run tauri build` never
#   picks it up;
# - its own identifier, so even without TRUNKDB_ADMIN_STATE_DIR it keeps
#   recent files and preferences apart from the real app's.
#
# `tauri build`, not `cargo build`: only it builds the frontend first.
# Prints the path of the binary to test.
set -eu
cd "$(dirname "$0")/.."

export CARGO_TARGET_DIR="$PWD/target/wdio-test"
export TAURI_CONFIG='{
  "identifier": "io.github.u-schmidt.trunkdb-admin.wdio-test",
  "app": {
    "security": {
      "capabilities": [
        "default",
        {
          "identifier": "wdio-test",
          "windows": ["main"],
          "permissions": ["wdio-webdriver:default"]
        }
      ]
    }
  }
}'
npx tauri build --features wdio-test --no-bundle >&2
echo "$CARGO_TARGET_DIR/release/trunkdb-admin"
