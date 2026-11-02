//! Index management.

mod common;

use common::Fixture;
use trunkdb::Document;
use trunkdb_admin_core::{ErrorCategory, IndexRequest, IndexSummary, Overview};

fn index(collection: &str, fields: &[&str], unique: bool, sparse: bool) -> IndexRequest {
    IndexRequest {
        collection: collection.to_string(),
        fields: fields.iter().map(|field| field.to_string()).collect(),
        unique,
        sparse,
    }
}

fn indexes(overview: &Overview, collection: &str) -> Vec<IndexSummary> {
    overview
        .collections
        .iter()
        .find(|c| c.name == collection)
        .map(|c| c.indexes.clone())
        .unwrap_or_default()
}

fn fields(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn people() -> Fixture {
    let fx = Fixture::new();
    fx.insert(
        "people",
        &[
            r#"{"name": "Ann", "email": "a@x", "address": {"city": "Bonn"}, "tags": ["a", "b"]}"#,
            r#"{"name": "Bo", "email": "b@x", "address": {"city": "Bonn"}, "tags": ["b"]}"#,
            r#"{"name": "Ann", "nick": null}"#,
        ],
    );
    fx
}

#[test]
fn single_nested_array_compound_unique_and_sparse_indexes_are_created_and_dropped() {
    let mut fx = people();

    fx.session
        .create_index(&index("people", &["name"], false, false))
        .unwrap();
    fx.session
        .create_index(&index("people", &["address.city"], false, false))
        .unwrap();
    fx.session
        .create_index(&index("people", &["tags[*]"], false, false))
        .unwrap();
    fx.session
        .create_index(&index("people", &["email"], true, false))
        .unwrap();
    fx.session
        .create_index(&index("people", &["nick"], false, true))
        .unwrap();
    let overview = fx
        .session
        .create_index(&index("people", &["address.city", "name"], true, true))
        .unwrap();

    let listed = indexes(&overview, "people");
    let summary: Vec<(Vec<&str>, bool, bool)> = listed
        .iter()
        .map(|i| {
            (
                i.fields.iter().map(String::as_str).collect(),
                i.unique,
                i.sparse,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (vec!["name"], false, false),
            (vec!["address.city"], false, false),
            (vec!["tags[*]"], false, false),
            (vec!["email"], true, false),
            (vec!["nick"], false, true),
            // Field order is the index's meaning, and is kept.
            (vec!["address.city", "name"], true, true),
        ]
    );

    fx.reopen();
    assert_eq!(indexes(&fx.session.overview().unwrap(), "people"), listed);

    // The reversed compound index is another index, not this one.
    let reversed = fx
        .session
        .drop_index("people", &fields(&["name", "address.city"]))
        .unwrap_err();
    assert_eq!(reversed.category, ErrorCategory::TargetNotFound);

    for dropped in listed {
        fx.session.drop_index("people", &dropped.fields).unwrap();
    }
    let overview = fx.session.overview().unwrap();
    assert!(indexes(&overview, "people").is_empty());
    assert_eq!(
        overview.collections[0].count,
        Some(3),
        "documents are untouched"
    );
}

#[test]
fn a_unique_index_over_conflicting_documents_creates_nothing() {
    let fx = people();

    let error = fx
        .session
        .create_index(&index("people", &["name"], true, false))
        .unwrap_err();

    assert_eq!(error.category, ErrorCategory::UniqueConflict);
    assert!(error.detail.unwrap().contains("name"));
    let overview = fx.session.overview().unwrap();
    assert!(indexes(&overview, "people").is_empty());
    assert_eq!(overview.collections[0].count, Some(3));
    // The same fields without the conflict-making option still work.
    fx.session
        .create_index(&index("people", &["name"], false, false))
        .unwrap();
}

#[test]
fn an_existing_index_is_never_replaced_by_one_with_other_options() {
    let fx = people();
    fx.session
        .create_index(&index("people", &["email"], true, false))
        .unwrap();

    let same = fx
        .session
        .create_index(&index("people", &["email"], true, false))
        .unwrap_err();
    let other = fx
        .session
        .create_index(&index("people", &["email"], false, true))
        .unwrap_err();

    assert_eq!(same.category, ErrorCategory::AlreadyExists);
    assert_eq!(other.category, ErrorCategory::AlreadyExists);
    assert!(other.message.contains("other options"), "{other}");
    let listed = indexes(&fx.session.overview().unwrap(), "people");
    assert_eq!(listed.len(), 1);
    assert!(listed[0].unique && !listed[0].sparse);
}

#[test]
fn the_primary_index_cannot_be_managed() {
    let fx = people();

    for attempt in [
        &["_id"][..],
        &["_id", "name"],
        &["name", "_id"],
        &["_id.part"],
        &["_id[*]"],
    ] {
        let create = fx
            .session
            .create_index(&index("people", attempt, false, false))
            .unwrap_err();
        assert_eq!(create.category, ErrorCategory::InvalidInput, "{attempt:?}");
        let drop = fx
            .session
            .drop_index("people", &fields(attempt))
            .unwrap_err();
        assert_eq!(drop.category, ErrorCategory::InvalidInput, "{attempt:?}");
    }

    let overview = fx.session.overview().unwrap();
    assert!(indexes(&overview, "people").is_empty());
    // Still readable by ID: the primary index is intact.
    assert_eq!(overview.collections[0].count, Some(3));
}

#[test]
fn trunkdbs_path_rules_are_enforced_and_reported_as_invalid_input() {
    let fx = people();
    let too_many: Vec<String> = (0..=trunkdb::Database::MAX_COMPOUND_FIELDS)
        .map(|n| format!("f{n}"))
        .collect();
    let too_many: Vec<&str> = too_many.iter().map(String::as_str).collect();

    for attempt in [
        &[][..],
        &[""],
        &["name", ""],
        &["tags[*]", "name"],
        &["a..b"],
        &["a[0]"],
        &["name", "name"],
        &too_many,
    ] {
        let error = fx
            .session
            .create_index(&index("people", attempt, false, false))
            .unwrap_err();
        assert_eq!(
            error.category,
            ErrorCategory::InvalidInput,
            "{attempt:?}: {error}"
        );
    }
    assert!(indexes(&fx.session.overview().unwrap(), "people").is_empty());
}

#[test]
fn dropping_an_index_that_does_not_exist_is_reported() {
    let fx = people();

    let error = fx
        .session
        .drop_index("people", &fields(&["nope"]))
        .unwrap_err();
    assert_eq!(error.category, ErrorCategory::TargetNotFound);
    let no_collection = fx
        .session
        .drop_index("nowhere", &fields(&["a"]))
        .unwrap_err();
    assert_eq!(no_collection.category, ErrorCategory::TargetNotFound);
    assert_eq!(fx.session.overview().unwrap().collections.len(), 1);
}

#[test]
fn the_first_index_persists_a_virtual_collection_and_a_refused_one_does_not() {
    let mut fx = Fixture::new();
    fx.session.prepare_collection("drafts").unwrap();

    fx.session
        .create_index(&index("drafts", &["tags[*]", "name"], false, false))
        .unwrap_err();
    assert!(!fx.session.overview().unwrap().collections[0].persisted);

    let overview = fx
        .session
        .create_index(&index("drafts", &["title"], true, false))
        .unwrap();
    assert!(overview.collections[0].persisted);
    assert_eq!(overview.collections[0].count, Some(0));

    fx.reopen();
    let overview = fx.session.overview().unwrap();
    assert_eq!(indexes(&overview, "drafts")[0].fields, ["title"]);
    // And the unique index is enforced for documents saved afterwards.
    fx.insert("drafts", &[r#"{"title": "a"}"#]);
    let duplicate = fx
        .session
        .write(|db| {
            Ok(db
                .collection::<Document>("drafts")
                .insert(r#"{"title": "a"}"#.parse().unwrap())?)
        })
        .unwrap_err();
    assert_eq!(duplicate.category, ErrorCategory::UniqueConflict);
}
