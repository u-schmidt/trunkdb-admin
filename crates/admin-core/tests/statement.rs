//! What the app hands trunkdb, as Rust: the list's count and
//! page, and the groups' aggregate, as the calls that make them.

use trunkdb_admin_core::{
    ColumnInput, ColumnKind, ConditionInput, ErrorCategory, FilterInput, GroupRequest, GroupSort,
    Operator, QueryRequest, SortInput, ValueInput, ValueType, groups_statement, query_statement,
};

fn list(filter: FilterInput) -> QueryRequest {
    QueryRequest {
        request_id: 1,
        collection: "recipes".to_string(),
        filter,
        sort: SortInput {
            field: "name".to_string(),
            descending: false,
        },
        page: 2,
        page_size: 50,
        select: None,
        except: Vec::new(),
        hint: None,
    }
}

#[test]
fn the_list_is_its_count_and_its_page() {
    let soup = FilterInput::Rows(vec![ConditionInput {
        field: "category".to_string(),
        operator: Operator::Eq,
        value: Some(ValueInput {
            value_type: ValueType::String,
            text: "soup".to_string(),
        }),
        ..Default::default()
    }]);
    assert_eq!(
        query_statement(&list(soup)).unwrap(),
        r##"let collection = db.collection::<Document>("recipes");
let total = collection.count(r#"category = "soup""#.parse::<Filter>()?)?;
// The page shown: documents 101 to 150 of `total`.
let page = collection.find(r#"category = "soup" order by name limit 50 offset 100"#.parse::<Filter>()?)?;
"##
    );

    let mut all = list(FilterInput::default());
    all.page = 0;
    all.select = Some(vec!["name".to_string()]);
    assert_eq!(
        query_statement(&all).unwrap(),
        r#"let collection = db.collection::<Document>("recipes");
let total = collection.count(Filter::new())?;
// The page shown: documents 1 to 50 of `total`.
let page = collection.find("select name order by name limit 50".parse::<Filter>()?)?;
"#
    );
}

#[test]
fn the_groups_are_their_aggregate_built_call_by_call() {
    let request = GroupRequest {
        request_id: 1,
        collection: "recipes".to_string(),
        filter: FilterInput::Text(r#"category = "soup""#.to_string()),
        unwind: Vec::new(),
        group_by: vec!["cuisine".to_string()],
        columns: vec![
            ColumnInput {
                kind: ColumnKind::Count,
                field: String::new(),
                condition: r#"ingredients[*] = "Tomatoes""#.to_string(),
                by: String::new(),
            },
            ColumnInput {
                kind: ColumnKind::Avg,
                field: "minutes".to_string(),
                condition: String::new(),
                by: String::new(),
            },
        ],
        sort: Some(GroupSort {
            column: 2,
            descending: true,
        }),
        page: 0,
        page_size: 25,
    };
    assert_eq!(
        groups_statement(&request).unwrap(),
        r##"let collection = db.collection::<Document>("recipes");
let filter: Filter = r#"category = "soup""#.parse()?;
// Column names are the app's own; the table shows labels.
let aggregate = Aggregate::new()
    .group_by("cuisine")
    .count()
    .named("#0")
    .count()
    .filter(r#"ingredients[*] = "Tomatoes""#.parse()?)
    .named("#1")
    .avg("minutes")
    .named("#2")
    .sort_desc("#1");
let rows = collection.aggregate(filter, &aggregate)?;
// The page shown: groups 1 to 25 of `rows`.
"##
    );
}

#[test]
fn what_wouldnt_run_has_no_statement() {
    let error = query_statement(&list(FilterInput::Text("a = ".to_string()))).unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);
    let request = GroupRequest {
        request_id: 1,
        collection: "recipes".to_string(),
        filter: FilterInput::default(),
        unwind: Vec::new(),
        group_by: vec![String::new()],
        columns: Vec::new(),
        sort: None,
        page: 0,
        page_size: 25,
    };
    let error = groups_statement(&request).unwrap_err();
    assert_eq!(error.category, ErrorCategory::InvalidInput);
}
