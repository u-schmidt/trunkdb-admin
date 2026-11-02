//! How a page is read (trunkdb SPEC §94): the list's own query, run by
//! `explain_run`.

mod common;

use common::Fixture;
use trunkdb::Document;
use trunkdb_admin_core::{
    ConditionInput, ErrorCategory, FilterInput, IndexReadReport, Operator, PlanKind, QueryRequest,
    SortInput, SortReport, ValueInput, ValueType,
};

fn request(collection: &str, sort: &str, page: usize, page_size: usize) -> QueryRequest {
    QueryRequest {
        request_id: 7,
        collection: collection.to_string(),
        filter: FilterInput::default(),
        sort: SortInput {
            field: sort.to_string(),
            descending: false,
        },
        page,
        page_size,
        select: None,
    }
}

fn condition(field: &str, operator: Operator, value_type: ValueType, text: &str) -> ConditionInput {
    ConditionInput {
        field: field.to_string(),
        operator,
        value: Some(ValueInput {
            value_type,
            text: text.to_string(),
        }),
    }
}

/// 120 people, `age` 0 to 59 twice over.
fn people() -> Fixture {
    let fixture = Fixture::new();
    let people: Vec<String> = (0..120)
        .map(|n| format!(r#"{{"n": {n}, "age": {}, "name": "p{n}"}}"#, n % 60))
        .collect();
    let people: Vec<&str> = people.iter().map(String::as_str).collect();
    fixture.insert("people", &people);
    fixture
}

fn index(fixture: &Fixture, field: &str) {
    fixture
        .session
        .write(|db| {
            db.collection::<Document>("people").ensure_index(field)?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn the_default_page_walks_the_primary_index_to_the_page() {
    let fixture = people();
    let report = fixture
        .session
        .explain(&request("people", "_id", 1, 50))
        .unwrap();
    assert_eq!(report.request_id, 7);
    // The primary index gives the `_id` order (trunkdb §96): page 2 walks
    // the first page and itself, not all 120, and its entries decide
    // (§100): only page 2 is read.
    assert_eq!(report.plan, PlanKind::IndexOrder);
    assert_eq!(
        report.reads,
        [IndexReadReport {
            index: "_id".into(),
            bounds: vec![],
            backward: false,
            entries: 100,
            covering: true,
        }]
    );
    assert_eq!(
        report.sort,
        Some(SortReport {
            from_index: 1,
            in_memory: 0
        })
    );
    assert_eq!((report.skip, report.limit), (50, 50));
    assert_eq!(report.keys_examined, 100);
    assert_eq!(
        (
            report.documents_examined,
            report.documents_matched,
            report.documents_returned
        ),
        (50, 100, 50)
    );
}

#[test]
fn an_indexed_sort_walks_the_index_and_stops_at_the_page() {
    let fixture = people();
    index(&fixture, "age");
    let report = fixture
        .session
        .explain(&request("people", "age", 0, 10))
        .unwrap();
    assert_eq!(report.plan, PlanKind::IndexOrder);
    assert_eq!(report.reads[0].index, "age");
    assert_eq!(
        report.sort,
        Some(SortReport {
            from_index: 1,
            in_memory: 0
        })
    );
    assert_eq!(report.documents_returned, 10);
    assert!(report.documents_examined < 20, "{report:?}");
}

#[test]
/// Bounds are in trunkdb's filter text: each reads back as a
/// condition, as it would be typed in the filter.
fn bounds_are_written_as_conditions() {
    let fixture = people();
    index(&fixture, "age");
    let mut adults = request("people", "n", 0, 50);
    adults.filter = FilterInput::Rows(vec![
        condition("age", Operator::Gte, ValueType::Int, "18"),
        condition("name", Operator::Ne, ValueType::String, "p20"),
    ]);
    let report = fixture.session.explain(&adults).unwrap();
    assert_eq!(report.plan, PlanKind::Index);
    assert_eq!(report.reads[0].bounds, ["age >= 18"]);
    for bound in &report.reads[0].bounds {
        bound.parse::<trunkdb::query::Condition>().unwrap();
    }
    assert_eq!(report.reads[0].entries, 84);
    assert_eq!(report.documents_matched, 83);
    // `name` isn't in the index: every document in the range is read.
    assert!(!report.reads[0].covering);
    assert_eq!(report.documents_examined, 84);

    let mut only_age = request("people", "age", 0, 10);
    only_age.filter =
        FilterInput::Rows(vec![condition("age", Operator::Gte, ValueType::Int, "18")]);
    let report = fixture.session.explain(&only_age).unwrap();
    assert!(report.reads[0].covering, "{report:?}");
    assert_eq!(report.documents_examined, 10);

    index(&fixture, "name");
    let mut named = request("people", "_id", 0, 50);
    named.filter = FilterInput::Rows(vec![condition(
        "name",
        Operator::Eq,
        ValueType::String,
        "p3",
    )]);
    let report = fixture.session.explain(&named).unwrap();
    assert_eq!(report.reads[0].bounds, [r#"name = "p3""#]);
}

#[test]
fn a_lookup_by_id_names_the_id() {
    let fixture = Fixture::new();
    let ids = fixture.insert("people", &[r#"{"n": 1}"#, r#"{"n": 2}"#]);
    let mut by_id = request("people", "_id", 0, 50);
    by_id.filter = FilterInput::Rows(vec![condition(
        "_id",
        Operator::Eq,
        ValueType::Id,
        &ids[1].to_string(),
    )]);
    let report = fixture.session.explain(&by_id).unwrap();
    assert_eq!(report.plan, PlanKind::ById);
    assert_eq!(
        report.reads[0].bounds,
        [format!(r#"_id = id("{}")"#, ids[1])]
    );
    assert_eq!(report.documents_returned, 1);
}

#[test]
fn it_explains_the_page_the_list_shows() {
    let fixture = people();
    index(&fixture, "age");
    let mut page = request("people", "age", 2, 25);
    page.filter = FilterInput::Rows(vec![condition("age", Operator::Lt, ValueType::Int, "40")]);
    let shown = fixture.session.query(&page).unwrap();
    let report = fixture.session.explain(&page).unwrap();
    assert_eq!(report.documents_returned, shown.rows.len() as u64);
    assert_eq!((report.skip, report.limit), (50, 25));
}

#[test]
fn a_missing_collection_reads_nothing() {
    let fixture = Fixture::new();
    let report = fixture
        .session
        .explain(&request("nothing", "_id", 0, 50))
        .unwrap();
    assert_eq!(report.plan, PlanKind::IndexOrder);
    assert!(report.reads.is_empty());
    assert_eq!(report.documents_examined, 0);
}

#[test]
fn invalid_input_and_a_closed_session_are_refused() {
    let fixture = people();
    let mut bad = request("people", "_id", 0, 50);
    bad.filter = FilterInput::Rows(vec![condition("age", Operator::Eq, ValueType::Int, "many")]);
    let error = fixture.session.explain(&bad).unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    let error = fixture
        .session
        .explain(&request("people", "_id", 0, 0))
        .unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);

    fixture.manager.close(fixture.session.id()).unwrap();
    let error = fixture
        .session
        .explain(&request("people", "_id", 0, 50))
        .unwrap_err();
    assert_eq!(error.category, ErrorCategory::SessionClosed);
}

/// A hint that can't be followed (trunkdb SPEC §132) is the query's
/// mistake, not the database's: invalid input, the index named.
#[test]
fn a_hint_that_cant_be_followed_is_invalid_input() {
    let fixture = people();
    let error = fixture
        .session
        .read(|db| {
            Ok(db
                .collection::<Document>("people")
                .find(trunkdb::query::Filter::new().eq("age", 3).use_index("name"))?)
        })
        .unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    assert!(error.detail.as_deref().unwrap_or("").contains("name"));
}
