//! Consistency check and JSONL export.

mod common;

use common::Fixture;
use std::path::{Path, PathBuf};
use trunkdb::query::Filter;
use trunkdb::{Database, Document, IndexOptions};
use trunkdb_admin_core::{ErrorCategory, SessionManager};

/// Collections of every kind: mixed shapes, tagged values, indexes with
/// options, an empty collection, and a virtual one that must not export.
fn populated() -> Fixture {
    let fx = Fixture::new();
    fx.insert(
        "people",
        &[
            r#"{"name": "Ann", "email": "a@x", "n": 9223372036854775807, "f": 2.0, "at": {"$date": "2026-03-01T12:00:00Z"}}"#,
            r#"{"name": "Bo", "email": "b@x", "bytes": {"$binary": "AAEC"}, "nan": {"$float": "NaN"}}"#,
            r#"{"name": "Cy", "tag_like": {"$object": {"$id": "text"}}, "nested": {"_id": 1}}"#,
        ],
    );
    fx.insert(
        "mixed",
        &[
            r#"{"v": [1, 2]}"#,
            r#"{"v": "text"}"#,
            r#"{"v": 42}"#,
            r#"{"v": 2.0}"#,
            r#"{"v": null}"#,
            r#"{"k": "v"}"#,
        ],
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
    fx.session.prepare_collection("virtual").unwrap();
    fx
}

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
        let mut cursor_ids = Vec::new();
        for document in collection.find(Filter::new().sort_asc("_id")).unwrap() {
            cursor_ids.push(format!("{name} doc {document}"));
        }
        // Non-objects carry no `_id`; their order by ID is the stored order.
        lines.push(format!("{name} count {}", cursor_ids.len()));
        lines.extend(cursor_ids);
    }
    lines
}

#[test]
fn a_valid_database_checks_clean_with_its_counts() {
    let fx = populated();

    let report = fx.session.check().unwrap();

    assert_eq!(report.problems, Vec::<String>::new());
    assert_eq!(
        report.collections, 3,
        "the virtual collection is not in the file"
    );
    assert_eq!(report.documents, 9);
    assert_eq!(report.pages, fx.session.file_info().unwrap().pages);
    // And nothing is left open: trunkdb would refuse to compact otherwise.
    fx.session
        .write(|db| Ok(db.compact().map(|_| ())?))
        .unwrap();
}

