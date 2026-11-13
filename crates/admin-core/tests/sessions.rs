//! Session lifecycle against real temporary databases: what opening and
//! creating may touch, when the file lock is held, and what a closed
//! session answers.

use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::Duration;
use tempfile::TempDir;
use trunkdb::{Database, Document};
use trunkdb_admin_core::{ErrorCategory, SessionManager, TrunkdbBuild};

fn scratch(name: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(name);
    (dir, path)
}

fn entries(dir: &TempDir) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn the_bundled_trunkdb_is_the_pinned_one() {
    assert_eq!(TrunkdbBuild::CURRENT.version, "0.40.0");
    assert_eq!(
        TrunkdbBuild::CURRENT.revision,
        "f4ae88cc506a604d5d205701d8b6ec77a302e285"
    );
}

#[test]
fn a_created_database_keeps_its_state_across_close_and_reopen() {
    let (_dir, path) = scratch("new.trunkdb");
    let manager = SessionManager::new();

    let session = manager.create_new(&path).unwrap();
    let info = session.info().unwrap();
    assert_eq!(info.file_name, "new.trunkdb");
    assert!(info.can_mutate);
    assert!(info.file.pages >= 1);
    session
        .write(|db| {
            let doc: Document = r#"{"name": "Ann"}"#.parse().unwrap();
            db.collection::<Document>("people").insert(doc)?;
            Ok(())
        })
        .unwrap();
    manager.close(session.id()).unwrap();

    let reopened = manager.open_existing(&path).unwrap();
    let names = reopened.read(|db| Ok(db.collections()?)).unwrap();
    assert_eq!(names, ["people"]);
    assert_ne!(reopened.id(), session.id());
}

#[test]
fn opening_a_missing_path_creates_nothing() {
    let (dir, path) = scratch("gone.trunkdb");
    let manager = SessionManager::new();

    let error = manager.open_existing(&path).err().unwrap();

    assert_eq!(error.category, ErrorCategory::FileNotFound);
    assert!(entries(&dir).is_empty(), "{:?}", entries(&dir));
}

#[test]
fn creating_over_an_existing_file_leaves_it_intact() {
    let (dir, path) = scratch("taken.trunkdb");
    std::fs::write(&path, b"someone else's bytes").unwrap();
    let manager = SessionManager::new();

    let error = manager.create_new(&path).err().unwrap();

    assert_eq!(error.category, ErrorCategory::AlreadyExists);
    assert_eq!(std::fs::read(&path).unwrap(), b"someone else's bytes");
    assert_eq!(entries(&dir), ["taken.trunkdb"]);
    // The refused create must not have taken the one session slot.
    let (_other_dir, other) = scratch("free.trunkdb");
    manager.create_new(&other).unwrap();
}

