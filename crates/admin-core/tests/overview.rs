//! The collection overview and virtual collections.

mod common;

use common::Fixture;
use trunkdb::{Document, IndexOptions};
use trunkdb_admin_core::{ErrorCategory, TrunkdbBuild};

#[test]
fn collections_are_listed_by_name_with_counts_and_indexes() {
    let fx = Fixture::new();
    fx.insert("people", &[r#"{"name": "Ann"}"#, r#"{"name": "Bo"}"#]);
    fx.insert(
        "events",
        &[r#"{"v": 1}"#, r#"{"v": [1, 2]}"#, r#"{"v": "text"}"#],
    );
    fx.session
        .write(|db| {
            let people = db.collection::<Document>("people");
            people.ensure_index("name")?;
            people.ensure_index_with(["city", "name"], IndexOptions::new().unique().sparse())?;
            Ok(())
        })
        .unwrap();

    let overview = fx.session.overview().unwrap();

    let names: Vec<&str> = overview
        .collections
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, ["events", "people"]);
    let events = &overview.collections[0];
    assert_eq!((events.count, events.persisted), (Some(3), true));
    assert!(events.indexes.is_empty());
    let people = &overview.collections[1];
    assert_eq!(people.count, Some(2));
    assert_eq!(people.indexes.len(), 2);
    assert_eq!(people.indexes[0].fields, ["name"]);
    assert!(!people.indexes[0].unique && !people.indexes[0].sparse);
    assert_eq!(people.indexes[1].fields, ["city", "name"]);
    assert!(people.indexes[1].unique && people.indexes[1].sparse);
    assert!(overview.file.pages > 1);
}

/// The releases that created and last wrote the file (trunkdb SPEC
/// §125), as text: a file this build made names this build for both, in
/// the overview and in the session's file facts alike.
#[test]
fn the_file_names_the_releases_that_created_and_wrote_it() {
    let fx = Fixture::new();
    fx.insert("people", &[r#"{"name": "Ann"}"#]);
    let this_build = Some(TrunkdbBuild::CURRENT.version.to_string());

    let overview = fx.session.overview().unwrap();
    assert_eq!(overview.file.created_by, this_build);
    assert_eq!(overview.file.written_by, this_build);
    assert_eq!(fx.session.file_info().unwrap(), overview.file);
}

#[test]
fn a_virtual_collection_is_listed_but_not_written() {
    let mut fx = Fixture::new();
    fx.insert("people", &["{}"]);

    let overview = fx.session.prepare_collection("drafts").unwrap();

    let drafts = overview
        .collections
        .iter()
        .find(|c| c.name == "drafts")
        .unwrap();
    assert!(!drafts.persisted);
    assert_eq!(drafts.count, Some(0));
    let stored = fx.session.read(|db| Ok(db.collections()?)).unwrap();
    assert_eq!(stored, ["people"]);

    // Closing discards it: nothing reached the file.
    fx.reopen();
    let names: Vec<String> = fx
        .session
        .overview()
        .unwrap()
        .collections
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(names, ["people"]);
}

#[test]
fn a_first_insert_makes_a_virtual_collection_persisted() {
    let mut fx = Fixture::new();
    fx.session.prepare_collection("drafts").unwrap();

    fx.insert("drafts", &[r#"{"title": "first"}"#]);

    let overview = fx.session.overview().unwrap();
    assert_eq!(overview.collections.len(), 1, "listed once, not twice");
    assert!(overview.collections[0].persisted);
    assert_eq!(overview.collections[0].count, Some(1));
    // No longer virtual, so it cannot be "discarded" as one.
    let error = fx.session.discard_virtual_collection("drafts").unwrap_err();
    assert_eq!(error.category, ErrorCategory::TargetNotFound);

    fx.reopen();
    assert_eq!(fx.session.overview().unwrap().collections[0].count, Some(1));
}

#[test]
fn a_first_index_makes_a_virtual_collection_persisted() {
    let fx = Fixture::new();
    fx.session.prepare_collection("drafts").unwrap();

    fx.session
        .write(|db| Ok(db.collection::<Document>("drafts").ensure_index("title")?))
        .unwrap();

    let overview = fx.session.overview().unwrap();
    assert!(overview.collections[0].persisted);
    assert_eq!(overview.collections[0].count, Some(0));
    assert_eq!(overview.collections[0].indexes[0].fields, ["title"]);
}

#[test]
fn empty_and_duplicate_names_are_refused() {
    let fx = Fixture::new();
    fx.insert("people", &["{}"]);
    fx.session.prepare_collection("drafts").unwrap();

    let empty = fx.session.prepare_collection("").unwrap_err();
    assert_eq!(empty.category, ErrorCategory::InvalidInput);
    let persisted = fx.session.prepare_collection("people").unwrap_err();
    assert_eq!(persisted.category, ErrorCategory::AlreadyExists);
    let virtual_twice = fx.session.prepare_collection("drafts").unwrap_err();
    assert_eq!(virtual_twice.category, ErrorCategory::AlreadyExists);
    let too_long = fx.session.prepare_collection(&"x".repeat(256)).unwrap_err();
    assert_eq!(too_long.category, ErrorCategory::InvalidInput);

    assert_eq!(fx.session.overview().unwrap().collections.len(), 2);
}

#[test]
fn discarding_removes_only_a_virtual_collection() {
    let fx = Fixture::new();
    fx.insert("people", &["{}"]);
    fx.session.prepare_collection("drafts").unwrap();

    let overview = fx.session.discard_virtual_collection("drafts").unwrap();
    assert_eq!(overview.collections.len(), 1);

    // The backend refuses even if a caller bypasses the UI.
    let error = fx.session.discard_virtual_collection("people").unwrap_err();
    assert_eq!(error.category, ErrorCategory::TargetNotFound);
    assert_eq!(fx.session.overview().unwrap().collections[0].count, Some(1));
}

#[test]
fn virtual_collections_belong_to_their_session() {
    let fx = Fixture::new();
    fx.session.prepare_collection("drafts").unwrap();
    let closed = fx.session.clone();
    fx.manager.close(closed.id()).unwrap();

    let error = closed.prepare_collection("more").unwrap_err();
    assert_eq!(error.category, ErrorCategory::SessionClosed);
    assert_eq!(
        closed.overview().unwrap_err().category,
        ErrorCategory::SessionClosed
    );
}
