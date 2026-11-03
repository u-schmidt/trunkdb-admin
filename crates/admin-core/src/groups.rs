//! Documents counted by group (trunkdb SPEC §107): the documents the
//! filter's conditions find, grouped by the values of some fields, with a
//! count and other columns per group. trunkdb groups, counts and sorts;
//! the groups are paged here, from the one run that makes them all.

use crate::error::{AppError, AppResult};
use crate::explain::ExplainReport;
use crate::filter_text::print;
use crate::query::{Cell, ConditionInput, FilterInput, Operator, ValueInput};
use crate::session::Session;
use crate::statement::rust_str;
use serde::{Deserialize, Serialize};
use trunkdb::Document;
use trunkdb::query::{Aggregate, Condition, Filter};

/// What a column says about its group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnKind {
    Count,
    Sum,
    Avg,
    Min,
    Max,
    /// How many different values, null and missing not counted
    /// (trunkdb SPEC §146).
    CountDistinct,
    /// The value in the group's first document, by ID or by `by`.
    First,
    /// The value in the group's last document, by ID or by `by`.
    Last,
}

/// A column besides the count, which every group has.
#[derive(Debug, Clone, Deserialize)]
pub struct ColumnInput {
    pub kind: ColumnKind,
    /// The field it sums, averages or finds the extremes of.
    #[serde(default)]
    pub field: String,
    /// Which of the group's documents the column takes in, as trunkdb
    /// filter text (its SPEC §126, SQL's `FILTER (WHERE …)`); empty: all
    /// of them. The groups and the other columns still see every one.
    #[serde(default)]
    pub condition: String,
    /// The field that orders the group's documents for `first` and
    /// `last`; empty: by ID, the order they were made in.
    #[serde(default)]
    pub by: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct GroupSort {
    /// A position in `GroupResult::columns`.
    pub column: usize,
    pub descending: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupRequest {
    /// Chosen by the caller and echoed in the result.
    pub request_id: u64,
    pub collection: String,
    /// The documents to group, as the list's filter has them.
    pub filter: FilterInput,
    /// Arrays each matching document is made one per element of, in
    /// order, before grouping (trunkdb SPEC §147): `items`, and
    /// `items.sku` names a field of one element.
    #[serde(default)]
    pub unwind: Vec<String>,
    /// In order; empty: one group of every matching document.
    pub group_by: Vec<String>,
    /// After the count.
    pub columns: Vec<ColumnInput>,
    /// None: by the group values, ascending.
    pub sort: Option<GroupSort>,
    /// Zero-based.
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupColumn {
    /// The field path of a group field; `count`, `sum tries`, ... for
    /// the others.
    pub label: String,
    /// Set for a group field, which holds the group's value.
    pub group: bool,
    /// None for a group field.
    pub kind: Option<ColumnKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupRow {
    /// One per column, in column order.
    pub cells: Vec<Cell>,
    /// The filter's conditions and an `eq` per group field: the documents
    /// counted in this group, exactly, as rows or as text like the
    /// request's filter. None where a value can't be one.
    pub documents: Option<FilterInput>,
    /// Why `documents` is None.
    pub no_documents: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupResult {
    pub request_id: u64,
    /// Groups, before paging.
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub page_count: usize,
    pub columns: Vec<GroupColumn>,
    pub rows: Vec<GroupRow>,
}

/// The aggregate a request asks for, and the names of its columns in
/// each row: a group field at its path, the others under names of their
/// own.
pub(crate) struct Built {
    pub(crate) aggregate: Aggregate,
    /// The builder calls that made `aggregate`, one per line, as Rust:
    /// `.group_by("status")`, `.count()`, `.named("#0")`.
    pub(crate) chain: Vec<String>,
    /// Per column, in order: its path in a row.
    paths: Vec<String>,
    columns: Vec<GroupColumn>,
}

impl GroupRequest {
    pub const MAX_PAGE_SIZE: usize = 1000;
    pub const MAX_GROUP_FIELDS: usize = 3;

    pub(crate) fn conditions(&self) -> AppResult<Filter> {
        self.filter.filter()
    }

    pub(crate) fn build(&self) -> AppResult<Built> {
        if self.page_size == 0 || self.page_size > Self::MAX_PAGE_SIZE {
            return Err(AppError::invalid_input(format!(
                "The page size must be between 1 and {}.",
                Self::MAX_PAGE_SIZE
            )));
        }
        if self.group_by.len() > Self::MAX_GROUP_FIELDS {
            return Err(AppError::invalid_input(format!(
                "Group by at most {} fields.",
                Self::MAX_GROUP_FIELDS
            )));
        }
        let path_problem = |path: &str| -> Option<&'static str> {
            if path.is_empty() {
                Some("enter a field path.")
            } else if path.contains("[*]") {
                Some("an array path ([*]) can't be grouped or summed.")
            } else {
                None
            }
        };
        let mut aggregate = Aggregate::new();
        let mut chain = Vec::new();
        let mut paths = Vec::new();
        let mut columns = Vec::new();
        for (n, path) in self.unwind.iter().enumerate() {
            let problem = match path_problem(path) {
                Some(problem) => Some(problem.to_string()),
                None if self.unwind[..n].contains(path) => {
                    Some(format!("\u{201c}{path}\u{201d} is unwound already."))
                }
                None => None,
            };
            if let Some(problem) = problem {
                return Err(AppError::invalid_input(format!(
                    "Unwind {}: {problem}",
                    n + 1
                )));
            }
            aggregate = aggregate.unwind(path.clone());
            chain.push(format!(".unwind({})", rust_str(path)));
        }
        for (n, path) in self.group_by.iter().enumerate() {
            if let Some(problem) = path_problem(path) {
                return Err(AppError::invalid_input(format!(
                    "Group field {}: {problem}",
                    n + 1
                )));
            }
            if self.group_by[..n].contains(path) {
                return Err(AppError::invalid_input(format!(
                    "Group field {}: \u{201c}{path}\u{201d} is already a group field.",
                    n + 1
                )));
            }
            aggregate = aggregate.group_by(path.clone());
            chain.push(format!(".group_by({})", rust_str(path)));
            paths.push(path.clone());
            columns.push(GroupColumn {
                label: path.clone(),
                group: true,
                kind: None,
            });
        }
        // Column names in a row are the app's: a plain name that is no
        // group field's first step, so trunkdb never refuses one.
        let firsts: Vec<&str> = (self.group_by.iter())
            .map(|path| path.split('.').next().unwrap_or(path))
            .collect();
        let name_of = |n: usize| {
            let mut name = format!("#{n}");
            while firsts.contains(&name.as_str()) {
                name.insert(0, '#');
            }
            name
        };
        let wanted = std::iter::once(ColumnInput {
            kind: ColumnKind::Count,
            field: String::new(),
            condition: String::new(),
            by: String::new(),
        })
        .chain(self.columns.iter().cloned());
        for (n, column) in wanted.enumerate() {
            let name = name_of(n);
            let field = column.field.as_str();
            if column.kind != ColumnKind::Count
                && let Some(problem) = path_problem(field)
            {
                return Err(AppError::invalid_input(format!("Column {n}: {problem}")));
            }
            let ordered = matches!(column.kind, ColumnKind::First | ColumnKind::Last);
            let by = column.by.as_str();
            if !by.is_empty() {
                if !ordered {
                    return Err(AppError::invalid_input(format!(
                        "Column {n}: only first and last are ordered by a field."
                    )));
                }
                if let Some(problem) = path_problem(by) {
                    return Err(AppError::invalid_input(format!(
                        "Column {n}, ordered by: {problem}"
                    )));
                }
            }
            // Read as a filter is, so the column says where in
            // its own text the mistake is, not the list's filter.
            let condition = FilterInput::Text(column.condition.clone())
                .conditions()
                .map_err(|error| AppError {
                    message: format!("Column {n}: the condition doesn't read."),
                    at: None,
                    ..error
                })?;
            let (label, unnamed) = match column.kind {
                ColumnKind::Count => ("count".to_string(), aggregate.count()),
                ColumnKind::Sum => (format!("sum {field}"), aggregate.sum(field)),
                ColumnKind::Avg => (format!("average {field}"), aggregate.avg(field)),
                ColumnKind::Min => (format!("min {field}"), aggregate.min(field)),
                ColumnKind::Max => (format!("max {field}"), aggregate.max(field)),
                ColumnKind::CountDistinct => {
                    (format!("distinct {field}"), aggregate.count_distinct(field))
                }
                ColumnKind::First => (format!("first {field}"), aggregate.first(field)),
                ColumnKind::Last => (format!("last {field}"), aggregate.last(field)),
            };
            let (label, unnamed) = match by.is_empty() {
                true => (label, unnamed),
                false => (format!("{label} by {by}"), unnamed.by(by)),
            };
            chain.push(match column.kind {
                ColumnKind::Count => ".count()".to_string(),
                ColumnKind::Sum => format!(".sum({})", rust_str(field)),
                ColumnKind::Avg => format!(".avg({})", rust_str(field)),
                ColumnKind::Min => format!(".min({})", rust_str(field)),
                ColumnKind::Max => format!(".max({})", rust_str(field)),
                ColumnKind::CountDistinct => format!(".count_distinct({})", rust_str(field)),
                ColumnKind::First => format!(".first({})", rust_str(field)),
                ColumnKind::Last => format!(".last({})", rust_str(field)),
            });
            if !by.is_empty() {
                chain.push(format!(".by({})", rust_str(by)));
            }
            // trunkdb ANDs a column's conditions, as their text does.
            if !condition.is_empty() {
                let text = print(condition.clone());
                chain.push(format!(".filter({}.parse()?)", rust_str(&text)));
            }
            chain.push(format!(".named({})", rust_str(&name)));
            let label = match condition.is_empty() {
                true => label,
                false => format!("{label} where {}", print(condition.clone())),
            };
            let next = (condition.into_iter())
                .fold(unnamed, |column, condition| column.filter(condition))
                .named(name.clone());
            aggregate = next;
            paths.push(name);
            columns.push(GroupColumn {
                label,
                group: false,
                kind: Some(column.kind),
            });
        }
        if let Some(sort) = self.sort {
            let Some(path) = paths.get(sort.column) else {
                return Err(AppError::invalid_input(
                    "There is no such column to sort by.",
                ));
            };
            aggregate = match sort.descending {
                true => aggregate.sort_desc(path.clone()),
                false => aggregate.sort_asc(path.clone()),
            };
            let call = if sort.descending {
                "sort_desc"
            } else {
                "sort_asc"
            };
            chain.push(format!(".{call}({})", rust_str(path)));
        }
        Ok(Built {
            aggregate,
            chain,
            paths,
            columns,
        })
    }
}

impl Session {
    /// One page of the groups. Every group is made in one snapshot, as
    /// trunkdb holds them all in memory anyway (its SPEC §107.11), and
    /// counted and paged from there.
    pub fn groups(&self, request: &GroupRequest) -> AppResult<GroupResult> {
        let conditions = request.conditions()?;
        let built = request.build()?;
        let rows = self.read(|database| {
            let snapshot = database.snapshot()?;
            let view = snapshot.collection::<Document>(&request.collection);
            Ok(view.aggregate(conditions, &built.aggregate)?)
        })?;
        let total = rows.len();
        let page_count = total.div_ceil(request.page_size);
        let page = request.page.min(page_count.saturating_sub(1));
        let groups = request.group_by.len();
        let rows = (rows.iter())
            .skip(page * request.page_size)
            .take(request.page_size)
            .map(|row| {
                let values: Vec<&Document> = (built.paths.iter())
                    .map(|path| value_at(row, path))
                    .collect();
                let (documents, no_documents) = match drill(
                    &request.filter,
                    &request.unwind,
                    &request.group_by,
                    &values[..groups],
                ) {
                    Ok(conditions) => (Some(conditions), None),
                    Err(why) => (None, Some(why)),
                };
                GroupRow {
                    cells: values.into_iter().map(Cell::new).collect(),
                    documents,
                    no_documents,
                }
            })
            .collect();
        Ok(GroupResult {
            request_id: request.request_id,
            total,
            page,
            page_size: request.page_size,
            page_count,
            columns: built.columns,
            rows,
        })
    }

    /// How trunkdb makes the groups (its SPEC §107.6): the same aggregate,
    /// run by `explain_aggregate`.
    pub fn explain_groups(&self, request: &GroupRequest) -> AppResult<ExplainReport> {
        let conditions = request.conditions()?;
        let built = request.build()?;
        let explained = self.read(|database| {
            Ok(database
                .collection::<Document>(&request.collection)
                .explain_aggregate(conditions, &built.aggregate)?)
        })?;
        Ok(ExplainReport::build(request.request_id, 0, 0, explained, true).report)
    }
}

/// Group fields as a filter finds them in the documents before they
/// were unwound: a field of an unwound array's element is one of any
/// element, `items.sku` is `items[*].sku`. Two fields of one element
/// would need `has`, which rows can't say: no filter then.
fn unwound_paths(unwind: &[String], fields: &[String]) -> Result<Vec<String>, String> {
    let mut seen: Vec<String> = Vec::new();
    let mut paths = Vec::with_capacity(fields.len());
    for field in fields {
        let steps: Vec<&str> = field.split('.').collect();
        let mut path = String::new();
        let mut innermost = None;
        for (at, step) in steps.iter().enumerate() {
            if at > 0 {
                path.push('.');
            }
            path.push_str(step);
            let prefix = steps[..=at].join(".");
            if unwind.contains(&prefix) {
                path.push_str("[*]");
                innermost = Some(prefix);
            }
        }
        if let Some(array) = innermost {
            if seen.contains(&array) {
                return Err(format!(
                    "Two group fields are of one element of \u{201c}{array}\u{201d}, \
                     which a filter can't find together."
                ));
            }
            seen.push(array);
        }
        paths.push(path);
    }
    Ok(paths)
}

/// The value at a dotted `path` of a row; a row holds every one.
fn value_at<'a>(row: &'a Document, path: &str) -> &'a Document {
    const NULL: &Document = &Document::Null;
    let mut value = row;
    for step in path.split('.') {
        value = match value {
            Document::Object(fields) => fields.get(step).unwrap_or(NULL),
            _ => NULL,
        };
    }
    value
}

/// The conditions that find a group's documents: the filter's, and an
/// `eq` per group field. `eq` finds what the group holds: a missing field
/// as `null` does, `5.0` as `5` does (trunkdb SPEC §107.2).
/// A text filter's drill is printed as text: its conditions and the
/// `eq`s, as trunkdb prints them. An array, an object or
/// binary data is compared by its contents (trunkdb SPEC §124), which
/// only text can write; rows have no such type.
fn drill(
    filter: &FilterInput,
    unwind: &[String],
    fields: &[String],
    values: &[&Document],
) -> Result<FilterInput, String> {
    let fields = unwound_paths(unwind, fields)?;
    for (field, value) in fields.iter().zip(values) {
        if matches!(value, Document::Float(f) if f.is_nan()) {
            return Err(format!(
                "\u{201c}{field}\u{201d} is NaN here, which no filter finds equal."
            ));
        }
    }
    match filter {
        FilterInput::Rows(rows) => {
            let mut all = rows.clone();
            for (field, value) in fields.iter().zip(values) {
                let value = ValueInput::of(value).map_err(|what| {
                    format!(
                        "\u{201c}{field}\u{201d} is {what} here, which rows can't hold. \
                         Switch the filter to Text to show these documents."
                    )
                })?;
                all.push(ConditionInput {
                    field: field.clone(),
                    operator: Operator::Eq,
                    value: Some(value),
                    ..ConditionInput::default()
                });
            }
            Ok(FilterInput::Rows(all))
        }
        FilterInput::Text(_) => {
            let mut conditions: Vec<Condition> = filter.conditions().map_err(|e| e.message)?;
            conditions.extend(
                (fields.iter().zip(values))
                    .map(|(field, value)| Condition::eq(field.as_str(), (*value).clone())),
            );
            Ok(FilterInput::Text(crate::filter_text::print(conditions)))
        }
    }
}
