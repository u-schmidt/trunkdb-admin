//! Browsing: result rows of every shape, typed filters checked against
//! direct trunkdb calls, sorting and paging.

mod common;

use common::{Fixture, doc};
use std::collections::BTreeSet;
use trunkdb::query::Filter;
use trunkdb::{DateTime, DocId, Document};
use trunkdb_admin_core::{
    ConditionInput, ErrorCategory, FilterInput, Operator, QueryRequest, QueryResult, SortInput,
    ValueInput, ValueKind, ValueType,
};

fn request(collection: &str) -> QueryRequest {
    QueryRequest {
        request_id: 1,
        collection: collection.to_string(),
        filter: FilterInput::default(),
        sort: SortInput {
            field: "_id".to_string(),
            descending: false,
        },
        page: 0,
        page_size: 50,
        select: None,
    }
}

fn condition(field: &str, operator: Operator, value: Option<(ValueType, &str)>) -> ConditionInput {
    ConditionInput {
        field: field.to_string(),
        operator,
        value: value.map(|(value_type, text)| ValueInput {
            value_type,
            text: text.to_string(),
        }),
    }
}

/// The rows' JSON, parsed back: what the tool shows, as documents.
fn documents(result: &QueryResult) -> Vec<Document> {
    result.rows.iter().map(|row| doc(&row.json)).collect()
}

const WHEN: &str = "2026-03-01T12:00:00Z";

/// One collection exercising every filter type.
fn typed_fixture() -> (Fixture, Vec<DocId>) {
    let fx = Fixture::new();
    let ids = fx.insert(
        "things",
        &[
            r#"{"name": "Anna Schmidt", "n": 9223372036854775807, "f": 2.0, "ok": true, "note": null, "at": {"$date": "2026-03-01T12:00:00Z"}, "address": {"city": "Berlin"}}"#,
            r#"{"name": "anna maria", "n": 9223372036854775806, "f": 2.5, "ok": false, "at": {"$date": "2026-03-02T12:00:00Z"}, "address": {"city": "Bonn"}}"#,
            r#"{"name": "Bo", "n": -9223372036854775808, "f": -0.5, "ok": true, "note": "x", "at": {"$date": "2025-01-01T00:00:00Z"}}"#,
            r#"{"name": 7, "n": 2, "f": 2, "ok": "true"}"#,
        ],
    );
    fx.session
        .write(|db| {
            let things = db.collection::<Document>("things");
            things.insert(doc(&format!(
                r#"{{"name": "ref", "ref": {{"$id": "{}"}}}}"#,
                ids[0]
            )))?;
            Ok(())
        })
        .unwrap();
    (fx, ids)
}

/// Runs `conditions` through the tool and `direct` through trunkdb, and
/// expects the same documents in the same order.
fn assert_agrees(fx: &Fixture, conditions: Vec<ConditionInput>, direct: Filter) -> usize {
    let mut req = request("things");
    req.filter = FilterInput::Rows(conditions);
    let result = fx.session.query(&req).unwrap();
    let expected = fx
        .session
        .read(|db| {
            Ok(db
                .collection::<Document>("things")
                .find(direct.sort_asc("_id"))?)
        })
        .unwrap();
    assert_eq!(documents(&result), expected);
    assert_eq!(result.total, expected.len());
    expected.len()
}

