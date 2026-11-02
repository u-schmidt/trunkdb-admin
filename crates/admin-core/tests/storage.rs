//! Storage statistics for the overview (trunkdb SPEC §93).

mod common;

use common::Fixture;
use trunkdb::query::Filter;
use trunkdb::{Document, IndexOptions};
use trunkdb_admin_core::ErrorCategory;

#[test]
fn the_report_adds_up_and_names_every_index() {
    let fixture = Fixture::new();
    let people: Vec<String> = (0..300)
        .map(|n| {
            format!(
                r#"{{"n": {n}, "name": "person {n}", "pad": "{}"}}"#,
                "x".repeat(n % 200)
            )
        })
        .collect();
    let people: Vec<&str> = people.iter().map(String::as_str).collect();
    fixture.insert("people", &people);
    fixture.insert(
        "blobs",
        &[&format!(r#"{{"blob": "{}"}}"#, "b".repeat(20_000))],
    );
    fixture
        .session
        .write(|db| {
            db.collection::<Document>("people")
                .ensure_index_with("name", IndexOptions::new().unique())?;
            Ok(())
        })
        .unwrap();
    fixture.session.prepare_collection("virtual").unwrap();

    let report = fixture.session.storage().unwrap();

    let used = &report.page_use;
    assert_eq!(
        used.header
            + used.catalog
            + used.free
            + used.data
            + used.overflow
            + used.index
            + used.unaccounted,
        report.pages
    );
    assert_eq!(used.unaccounted, 0);
    assert_eq!(report.page_size, 8192);
    assert_eq!(report.recovered, None, "a clean open");
    assert!(report.wal_bytes.is_some());

    // Persisted collections only, by name; a virtual one has no pages.
    let names: Vec<&str> = report.collections.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["blobs", "people"]);
    let (blobs, people) = (&report.collections[0], &report.collections[1]);
    assert_eq!(blobs.documents, 1);
    assert_eq!(blobs.overflow_pages, 3);
    assert_eq!(people.documents, 300);
    assert_eq!(people.overflow_pages, 0);
    let indexes: Vec<(Vec<String>, u64)> = people
        .indexes
        .iter()
        .map(|index| (index.fields.clone(), index.entries))
        .collect();
    assert_eq!(
        indexes,
        [
            (vec!["_id".to_string()], 300),
            (vec!["name".to_string()], 300)
        ]
    );
}

#[test]
fn the_compaction_estimate_is_what_compacting_makes() {
    let fixture = Fixture::new();
    let docs: Vec<String> = (0..500)
        .map(|n| format!(r#"{{"n": {n}, "pad": "{}"}}"#, "y".repeat(400)))
        .collect();
    let docs: Vec<&str> = docs.iter().map(String::as_str).collect();
    fixture.insert("c", &docs);
    fixture
        .session
        .write(|db| {
            db.collection::<Document>("c")
                .delete_many(Filter::new().lt("n", 350))?;
            Ok(())
        })
        .unwrap();

    let report = fixture.session.storage().unwrap();
    assert!(report.compacted_pages < report.pages);
    let compacted = fixture.session.write(|db| Ok(db.compact()?)).unwrap();
    assert_eq!(
        (report.pages, report.compacted_pages),
        (compacted.pages_before, compacted.pages_after)
    );
}

#[test]
fn a_closed_session_has_no_report() {
    let fixture = Fixture::new();
    fixture.manager.close(fixture.session.id()).unwrap();
    let error = fixture.session.storage().unwrap_err();
    assert_eq!(error.category, ErrorCategory::SessionClosed);
}
