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

#[test]
fn a_read_only_groups_list_hears_a_write_that_changes_a_group_it_counts() {
    use trunkdb_admin_core::GroupRequest;

    let fixture = Fixture::new();
    fixture.insert("people", &[r#"{"name": "Ann", "city": "Bonn"}"#]);
    fixture.manager.close(fixture.session.id()).unwrap();

    let session = fixture.manager.open_read_only(&fixture.path).unwrap();
    let request = GroupRequest {
        request_id: 1,
        collection: "people".into(),
        filter: FilterInput::Text(r#"city = "Bonn""#.into()),
        unwind: Vec::new(),
        group_by: vec!["city".into()],
        columns: Vec::new(),
        sort: None,
        page: 0,
        page_size: 50,
    };
    let watch = session.watch_groups(&request).unwrap();
    settle(&watch);

    let writer = Database::open(&fixture.path).unwrap();
    let people = writer.collection::<Document>("people");
    // Another city is outside the filter, so no group changes.
    people
        .insert(doc(r#"{"name": "Dee", "city": "Hamburg"}"#))
        .unwrap();
    assert_eq!(watch.wait(Duration::from_secs(1)), Wait::Quiet);

    people
        .insert(doc(r#"{"name": "Cy", "city": "Bonn"}"#))
        .unwrap();
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

#[test]
fn a_watcher_signals_a_burst_once_and_nothing_after_it_is_dropped() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use trunkdb_admin_core::ListWatcher;

    let fixture = Fixture::new();
    fixture.insert("people", &[r#"{"name": "Ann", "age": 41}"#]);
    fixture.manager.close(fixture.session.id()).unwrap();
    let session = fixture.manager.open_read_only(&fixture.path).unwrap();
    let filter = FilterInput::Text(r#"name = "Bo""#.into());

    let signals = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&signals);
    let watcher = ListWatcher::start(&session, "people", &filter, move || {
        counted.fetch_add(1, Ordering::SeqCst);
    })
    .unwrap();
    // Let the first reports (the documents already there) pass.
    std::thread::sleep(Duration::from_secs(2));
    let before = signals.load(Ordering::SeqCst);

    let writer = Database::open(&fixture.path).unwrap();
    let people = writer.collection::<Document>("people");
    for name in ["Bo", "Bo", "Bo"] {
        people
            .insert(doc(&format!(r#"{{"name": "{name}"}}"#)))
            .unwrap();
    }
    std::thread::sleep(Duration::from_secs(2));
    let burst = signals.load(Ordering::SeqCst) - before;
    assert!(
        (1..3).contains(&burst),
        "a burst of three writes signalled {burst} times"
    );

    drop(watcher);
    people.insert(doc(r#"{"name": "Bo"}"#)).unwrap();
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(signals.load(Ordering::SeqCst), before + burst);

    drop(people);
    drop(writer);
    fixture.manager.close(session.id()).unwrap();
}
