//! The recent files list.

use trunkdb_admin_core::RecentFiles;

#[test]
fn entries_are_most_recent_first_deduplicated_and_capped() {
    let dir = tempfile::tempdir().unwrap();
    let recents = RecentFiles::new(dir.path().join("state/recent.json"));
    assert!(recents.list().is_empty());

    for n in 0..12 {
        recents
            .add(&dir.path().join(format!("db{n}.trunkdb")), false)
            .unwrap();
    }
    let listed = recents.add(&dir.path().join("db5.trunkdb"), false).unwrap();

    assert_eq!(listed.len(), RecentFiles::MAX_ENTRIES);
    assert_eq!(listed[0].file_name, "db5.trunkdb");
    assert_eq!(listed[1].file_name, "db11.trunkdb");
    assert_eq!(
        listed
            .iter()
            .filter(|entry| entry.file_name == "db5.trunkdb")
            .count(),
        1
    );
    // A second instance reads what the first stored.
    let again = RecentFiles::new(dir.path().join("state/recent.json"));
    assert_eq!(again.list(), listed);
}

#[cfg(unix)]
#[test]
fn a_file_named_through_a_symlinked_folder_is_listed_once() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    std::fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, dir.path().join("link")).unwrap();
    std::fs::write(real.join("db.trunkdb"), b"x").unwrap();
    let recents = RecentFiles::new(dir.path().join("recent.json"));

    recents
        .add(&dir.path().join("link/db.trunkdb"), false)
        .unwrap();
    let resolved = std::fs::canonicalize(real.join("db.trunkdb")).unwrap();
    let listed = recents.add(&resolved, false).unwrap();

    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, resolved.display().to_string());
}

#[test]
fn a_stale_entry_is_marked_and_removable_and_never_created() {
    let dir = tempfile::tempdir().unwrap();
    let recents = RecentFiles::new(dir.path().join("recent.json"));
    let present = dir.path().join("present.trunkdb");
    let gone = dir.path().join("gone.trunkdb");
    std::fs::write(&present, b"x").unwrap();
    recents.add(&gone, false).unwrap();
    recents.add(&present, false).unwrap();

    let listed = recents.list();
    assert!(listed[0].exists);
    assert!(!listed[1].exists);
    assert!(!gone.exists());

    let listed = recents.remove(&gone.display().to_string()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].file_name, "present.trunkdb");
}

#[test]
fn an_unreadable_list_is_an_empty_one() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("recent.json");
    std::fs::write(&file, b"{ not json").unwrap();
    let recents = RecentFiles::new(&file);

    assert!(recents.list().is_empty());
    let listed = recents.add(&dir.path().join("a.trunkdb"), false).unwrap();
    assert_eq!(listed.len(), 1);
}

#[test]
fn each_entry_remembers_how_it_was_last_opened() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("recent.json");
    let recents = RecentFiles::new(&file);
    let backup = dir.path().join("backup.trunkdb");
    let live = dir.path().join("live.trunkdb");

    recents.add(&backup, true).unwrap();
    let listed = recents.add(&live, false).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|entry| (entry.file_name.as_str(), entry.read_only))
            .collect::<Vec<_>>(),
        [("live.trunkdb", false), ("backup.trunkdb", true)]
    );
    // A second instance reads the modes back.
    assert_eq!(RecentFiles::new(&file).list(), listed);

    // The last open decides: for editing now.
    let listed = recents.add(&backup, false).unwrap();
    assert!(!listed[0].read_only);
    // A removed entry forgets its mode.
    recents.add(&live, true).unwrap();
    recents.remove(&live.display().to_string()).unwrap();
    assert!(!recents.add(&live, false).unwrap()[0].read_only);
}

#[test]
fn a_list_from_before_modes_opens_everything_for_editing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("recent.json");
    let old = dir.path().join("old.trunkdb");
    std::fs::write(
        &file,
        serde_json::json!({ "paths": [old.display().to_string()] }).to_string(),
    )
    .unwrap();

    let listed = RecentFiles::new(&file).list();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].read_only);
}
