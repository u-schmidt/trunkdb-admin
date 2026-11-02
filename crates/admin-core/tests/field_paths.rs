//! Field paths: every document read, counted as `trunkdb
//! fields` counts (its SPEC §121), on real temporary databases.

mod common;

use common::Fixture;
use trunkdb::Document;
use trunkdb::query::{Condition, Filter};
use trunkdb_admin_core::{FieldPath, FieldPaths, FieldPathsRequest, MAX_PATHS, ValueKind};

fn paths_of(fx: &Fixture, collection: &str) -> FieldPaths {
    fx.session
        .field_paths(&FieldPathsRequest {
            request_id: 7,
            collection: collection.into(),
        })
        .unwrap()
}

/// `path documents kind n, kind n`, as compact as a line can be.
fn line(path: &FieldPath) -> String {
    let kinds: Vec<String> = (path.kinds.iter())
        .map(|k| format!("{:?} {}", k.kind, k.documents).to_lowercase())
        .collect();
    format!("{} {} {}", path.path, path.documents, kinds.join(", "))
}

#[test]
fn every_path_is_counted_per_document_in_order() {
    let fx = Fixture::new();
    fx.insert(
        "things",
        &[
            r#"{"name": "a", "tags": ["x", "y", 3], "address": {"city": "Bonn", "zip": null}, "items": [{"sku": "A1", "qty": 2}, {"sku": "B2"}], "grid": [[1, 2], [3]]}"#,
            r#"{"name": 7, "tags": [], "address": {"city": null}, "items": [{"sku": "C3", "qty": 1.5}]}"#,
            r#"{"name": null, "tags": "none", "note": {"$date": "2026-03-01T12:00:00Z"}}"#,
            r#"{"other": true}"#,
        ],
    );

    let result = paths_of(&fx, "things");

    assert_eq!(result.request_id, 7);
    assert_eq!(result.documents, 4);
    assert!(!result.truncated);
    let lines: Vec<String> = result.paths.iter().map(line).collect();
    assert_eq!(
        lines,
        [
            "_id 4 id 4",
            "address 2 object 2",
            "address.city 2 null 1, string 1",
            "address.zip 1 null 1",
            "grid 1 array 1",
            "grid[*] 1 array 1",
            "grid[*][*] 1 int 1",
            "items 2 array 2",
            "items[*] 2 object 2",
            "items[*].qty 2 int 1, float 1",
            "items[*].sku 2 string 2",
            // Counted once per document however many tags; an empty array
            // has no elements, a string none either.
            "name 3 null 1, int 1, string 1",
            "note 1 datetime 1",
            "other 1 bool 1",
            "tags 3 array 2, string 1",
            "tags[*] 1 int 1, string 1",
        ]
    );
}

#[test]
fn names_a_path_cant_reach_are_marked_and_odd_ones_written_in_backticks() {
    let fx = Fixture::new();
    fx.insert(
        "things",
        &[r#"{"a.b": {"c": 1}, "x[*]y": 1, "first name": 1, "order": 1, "plain": 1}"#],
    );
    let result = paths_of(&fx, "things");
    let find = |path: &str| result.paths.iter().find(|p| p.path == path).unwrap();

    assert!(!find("a.b").nameable);
    assert!(!find("a.b.c").nameable, "below an unnameable one");
    assert_eq!(find("a.b").text, "`a.b`");
    assert!(!find("x[*]y").nameable);
    assert!(find("first name").nameable);
    assert_eq!(find("first name").text, "`first name`");
    assert_eq!(find("order").text, "`order`");
    assert_eq!(find("plain").text, "plain");
}

#[test]
fn past_the_cap_paths_are_left_out_and_said_so() {
    let fx = Fixture::new();
    let fields: Vec<String> = (0..MAX_PATHS + 50)
        .map(|n| format!(r#""f{n}": 1"#))
        .collect();
    fx.insert("wide", &[&format!("{{{}}}", fields.join(", "))]);

    let result = paths_of(&fx, "wide");

    assert!(result.truncated);
    assert_eq!(result.paths.len(), MAX_PATHS);
}

#[test]
fn each_paths_documents_are_what_trunkdb_finds_there() {
    let fx = Fixture::new();
    let texts: Vec<String> = (0..300)
        .map(|n| {
            let tags = match n % 4 {
                0 => "[]".to_string(),
                1 => r#"["a"]"#.to_string(),
                2 => r#"[{"k": 1}, {"j": null}]"#.to_string(),
                _ => "null".to_string(),
            };
            let address = match n % 3 {
                0 => r#"{"city": "Bonn"}"#,
                1 => r#"{"zip": 5}"#,
                _ => "7",
            };
            format!(r#"{{"n": {n}, "tags": {tags}, "address": {address}}}"#)
        })
        .collect();
    fx.insert(
        "things",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );

    let result = paths_of(&fx, "things");

    for path in result.paths.iter().filter(|p| p.nameable) {
        let found = fx
            .session
            .read(|db| {
                Ok(db
                    .collection::<Document>("things")
                    .count(Filter::new().and(Condition::exists(path.path.as_str())))?)
            })
            .unwrap();
        assert_eq!(found as u64, path.documents, "{}", path.path);
        // The text spelling reads back as the same condition.
        let text: Condition = format!("exists({})", path.text).parse().unwrap();
        assert_eq!(text, Condition::exists(path.path.as_str()), "{}", path.text);
    }
}

#[test]
fn a_collection_that_isnt_stored_has_no_paths() {
    let fx = Fixture::new();
    fx.session.prepare_collection("draft").unwrap();
    for name in ["draft", "nowhere"] {
        let result = paths_of(&fx, name);
        assert_eq!((result.documents, result.paths.len()), (0, 0), "{name}");
    }
    // Nothing was made by asking.
    let names = fx.session.read(|db| Ok(db.collections()?)).unwrap();
    assert!(names.is_empty(), "{names:?}");
    let _ = ValueKind::Null;
}

#[test]
fn a_field_only_the_last_document_has_is_found_every_document_is_read() {
    let fx = Fixture::new();
    let mut texts: Vec<String> = (0..1499).map(|n| format!(r#"{{"n": {n}}}"#)).collect();
    texts.push(r#"{"n": 1499, "late": true}"#.to_string());
    fx.insert(
        "things",
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );

    let result = paths_of(&fx, "things");

    assert_eq!(result.documents, 1500);
    let late = result.paths.iter().find(|p| p.path == "late");
    assert_eq!(late.map(|p| p.documents), Some(1));
    assert_eq!(
        result
            .paths
            .iter()
            .find(|p| p.path == "n")
            .unwrap()
            .documents,
        1500
    );
}
