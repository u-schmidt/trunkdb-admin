//! Opening a database read-only (trunkdb SPEC §88): nothing is
//! written to the file or its WAL, every write is refused as `read_only`,
//! and a WAL a crash left is shown from memory.

mod common;

use common::{Fixture, doc};
use std::path::{Path, PathBuf};
use trunkdb::Document;
use trunkdb_admin_core::{
    ErrorCategory, FilterInput, IndexRequest, SaveRequest, Session, SessionManager,
};

fn wal(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".wal");
    PathBuf::from(name)
}

/// The bytes of the database and of its WAL, `None` where there is none.
fn bytes(path: &Path) -> (Vec<u8>, Option<Vec<u8>>) {
    (std::fs::read(path).unwrap(), std::fs::read(wal(path)).ok())
}

fn refused<T: std::fmt::Debug>(result: Result<T, trunkdb_admin_core::AppError>) {
    let error = result.expect_err("a write must be refused");
    assert_eq!(error.category, ErrorCategory::ReadOnly, "{error:?}");
}

/// A database with one collection, one index and one document, closed.
fn closed_fixture() -> (Fixture, String) {
    let fixture = Fixture::new();
    let id = fixture.insert("people", &[r#"{"name": "Ann", "age": 41}"#])[0].to_string();
    fixture
        .session
        .create_index(&IndexRequest {
            collection: "people".into(),
            fields: vec!["age".into()],
            unique: false,
            sparse: false,
        })
        .unwrap();
    fixture.manager.close(fixture.session.id()).unwrap();
    (fixture, id)
}

fn every_write_is_refused(session: &Session, id: &str) {
    refused(session.save_document(&SaveRequest {
        collection: "people".into(),
        id: None,
        json: r#"{"name": "Bo"}"#.into(),
        filter: FilterInput::default(),
    }));
    refused(session.save_document(&SaveRequest {
        collection: "people".into(),
        id: Some(id.into()),
        json: r#"{"name": "Ann", "age": 42}"#.into(),
        filter: FilterInput::default(),
    }));
    refused(session.delete_document("people", id));
    refused(session.drop_collection("people"));
    refused(session.create_index(&IndexRequest {
        collection: "people".into(),
        fields: vec!["name".into()],
        unique: false,
        sparse: false,
    }));
    refused(session.drop_index("people", &["age".into()]));
    // A virtual collection could never be stored.
    refused(session.prepare_collection("drafts"));
    // Past the app's own gate, through a read: trunkdb refuses it, and
    // the error is the same category.
    refused(session.read(|db| {
        Ok(db
            .collection::<Document>("people")
            .insert(doc(r#"{"x": 1}"#))?)
    }));
}

#[test]
fn a_read_only_session_reads_everything_and_writes_nothing() {
    let (fixture, id) = closed_fixture();
    let before = bytes(&fixture.path);

    let session = fixture.manager.open_read_only(&fixture.path).unwrap();
    let info = session.info().unwrap();
    assert!(!info.can_mutate);

    every_write_is_refused(&session, &id);

    // Every read works: the overview, a document, storage, check, export.
    let overview = session.overview().unwrap();
    assert_eq!(overview.collections[0].name, "people");
    assert_eq!(overview.collections[0].count, Some(1));
    assert!(
        session
            .read_document("people", &id)
            .unwrap()
            .json
            .contains("Ann")
    );
    assert_eq!(session.storage().unwrap().recovered, None);
    assert!(session.check().unwrap().problems.is_empty());
    let exported = fixture.dir.path().join("out.jsonl");
    assert_eq!(session.export(&exported, false).unwrap().documents, 1);
    assert!(overview.collections.iter().all(|c| c.persisted));

    assert_eq!(bytes(&fixture.path), before, "while open");
    fixture.manager.close(session.id()).unwrap();
    assert_eq!(bytes(&fixture.path), before, "after close");
}

#[test]
fn a_read_only_open_creates_no_wal() {
    let (fixture, _) = closed_fixture();
    let _ = std::fs::remove_file(wal(&fixture.path));

    let session = fixture.manager.open_read_only(&fixture.path).unwrap();
    session.overview().unwrap();
    fixture.manager.close(session.id()).unwrap();

    assert!(!wal(&fixture.path).exists());
}

#[test]
fn a_read_only_open_refuses_a_missing_or_empty_file_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let manager = SessionManager::new();

    let missing = dir.path().join("missing.trunkdb");
    let error = manager.open_read_only(&missing).err().unwrap();
    assert_eq!(error.category, ErrorCategory::FileNotFound);

    let empty = dir.path().join("empty.trunkdb");
    std::fs::write(&empty, b"").unwrap();
    let error = manager.open_read_only(&empty).err().unwrap();
    assert_eq!(error.category, ErrorCategory::NotADatabase);

    let mut names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(names, ["empty.trunkdb"]);
}

/// The state a crash leaves: the database and its WAL, copied while the
/// session that wrote them is still open, so the last write is in the WAL
/// only.
fn crashed_copy(fixture: &Fixture) -> PathBuf {
    let copy = fixture.dir.path().join("crashed.trunkdb");
    std::fs::copy(&fixture.path, &copy).unwrap();
    std::fs::copy(wal(&fixture.path), wal(&copy)).unwrap();
    copy
}

#[test]
fn a_wal_a_crash_left_is_shown_from_memory_and_left_as_it_is() {
    let fixture = Fixture::new();
    let id = fixture.insert("people", &[r#"{"name": "Ann"}"#])[0].to_string();
    let copy = crashed_copy(&fixture);
    fixture.manager.close(fixture.session.id()).unwrap();
    let before = bytes(&copy);
    assert!(before.1.as_ref().is_some_and(|wal| !wal.is_empty()));

    let session = fixture.manager.open_read_only(&copy).unwrap();
    assert!(
        session
            .read_document("people", &id)
            .unwrap()
            .json
            .contains("Ann")
    );
    let recovered = session.storage().unwrap().recovered.expect("a recovery");
    assert!(recovered.pages > 0);
    assert!(recovered.in_memory);
    fixture.manager.close(session.id()).unwrap();
    assert_eq!(bytes(&copy), before, "nothing written");

    // An open for editing recovers it into the file, as it would have.
    let session = fixture.manager.open_existing(&copy).unwrap();
    let recovered = session.storage().unwrap().recovered.expect("a recovery");
    assert!(!recovered.in_memory);
    assert!(
        session
            .read_document("people", &id)
            .unwrap()
            .json
            .contains("Ann")
    );
    fixture.manager.close(session.id()).unwrap();
    assert!(std::fs::read(wal(&copy)).unwrap_or_default().is_empty());
}

#[cfg(unix)]
#[test]
fn a_file_that_cannot_be_written_opens_read_only() {
    use std::os::unix::fs::PermissionsExt;

    let (fixture, id) = closed_fixture();
    let _ = std::fs::remove_file(wal(&fixture.path));
    let directory = fixture.path.parent().unwrap().to_path_buf();
    let mode = |path: &Path, mode: u32| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    };
    mode(&fixture.path, 0o444);
    mode(&directory, 0o555);

    let opened = fixture.manager.open_existing(&fixture.path);
    let read_only = fixture.manager.open_read_only(&fixture.path);

    // Writable again, so the directory can be cleaned up whatever happened.
    mode(&directory, 0o755);
    mode(&fixture.path, 0o644);

    assert_eq!(
        opened.err().expect("an open for editing").category,
        ErrorCategory::PermissionDenied
    );
    let session = read_only.unwrap();
    assert!(
        session
            .read_document("people", &id)
            .unwrap()
            .json
            .contains("Ann")
    );
}

#[test]
fn an_open_for_editing_still_writes() {
    let (fixture, id) = closed_fixture();
    let session = fixture.manager.open_existing(&fixture.path).unwrap();
    assert!(session.info().unwrap().can_mutate);
    session.delete_document("people", &id).unwrap();
}
