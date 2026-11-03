//! Filters as text: a condition in trunkdb's language finds
//! what rows find, says what rows can't, carries into groups and saves,
//! shows where a mistake is, and turns into a `trunkdb find` command.

mod common;

use common::{Fixture, doc};
use trunkdb::Document;
use trunkdb::query::{Condition, Filter};
use trunkdb_admin_core::{
    ColumnInput, ConditionInput, ErrorCategory, FilterInput, FilterRows, GroupRequest, KindInput,
    Operator, QueryRequest, QueryResult, SaveRequest, SessionManager, SortInput, ValueInput,
    ValueType, filter_to_rows, filter_to_text,
};

fn request(collection: &str, filter: FilterInput) -> QueryRequest {
    QueryRequest {
        request_id: 1,
        collection: collection.to_string(),
        filter,
        sort: SortInput {
            field: "_id".to_string(),
            descending: false,
        },
        page: 0,
        page_size: 1000,
        select: None,
        except: Vec::new(),
        hint: None,
    }
}

fn row(field: &str, operator: Operator, value: Option<(ValueType, &str)>) -> ConditionInput {
    ConditionInput {
        field: field.to_string(),
        operator,
        value: value.map(|(value_type, text)| ValueInput {
            value_type,
            text: text.to_string(),
        }),
        ..Default::default()
    }
}

/// An `in` or `not in` row of values of one type.
fn in_row(
    field: &str,
    operator: Operator,
    value_type: ValueType,
    texts: &[&str],
) -> ConditionInput {
    ConditionInput {
        field: field.to_string(),
        operator,
        values: (texts.iter())
            .map(|text| ValueInput {
                value_type,
                text: text.to_string(),
            })
            .collect(),
        ..Default::default()
    }
}

/// An `is` or `is not` row.
fn kind_row(field: &str, operator: Operator, kind: KindInput) -> ConditionInput {
    ConditionInput {
        field: field.to_string(),
        operator,
        kind: Some(kind),
        ..Default::default()
    }
}

fn text(filter: &str) -> FilterInput {
    FilterInput::Text(filter.to_string())
}

fn ids(result: &QueryResult) -> Vec<String> {
    result.rows.iter().map(|row| row.id.clone()).collect()
}

/// Things of every type the rows offer.
fn things() -> Fixture {
    let fx = Fixture::new();
    let first = fx.insert(
        "things",
        &[
            r#"{"name": "Anna", "n": 9223372036854775807, "f": 2.5, "ok": true, "note": null, "at": {"$date": "2026-03-01T12:00:00Z"}, "tags": ["a", "b"], "items": [{"sku": "A1", "qty": 3}]}"#,
            r#"{"name": "anna maria", "n": 4, "f": 2.0, "ok": false, "at": {"$date": "2026-03-02T12:00:00Z"}, "tags": [], "items": [{"sku": "A1", "qty": 1}, {"sku": "B2", "qty": 5}]}"#,
            r#"{"name": "Bo", "n": -9223372036854775808, "f": -0.5, "ok": true, "note": "x", "tags": ["b"]}"#,
            r#"{"name": "Cy", "n": 2, "f": 2, "status": "failed"}"#,
            r#"{"name": "Di", "n": 3, "status": "stuck", "meta": {"k": 1}}"#,
        ],
    );
    fx.insert(
        "things",
        &[&format!(
            r#"{{"name": "ref", "ref": {{"$id": "{}"}}}}"#,
            first[0]
        )],
    );
    fx
}

