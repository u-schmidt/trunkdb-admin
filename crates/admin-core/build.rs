//! Reads the trunkdb version and Git revision this build links from the
//! workspace lockfile, so the app can display what it actually bundles
//! instead of a constant that could drift from the pin.

use std::path::PathBuf;

fn main() {
    let lockfile =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../Cargo.lock");
    println!("cargo:rerun-if-changed={}", lockfile.display());

    let text = std::fs::read_to_string(&lockfile).unwrap_or_default();
    let (version, revision) = trunkdb_entry(&text);
    println!("cargo:rustc-env=TRUNKDB_VERSION={version}");
    println!("cargo:rustc-env=TRUNKDB_REVISION={revision}");
}

/// The `version` and the revision after `#` in `source` of the lockfile's
/// `trunkdb` package; "unknown" for whatever is missing (a path dependency
/// has no source line).
fn trunkdb_entry(lockfile: &str) -> (String, String) {
    let mut version = "unknown".to_string();
    let mut revision = "unknown".to_string();
    let mut lines = lockfile.lines();
    while let Some(line) = lines.next() {
        if line.trim() != r#"name = "trunkdb""# {
            continue;
        }
        for line in lines.by_ref().take_while(|line| !line.trim().is_empty()) {
            if let Some(value) = quoted(line, "version") {
                version = value.to_string();
            } else if let Some(value) = quoted(line, "source")
                && let Some((_, rev)) = value.rsplit_once('#')
            {
                revision = rev.to_string();
            }
        }
        break;
    }
    (version, revision)
}

fn quoted<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.trim()
        .strip_prefix(key)?
        .trim_start()
        .strip_prefix('=')?
        .trim()
        .strip_prefix('"')?
        .strip_suffix('"')
}
