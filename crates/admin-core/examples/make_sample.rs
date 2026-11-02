//! Writes a sample database for trying the app by hand:
//!
//!     cargo run --example make_sample -- /tmp/sample.trunkdb
//!
//! Refuses an existing file. Collections: `people` (137 objects with
//! nested fields, nulls, missing fields and two indexes), `mixed` (every
//! document shape, tagged values, i64 boundaries) and `empty`.

use trunkdb::{Database, Document, IndexOptions};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("usage: make_sample <new-database-path>")?;
    if std::path::Path::new(&path).exists() {
        return Err("the file already exists; choose a new path".into());
    }
    let db = Database::open(&path)?;

    let people = db.collection::<Document>("people");
    let names = [
        "Anna Schmidt",
        "Bo Lind",
        "Chidi Okafor",
        "anna maria",
        "Émile Zola",
    ];
    let cities = ["Berlin", "Bonn", "Bremen"];
    for n in 0..137 {
        let mut text = format!(
            r#"{{"name": "{}", "score": {}.5, "active": {}, "address": {{"city": "{}", "zip": "1{:04}"}}, "tags": ["t{}", "t{}"], "joined": {{"$date": "2026-03-{:02}T12:00:00Z"}}"#,
            names[n % names.len()],
            n % 7,
            n % 2 == 0,
            cities[n % cities.len()],
            n,
            n % 4,
            n % 9,
            n % 28 + 1,
        );
        if n % 5 != 0 {
            text.push_str(&format!(r#", "age": {}"#, 20 + n % 50));
        }
        if n % 4 == 0 {
            text.push_str(r#", "note": null"#);
        }
        text.push('}');
        people.insert(text.parse()?)?;
    }
    people.ensure_index("name")?;
    people.ensure_index_with(["address.city", "age"], IndexOptions::new().sparse())?;

    let mixed = db.collection::<Document>("mixed");
    for text in [
        r#"{"kind": "object", "max": 9223372036854775807, "min": -9223372036854775808, "float": 2.0, "nan": {"$float": "NaN"}, "bytes": {"$binary": "AAEC/w=="}, "tag_like": {"$object": {"$id": "not an id"}}}"#,
        r#"{"kind": "sparse"}"#,
        r#"{"value": [1, [2, 3], {"deep": true}]}"#,
        r#"{"value": "just text"}"#,
        r#"{"value": 42}"#,
        r#"{"value": 2.0}"#,
        r#"{"value": true}"#,
        r#"{"value": null}"#,
        r#"{"value": {"$date": "2026-03-01T12:00:00Z"}}"#,
    ] {
        mixed.insert(text.parse()?)?;
    }

    db.collection::<Document>("empty")
        .ensure_index("anything")?;
    println!("wrote {}", std::path::Path::new(&path).display());
    Ok(())
}