#[test]
fn every_value_shape_has_its_kind_and_preview_and_every_row_its_id() {
    let fx = Fixture::new();
    let values = [
        "[1, [2, 3]]",
        r#""text""#,
        "42",
        "2.0",
        "true",
        "null",
        r#"{"$date": "2026-03-01T12:00:00Z"}"#,
        r#"{"$binary": "AAEC"}"#,
        r#"{"$float": "NaN"}"#,
        r#"{"a": 1}"#,
    ];
    // Every document is an object (trunkdb SPEC §95): one value each.
    let documents: Vec<String> = values.iter().map(|v| format!(r#"{{"v": {v}}}"#)).collect();
    let documents: Vec<&str> = documents.iter().map(String::as_str).collect();
    let ids = fx.insert("mixed", &documents);

    let result = fx.session.query(&request("mixed")).unwrap();

    assert_eq!(result.total, 10);
    let rows_ids: Vec<&str> = result.rows.iter().map(|row| row.id.as_str()).collect();
    let inserted: Vec<String> = ids.iter().map(ToString::to_string).collect();
    assert_eq!(rows_ids, inserted, "in ID order, each with its ID");
    for row in &result.rows {
        assert_eq!(row.cells["_id"].kind, ValueKind::Id);
        assert_eq!(row.cells["_id"].preview, row.id);
    }
    let cells: Vec<(ValueKind, &str)> = result
        .rows
        .iter()
        .map(|row| (row.cells["v"].kind, row.cells["v"].preview.as_str()))
        .collect();
    assert_eq!(
        cells,
        [
            (ValueKind::Array, "[1,[2,3]]"),
            (ValueKind::String, "text"),
            (ValueKind::Int, "42"),
            (ValueKind::Float, "2.0"),
            (ValueKind::Bool, "true"),
            (ValueKind::Null, "null"),
            (ValueKind::DateTime, WHEN),
            (ValueKind::Binary, "3 bytes"),
            (ValueKind::Float, "NaN"),
            (ValueKind::Object, r#"{"a":1}"#),
        ]
    );
    // The JSON is the faithful form, tags included.
    assert!(result.rows[3].json.contains("2.0"));
    let Document::Object(binary) = doc(&result.rows[7].json) else {
        panic!("an object");
    };
    assert_eq!(binary["v"], Document::Binary(vec![0, 1, 2]));
    assert!(result.rows[8].json.contains("$float"));
    assert_eq!(result.columns, ["_id", "v"]);
}

#[test]
fn table_columns_are_id_first_then_by_name_and_missing_is_not_null() {
    let fx = Fixture::new();
    fx.insert(
        "t",
        &[
            r#"{"zeta": 1, "alpha": null, "nested": {"deep": [1, 2]}}"#,
            r#"{"beta": "b", "zeta": 9223372036854775807}"#,
        ],
    );

    let result = fx.session.query(&request("t")).unwrap();

    assert_eq!(result.columns, ["_id", "alpha", "beta", "nested", "zeta"]);
    let first = &result.rows[0].cells;
    let second = &result.rows[1].cells;
    assert_eq!(first["alpha"].kind, ValueKind::Null);
    assert!(!second.contains_key("alpha"), "missing has no cell at all");
    assert_eq!(first["nested"].kind, ValueKind::Object);
    assert_eq!(first["nested"].preview, r#"{"deep":[1,2]}"#);
    assert_eq!(second["zeta"].preview, "9223372036854775807");
    assert_eq!(first["_id"].kind, ValueKind::Id);
    assert_eq!(first["_id"].preview, result.rows[0].id);
}

#[test]
fn long_values_are_shortened_in_cells_but_not_in_the_json() {
    let fx = Fixture::new();
    let long = "ä".repeat(500);
    fx.insert("t", &[&format!(r#"{{"text": "{long}"}}"#)]);

    let result = fx.session.query(&request("t")).unwrap();

    let cell = &result.rows[0].cells["text"];
    assert_eq!(cell.preview.chars().count(), 121);
    assert!(cell.preview.ends_with('…'));
    assert!(result.rows[0].json.contains(&long));
}

#[test]
fn typed_conditions_agree_with_direct_trunkdb_calls() {
    let (fx, ids) = typed_fixture();
    let when: DateTime = WHEN.parse().unwrap();
    use Operator::*;
    use ValueType as T;

    let cases: Vec<(ConditionInput, Filter, usize)> = vec![
        (
            condition("name", Eq, Some((T::String, "Bo"))),
            Filter::new().eq("name", "Bo"),
            1,
        ),
        (
            condition("name", Ne, Some((T::String, "Bo"))),
            Filter::new().ne("name", "Bo"),
            4,
        ),
        (
            condition("n", Eq, Some((T::Int, "9223372036854775807"))),
            Filter::new().eq("n", i64::MAX),
            1,
        ),
        (
            condition("n", Lt, Some((T::Int, " 9223372036854775807 "))),
            Filter::new().lt("n", i64::MAX),
            3,
        ),
        (
            condition("n", Gte, Some((T::Int, "-9223372036854775808"))),
            Filter::new().gte("n", i64::MIN),
            4,
        ),
        (
            condition("f", Gt, Some((T::Float, "2.0"))),
            Filter::new().gt("f", 2.0),
            1,
        ),
        (
            condition("f", Lte, Some((T::Float, "2"))),
            Filter::new().lte("f", 2.0),
            3,
        ),
        (
            condition("ok", Eq, Some((T::Bool, "true"))),
            Filter::new().eq("ok", true),
            2,
        ),
        (
            condition("at", Gte, Some((T::DateTime, WHEN))),
            Filter::new().gte("at", Document::DateTime(when)),
            2,
        ),
        (
            condition("ref", Eq, Some((T::Id, &ids[0].to_string()))),
            Filter::new().eq("ref", ids[0]),
            1,
        ),
        (
            condition("_id", Eq, Some((T::Id, &ids[2].to_string()))),
            Filter::new().id(ids[2]),
            1,
        ),
        (
            condition("address.city", Eq, Some((T::String, "Berlin"))),
            Filter::new().eq("address.city", "Berlin"),
            1,
        ),
    ];
    for (input, direct, expected) in cases {
        let label = format!("{input:?}");
        assert_eq!(assert_agrees(&fx, vec![input], direct), expected, "{label}");
    }
}

#[test]
fn contains_ignores_case_and_matches_strings_only() {
    let (fx, _) = typed_fixture();

    let found = assert_agrees(
        &fx,
        vec![condition(
            "name",
            Operator::Contains,
            Some((ValueType::String, "ANNA")),
        )],
        Filter::new().contains("name", "ANNA"),
    );
    assert_eq!(found, 2);
    // The number 7 is not the string "7".
    let found = assert_agrees(
        &fx,
        vec![condition(
            "name",
            Operator::Contains,
            Some((ValueType::String, "7")),
        )],
        Filter::new().contains("name", "7"),
    );
    assert_eq!(found, 0);
}

#[test]
fn null_matches_null_and_missing_while_exists_and_missing_tell_them_apart() {
    let (fx, _) = typed_fixture();
    use Operator::*;

    let null_or_missing = assert_agrees(
        &fx,
        vec![condition("note", Eq, Some((ValueType::Null, "")))],
        Filter::new().is_null("note"),
    );
    let exists = assert_agrees(
        &fx,
        vec![condition("note", Exists, None)],
        Filter::new().exists("note"),
    );
    let missing = assert_agrees(
        &fx,
        vec![condition("note", Missing, None)],
        Filter::new().missing("note"),
    );

    // "note": null once, "x" once, absent three times.
    assert_eq!((null_or_missing, exists, missing), (4, 2, 3));
}

#[test]
fn conditions_are_combined_with_and() {
    let (fx, _) = typed_fixture();

    let found = assert_agrees(
        &fx,
        vec![
            condition(
                "name",
                Operator::Contains,
                Some((ValueType::String, "anna")),
            ),
            condition("ok", Operator::Eq, Some((ValueType::Bool, "false"))),
            condition("address", Operator::Exists, None),
        ],
        Filter::new()
            .contains("name", "anna")
            .eq("ok", false)
            .exists("address"),
    );
    assert_eq!(found, 1);
}

#[test]
fn invalid_typed_input_is_refused_and_names_its_condition() {
    let (fx, _) = typed_fixture();
    use Operator::*;
    use ValueType as T;
    let invalid = [
        condition("n", Eq, Some((T::Int, "9223372036854775808"))),
        condition("n", Eq, Some((T::Int, "1.0"))),
        condition("n", Eq, Some((T::Int, ""))),
        condition("f", Eq, Some((T::Float, "two"))),
        condition("ok", Eq, Some((T::Bool, "yes"))),
        condition("at", Eq, Some((T::DateTime, "2026-03-01"))),
        condition("ref", Eq, Some((T::Id, "not-a-uuid"))),
        condition("name", Contains, Some((T::Int, "7"))),
        condition("name", Eq, None),
        condition("", Exists, None),
    ];

    for bad in invalid {
        let label = format!("{bad:?}");
        let mut req = request("things");
        // A valid condition first: the error must point at the second.
        req.filter = FilterInput::Rows(vec![condition("name", Exists, None), bad]);
        let error = fx.session.query(&req).unwrap_err();
        assert_eq!(error.category, ErrorCategory::InvalidInput, "{label}");
        assert!(
            error.message.starts_with("Condition 2:"),
            "{label}: {error}"
        );
    }
}

#[test]
fn pages_over_equal_sort_values_neither_overlap_nor_omit() {
    let fx = Fixture::new();
    let texts: Vec<String> = (0..57)
        .map(|n| format!(r#"{{"group": {}, "n": {n}}}"#, n % 3))
        .collect();
    let all = fx.insert(
        "items",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );

    for descending in [false, true] {
        let mut seen = Vec::new();
        let mut groups = Vec::new();
        for page in 0..6 {
            let mut req = request("items");
            req.sort = SortInput {
                field: "group".to_string(),
                descending,
            };
            req.page = page;
            req.page_size = 10;
            let result = fx.session.query(&req).unwrap();
            assert_eq!(
                (result.total, result.page_count, result.page),
                (57, 6, page)
            );
            assert_eq!(result.rows.len(), if page == 5 { 7 } else { 10 });
            for row in &result.rows {
                seen.push(row.id.clone());
                groups.push(row.cells["group"].preview.clone());
            }
        }
        let distinct: BTreeSet<&String> = seen.iter().collect();
        assert_eq!(distinct.len(), 57, "a document appeared twice");
        let expected: BTreeSet<String> = all.iter().map(DocId::to_string).collect();
        assert_eq!(
            distinct.into_iter().cloned().collect::<BTreeSet<_>>(),
            expected
        );
        let mut ordered = groups.clone();
        ordered.sort();
        if descending {
            ordered.reverse();
        }
        assert_eq!(groups, ordered, "sorted across pages, not within one");
    }
}

#[test]
fn the_total_counts_the_conditions_not_the_page() {
    let fx = Fixture::new();
    let texts: Vec<String> = (0..30)
        .map(|n| format!(r#"{{"even": {}}}"#, n % 2 == 0))
        .collect();
    fx.insert(
        "items",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );

    let mut req = request("items");
    req.filter = FilterInput::Rows(vec![condition(
        "even",
        Operator::Eq,
        Some((ValueType::Bool, "true")),
    )]);
    req.page_size = 10;
    req.page = 1;
    let result = fx.session.query(&req).unwrap();

    assert_eq!(
        (result.total, result.page_count, result.rows.len()),
        (15, 2, 5)
    );
    assert_eq!(result.request_id, 1);
}

#[test]
fn a_page_past_the_end_becomes_the_last_valid_page() {
    let fx = Fixture::new();
    let texts: Vec<String> = (0..25).map(|n| format!(r#"{{"n": {n}}}"#)).collect();
    fx.insert(
        "items",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );

    let mut req = request("items");
    req.page_size = 10;
    req.page = 9;
    let result = fx.session.query(&req).unwrap();

    assert_eq!(
        (result.page, result.page_count, result.rows.len()),
        (2, 3, 5)
    );
}

#[test]
fn an_empty_result_has_no_page_and_no_rows() {
    let (fx, _) = typed_fixture();

    let mut req = request("things");
    req.filter = FilterInput::Rows(vec![condition(
        "name",
        Operator::Eq,
        Some((ValueType::String, "nobody")),
    )]);
    req.page = 3;
    let filtered = fx.session.query(&req).unwrap();
    assert_eq!(
        (filtered.total, filtered.page, filtered.page_count),
        (0, 0, 0)
    );
    assert!(filtered.rows.is_empty() && filtered.columns.is_empty());

    // A collection that does not exist (a virtual one) reads as empty.
    let unknown = fx.session.query(&request("never-stored")).unwrap();
    assert_eq!((unknown.total, unknown.page_count), (0, 0));
    assert_eq!(fx.session.overview().unwrap().collections.len(), 1);
}

#[test]
fn an_empty_sort_field_means_id_order_and_page_size_is_bounded() {
    let fx = Fixture::new();
    let ids = fx.insert("items", &[r#"{"n": 3}"#, r#"{"n": 1}"#, r#"{"n": 2}"#]);

    let mut req = request("items");
    req.sort.field = String::new();
    let result = fx.session.query(&req).unwrap();
    let listed: Vec<String> = result.rows.iter().map(|row| row.id.clone()).collect();
    let mut expected: Vec<DocId> = ids.clone();
    expected.sort();
    assert_eq!(
        listed,
        expected.iter().map(DocId::to_string).collect::<Vec<_>>()
    );

    for size in [0, 1001] {
        req.page_size = size;
        let error = fx.session.query(&req).unwrap_err();
        assert_eq!(error.category, ErrorCategory::InvalidInput);
    }
}

#[test]
fn a_query_keeps_no_snapshot_open() {
    let (fx, _) = typed_fixture();

    fx.session.query(&request("things")).unwrap();
    fx.session.overview().unwrap();

    // trunkdb refuses to compact while any snapshot is open.
    fx.session
        .write(|db| Ok(db.compact().map(|_| ())?))
        .unwrap();
}
