//! Document CRUD through the editor's text contract, and dropping
//! collections.

mod common;

use common::{Fixture, doc};
use trunkdb::{DocId, Document, IndexOptions};
use trunkdb_admin_core::{
    ConditionInput, DocumentView, ErrorCategory, FilterInput, Operator, SaveRequest, ValueInput,
    ValueType,
};

fn save(collection: &str, id: Option<&str>, json: &str) -> SaveRequest {
    SaveRequest {
        collection: collection.to_string(),
        id: id.map(str::to_string),
        json: json.to_string(),
        filter: FilterInput::default(),
    }
}

fn eq_string(field: &str, text: &str) -> ConditionInput {
    ConditionInput {
        field: field.to_string(),
        operator: Operator::Eq,
        value: Some(ValueInput {
            value_type: ValueType::String,
            text: text.to_string(),
        }),
    }
}

fn stored(fx: &Fixture, collection: &str, id: &str) -> Option<Document> {
    let id: DocId = id.parse().unwrap();
    fx.session
        .read(|db| Ok(db.collection::<Document>(collection).get(&id)?))
        .unwrap()
}

fn count(fx: &Fixture, collection: &str) -> usize {
    fx.session
        .read(|db| {
            Ok(db
                .collection::<Document>(collection)
                .count(Default::default())?)
        })
        .unwrap()
}