#[test]
fn rows_and_their_text_find_the_same_and_the_text_turns_back_into_the_rows() {
    let fx = things();
    let first = fx
        .session
        .query(&request("things", FilterInput::default()))
        .unwrap()
        .rows[0]
        .id
        .clone();
    use Operator::*;
    use ValueType::*;
    let cases: Vec<Vec<ConditionInput>> = vec![
        vec![row("name", Eq, Some((String, "Anna")))],
        vec![row("name", Ne, Some((String, "Anna")))],
        vec![row("name", Contains, Some((String, "ANNA")))],
        vec![row("n", Gte, Some((Int, "9223372036854775807")))],
        vec![row("n", Lt, Some((Int, "3")))],
        vec![row("f", Gt, Some((Float, "2")))],
        vec![row("f", Lte, Some((Float, "-0.5")))],
        vec![row("ok", Eq, Some((Bool, "true")))],
        vec![row("note", Eq, Some((Null, "")))],
        vec![row("note", Ne, Some((Null, "")))],
        vec![row("at", Gt, Some((DateTime, "2026-03-01T12:00:00Z")))],
        vec![row("ref", Eq, Some((Id, &first)))],
        vec![row("_id", Eq, Some((Id, &first)))],
        vec![row("note", Exists, None)],
        vec![row("note", Missing, None)],
        // trunkdb SPEC §158, §159 and §115.
        vec![row("name", StartsWith, Some((String, "Ann")))],
        vec![in_row("status", In, String, &["failed", "stuck"])],
        vec![in_row("status", NotIn, String, &["failed"])],
        vec![kind_row("f", IsKind, KindInput::Float)],
        vec![kind_row("n", IsKind, KindInput::Number)],
        vec![kind_row("at", IsNotKind, KindInput::Date)],
        vec![
            row("name", Contains, Some((String, "anna"))),
            row("ok", Eq, Some((Bool, "false"))),
        ],
        vec![
            row("tags[*]", Eq, Some((String, "b"))),
            row("f", Missing, None),
            row("n", Gt, Some((Int, "-1"))),
        ],
        vec![],
    ];
    for rows in cases {
        let as_text = filter_to_text(&rows).unwrap();
        let by_rows = fx
            .session
            .query(&request("things", FilterInput::Rows(rows.clone())))
            .unwrap();
        let by_text = fx
            .session
            .query(&request("things", text(&as_text)))
            .unwrap();
        assert_eq!(by_text.total, by_rows.total, "{as_text}");
        assert_eq!(ids(&by_text), ids(&by_rows), "{as_text}");
        assert_eq!(
            filter_to_rows(&as_text),
            FilterRows::Rows(rows),
            "{as_text}"
        );
    }
}

