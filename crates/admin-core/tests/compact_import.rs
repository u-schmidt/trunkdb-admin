//! Compact and import into a new database, on real files.

mod common;

use common::{Fixture, doc};
use std::path::Path;
use std::sync::mpsc;
use trunkdb::query::Filter;
use trunkdb::{Database, Document, IndexOptions};
use trunkdb_admin_core::{ErrorCategory, SessionManager};

fn entries(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Everything a database holds, as comparable text: per collection its
/// index definitions and its documents with their IDs.
fn contents(db: &Database) -> Vec<String> {
    let mut lines = Vec::new();
    for name in db.collections().unwrap() {
        let collection = db.collection::<Document>(&name);
        for index in collection.indexes().unwrap() {
            lines.push(format!(
                "{name} index {:?} unique={} sparse={}",
                index.fields(),
                index.is_unique(),
                index.is_sparse()
            ));
        }
        for document in collection.find(Filter::new().sort_asc("_id")).unwrap() {
            lines.push(format!("{name} {document}"));
        }
    }
    lines
}

/// Every kind of value, two collections with indexes, an empty one.
fn populated() -> Fixture {
    let fx = Fixture::new();
    fx.insert(
        "people",
        &[
            r#"{"name": "Ann", "email": "a@x", "n": 9223372036854775807, "f": 2.0, "at": {"$date": "2026-03-01T12:00:00Z"}}"#,
            r#"{"name": "Bo", "email": "b@x", "bytes": {"$binary": "AAEC"}, "nan": {"$float": "NaN"}}"#,
            r#"{"name": "Cy", "tag_like": {"$object": {"$id": "text"}}, "meta": {"k": [1, 2.5]}}"#,
        ],
    );
    fx.insert(
        "mixed",
        &[r#"{"v": [1, 2]}"#, r#"{"v": "text"}"#, r#"{"v": null}"#],
    );
    fx.session
        .write(|db| {
            let people = db.collection::<Document>("people");
            people.ensure_index("name")?;
            people.ensure_index_with("email", IndexOptions::new().unique())?;
            people.ensure_index_with(["name", "email"], IndexOptions::new().unique().sparse())?;
            db.collection::<Document>("empty")
                .ensure_index_with("x", IndexOptions::new().sparse())?;
            Ok(())
        })
        .unwrap();
    fx
}

// --- Compact ---

#[test]
fn compact_shrinks_the_file_to_the_estimate_and_changes_no_document() {
    let fx = Fixture::new();
    let texts: Vec<String> = (0..3000)
        .map(|n| format!(r#"{{"n": {n}, "pad": "{}"}}"#, "x".repeat(200)))
        .collect();
    fx.insert(
        "things",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    fx.session
        .write(|db| {
            let things = db.collection::<Document>("things");
            things.ensure_index("n")?;
            things.delete_many(Filter::new().lt("n", 2500))?;
            Ok(())
        })
        .unwrap();
    let before = fx.session.read(|db| Ok(contents(db))).unwrap();
    let storage = fx.session.storage().unwrap();
    assert!(storage.compacted_pages < storage.pages, "something to free");

    let report = fx.session.compact().unwrap();

    assert_eq!(report.pages_before, storage.pages);
    assert_eq!(
        report.pages_after, storage.compacted_pages,
        "the estimate is exact"
    );
    assert_eq!(report.page_size, 8192);
    assert_eq!(fx.session.storage().unwrap().pages, report.pages_after);
    assert_eq!(fx.session.read(|db| Ok(contents(db))).unwrap(), before);
    assert!(fx.session.check().unwrap().problems.is_empty());
    assert_eq!(
        std::fs::metadata(&fx.path).unwrap().len(),
        report.pages_after * report.page_size
    );

    // Already as small: nothing written.
    let again = fx.session.compact().unwrap();
    assert_eq!(again.pages_before, again.pages_after);
}

#[test]
fn compact_is_a_write_refused_read_only() {
    let fx = Fixture::new();
    fx.insert("things", &[r#"{"n": 1}"#]);
    fx.manager.close(fx.session.id()).unwrap();
    let session = fx.manager.open_read_only(&fx.path).unwrap();
    let before = std::fs::read(&fx.path).unwrap();

    let error = session.compact().unwrap_err();

    assert_eq!(error.category, ErrorCategory::ReadOnly);
    assert_eq!(std::fs::read(&fx.path).unwrap(), before);
}

#[test]
fn a_snapshot_held_by_a_read_makes_compact_try_again_later() {
    let fx = Fixture::new();
    let texts: Vec<String> = (0..500).map(|n| format!(r#"{{"n": {n}}}"#)).collect();
    fx.insert(
        "things",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    fx.session
        .write(|db| {
            db.collection::<Document>("things")
                .delete_many(Filter::new().lt("n", 400))?;
            Ok(())
        })
        .unwrap();
    let pages = fx.session.storage().unwrap().pages;

    let (held_tx, held_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let session = std::sync::Arc::clone(&fx.session);
    let reader = std::thread::spawn(move || {
        session.read(|db| {
            let snapshot = db.snapshot()?;
            held_tx.send(()).unwrap();
            done_rx.recv().unwrap();
            drop(snapshot);
            Ok(())
        })
    });
    held_rx.recv().unwrap();

    let error = fx.session.compact().unwrap_err();

    done_tx.send(()).unwrap();
    reader.join().unwrap().unwrap();
    assert_eq!(error.category, ErrorCategory::Busy, "{error:?}");
    assert_eq!(
        fx.session.storage().unwrap().pages,
        pages,
        "nothing changed"
    );
    assert!(
        fx.session.compact().unwrap().pages_after < pages,
        "later it runs"
    );
}

// --- Import ---

#[test]
fn an_import_makes_a_new_database_equal_to_the_exported_one() {
    let fx = populated();
    let export = fx.dir.path().join("shop.jsonl");
    fx.session.export(&export, false).unwrap();
    let original = fx.session.read(|db| Ok(contents(db))).unwrap();
    let destination = fx.dir.path().join("shop.trunkdb");

    // While the exported database is open: the import touches nothing open.
    let summary = fx.manager.import_into_new(&export, &destination).unwrap();

    assert_eq!(summary.collections, 3);
    assert_eq!(summary.documents, 6);
    assert_eq!(
        summary.path,
        std::fs::canonicalize(&destination)
            .unwrap()
            .display()
            .to_string()
    );
    assert_eq!(
        summary.bytes,
        std::fs::metadata(&destination).unwrap().len()
    );
    // Only the new file: no temporary file, no WAL.
    assert_eq!(
        entries(fx.dir.path()),
        [
            "fixture.trunkdb",
            "fixture.trunkdb.wal",
            "shop.jsonl",
            "shop.trunkdb"
        ]
    );
    fx.manager.close(fx.session.id()).unwrap();
    let imported = fx.manager.open_existing(&destination).unwrap();
    assert_eq!(imported.read(|db| Ok(contents(db))).unwrap(), original);
    assert!(imported.check().unwrap().problems.is_empty());
}

#[test]
fn an_existing_destination_is_refused_and_left_as_it_is() {
    let fx = populated();
    let export = fx.dir.path().join("shop.jsonl");
    fx.session.export(&export, false).unwrap();
    let destination = fx.dir.path().join("taken.trunkdb");
    std::fs::write(&destination, b"someone's file").unwrap();

    let error = fx
        .manager
        .import_into_new(&export, &destination)
        .unwrap_err();

    assert_eq!(error.category, ErrorCategory::AlreadyExists);
    assert_eq!(std::fs::read(&destination).unwrap(), b"someone's file");
    // A symlink there counts as taken too, wherever it points.
    let link = fx.dir.path().join("link.trunkdb");
    #[cfg(unix)]
    std::os::unix::fs::symlink(fx.dir.path().join("nowhere"), &link).unwrap();
    #[cfg(unix)]
    assert_eq!(
        fx.manager
            .import_into_new(&export, &link)
            .unwrap_err()
            .category,
        ErrorCategory::AlreadyExists
    );
}

/// An export of `n` documents in one collection, as JSON Lines: one
/// exported for the header lines, the rest written without an `_id`,
/// which an import gives a new one, before an end line that counts
/// them all.
fn big_export(fx: &Fixture, n: usize) -> std::path::PathBuf {
    fx.insert("things", &[r#"{"n": 0}"#]);
    let export = fx.dir.path().join("things.jsonl");
    fx.session.export(&export, false).unwrap();
    let mut text = without_end(&std::fs::read_to_string(&export).unwrap());
    for i in 1..n {
        text.push_str(&format!("{{\"n\": {i}}}\n"));
    }
    std::fs::write(&export, with_end(text, n)).unwrap();
    export
}

/// An export's lines without its end line, which counts what it holds
/// (trunkdb SPEC §165).
fn without_end(text: &str) -> String {
    let end = text.trim_end().rfind('\n').unwrap() + 1;
    assert!(text[end..].starts_with(r#"{"$end""#), "{text}");
    text[..end].to_string()
}

/// The lines of one collection's export with an end line counting
/// `documents`.
fn with_end(mut text: String, documents: usize) -> String {
    text.push_str(&format!(
        "{{\"$end\":{{\"collections\":1,\"documents\":{documents}}}}}\n"
    ));
    text
}

#[test]
fn a_broken_line_names_its_line_and_leaves_nothing() {
    let fx = Fixture::new();
    let export = big_export(&fx, 3000);
    let text = std::fs::read_to_string(&export).unwrap();
    let mut lines: Vec<&str> = text.lines().collect();
    // Past the first batches trunkdb has written (§30.3).
    lines[1500] = r#"{"_id": {"$id": "01"#;
    std::fs::write(&export, lines.join("\n")).unwrap();
    let destination = fx.dir.path().join("new.trunkdb");
    let before = entries(fx.dir.path());

    let error = fx
        .manager
        .import_into_new(&export, &destination)
        .unwrap_err();

    assert_eq!(error.category, ErrorCategory::InvalidInput, "{error:?}");
    assert!(error.message.contains("can't be read"), "{error:?}");
    assert!(error.detail.unwrap().contains("1501"), "the line, from 1");
    assert_eq!(
        entries(fx.dir.path()),
        before,
        "no destination, no temporary file"
    );
}

#[test]
fn an_id_twice_is_the_exports_fault_and_leaves_nothing() {
    let fx = Fixture::new();
    let export = big_export(&fx, 10);
    let text = std::fs::read_to_string(&export).unwrap();
    let with_id = text
        .lines()
        .find(|line| line.contains("\"_id\""))
        .unwrap()
        .to_string();
    let lines = format!("{}{with_id}\n", without_end(&text));
    std::fs::write(&export, with_end(lines, 11)).unwrap();
    let destination = fx.dir.path().join("new.trunkdb");
    let before = entries(fx.dir.path());

    let error = fx
        .manager
        .import_into_new(&export, &destination)
        .unwrap_err();

    assert_eq!(error.category, ErrorCategory::InvalidInput, "{error:?}");
    assert!(error.message.contains("twice"), "{error:?}");
    assert_eq!(entries(fx.dir.path()), before);
}

#[test]
fn an_open_database_or_its_wal_is_refused_as_the_source() {
    let fx = populated();
    let destination = fx.dir.path().join("new.trunkdb");
    let wal = fx.dir.path().join("fixture.trunkdb.wal");
    let link = fx.dir.path().join("alias.jsonl");
    std::fs::hard_link(&fx.path, &link).unwrap();
    for source in [&fx.path, &wal, &link] {
        let error = fx
            .manager
            .import_into_new(source, &destination)
            .unwrap_err();
        assert_eq!(error.category, ErrorCategory::InvalidInput, "{source:?}");
        assert!(error.message.contains("open database"), "{error:?}");
    }
    assert!(!destination.exists());
}

#[test]
fn a_missing_source_or_a_folder_creates_nothing() {
    let fx = Fixture::new();
    let destination = fx.dir.path().join("new.trunkdb");
    let missing = fx.dir.path().join("missing.jsonl");
    assert_eq!(
        fx.manager
            .import_into_new(&missing, &destination)
            .unwrap_err()
            .category,
        ErrorCategory::FileNotFound
    );
    let folder = fx.dir.path().join("folder");
    std::fs::create_dir(&folder).unwrap();
    assert!(fx.manager.import_into_new(&folder, &destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn app_exit_waits_for_an_import_and_starts_no_new_one() {
    let fx = Fixture::new();
    let export = big_export(&fx, 20_000);
    let manager = std::sync::Arc::new(SessionManager::new());
    let destination = fx.dir.path().join("new.trunkdb");

    let importer = std::thread::spawn({
        let manager = std::sync::Arc::clone(&manager);
        let (export, destination) = (export.clone(), destination.clone());
        move || manager.import_into_new(&export, &destination)
    });
    // Give it a moment to start; whether it has or not, exit waits for
    // it or it doesn't start.
    std::thread::sleep(std::time::Duration::from_millis(20));
    manager.close_all();
    let finished = importer.join().unwrap();

    match finished {
        Ok(summary) => {
            assert_eq!(summary.documents, 20_000);
            let imported = Database::open(&destination).unwrap();
            assert_eq!(
                imported
                    .collection::<Document>("things")
                    .count(Filter::new())
                    .unwrap(),
                20_000
            );
        }
        Err(error) => {
            assert_eq!(error.category, ErrorCategory::Busy);
            assert!(!destination.exists());
        }
    }
    let after = manager
        .import_into_new(&export, &fx.dir.path().join("later.trunkdb"))
        .unwrap_err();
    assert_eq!(after.category, ErrorCategory::Busy);
    let _ = doc("{}");
}
