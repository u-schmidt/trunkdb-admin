//! Documents counted by group (trunkdb SPEC §107): grouped, counted and
//! sorted by trunkdb, paged by the app, each group's documents one
//! filter away.

mod common;

use common::Fixture;
use trunkdb::Document;
use trunkdb::query::{Aggregate, Filter};
use trunkdb_admin_core::{
    ColumnInput, ColumnKind, ConditionInput, ErrorCategory, FilterInput, GroupRequest, GroupResult,
    GroupSort, Operator, PlanKind, QueryRequest, SortInput, ValueInput, ValueType,
};

fn request(collection: &str, group_by: &[&str]) -> GroupRequest {
    GroupRequest {
        request_id: 9,
        collection: collection.to_string(),
        filter: FilterInput::default(),
        unwind: Vec::new(),
        group_by: group_by.iter().map(|s| s.to_string()).collect(),
        columns: Vec::new(),
        sort: None,
        page: 0,
        page_size: 50,
    }
}

fn column(kind: ColumnKind, field: &str) -> ColumnInput {
    ColumnInput {
        kind,
        field: field.to_string(),
        condition: String::new(),
        by: String::new(),
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
        ..Default::default()
    }
}

/// 300 tasks: `status` a third each, `tenant` t0–t9, `tries` 0–6.
fn tasks() -> Fixture {
    let fixture = Fixture::new();
    let tasks: Vec<String> = (0..300)
        .map(|n| {
            format!(
                r#"{{"status": "{}", "tenant": "t{}", "tries": {}, "created": {{"$date": "2026-01-01T00:{:02}:{:02}Z"}}}}"#,
                ["queued", "running", "done"][n % 3],
                n % 10,
                n % 7,
                n / 60,
                n % 60
            )
        })
        .collect();
    let tasks: Vec<&str> = tasks.iter().map(String::as_str).collect();
    fixture.insert("tasks", &tasks);
    fixture
}

fn previews(result: &GroupResult) -> Vec<Vec<String>> {
    (result.rows.iter())
        .map(|row| row.cells.iter().map(|c| c.preview.clone()).collect())
        .collect()
}

/// How many documents the list finds with `filter`.
fn listed(fixture: &Fixture, collection: &str, filter: FilterInput) -> usize {
    fixture
        .session
        .query(&QueryRequest {
            request_id: 1,
            collection: collection.to_string(),
            filter,
            sort: SortInput {
                field: "_id".into(),
                descending: false,
            },
            page: 0,
            page_size: 1,
            select: None,
            except: Vec::new(),
            hint: None,
        })
        .unwrap()
        .total
}

/// Every group's documents, through the list, are as many as it counts.
fn drills_find_what_is_counted(fixture: &Fixture, collection: &str, result: &GroupResult) {
    let count_at = result
        .columns
        .iter()
        .position(|c| c.label == "count")
        .unwrap();
    for row in &result.rows {
        let Some(conditions) = &row.documents else {
            continue;
        };
        let counted: usize = row.cells[count_at].preview.parse().unwrap();
        assert_eq!(
            listed(fixture, collection, conditions.clone()),
            counted,
            "{conditions:?}"
        );
    }
}

