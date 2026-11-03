//! Chosen columns (trunkdb SPEC §106): the list reads and shows only the
//! fields chosen, nested paths included, and trunkdb answers from index
//! entries where it can.

mod common;

use common::Fixture;
use trunkdb::Document;
use trunkdb::query::Filter;
use trunkdb_admin_core::{
    ConditionInput, ErrorCategory, FilterInput, Operator, QueryRequest, SortInput, ValueInput,
    ValueKind, ValueType,
};

fn request(collection: &str, select: Option<&[&str]>) -> QueryRequest {
    QueryRequest {
        request_id: 3,
        collection: collection.to_string(),
        filter: FilterInput::default(),
        sort: SortInput {
            field: "_id".into(),
            descending: false,
        },
        page: 0,
        page_size: 50,
        select: select.map(|paths| paths.iter().map(|p| p.to_string()).collect()),
        except: Vec::new(),
        hint: None,
    }
}

fn people() -> Fixture {
    let fixture = Fixture::new();
    fixture.insert(
        "people",
        &[
            r#"{"name": "Ann", "address": {"city": "Bonn", "zip": "53111"}, "note": null, "bio": "long"}"#,
            r#"{"name": "Bo", "address": "unknown"}"#,
            r#"{"name": "Cy", "address": {"zip": "50667"}, "tags": [{"city": "x"}]}"#,
        ],
    );
    fixture
}

#[test]
fn chosen_paths_are_the_columns_and_all_a_row_holds() {
    let fixture = people();
    let result = fixture
        .session
        .query(&request(
            "people",
            Some(&["address.city", "name", "note", "_id", "name"]),
        ))
        .unwrap();
    // `_id` first, then in the order chosen, without repeats.
    assert_eq!(result.columns, ["_id", "address.city", "name", "note"]);
    assert_eq!(
        result.select,
        Some(vec!["address.city".into(), "name".into(), "note".into()])
    );
    let [ann, bo, cy] = &result.rows[..] else {
        panic!("three rows")
    };
    assert_eq!(ann.cells["address.city"].preview, "Bonn");
    assert_eq!(ann.cells["note"].kind, ValueKind::Null);
    assert_eq!(ann.cells["_id"].preview, ann.id);
    let keys = |row: &trunkdb_admin_core::ResultRow| -> Vec<String> {
        row.cells.keys().cloned().collect()
    };
    assert_eq!(keys(ann), ["_id", "address.city", "name", "note"]);
    // Missing stays missing, through a string and past a missing field.
    assert_eq!(keys(bo), ["_id", "name"]);
    assert_eq!(keys(cy), ["_id", "name"]);
    // The JSON is the chosen fields, nested as stored.
    assert!(ann.json.contains("\"city\": \"Bonn\""), "{}", ann.json);
    assert!(!ann.json.contains("zip") && !ann.json.contains("bio"));

    // Whole documents without a choice.
    let whole = fixture.session.query(&request("people", None)).unwrap();
    assert_eq!(whole.select, None);
    assert!(whole.rows[0].json.contains("bio"));
    assert_eq!(
        whole.columns,
        ["_id", "address", "bio", "name", "note", "tags"]
    );
}

#[test]
fn a_chosen_nested_path_sorts_and_filters_as_ever() {
    let fixture = people();
    let mut asked = request("people", Some(&["address.city"]));
    asked.sort = SortInput {
        field: "address.city".into(),
        descending: true,
    };
    asked.filter = FilterInput::Rows(vec![ConditionInput {
        field: "name".into(),
        operator: Operator::Ne,
        value: Some(ValueInput {
            value_type: ValueType::String,
            text: "Cy".into(),
        }),
        ..Default::default()
    }]);
    let result = fixture.session.query(&asked).unwrap();
    assert_eq!(result.total, 2);
    let cities: Vec<Option<&str>> = (result.rows.iter())
        .map(|row| row.cells.get("address.city").map(|c| c.preview.as_str()))
        .collect();
    assert_eq!(cities, [Some("Bonn"), None]);
}