#[test]
fn text_says_what_rows_cant_and_finds_what_trunkdb_finds() {
    let fx = things();
    for (filter, what) in [
        (r#"status = "failed" or n > 3"#, "or"),
        (r#"status in ("failed", 3)"#, "different types"),
        (r#"not (ok = true and n > 0)"#, "not"),
        (r#"items has (sku = "A1" and qty > 2)"#, "has"),
        ("size(tags) = 0", "size"),
        (r#"meta = {"k": 1}"#, "object"),
        (r#"tags = ["a", "b"]"#, "array"),
    ] {
        let listed = fx.session.query(&request("things", text(filter))).unwrap();
        let condition: Condition = filter.parse().unwrap();
        let direct = fx
            .session
            .read(|db| {
                Ok(db
                    .collection::<Document>("things")
                    .find(Filter::new().and(condition).sort_asc("_id"))?)
            })
            .unwrap();
        // Objects and arrays too, by their contents (trunkdb SPEC §124).
        assert!(!direct.is_empty(), "{filter} finds something");
        let direct: Vec<String> = direct
            .iter()
            .map(|d| match d {
                Document::Object(fields) => match fields.get("_id") {
                    Some(Document::Id(id)) => id.to_string(),
                    _ => unreachable!(),
                },
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(ids(&listed), direct, "{filter}");

        let FilterRows::Reason(reason) = filter_to_rows(filter) else {
            panic!("{filter} can't be rows");
        };
        assert!(reason.contains(what), "{filter}: {reason}");
    }
}

#[test]
fn an_empty_text_is_every_document_and_true_is_no_row() {
    let fx = things();
    let all = fx.session.query(&request("things", text("  \n"))).unwrap();
    assert_eq!(all.total, 6);
    assert_eq!(filter_to_rows(""), FilterRows::Rows(vec![]));
    assert_eq!(filter_to_rows("true"), FilterRows::Rows(vec![]));
    assert_eq!(filter_to_text(&[]).unwrap(), "");
}

#[test]
fn a_mistake_says_where_it_is_as_javascript_counts() {
    let fx = things();
    let mistake = |filter: &str| {
        fx.session
            .query(&request("things", text(filter)))
            .expect_err("a mistake")
    };

    // After a name with umlauts and an emoji, which is two UTF-16 units.
    let filter = "Größe = \"😀\" and b = ";
    let error = mistake(filter);
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    let at = error.at.expect("a place");
    assert_eq!((at.line, at.column), (1, 21));
    // 20 characters before it, one of them two units long.
    assert_eq!(at.index, 21);
    assert!(error.detail.unwrap().contains("expected a value"));

    let error = mistake("n > 1 and\n  name = Ada");
    let at = error.at.unwrap();
    assert_eq!((at.line, at.column, at.index), (2, 10, 19));

    // The clauses the list sets with its controls.
    for filter in [
        "n > 1 order by n",
        "n > 1 LIMIT 5",
        "select name where n > 1",
    ] {
        let error = mistake(filter);
        assert!(
            error.message.contains("set with their own controls"),
            "{filter}: {error:?}"
        );
    }
    assert!(!mistake("n >").message.contains("controls"));

    // Rows can't be had from it either, and say why.
    let FilterRows::Reason(reason) = filter_to_rows("n >") else {
        panic!()
    };
    assert!(reason.contains("expected a value"), "{reason}");
}

#[test]
fn groups_take_text_and_a_groups_documents_come_back_as_text() {
    let fx = things();
    let groups = GroupRequest {
        request_id: 1,
        collection: "things".into(),
        filter: text(r#"n > 0 or ok = false"#),
        unwind: Vec::new(),
        group_by: vec!["ok".into()],
        columns: vec![ColumnInput {
            kind: trunkdb_admin_core::ColumnKind::Count,
            field: String::new(),
            condition: String::new(),
            by: String::new(),
        }],
        sort: None,
        page: 0,
        page_size: 50,
    };
    let result = fx.session.groups(&groups).unwrap();
    assert!(result.total >= 2);
    for group in &result.rows {
        let Some(FilterInput::Text(drill)) = &group.documents else {
            panic!("text in, text out: {group:?}");
        };
        assert!(drill.starts_with("(n > 0 or ok = false) and ok"), "{drill}");
        let counted: usize = group.cells.last().unwrap().preview.parse().unwrap();
        let listed = fx.session.query(&request("things", text(drill))).unwrap();
        assert_eq!(listed.total, counted, "{drill}");
    }
}

#[test]
fn a_save_is_checked_against_a_text_filter() {
    let fx = things();
    let save = |json: &str| SaveRequest {
        collection: "things".into(),
        id: None,
        json: json.into(),
        filter: text(r#"status in ("failed", "stuck")"#),
    };
    assert!(
        fx.session
            .save_document(&save(r#"{"status": "stuck"}"#))
            .unwrap()
            .matches_filter
    );
    assert!(
        !fx.session
            .save_document(&save(r#"{"status": "done"}"#))
            .unwrap()
            .matches_filter
    );
}

#[test]
fn the_command_says_the_list_s_query_quoted_for_a_shell() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("it's here.trunkdb");
    let manager = SessionManager::new();
    let session = manager.create_new(&path).unwrap();
    let path = std::fs::canonicalize(&path).unwrap().display().to_string();
    let quoted_path = format!("'{}'", path.replace('\'', r"'\''"));

    let mut asked = request("my tasks", text(r#"name = "it's" or n > 1"#));
    assert_eq!(
        session.find_command(&asked).unwrap(),
        format!(r#"trunkdb find {quoted_path} 'my tasks' 'name = "it'\''s" or n > 1'"#),
        "the default sort is left out"
    );

    asked.sort.descending = true;
    asked.select = Some(vec!["name".into(), "_id".into()]);
    assert_eq!(
        session.find_command(&asked).unwrap(),
        format!(
            r#"trunkdb find {quoted_path} 'my tasks' 'select name where name = "it'\''s" or n > 1 order by _id desc'"#
        )
    );

    let mut plain = request("tasks", FilterInput::default());
    plain.sort.field = "name".into();
    assert_eq!(
        session.find_command(&plain).unwrap(),
        format!("trunkdb find {quoted_path} tasks 'order by name'")
    );
    plain.sort.field = "_id".into();
    assert_eq!(
        session.find_command(&plain).unwrap(),
        format!("trunkdb find {quoted_path} tasks")
    );

    // A filter that doesn't read is refused here as in the list.
    assert!(
        session
            .find_command(&request("tasks", text("n >")))
            .is_err()
    );
    drop(doc("{}"));
}

/// An OR of `=`s on one field is an `in`, as trunkdb prints it (its
/// SPEC §115); on several fields it stays an `or`.
#[test]
fn an_or_of_equals_on_one_field_is_an_in_row() {
    assert_eq!(
        filter_to_rows(r#"status = "failed" or status = "stuck""#),
        FilterRows::Rows(vec![in_row(
            "status",
            Operator::In,
            ValueType::String,
            &["failed", "stuck"]
        )])
    );
    assert_eq!(
        filter_to_rows(r#"not (n = 1 or n = 2)"#),
        FilterRows::Rows(vec![in_row(
            "n",
            Operator::NotIn,
            ValueType::Int,
            &["1", "2"]
        )])
    );
    let FilterRows::Reason(reason) = filter_to_rows(r#"status = "failed" or n = 2"#) else {
        panic!("two fields are an or");
    };
    assert!(reason.contains("`or`"), "{reason}");
}

#[test]
fn new_rows_say_what_they_are_missing() {
    let fx = things();
    for (rows, problem) in [
        (
            vec![in_row("n", Operator::In, ValueType::Int, &[])],
            "at least one value",
        ),
        (
            vec![in_row("n", Operator::In, ValueType::Int, &["1", "x"])],
            "value 2:",
        ),
        (
            vec![ConditionInput {
                field: "n".to_string(),
                operator: Operator::IsKind,
                ..Default::default()
            }],
            "kind",
        ),
        (
            vec![row("n", Operator::StartsWith, Some((ValueType::Int, "1")))],
            "starts with",
        ),
    ] {
        let error = fx
            .session
            .query(&request("things", FilterInput::Rows(rows)))
            .expect_err(problem);
        assert_eq!(error.category, ErrorCategory::InvalidInput);
        assert!(error.message.contains(problem), "{}", error.message);
    }
}

/// A hint (trunkdb SPEC §132) is a clause, like `order by`: the text is
/// a condition only, so `use index` there is a mistake, never a hint.
#[test]
fn a_hint_in_the_text_is_a_mistake() {
    let fx = things();
    let error = fx
        .session
        .query(&request("things", text("n = 1 use index n")))
        .expect_err("a mistake");
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    assert!(error.at.is_some());
}

/// The hint goes into the command, as `trunkdb find` reads it (trunkdb
/// SPEC §132).
#[test]
fn the_command_carries_the_hint() {
    let fx = things();
    let mut asked = request("things", text("n > 1"));
    asked.hint = Some(trunkdb_admin_core::HintInput::NoIndex);
    let command = fx.session.find_command(&asked).unwrap();
    assert!(command.ends_with("'n > 1 use no index'"), "{command}");
    asked.hint = Some(trunkdb_admin_core::HintInput::Index {
        fields: vec!["n".into(), "f".into()],
    });
    let command = fx.session.find_command(&asked).unwrap();
    assert!(command.ends_with("'n > 1 use index (n, f)'"), "{command}");
}