#[test]
fn documents_are_counted_per_value_in_value_order() {
    let fixture = tasks();
    let result = fixture
        .session
        .groups(&request("tasks", &["status"]))
        .unwrap();
    assert_eq!(result.request_id, 9);
    assert_eq!((result.total, result.page, result.page_count), (3, 0, 1));
    let labels: Vec<&str> = result.columns.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["status", "count"]);
    assert!(result.columns[0].group && !result.columns[1].group);
    assert_eq!(
        previews(&result),
        [["done", "100"], ["queued", "100"], ["running", "100"]]
    );
    // Show documents: the filter and `status = <value>`.
    assert_eq!(
        result.rows[0].documents,
        Some(FilterInput::Rows(vec![condition(
            "status",
            Operator::Eq,
            ValueType::String,
            "done"
        )]))
    );
    drills_find_what_is_counted(&fixture, "tasks", &result);

    // The filter picks the documents; its conditions come first in a drill.
    let mut filtered = request("tasks", &["status", "tenant"]);
    filtered.filter =
        FilterInput::Rows(vec![condition("tries", Operator::Lt, ValueType::Int, "2")]);
    let result = fixture.session.groups(&filtered).unwrap();
    assert_eq!(result.total, 30);
    let Some(FilterInput::Rows(documents)) = result.rows[0].documents.clone() else {
        panic!("rows in, rows out");
    };
    assert_eq!(documents.len(), 3);
    let FilterInput::Rows(asked) = &filtered.filter else {
        unreachable!()
    };
    assert_eq!(documents[0], asked[0]);
    drills_find_what_is_counted(&fixture, "tasks", &result);

    // Without group fields: one group of everything, even of nothing.
    let result = fixture.session.groups(&request("tasks", &[])).unwrap();
    assert_eq!(previews(&result), [["300"]]);
    assert_eq!(result.rows[0].documents, Some(FilterInput::Rows(vec![])));
    let mut none = request("tasks", &[]);
    none.filter = FilterInput::Rows(vec![condition("tries", Operator::Gt, ValueType::Int, "99")]);
    assert_eq!(previews(&fixture.session.groups(&none).unwrap()), [["0"]]);
    assert_eq!(
        previews(
            &fixture
                .session
                .groups(&request("nothing", &["status"]))
                .unwrap()
        ),
        Vec::<Vec<String>>::new()
    );
}

#[test]
fn columns_are_what_trunkdb_computes() {
    let fixture = tasks();
    let mut asked = request("tasks", &["tenant"]);
    asked.columns = vec![
        column(ColumnKind::Sum, "tries"),
        column(ColumnKind::Avg, "tries"),
        column(ColumnKind::Min, "created"),
        column(ColumnKind::Max, "tries"),
    ];
    let result = fixture.session.groups(&asked).unwrap();
    let labels: Vec<&str> = result.columns.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "tenant",
            "count",
            "sum tries",
            "average tries",
            "min created",
            "max tries"
        ]
    );
    let kinds: Vec<Option<ColumnKind>> = result.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            None,
            Some(ColumnKind::Count),
            Some(ColumnKind::Sum),
            Some(ColumnKind::Avg),
            Some(ColumnKind::Min),
            Some(ColumnKind::Max)
        ]
    );
    let direct = fixture
        .session
        .read(|db| {
            Ok(db.collection::<Document>("tasks").aggregate(
                Filter::new(),
                &Aggregate::new()
                    .group_by("tenant")
                    .count()
                    .named("n")
                    .sum("tries")
                    .named("s")
                    .avg("tries")
                    .named("a")
                    .min("created")
                    .named("lo")
                    .max("tries")
                    .named("hi"),
            )?)
        })
        .unwrap();
    assert_eq!(result.total, direct.len());
    for (row, direct) in result.rows.iter().zip(&direct) {
        let Document::Object(fields) = direct else {
            panic!("a row is an object")
        };
        let expected: Vec<String> = ["tenant", "n", "s", "a", "lo", "hi"]
            .iter()
            .map(|name| match &fields[*name] {
                Document::String(s) => s.clone(),
                Document::DateTime(t) => t.to_string(),
                other => other.to_string(),
            })
            .collect();
        let shown: Vec<String> = row.cells.iter().map(|c| c.preview.clone()).collect();
        assert_eq!(shown, expected);
    }
    // An Int sum stays an Int, an average is a Float.
    assert_eq!(
        format!("{:?}", result.rows[0].cells[2].kind),
        format!("{:?}", trunkdb_admin_core::ValueKind::Int)
    );
    assert_eq!(
        format!("{:?}", result.rows[0].cells[3].kind),
        format!("{:?}", trunkdb_admin_core::ValueKind::Float)
    );
}