#[test]
fn a_damaged_database_is_never_reported_as_clean() {
    let mut fx = Fixture::new();
    let texts: Vec<String> = (0..400)
        .map(|n| format!(r#"{{"n": {n}, "text": "{}"}}"#, "x".repeat(200)))
        .collect();
    fx.insert(
        "items",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let pages = fx.session.file_info().unwrap().pages as usize;
    let page_size = fx.session.file_info().unwrap().page_size;
    fx.manager.close(fx.session.id()).unwrap();

    // Flip bytes in the middle of a data page well inside the file.
    let mut bytes = std::fs::read(&fx.path).unwrap();
    let at = (pages / 2) * page_size + page_size / 2;
    for byte in &mut bytes[at..at + 64] {
        *byte ^= 0xff;
    }
    std::fs::write(&fx.path, &bytes).unwrap();

    // Either the file no longer opens, or the check finds the damage, or
    // the check cannot finish. All three are "not clean".
    match fx.manager.open_existing(&fx.path) {
        Err(error) => assert_eq!(error.category, ErrorCategory::DamagedData, "{error}"),
        Ok(session) => {
            fx.session = session;
            match fx.session.check() {
                Ok(report) => {
                    assert!(!report.problems.is_empty(), "damage went unreported");
                    assert!(report.problems.iter().all(|problem| !problem.is_empty()));
                }
                Err(error) => assert_ne!(error.category, ErrorCategory::SessionClosed, "{error}"),
            }
        }
    }
}

#[test]
fn an_export_imports_into_an_identical_database() {
    let fx = populated();
    let out = fx.dir.path().join("export.jsonl");

    let summary = fx.session.export(&out, false).unwrap();

    assert_eq!((summary.collections, summary.documents), (3, 9));
    assert_eq!(summary.bytes, std::fs::metadata(&out).unwrap().len());
    assert_eq!(
        PathBuf::from(&summary.path),
        std::fs::canonicalize(&out).unwrap()
    );
    let text = std::fs::read_to_string(&out).unwrap();
    assert!(
        !text.contains("virtual"),
        "a virtual collection is not exported"
    );
    assert_eq!(
        text.lines().count(),
        1 + 3 + 9,
        "one line per header, collection, document"
    );

    let copy = Database::open(fx.dir.path().join("copy.trunkdb")).unwrap();
    let imported = copy.import(std::fs::File::open(&out).unwrap()).unwrap();
    assert_eq!((imported.collections, imported.documents), (3, 9));
    let original = fx.session.read(|db| Ok(contents(db))).unwrap();
    assert_eq!(contents(&copy), original);
    assert!(
        original
            .iter()
            .any(|line| line.contains("9223372036854775807"))
    );
    assert!(
        original
            .iter()
            .any(|line| line.contains(r#"["name", "email"] unique=true sparse=true"#))
    );
    assert!(copy.check().unwrap().is_ok());

    // No temporary file remains, and no snapshot.
    assert_eq!(
        entries(fx.dir.path()),
        [
            "copy.trunkdb",
            "copy.trunkdb.wal",
            "export.jsonl",
            "fixture.trunkdb",
            "fixture.trunkdb.wal"
        ]
    );
    fx.session
        .write(|db| Ok(db.compact().map(|_| ())?))
        .unwrap();
}

#[test]
fn the_database_and_its_wal_are_refused_as_destinations_under_any_name() {
    let fx = populated();
    let dir = fx.dir.path();
    let wal = dir.join("fixture.trunkdb.wal");
    assert!(wal.exists(), "the fixture's WAL is beside it");
    let symlink = dir.join("link-to-db.jsonl");
    std::os::unix::fs::symlink(&fx.path, &symlink).unwrap();
    let wal_symlink = dir.join("link-to-wal.jsonl");
    std::os::unix::fs::symlink(&wal, &wal_symlink).unwrap();
    let hard_link = dir.join("hard-link.jsonl");
    std::fs::hard_link(&fx.path, &hard_link).unwrap();
    let sub = dir.join("sub");
    std::fs::create_dir(&sub).unwrap();
    let dotted = sub.join("..").join("fixture.trunkdb");
    let dir_symlink = dir.join("dir-link");
    std::os::unix::fs::symlink(dir, &dir_symlink).unwrap();
    let before = fx.session.read(|db| Ok(contents(db))).unwrap();
    let listing = entries(dir);

    for destination in [
        fx.path.clone(),
        wal.clone(),
        symlink,
        wal_symlink,
        hard_link,
        dotted,
        dir_symlink.join("fixture.trunkdb"),
        dir_symlink.join("fixture.trunkdb.wal"),
    ] {
        for overwrite in [false, true] {
            let error = fx.session.export(&destination, overwrite).unwrap_err();
            assert_eq!(
                error.category,
                ErrorCategory::InvalidInput,
                "{} overwrite={overwrite}: {error}",
                destination.display()
            );
        }
    }

    assert_eq!(entries(dir), listing, "nothing was created");
    assert_eq!(fx.session.read(|db| Ok(contents(db))).unwrap(), before);
    assert!(fx.session.check().unwrap().problems.is_empty());
}

#[test]
fn an_existing_file_is_replaced_only_on_request() {
    let fx = populated();
    let out = fx.dir.path().join("export.jsonl");
    std::fs::write(&out, b"an earlier export").unwrap();

    let refused = fx.session.export(&out, false).unwrap_err();
    assert_eq!(refused.category, ErrorCategory::AlreadyExists);
    assert_eq!(std::fs::read(&out).unwrap(), b"an earlier export");
    assert_eq!(entries(fx.dir.path()).len(), 3, "no temporary file left");

    let summary = fx.session.export(&out, true).unwrap();
    assert_eq!(summary.documents, 9);
    assert!(
        std::fs::read_to_string(&out)
            .unwrap()
            .contains("\"people\"")
    );
    assert_eq!(entries(fx.dir.path()).len(), 3);
}

#[test]
fn an_ordinary_symlink_is_followed_to_its_target() {
    let fx = populated();
    let target = fx.dir.path().join("real.jsonl");
    std::fs::write(&target, b"old").unwrap();
    let link = fx.dir.path().join("link.jsonl");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let summary = fx.session.export(&link, true).unwrap();

    assert_eq!(
        PathBuf::from(summary.path),
        std::fs::canonicalize(&target).unwrap()
    );
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        std::fs::read_to_string(&target)
            .unwrap()
            .contains("\"people\"")
    );
}

#[test]
fn unusable_destinations_are_reported_and_create_nothing() {
    let fx = populated();
    let listing = entries(fx.dir.path());

    let folder = fx.session.export(fx.dir.path(), true).unwrap_err();
    assert_eq!(folder.category, ErrorCategory::InvalidInput);
    let missing = fx
        .session
        .export(
            &fx.dir.path().join("no-such-folder").join("out.jsonl"),
            false,
        )
        .unwrap_err();
    assert_eq!(missing.category, ErrorCategory::FileNotFound);

    assert_eq!(entries(fx.dir.path()), listing);
}

#[test]
fn a_closed_session_neither_checks_nor_exports() {
    let fx = populated();
    let out = fx.dir.path().join("export.jsonl");
    let closed = fx.session.clone();
    fx.manager.close(closed.id()).unwrap();

    assert_eq!(
        closed.check().unwrap_err().category,
        ErrorCategory::SessionClosed
    );
    assert_eq!(
        closed.export(&out, true).unwrap_err().category,
        ErrorCategory::SessionClosed
    );
    assert!(!out.exists());
}

#[test]
fn an_export_can_be_imported_by_another_session_of_the_tool() {
    let fx = populated();
    let out = fx.dir.path().join("export.jsonl");
    fx.session.export(&out, false).unwrap();
    fx.manager.close(fx.session.id()).unwrap();

    // The export stands on its own once the source is closed.
    let other = SessionManager::new();
    let copy_path = fx.dir.path().join("copy.trunkdb");
    let copy = other.create_new(&copy_path).unwrap();
    copy.write(|db| Ok(db.import(std::fs::File::open(&out).unwrap()).map(|_| ())?))
        .unwrap();

    let overview = copy.overview().unwrap();
    let counts: Vec<(&str, Option<usize>)> = overview
        .collections
        .iter()
        .map(|c| (c.name.as_str(), c.count))
        .collect();
    assert_eq!(
        counts,
        [("empty", Some(0)), ("mixed", Some(6)), ("people", Some(3))]
    );
    assert_eq!(overview.collections[2].indexes.len(), 3);
}
