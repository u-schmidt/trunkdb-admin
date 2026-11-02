//! What the app hands trunkdb, as Rust: the list's page and
//! count, or the groups' aggregate, written as the calls that make them.
//! Filters are trunkdb's text, parsed where they're used, as trunkdb
//! reads and prints it; an aggregate has no text of its own.

use crate::error::AppResult;
use crate::groups::GroupRequest;
use crate::query::QueryRequest;

/// The list's count and the page it shows, as the list asks for them.
pub fn query_statement(request: &QueryRequest) -> AppResult<String> {
    let conditions = request.conditions()?;
    let count = conditions.to_string();
    let page = request.page_filter(conditions, request.page)?;
    let first = request.page * request.page_size + 1;
    Ok(format!(
        "let collection = db.collection::<Document>({collection});\n\
         let total = collection.count({count})?;\n\
         // The page shown: documents {first} to {last} of `total`.\n\
         let page = collection.find({page})?;\n",
        collection = rust_str(&request.collection),
        count = filter_expr(&count),
        last = first + request.page_size - 1,
        page = filter_expr(&page.to_string()),
    ))
}

/// The groups' aggregate, all of them made in one run and paged by the
/// app.
pub fn groups_statement(request: &GroupRequest) -> AppResult<String> {
    let filter = request.conditions()?.to_string();
    let built = request.build()?;
    let mut text = format!(
        "let collection = db.collection::<Document>({collection});\n\
         let filter: Filter = {filter};\n\
         // Column names are the app's own; the table shows labels.\n\
         let aggregate = Aggregate::new()",
        collection = rust_str(&request.collection),
        filter = match filter.is_empty() {
            true => "Filter::new()".to_string(),
            false => format!("{}.parse()?", rust_str(&filter)),
        },
    );
    for call in &built.chain {
        text.push_str("\n    ");
        text.push_str(call);
    }
    let first = request.page * request.page_size + 1;
    text.push_str(&format!(
        ";\nlet rows = collection.aggregate(filter, &aggregate)?;\n\
         // The page shown: groups {first} to {last} of `rows`.\n",
        last = first + request.page_size - 1,
    ));
    Ok(text)
}

/// `Filter::new()` for no text, the text parsed otherwise.
fn filter_expr(text: &str) -> String {
    match text.is_empty() {
        true => "Filter::new()".to_string(),
        false => format!("{}.parse::<Filter>()?", rust_str(text)),
    }
}

/// A Rust string literal of `text`: plain where it can be, raw with as
/// few `#` as it needs otherwise.
pub(crate) fn rust_str(text: &str) -> String {
    if !text.contains(['"', '\\']) {
        return format!("\"{text}\"");
    }
    let mut hashes = "#".to_string();
    while text.contains(&format!("\"{hashes}")) {
        hashes.push('#');
    }
    format!("r{hashes}\"{text}\"{hashes}")
}

#[cfg(test)]
mod tests {
    use super::rust_str;

    #[test]
    fn strings_are_raw_only_where_they_must_be() {
        assert_eq!(rust_str("status"), r#""status""#);
        assert_eq!(rust_str(r#"a = "x""#), r##"r#"a = "x""#"##);
        assert_eq!(rust_str(r##"a = "#x""##), r###"r##"a = "#x""##"###);
        assert_eq!(rust_str(r"a\b"), r##"r#"a\b"#"##);
    }
}