#[test]
fn creating_over_an_existing_database_leaves_it_intact() {
    let (_dir, path) = scratch("db.trunkdb");
    let manager = SessionManager::new();
    let session = manager.create_new(&path).unwrap();
    manager.close(session.id()).unwrap();
    let before = std::fs::read(&path).unwrap();

    let error = manager.create_new(&path).err().unwrap();

    assert_eq!(error.category, ErrorCategory::AlreadyExists);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn an_empty_file_is_not_opened_as_a_database() {
    let (_dir, path) = scratch("empty.trunkdb");
    std::fs::write(&path, b"").unwrap();
    let manager = SessionManager::new();

    let error = manager.open_existing(&path).err().unwrap();

    assert_eq!(error.category, ErrorCategory::NotADatabase);
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
}

#[test]
fn a_foreign_file_is_reported_as_not_a_database_and_unchanged() {
    let (_dir, path) = scratch("notes.txt");
    let content = "just some text\n".repeat(1000);
    std::fs::write(&path, &content).unwrap();
    let manager = SessionManager::new();

    let error = manager.open_existing(&path).err().unwrap();

    assert_eq!(error.category, ErrorCategory::NotADatabase);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
}

#[test]
fn a_directory_is_not_a_database() {
    let dir = tempfile::tempdir().unwrap();
    let manager = SessionManager::new();

    let error = manager.open_existing(dir.path()).err().unwrap();

    assert_eq!(error.category, ErrorCategory::NotADatabase);
}

/// A closed database made here, its bytes changed by `change`.
fn changed_database(name: &str, change: impl FnOnce(&mut Vec<u8>)) -> (tempfile::TempDir, PathBuf) {
    let (dir, path) = scratch(name);
    let manager = SessionManager::new();
    let session = manager.create_new(&path).unwrap();
    manager.close(session.id()).unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    change(&mut bytes);
    std::fs::write(&path, &bytes).unwrap();
    (dir, path)
}

/// The header's format version, little-endian at byte 28.
fn with_format(version: u32) -> impl FnOnce(&mut Vec<u8>) {
    move |bytes| bytes[28..32].copy_from_slice(&version.to_le_bytes())
}

#[test]
fn a_file_format_the_bundled_trunkdb_cannot_read_says_which() {
    for (version, words) in [
        (
            9999,
            "file format 9999, newer than the bundled trunkdb reads (17)",
        ),
        (
            5,
            "file format 5; the bundled trunkdb reads formats 6 to 17",
        ),
        (0, "before file formats had versions"),
    ] {
        let (_dir, path) = changed_database("other.trunkdb", with_format(version));
        let before = std::fs::read(&path).unwrap();

        let error = SessionManager::new().open_existing(&path).err().unwrap();

        assert_eq!(error.category, ErrorCategory::UnsupportedFormat, "{error}");
        assert!(error.message.contains(words), "{error}");
        assert!(error.detail.is_some(), "trunkdb's words are kept");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn a_write_ahead_log_the_bundled_trunkdb_cannot_read_says_so() {
    let mut newer = b"TRUNKWAL".to_vec();
    newer.extend_from_slice(&5u32.to_le_bytes());
    for (wal, words) in [
        (newer, "has version 5"),
        (b"another program's log".to_vec(), "not a trunkdb log"),
    ] {
        let (_dir, path) = changed_database("logged.trunkdb", |_| {});
        let wal_path = PathBuf::from(format!("{}.wal", path.display()));
        std::fs::write(&wal_path, &wal).unwrap();

        let error = SessionManager::new().open_existing(&path).err().unwrap();

        assert_eq!(error.category, ErrorCategory::UnsupportedFormat, "{error}");
        assert!(error.message.contains(words), "{error}");
        assert_eq!(
            std::fs::read(&wal_path).unwrap(),
            wal,
            "the log is left as it is"
        );
    }
}

#[test]
fn a_write_ahead_log_of_another_database_is_not_replayed() {
    // A WAL with a batch in it, copied while its database is open, as a
    // crash would leave it, then put beside another database.
    let (dir, other) = scratch("other.trunkdb");
    let writer = Database::open(&other).unwrap();
    let ann: Document = r#"{"name": "Ann"}"#.parse().unwrap();
    writer.collection::<Document>("people").insert(ann).unwrap();
    let wal = std::fs::read(format!("{}.wal", other.display())).unwrap();
    assert!(!wal.is_empty(), "the batch is still in the log");
    drop(writer);

    let path = dir.path().join("this.trunkdb");
    let manager = SessionManager::new();
    let session = manager.create_new(&path).unwrap();
    manager.close(session.id()).unwrap();
    let wal_path = PathBuf::from(format!("{}.wal", path.display()));
    std::fs::write(&wal_path, &wal).unwrap();
    let before = std::fs::read(&path).unwrap();

    let error = SessionManager::new().open_existing(&path).err().unwrap();

    assert_eq!(error.category, ErrorCategory::UnsupportedFormat, "{error}");
    assert!(
        error.message.contains("belongs to another database file"),
        "{error}"
    );
    assert!(
        error.detail.unwrap().contains(".stale"),
        "trunkdb's words are kept"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        std::fs::read(&wal_path).unwrap(),
        wal,
        "the log is left as it is"
    );
}

#[test]
fn a_damaged_header_is_reported_as_damage() {
    // A page size trunkdb never had: a damaged field, not another format.
    let (_dir, path) = changed_database("damaged.trunkdb", |bytes| {
        bytes[8..12].copy_from_slice(&4096u32.to_le_bytes())
    });

    let error = SessionManager::new().open_existing(&path).err().unwrap();

    assert_eq!(error.category, ErrorCategory::DamagedData, "{error}");
}

#[test]
fn a_database_held_elsewhere_is_reported_as_locked_and_opens_after_release() {
    let (_dir, path) = scratch("busy.trunkdb");
    let holder = Database::open(&path).unwrap();
    holder
        .collection::<Document>("c")
        .insert(r#"{"n": 1}"#.parse().unwrap())
        .unwrap();
    let manager = SessionManager::new();

    let error = manager.open_existing(&path).err().unwrap();
    assert_eq!(error.category, ErrorCategory::Locked);

    drop(holder);
    manager.open_existing(&path).unwrap();
}

#[test]
fn the_lock_is_held_while_open_and_released_by_close() {
    let (_dir, path) = scratch("mine.trunkdb");
    let manager = SessionManager::new();
    let session = manager.create_new(&path).unwrap();

    assert!(Database::open(&path).is_err(), "the session owns the file");

    manager.close(session.id()).unwrap();
    Database::open(&path).unwrap();
}

#[test]
fn a_closed_session_refuses_work_by_id_and_by_handle() {
    let (_dir, path) = scratch("closed.trunkdb");
    let manager = SessionManager::new();
    let session = manager.create_new(&path).unwrap();
    let id = session.id().to_string();
    manager.close(&id).unwrap();

    assert_eq!(
        manager.get(&id).err().unwrap().category,
        ErrorCategory::SessionClosed
    );
    assert_eq!(
        manager.close(&id).unwrap_err().category,
        ErrorCategory::SessionClosed
    );
    // A handle taken before the close, as a running command would hold.
    assert_eq!(
        session.file_info().unwrap_err().category,
        ErrorCategory::SessionClosed
    );
    let wrote = session.write(|db| Ok(db.collection::<Document>("c").insert(Document::Int(1))?));
    assert_eq!(wrote.unwrap_err().category, ErrorCategory::SessionClosed);
}

#[test]
fn a_stale_session_id_never_reaches_the_next_session() {
    let (_dir, first_path) = scratch("first.trunkdb");
    let (_dir2, second_path) = scratch("second.trunkdb");
    let manager = SessionManager::new();
    let first = manager.create_new(&first_path).unwrap();
    let stale = first.id().to_string();
    manager.close(&stale).unwrap();
    let second = manager.create_new(&second_path).unwrap();

    assert_eq!(
        manager.get(&stale).err().unwrap().category,
        ErrorCategory::SessionClosed
    );
    assert_eq!(
        manager.close(&stale).unwrap_err().category,
        ErrorCategory::SessionClosed
    );
    // The second session is untouched by the stale close.
    second.file_info().unwrap();
}

#[test]
fn only_one_database_is_open_at_a_time() {
    let (_dir, first_path) = scratch("first.trunkdb");
    let (dir2, second_path) = scratch("second.trunkdb");
    let manager = SessionManager::new();
    let first = manager.create_new(&first_path).unwrap();

    let error = manager.create_new(&second_path).err().unwrap();
    assert_eq!(error.category, ErrorCategory::Busy);
    assert!(entries(&dir2).is_empty(), "a refused create writes nothing");

    manager.close(first.id()).unwrap();
    manager.create_new(&second_path).unwrap();
}

#[test]
fn close_waits_for_running_work_and_only_then_releases_the_lock() {
    let (_dir, path) = scratch("working.trunkdb");
    let manager = Arc::new(SessionManager::new());
    let session = manager.create_new(&path).unwrap();
    let id = session.id().to_string();

    let (started_tx, started_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel::<()>();
    let worker = std::thread::spawn({
        let session = Arc::clone(&session);
        move || {
            session.read(|db| {
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(db.collections()?)
            })
        }
    });
    started_rx.recv().unwrap();

    let (closed_tx, closed_rx) = mpsc::channel();
    let closer = std::thread::spawn({
        let manager = Arc::clone(&manager);
        move || {
            manager.close(&id).unwrap();
            closed_tx.send(()).unwrap();
        }
    });

    assert!(
        closed_rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "close returned while work was still running"
    );
    assert!(Database::open(&path).is_err(), "lock released too early");
    // New work is refused as soon as closing has begun, not queued.
    assert_eq!(
        session.file_info().unwrap_err().category,
        ErrorCategory::SessionClosed
    );

    finish_tx.send(()).unwrap();
    closed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    closer.join().unwrap();
    // The running work finished normally rather than being cut off.
    assert!(worker.join().unwrap().is_ok());
    Database::open(&path).unwrap();
}

#[test]
fn close_all_releases_every_lock() {
    let (_dir, path) = scratch("exit.trunkdb");
    let manager = SessionManager::new();
    manager.create_new(&path).unwrap();

    manager.close_all();

    Database::open(&path).unwrap();
}