#[test]
fn every_kind_of_value_finds_its_documents_or_says_why_not() {
    let fixture = Fixture::new();
    let id = fixture.insert("things", &[r#"{"v": "anchor"}"#])[0];
    let things = [
        r#"{"v": 5}"#.to_string(),
        r#"{"v": 5.0}"#.to_string(),
        r#"{"v": 2.5}"#.to_string(),
        r#"{"v": -0.1}"#.to_string(),
        r#"{"v": 9007199254740993}"#.to_string(),
        r#"{"v": {"$float": "Infinity"}}"#.to_string(),
        r#"{"v": {"$float": "NaN"}}"#.to_string(),
        r#"{"v": "a"}"#.to_string(),
        r#"{"v": "A"}"#.to_string(),
        r#"{"v": ""}"#.to_string(),
        r#"{"v": true}"#.to_string(),
        r#"{"v": false}"#.to_string(),
        r#"{"v": null}"#.to_string(),
        r#"{"w": 1}"#.to_string(),
        r#"{"v": {"$date": "2026-03-01T12:30:00.123456789Z"}}"#.to_string(),
        format!(r#"{{"v": {{"$id": "{id}"}}}}"#),
        r#"{"v": [1, 2]}"#.to_string(),
        r#"{"v": {"x": 1}}"#.to_string(),
        r#"{"v": {"$binary": "AAE="}}"#.to_string(),
    ];
    let things: Vec<&str> = things.iter().map(String::as_str).collect();
    fixture.insert("things", &things);

    let result = fixture.session.groups(&request("things", &["v"])).unwrap();
    // `5` and `5.0` are one group, shown as the first; missing is null's.
    let groups: Vec<(String, String)> = (result.rows.iter())
        .map(|row| (row.cells[0].preview.clone(), row.cells[1].preview.clone()))
        .collect();
    assert!(groups.contains(&("5".into(), "2".into())), "{groups:?}");
    assert!(groups.contains(&("null".into(), "2".into())), "{groups:?}");
    assert_eq!(result.total, 18);
    drills_find_what_is_counted(&fixture, "things", &result);

    let refused: Vec<&str> = (result.rows.iter())
        .filter(|row| row.documents.is_none())
        .map(|row| row.no_documents.as_deref().unwrap())
        .collect();
    assert_eq!(refused.len(), 4, "{refused:?}");
    for what in ["NaN", "an array", "an object", "binary data"] {
        assert!(
            refused.iter().any(|why| why.contains(what)),
            "{what}: {refused:?}"
        );
    }
    assert!(
        result
            .rows
            .iter()
            .all(|r| r.documents.is_some() != r.no_documents.is_some())
    );
    // Rows can't hold these values; the reason says where to go.
    assert!(
        refused
            .iter()
            .any(|why| why.contains("Switch the filter to Text"))
    );

    // In text, trunkdb compares arrays, objects and binary by their
    // contents (its SPEC §124): only NaN is left without its documents.
    let mut as_text = request("things", &["v"]);
    as_text.filter = FilterInput::Text(String::new());
    let result = fixture.session.groups(&as_text).unwrap();
    let refused: Vec<&str> = (result.rows.iter())
        .filter_map(|row| row.no_documents.as_deref())
        .collect();
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert!(refused[0].contains("NaN"));
    drills_find_what_is_counted(&fixture, "things", &result);
    assert!(result.rows.iter().any(|row| matches!(
        &row.documents,
        Some(FilterInput::Text(text)) if text == r#"v = {"x":1}"#
    )));
}

#[test]
fn a_nested_path_groups_and_finds_its_documents() {
    let fixture = Fixture::new();
    fixture.insert(
        "people",
        &[
            r#"{"address": {"city": "Bonn"}}"#,
            r#"{"address": {"city": "Bonn", "zip": 1}}"#,
            r#"{"address": {"city": "Köln"}}"#,
            r#"{"address": "unknown"}"#,
            r#"{"name": "no address"}"#,
        ],
    );
    let result = fixture
        .session
        .groups(&request("people", &["address.city"]))
        .unwrap();
    assert_eq!(result.columns[0].label, "address.city");
    assert_eq!(
        previews(&result),
        [["null", "2"], ["Bonn", "2"], ["Köln", "1"]]
    );
    drills_find_what_is_counted(&fixture, "people", &result);
}

#[test]
fn groups_are_sorted_by_any_column_and_paged() {
    let fixture = tasks();
    let mut asked = request("tasks", &["tries"]);
    asked.sort = Some(GroupSort {
        column: 1,
        descending: true,
    });
    asked.page_size = 3;
    let result = fixture.session.groups(&asked).unwrap();
    // `tries` is n % 7 for 300 tasks: 0–5 have 43, 6 has 42.
    assert_eq!((result.total, result.page_count), (7, 3));
    assert_eq!(
        previews(&result),
        [["0", "43"], ["1", "43"], ["2", "43"]],
        "ties keep the group order"
    );
    asked.page = 2;
    assert_eq!(
        previews(&fixture.session.groups(&asked).unwrap()),
        [["6", "42"]]
    );
    // A page past the end is the last one.
    asked.page = 9;
    let result = fixture.session.groups(&asked).unwrap();
    assert_eq!((result.page, result.rows.len()), (2, 1));
    // By the group value, descending.
    asked.sort = Some(GroupSort {
        column: 0,
        descending: true,
    });
    asked.page = 0;
    assert_eq!(
        previews(&fixture.session.groups(&asked).unwrap())[0],
        ["6", "42"]
    );
}

#[test]
fn explain_says_how_the_groups_were_made() {
    let fixture = tasks();
    let report = fixture
        .session
        .explain_groups(&request("tasks", &["status"]))
        .unwrap();
    assert_eq!(report.plan, PlanKind::Scan);
    assert_eq!(report.groups, Some(3));
    assert_eq!((report.documents_examined, report.from_entries), (300, 0));

    // An index holding the group field counts from its entries.
    fixture
        .session
        .write(|db| {
            db.collection::<Document>("tasks")
                .ensure_index(["status", "created"])?;
            Ok(())
        })
        .unwrap();
    let report = fixture
        .session
        .explain_groups(&request("tasks", &["status"]))
        .unwrap();
    assert_eq!(report.plan, PlanKind::IndexOrder);
    assert_eq!(report.reads[0].index, "(status, created)");
    assert_eq!(
        (
            report.documents_examined,
            report.from_entries,
            report.documents_matched
        ),
        (0, 300, 300)
    );
    assert_eq!(report.groups, Some(3));
    assert_eq!(report.request_id, 9);
    // A sum reads its documents (trunkdb SPEC §107.5).
    let mut summed = request("tasks", &["status"]);
    summed.columns = vec![column(ColumnKind::Sum, "created")];
    let report = fixture.session.explain_groups(&summed).unwrap();
    assert_eq!(report.from_entries, 0);

    // A list's explanation has no groups.
    let list = fixture
        .session
        .explain(&QueryRequest {
            request_id: 1,
            collection: "tasks".into(),
            filter: FilterInput::default(),
            sort: SortInput {
                field: "_id".into(),
                descending: false,
            },
            page: 0,
            page_size: 10,
            select: None,
            except: Vec::new(),
            hint: None,
        })
        .unwrap();
    assert_eq!(list.groups, None);
}

#[test]
fn wrong_requests_and_a_closed_session_are_refused() {
    let fixture = tasks();
    let refused = |change: &dyn Fn(&mut GroupRequest)| {
        let mut asked = request("tasks", &["status"]);
        change(&mut asked);
        let error = fixture.session.groups(&asked).unwrap_err();
        assert_eq!(error.category, ErrorCategory::InvalidInput, "{error:?}");
        let explained = fixture.session.explain_groups(&asked).unwrap_err();
        assert_eq!(explained.category, ErrorCategory::InvalidInput);
        error.message
    };
    assert!(refused(&|r| r.group_by = vec!["".into()]).starts_with("Group field 1"));
    assert!(refused(&|r| r.group_by = vec!["tags[*]".into()]).contains("[*]"));
    assert!(refused(&|r| r.group_by = vec!["a".into(), "a".into()]).starts_with("Group field 2"));
    refused(&|r| r.group_by = vec!["a".into(), "a.b".into()]);
    refused(&|r| r.group_by = ["a", "b", "c", "d"].map(String::from).to_vec());
    assert!(refused(&|r| r.columns = vec![column(ColumnKind::Sum, "")]).starts_with("Column 1"));
    refused(&|r| r.page_size = 0);
    refused(&|r| r.page_size = 1001);
    refused(&|r| {
        r.sort = Some(GroupSort {
            column: 2,
            descending: false,
        })
    });
    assert!(
        refused(&|r| r.filter =
            FilterInput::Rows(vec![condition("tries", Operator::Eq, ValueType::Int, "x")]))
        .starts_with("Condition 1")
    );
    // A group field named like the app's column names is fine.
    let mut hashes = request("tasks", &["#1", "#0"]);
    hashes.columns = vec![column(ColumnKind::Max, "tries")];
    assert_eq!(fixture.session.groups(&hashes).unwrap().total, 1);

    fixture.manager.close(fixture.session.id()).unwrap();
    let error = fixture
        .session
        .groups(&request("tasks", &["status"]))
        .unwrap_err();
    assert_eq!(error.category, ErrorCategory::SessionClosed);
}

fn filtered(kind: ColumnKind, field: &str, condition: &str) -> ColumnInput {
    ColumnInput {
        condition: condition.to_string(),
        by: String::new(),
        ..column(kind, field)
    }
}

/// A column's condition (trunkdb SPEC §126) narrows that column alone:
/// every group stays, the count beside it still counts all, and a group
/// none of whose documents meet it shows 0.
#[test]
fn a_column_takes_in_only_the_documents_its_condition_finds() {
    let fixture = tasks();
    let mut ask = request("tasks", &["status"]);
    ask.columns = vec![
        filtered(ColumnKind::Count, "", "tries > 3"),
        filtered(ColumnKind::Sum, "tries", r#"tenant = "t0""#),
        filtered(ColumnKind::Count, "", r#"status = "done""#),
    ];
    let result = fixture.session.groups(&ask).unwrap();
    let labels: Vec<&str> = result.columns.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "status",
            "count",
            "count where tries > 3",
            r#"sum tries where tenant = "t0""#,
            r#"count where status = "done""#,
        ]
    );

    let mut expected = Vec::new();
    for (at, status) in [(2, "done"), (0, "queued"), (1, "running")] {
        let members: Vec<usize> = (0..300).filter(|n| n % 3 == at).collect();
        let many_tries = members.iter().filter(|n| *n % 7 > 3).count();
        let t0_tries: usize = (members.iter())
            .filter(|n| *n % 10 == 0)
            .map(|n| n % 7)
            .sum();
        let done = if status == "done" { members.len() } else { 0 };
        expected.push(vec![
            status.to_string(),
            members.len().to_string(),
            many_tries.to_string(),
            t0_tries.to_string(),
            done.to_string(),
        ]);
    }
    assert_eq!(previews(&result), expected);
    // Show documents lists the group, not a column's part of it.
    drills_find_what_is_counted(&fixture, "tasks", &result);
}

/// Without group fields, one row: the total beside the part a condition
/// finds, and the column sorts like any other.
#[test]
fn a_condition_counts_part_of_every_document_and_sorts() {
    let fixture = tasks();
    let mut ask = request("tasks", &[]);
    ask.columns = vec![filtered(
        ColumnKind::Count,
        "",
        r#"status = "done" and tries = 0"#,
    )];
    let result = fixture.session.groups(&ask).unwrap();
    let done_untried = (0..300).filter(|n| n % 3 == 2 && n % 7 == 0).count();
    assert_eq!(
        previews(&result),
        [vec!["300".to_string(), done_untried.to_string()]]
    );

    let mut ask = request("tasks", &["tenant"]);
    ask.columns = vec![filtered(ColumnKind::Count, "", "tries = 6")];
    ask.sort = Some(GroupSort {
        column: 2,
        descending: true,
    });
    let result = fixture.session.groups(&ask).unwrap();
    let counts: Vec<usize> = (result.rows.iter())
        .map(|row| row.cells[2].preview.parse().unwrap())
        .collect();
    assert!(
        counts.windows(2).all(|pair| pair[0] >= pair[1]),
        "{counts:?}"
    );
    fixture.session.explain_groups(&ask).unwrap();
}

/// A condition that doesn't read names its column; its place is in the
/// column's text, so none is given for the list's filter.
#[test]
fn a_condition_that_doesnt_read_names_its_column() {
    let fixture = tasks();
    let mut ask = request("tasks", &["status"]);
    ask.columns = vec![
        column(ColumnKind::Sum, "tries"),
        filtered(ColumnKind::Count, "", "tries >"),
    ];
    let error = fixture.session.groups(&ask).unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    assert_eq!(error.message, "Column 2: the condition doesn't read.");
    assert!(error.detail.is_some());
    assert!(error.at.is_none());
    let error = fixture.session.explain_groups(&ask).unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);
}

fn ordered(kind: ColumnKind, field: &str, by: &str) -> ColumnInput {
    ColumnInput {
        by: by.to_string(),
        ..column(kind, field)
    }
}

/// `count distinct`, `first` and `last` (trunkdb SPEC §146), the last
/// two by ID or by a field.
#[test]
fn distinct_first_and_last_columns() {
    let fixture = tasks();
    let mut asked = request("tasks", &["status"]);
    asked.columns = vec![
        column(ColumnKind::CountDistinct, "tenant"),
        column(ColumnKind::First, "tries"),
        column(ColumnKind::Last, "tries"),
        ordered(ColumnKind::First, "tenant", "tries"),
        ordered(ColumnKind::Last, "tenant", "tries"),
    ];
    let result = fixture.session.groups(&asked).unwrap();
    let labels: Vec<&str> = result.columns.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "status",
            "count",
            "distinct tenant",
            "first tries",
            "last tries",
            "first tenant by tries",
            "last tenant by tries"
        ]
    );
    // Groups in value order: done, queued, running. Queued is task 0, 3,
    // 6 … 297: the first by ID has 0 tries, the last 297 % 7 = 3; by
    // tries, the first with 0 is task 0 (t0), the last with 6 task 279.
    assert_eq!(
        previews(&result)[1],
        ["queued", "100", "10", "0", "3", "t0", "t9"]
    );
    let statement = trunkdb_admin_core::groups_statement(&asked).unwrap();
    assert!(
        statement.contains(".count_distinct(\"tenant\")"),
        "{statement}"
    );
    assert!(
        statement.contains(".first(\"tenant\")\n    .by(\"tries\")"),
        "{statement}"
    );

    asked.columns = vec![ordered(ColumnKind::Sum, "tries", "created")];
    let error = fixture
        .session
        .groups(&asked)
        .expect_err("sum has no order");
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    assert!(
        error.message.contains("only first and last"),
        "{}",
        error.message
    );
}