#[test]
fn insert_generates_the_id_and_the_document_survives_a_reopen() {
    let mut fx = Fixture::new();

    let saved = fx
        .session
        .save_document(&save("people", None, r#"{"name": "Ann", "age": 41}"#))
        .unwrap();

    assert!(saved.created && saved.matches_filter);
    let id = saved.document.id.clone();
    id.parse::<DocId>().expect("a trunkdb-generated ID");
    assert_eq!(
        doc(&saved.document.json),
        doc(r#"{"name": "Ann", "age": 41}"#)
    );
    assert!(
        !saved.document.json.contains("_id"),
        "the ID is shown apart"
    );

    fx.reopen();
    let read = fx.session.read_document("people", &id).unwrap();
    assert_eq!(read, saved.document);
    let whole = stored(&fx, "people", &id).unwrap();
    assert_eq!(
        whole,
        doc(&format!(
            r#"{{"_id": {{"$id": "{id}"}}, "name": "Ann", "age": 41}}"#
        ))
    );
}

#[test]
fn update_replaces_the_whole_body_and_keeps_the_id() {
    let fx = Fixture::new();
    let id = fx.insert("people", &[r#"{"name": "Ann", "age": 41, "city": "Bonn"}"#])[0].to_string();

    let saved = fx
        .session
        .save_document(&save(
            "people",
            Some(&id),
            r#"{"name": "Ann B.", "tags": []}"#,
        ))
        .unwrap();

    assert!(!saved.created);
    assert_eq!(saved.document.id, id);
    // Fields left out of the text are gone from storage.
    assert_eq!(
        stored(&fx, "people", &id).unwrap(),
        doc(&format!(
            r#"{{"_id": {{"$id": "{id}"}}, "name": "Ann B.", "tags": []}}"#
        ))
    );
    assert_eq!(count(&fx, "people"), 1);
}

#[test]
fn updating_or_deleting_a_document_that_is_gone_is_not_success() {
    let fx = Fixture::new();
    let id = fx.insert("people", &[r#"{"name": "Ann"}"#])[0].to_string();

    fx.session.delete_document("people", &id).unwrap();
    assert_eq!(stored(&fx, "people", &id), None);

    let update = fx
        .session
        .save_document(&save("people", Some(&id), r#"{"name": "again"}"#))
        .unwrap_err();
    assert_eq!(update.category, ErrorCategory::TargetNotFound);
    assert_eq!(count(&fx, "people"), 0, "a failed update must not insert");
    let delete = fx.session.delete_document("people", &id).unwrap_err();
    assert_eq!(delete.category, ErrorCategory::TargetNotFound);
    let read = fx.session.read_document("people", &id).unwrap_err();
    assert_eq!(read.category, ErrorCategory::TargetNotFound);
    let bad_id = fx.session.read_document("people", "nope").unwrap_err();
    assert_eq!(bad_id.category, ErrorCategory::InvalidInput);
}

/// Every type and spelling the editor must not disturb.
const EVERYTHING: &str = r#"{
  "max": 9223372036854775807,
  "min": -9223372036854775808,
  "beyond_js": 9007199254740993,
  "float_two": 2.0,
  "small": 1e-7,
  "nan": {"$float": "NaN"},
  "inf": {"$float": "Infinity"},
  "neg_inf": {"$float": "-Infinity"},
  "when": {"$date": "2026-03-01T12:00:00.123456789Z"},
  "ref": {"$id": "0192f3a0-0000-7000-8000-000000000001"},
  "bytes": {"$binary": "AAEC/w=="},
  "tag_like": {"$object": {"$id": "just a string"}},
  "tag_like_date": {"$object": {"$date": 5}},
  "looks_like_id": "0192f3a0-0000-7000-8000-000000000001",
  "nested": {"_id": "ordinary content", "list": [1, 1.0, "1", null, true]},
  "unicode": "Ünïcödé \u0000 \" \\ 😀",
  "empty": {}
}"#;

#[test]
fn an_unchanged_body_round_trips_without_changing_types_or_values() {
    let fx = Fixture::new();
    let original = doc(EVERYTHING);

    let first = fx
        .session
        .save_document(&save("t", None, EVERYTHING))
        .unwrap();
    let id = first.document.id.clone();

    // What the editor would show, saved again as it is, twice over.
    let shown = fx.session.read_document("t", &id).unwrap().json;
    let second = fx
        .session
        .save_document(&save("t", Some(&id), &shown))
        .unwrap();
    let third = fx
        .session
        .save_document(&save("t", Some(&id), &second.document.json))
        .unwrap();
    assert_eq!(shown, second.document.json);
    assert_eq!(shown, third.document.json, "the text is stable");

    // Compared as trunkdb values, straight from the collection.
    let Document::Object(mut fields) = stored(&fx, "t", &id).unwrap() else {
        panic!("not an object");
    };
    assert_eq!(
        fields.remove("_id"),
        Some(Document::Id(id.parse().unwrap()))
    );
    let (Document::Object(expected), actual) = (original, fields) else {
        panic!("fixture is not an object");
    };
    // NaN is not equal to itself, so it is checked apart.
    for (name, value) in &expected {
        match value {
            Document::Float(float) if float.is_nan() => {
                assert!(
                    matches!(actual[name], Document::Float(f) if f.is_nan()),
                    "{name}"
                );
            }
            other => assert_eq!(&actual[name], other, "{name}"),
        }
    }
    assert_eq!(actual.len(), expected.len());
    assert_eq!(
        actual.keys().collect::<Vec<_>>(),
        expected.keys().collect::<Vec<_>>()
    );

    // The spellings that carry the type are in the text itself.
    for spelling in [
        "9223372036854775807",
        "-9223372036854775808",
        "9007199254740993",
        "\"float_two\": 2.0",
        "\"$float\": \"NaN\"",
        "\"$date\": \"2026-03-01T12:00:00.123456789Z\"",
        "\"$binary\": \"AAEC/w==\"",
        "\"$object\"",
    ] {
        assert!(shown.contains(spelling), "{spelling} missing in:\n{shown}");
    }
    assert!(matches!(actual["tag_like"], Document::Object(_)));
    assert!(matches!(actual["looks_like_id"], Document::String(_)));
    assert!(matches!(actual["float_two"], Document::Float(_)));
    assert!(matches!(
        actual["beyond_js"],
        Document::Int(9007199254740993)
    ));
}

#[test]
fn format_only_reformats() {
    let formatted = DocumentView::format_body(
        r#"{"b":2.0,"a":{"$id":"0192f3a0-0000-7000-8000-000000000001"}}"#,
    )
    .unwrap();

    assert_eq!(
        doc(&formatted),
        doc(r#"{"b": 2.0, "a": {"$id": "0192f3a0-0000-7000-8000-000000000001"}}"#)
    );
    assert!(formatted.contains('\n') && formatted.contains("2.0"));
    assert!(
        formatted.find("\"b\"").unwrap() < formatted.find("\"a\"").unwrap(),
        "key order kept"
    );
}

#[test]
fn bodies_that_are_not_plain_objects_are_refused_and_nothing_is_written() {
    let fx = Fixture::new();
    let id = fx.insert("t", &[r#"{"keep": true}"#])[0].to_string();
    let other = "0192f3a0-0000-7000-8000-00000000abcd";
    let deep = format!("{}1{}", "[".repeat(70), "]".repeat(70));
    let refused: Vec<(String, ErrorCategory)> = vec![
        ("42".into(), ErrorCategory::InvalidInput),
        (r#""text""#.into(), ErrorCategory::InvalidInput),
        ("[1, 2]".into(), ErrorCategory::InvalidInput),
        ("null".into(), ErrorCategory::InvalidInput),
        // A tag at the top is a scalar, not an object.
        (
            r#"{"$date": "2026-03-01T12:00:00Z"}"#.into(),
            ErrorCategory::InvalidInput,
        ),
        (
            format!(r#"{{"_id": {{"$id": "{other}"}}, "a": 1}}"#),
            ErrorCategory::InvalidInput,
        ),
        (
            format!(r#"{{"_id": {{"$id": "{id}"}}, "a": 1}}"#),
            ErrorCategory::InvalidInput,
        ),
        (
            r#"{"_id": "custom", "a": 1}"#.into(),
            ErrorCategory::InvalidInput,
        ),
        (format!(r#"{{"a": {deep}}}"#), ErrorCategory::InvalidInput),
        (r#"{"a": 1,}"#.into(), ErrorCategory::InvalidJson),
        (
            r#"{"a": 9223372036854775808}"#.into(),
            ErrorCategory::InvalidJson,
        ),
        (
            r#"{"a": {"$id": "not a uuid"}}"#.into(),
            ErrorCategory::InvalidJson,
        ),
        ("".into(), ErrorCategory::InvalidJson),
    ];

    for (json, category) in refused {
        let label: String = json.chars().take(60).collect();
        let insert = fx
            .session
            .save_document(&save("t", None, &json))
            .unwrap_err();
        assert_eq!(insert.category, category, "insert {label}: {insert}");
        let update = fx
            .session
            .save_document(&save("t", Some(&id), &json))
            .unwrap_err();
        assert_eq!(update.category, category, "update {label}");
        assert_eq!(
            DocumentView::format_body(&json).unwrap_err().category,
            category
        );
    }

    assert_eq!(count(&fx, "t"), 1);
    assert_eq!(
        fx.session.read_document("t", &id).unwrap().json,
        "{\n  \"keep\": true\n}"
    );
    assert_eq!(stored(&fx, "t", other), None);
}

/// The deepest body trunkdb writes, 64 levels with the object around it,
/// is formatted and saved; one level more is refused before the write,
/// as trunkdb's own write would refuse it (its SPEC §56, §118).
#[test]
fn the_nesting_limit_is_trunkdbs() {
    let fx = Fixture::new();
    let body = |arrays: usize| format!(r#"{{"a": {}1{}}}"#, "[".repeat(arrays), "]".repeat(arrays));
    let deepest = body(trunkdb::Document::MAX_NESTING - 1);
    DocumentView::format_body(&deepest).unwrap();
    fx.session
        .save_document(&save("t", None, &deepest))
        .unwrap();
    let too_deep = body(trunkdb::Document::MAX_NESTING);
    let error = DocumentView::format_body(&too_deep).unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    assert!(
        error.message.contains("deeper than 64"),
        "{}",
        error.message
    );
    assert_eq!(count(&fx, "t"), 1);
}

#[test]
fn a_nested_id_field_is_ordinary_content() {
    let fx = Fixture::new();

    let saved = fx
        .session
        .save_document(&save(
            "t",
            None,
            r#"{"child": {"_id": 7}, "items": [{"_id": "x"}]}"#,
        ))
        .unwrap();

    assert_eq!(
        doc(&saved.document.json),
        doc(r#"{"child": {"_id": 7}, "items": [{"_id": "x"}]}"#)
    );
}

#[test]
fn saving_reports_filter_membership_independently_of_pages() {
    let fx = Fixture::new();
    let texts: Vec<String> = (0..120)
        .map(|n| format!(r#"{{"city": "Bonn", "n": {n}}}"#))
        .collect();
    let ids = fx.insert(
        "people",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let in_bonn = vec![eq_string("city", "Bonn")];

    // Still matching, though far beyond any first page.
    let mut request = save(
        "people",
        Some(&ids[119].to_string()),
        r#"{"city": "Bonn", "n": -1}"#,
    );
    request.filter = FilterInput::Rows(in_bonn.clone());
    assert!(fx.session.save_document(&request).unwrap().matches_filter);

    // Edited out of the filter.
    request.json = r#"{"city": "Berlin"}"#.to_string();
    let moved = fx.session.save_document(&request).unwrap();
    assert!(!moved.matches_filter);
    assert_eq!(
        doc(&moved.document.json),
        doc(r#"{"city": "Berlin"}"#),
        "saved all the same"
    );

    // A new document outside the filter, and one inside it.
    let mut outside = save("people", None, r#"{"city": "Bremen"}"#);
    outside.filter = FilterInput::Rows(in_bonn.clone());
    assert!(!fx.session.save_document(&outside).unwrap().matches_filter);
    let mut inside = save("people", None, r#"{"city": "Bonn"}"#);
    inside.filter = FilterInput::Rows(in_bonn);
    assert!(fx.session.save_document(&inside).unwrap().matches_filter);
}

#[test]
fn invalid_filter_conditions_stop_a_save_before_it_writes() {
    let fx = Fixture::new();
    let mut request = save("people", None, r#"{"a": 1}"#);
    request.filter = FilterInput::Rows(vec![ConditionInput {
        field: "n".to_string(),
        operator: Operator::Eq,
        value: Some(ValueInput {
            value_type: ValueType::Int,
            text: "abc".to_string(),
        }),
    }]);

    let error = fx.session.save_document(&request).unwrap_err();

    assert_eq!(error.category, ErrorCategory::InvalidInput);
    assert_eq!(count(&fx, "people"), 0);
    assert!(fx.session.overview().unwrap().collections.is_empty());
}

#[test]
fn a_unique_conflict_on_save_changes_nothing() {
    let fx = Fixture::new();
    let ids = fx.insert("users", &[r#"{"email": "a@x"}"#, r#"{"email": "b@x"}"#]);
    fx.session
        .write(|db| {
            db.collection::<Document>("users")
                .ensure_index_with("email", IndexOptions::new().unique())?;
            Ok(())
        })
        .unwrap();

    let insert = fx
        .session
        .save_document(&save("users", None, r#"{"email": "a@x"}"#))
        .unwrap_err();
    let update = fx
        .session
        .save_document(&save(
            "users",
            Some(&ids[1].to_string()),
            r#"{"email": "a@x"}"#,
        ))
        .unwrap_err();

    assert_eq!(insert.category, ErrorCategory::UniqueConflict);
    assert_eq!(update.category, ErrorCategory::UniqueConflict);
    assert!(update.detail.unwrap().contains("email"));
    assert_eq!(count(&fx, "users"), 2);
    assert_eq!(
        doc(&fx
            .session
            .read_document("users", &ids[1].to_string())
            .unwrap()
            .json),
        doc(r#"{"email": "b@x"}"#)
    );
}

#[test]
fn the_first_insert_persists_a_virtual_collection_and_a_refused_one_does_not() {
    let mut fx = Fixture::new();
    fx.session.prepare_collection("drafts").unwrap();

    fx.session
        .save_document(&save("drafts", None, "[1]"))
        .unwrap_err();
    let overview = fx.session.overview().unwrap();
    assert!(
        !overview.collections[0].persisted,
        "a failed insert leaves it virtual"
    );

    fx.session
        .save_document(&save("drafts", None, "{}"))
        .unwrap();
    let overview = fx.session.overview().unwrap();
    assert!(overview.collections[0].persisted);
    assert_eq!(overview.collections[0].count, Some(1));
    fx.reopen();
    assert_eq!(fx.session.overview().unwrap().collections[0].name, "drafts");
}

#[test]
fn dropping_a_collection_removes_its_documents_and_indexes_only() {
    let mut fx = Fixture::new();
    fx.insert("keep", &[r#"{"a": 1}"#]);
    fx.insert("gone", &[r#"{"a": 1}"#, r#"{"a": 2}"#]);
    fx.session
        .write(|db| Ok(db.collection::<Document>("gone").ensure_index("a")?))
        .unwrap();
    fx.session.prepare_collection("virtual").unwrap();

    let overview = fx.session.drop_collection("gone").unwrap();

    let names: Vec<&str> = overview
        .collections
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, ["keep", "virtual"]);
    assert_eq!(count(&fx, "gone"), 0);

    let missing = fx.session.drop_collection("gone").unwrap_err();
    assert_eq!(missing.category, ErrorCategory::TargetNotFound);
    // A virtual collection is not in the file: this operation refuses it.
    let unsaved = fx.session.drop_collection("virtual").unwrap_err();
    assert_eq!(unsaved.category, ErrorCategory::TargetNotFound);

    fx.reopen();
    let overview = fx.session.overview().unwrap();
    assert_eq!(overview.collections.len(), 1);
    assert_eq!(overview.collections[0].count, Some(1));
}

#[test]
fn a_closed_session_writes_nothing() {
    let fx = Fixture::new();
    let id = fx.insert("t", &[r#"{"a": 1}"#])[0].to_string();
    let closed = fx.session.clone();
    fx.manager.close(closed.id()).unwrap();

    for error in [
        closed.save_document(&save("t", None, "{}")).unwrap_err(),
        closed
            .save_document(&save("t", Some(&id), "{}"))
            .unwrap_err(),
        closed.delete_document("t", &id).unwrap_err(),
        closed.drop_collection("t").unwrap_err(),
        closed.read_document("t", &id).map(|_| ()).unwrap_err(),
    ] {
        assert_eq!(error.category, ErrorCategory::SessionClosed);
    }

    let reopened = fx.manager.open_existing(&fx.path).unwrap();
    assert_eq!(
        doc(&reopened.read_document("t", &id).unwrap().json),
        doc(r#"{"a": 1}"#)
    );
}
