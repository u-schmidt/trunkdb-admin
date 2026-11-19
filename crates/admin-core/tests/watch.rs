//! A read-only list hears the changes to what it shows, made by another
//! program beside it (spike): nothing for documents it doesn't show, one
//! signal for those it does, and the watch ends with its session.

mod common;

use common::{Fixture, doc};
use std::time::Duration;
use trunkdb::{Database, Document};
use trunkdb_admin_core::{FilterInput, Wait};

/// Waits until nothing has come for half a second: the first reports, the
/// documents already there, are read here.
fn settle(watch: &trunkdb_admin_core::ListWatch) {
    while watch.wait(Duration::from_millis(500)) != Wait::Quiet {}
}

#[test]
fn a_read_only_list_hears_a_matching_write_beside_it_and_not_another() {
    let fixture = Fixture::new();
    fixture.insert("people", &[r#"{"name": "Ann", "age": 41}"#]);
    fixture.manager.close(fixture.session.id()).unwrap();

    let session = fixture.manager.open_read_only(&fixture.path).unwrap();
    let watch = session
        .watch_list("people", &FilterInput::Text(r#"name = "Bo""#.into()))
        .unwrap();
    settle(&watch);

    // Another program writes while the list is open read-only here.
    let writer = Database::open(&fixture.path).unwrap();
    let people = writer.collection::<Document>("people");
    people.insert(doc(r#"{"name": "Cy"}"#)).unwrap();
    assert_eq!(watch.wait(Duration::from_secs(1)), Wait::Quiet);

    people.insert(doc(r#"{"name": "Bo"}"#)).unwrap();
    assert_eq!(watch.wait(Duration::from_secs(5)), Wait::Changed);

    drop(people);
    drop(writer);
    fixture.manager.close(session.id()).unwrap();
    assert_eq!(watch.wait(Duration::from_secs(5)), Wait::Ended);
}

/// Ignored by default: needs the pinned CLI (`npm run test:cli`, or
/// `scripts/install-pinned-cli.sh` then `cargo test --test watch -- --ignored`).
/// The write comes from a separate process, as another program's would.
#[test]
#[ignore]
fn a_write_by_the_pinned_cli_reaches_a_read_only_list() {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let cli = std::env::var_os("TRUNKDB_CLI")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/pinned-cli/bin/trunkdb")
        });
    assert!(cli.is_file(), "no trunkdb CLI at {}", cli.display());

    let fixture = Fixture::new();
    fixture.insert("people", &[r#"{"name": "Ann", "age": 41}"#]);
    fixture.manager.close(fixture.session.id()).unwrap();
    let session = fixture.manager.open_read_only(&fixture.path).unwrap();
    let watch = session
        .watch_list("people", &FilterInput::Text(r#"name = "Bo""#.into()))
        .unwrap();
    settle(&watch);

    let batch = |ops: &str| {
        let mut child = Command::new(&cli)
            .args(["batch", fixture.path.to_str().unwrap(), "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(ops.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };

    batch(r#"{"op": "insert", "collection": "people", "document": {"name": "Cy"}}"#);
    assert_eq!(watch.wait(Duration::from_secs(1)), Wait::Quiet);
    batch(r#"{"op": "insert", "collection": "people", "document": {"name": "Bo"}}"#);
    assert_eq!(watch.wait(Duration::from_secs(5)), Wait::Changed);

    fixture.manager.close(session.id()).unwrap();
}