/// 3 orders with items, one with none and one without the field.
fn orders() -> Fixture {
    let fixture = Fixture::new();
    fixture.insert(
        "orders",
        &[
            r#"{"items": [{"sku": "A1", "qty": 3}, {"sku": "B2", "qty": 1}], "tags": ["x", "y"]}"#,
            r#"{"items": [{"sku": "A1", "qty": 2}], "tags": ["x"]}"#,
            r#"{"items": [{"sku": "C3", "qty": 4}]}"#,
            r#"{"items": []}"#,
            r#"{"other": 1}"#,
        ],
    );
    fixture
}

/// Unwound (trunkdb SPEC §147): one per element, a group field of the
/// element; a group's documents are those with such an element.
#[test]
fn unwound_arrays_group_their_elements_and_find_their_documents() {
    let fixture = orders();
    let mut asked = request("orders", &["items.sku"]);
    asked.unwind = vec!["items".into()];
    asked.columns = vec![column(ColumnKind::Sum, "items.qty")];
    let result = fixture.session.groups(&asked).unwrap();
    assert_eq!(
        previews(&result),
        [["A1", "2", "5"], ["B2", "1", "1"], ["C3", "1", "4"]]
    );
    assert_eq!(
        result.rows[0].documents,
        Some(FilterInput::Rows(vec![condition(
            "items[*].sku",
            Operator::Eq,
            ValueType::String,
            "A1"
        )]))
    );
    drills_find_what_is_counted(&fixture, "orders", &result);
    let statement = trunkdb_admin_core::groups_statement(&asked).unwrap();
    assert!(
        statement.contains(".unwind(\"items\")\n    .group_by(\"items.sku\")"),
        "{statement}"
    );

    // An array of plain values: each value its own group.
    let mut asked = request("orders", &["tags"]);
    asked.unwind = vec!["tags".into()];
    let result = fixture.session.groups(&asked).unwrap();
    assert_eq!(previews(&result), [["x", "2"], ["y", "1"]]);
    drills_find_what_is_counted(&fixture, "orders", &result);

    // Two fields of one element can't be found together by rows.
    let mut asked = request("orders", &["items.sku", "items.qty"]);
    asked.unwind = vec!["items".into()];
    let result = fixture.session.groups(&asked).unwrap();
    assert!(result.rows.iter().all(|row| row.documents.is_none()));
    assert!(
        result.rows[0]
            .no_documents
            .as_deref()
            .is_some_and(|why| why.contains("one element")),
        "{:?}",
        result.rows[0].no_documents
    );

    let mut asked = request("orders", &["items.sku"]);
    asked.unwind = vec!["items".into(), "items".into()];
    let error = fixture.session.groups(&asked).expect_err("twice");
    assert!(error.message.starts_with("Unwind 2:"), "{}", error.message);
}