#[test]
fn chosen_index_fields_are_shown_from_the_entries() {
    let fixture = Fixture::new();
    let tasks: Vec<String> = (0..200)
        .map(|n| {
            format!(
                r#"{{"status": "{}", "title": "task {n}", "body": "{}"}}"#,
                ["queued", "done"][n % 2],
                "x".repeat(200)
            )
        })
        .collect();
    let tasks: Vec<&str> = tasks.iter().map(String::as_str).collect();
    fixture.insert("tasks", &tasks);
    fixture
        .session
        .write(|db| {
            db.collection::<Document>("tasks").ensure_index("status")?;
            Ok(())
        })
        .unwrap();
    let mut asked = request("tasks", Some(&["status"]));
    asked.filter = FilterInput::Rows(vec![ConditionInput {
        field: "status".into(),
        operator: Operator::Eq,
        value: Some(ValueInput {
            value_type: ValueType::String,
            text: "done".into(),
        }),
        ..Default::default()
    }]);
    let report = fixture.session.explain(&asked).unwrap();
    let direct = fixture
        .session
        .read(|db| {
            Ok(db.collection::<Document>("tasks").explain_run(
                Filter::new()
                    .eq("status", "done")
                    .sort_asc("_id")
                    .limit(50)
                    .select(["status"]),
            )?)
        })
        .unwrap();
    assert_eq!(report.from_entries, direct.stats.from_entries);
    assert_eq!(report.from_entries, 50, "{report:?}");
    assert_eq!(report.documents_examined, 0);
    assert_eq!(report.groups, None);

    // Whole documents are read.
    asked.select = None;
    let report = fixture.session.explain(&asked).unwrap();
    assert_eq!((report.from_entries, report.documents_examined), (0, 50));
}

#[test]
fn a_path_that_names_no_field_is_refused() {
    let fixture = people();
    for (select, says) in [
        (&["name", ""][..], "Column 2: enter a field path."),
        (
            &["tags[*]"][..],
            "Column 1: choose the array \u{201c}tags\u{201d}",
        ),
    ] {
        let error = fixture
            .session
            .query(&request("people", Some(select)))
            .unwrap_err();
        assert_eq!(error.category, ErrorCategory::InvalidInput);
        assert!(error.message.starts_with(says), "{}", error.message);
        let error = fixture
            .session
            .explain(&request("people", Some(select)))
            .unwrap_err();
        assert_eq!(error.category, ErrorCategory::InvalidInput);
    }
}

/// Hidden fields (trunkdb SPEC §143): whole documents without them,
/// a nested one taken out of its object; the rest in stored order.
#[test]
fn hidden_fields_are_left_out_of_whole_documents() {
    let fixture = people();
    let mut asked = request("people", None);
    asked.except = vec!["bio".into(), "address.zip".into(), "bio".into()];
    let result = fixture.session.query(&asked).unwrap();
    assert_eq!(result.except, ["bio", "address.zip"]);
    assert_eq!(result.select, None);
    assert_eq!(result.columns, ["_id", "address", "name", "note", "tags"]);
    let ann = &result.rows[0];
    assert!(!ann.cells.contains_key("bio"));
    assert_eq!(ann.cells["address"].preview, r#"{"city":"Bonn"}"#);
    assert!(!ann.json.contains("53111") && !ann.json.contains("long"));
    let command = fixture.session.find_command(&asked).unwrap();
    assert!(command.contains("except"), "{command}");

    for (except, select, problem) in [
        (vec!["_id"], None, "_id always comes"),
        (vec!["tags[*].city"], None, "itself"),
        (vec![""], None, "enter a field path"),
        (vec!["bio"], Some(vec!["name".to_string()]), "not both"),
    ] {
        asked.except = except.into_iter().map(String::from).collect();
        asked.select = select;
        let error = fixture.session.query(&asked).expect_err(problem);
        assert_eq!(error.category, ErrorCategory::InvalidInput);
        assert!(error.message.contains(problem), "{}", error.message);
    }
}
