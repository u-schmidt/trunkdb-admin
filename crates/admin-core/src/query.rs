//! Browsing a collection: typed AND conditions, one sort field and offset
//! paging, all evaluated by trunkdb. Nothing is matched,
//! sorted or counted outside the database.

use crate::error::{AppError, AppResult, ErrorCategory};
use crate::session::Session;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use trunkdb::query::{Condition, Filter, Kind, Op, SortOrder};
use trunkdb::{DateTime, DocId, Document};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    #[default]
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    Contains,
    /// A string beginning with the value, case counting (trunkdb SPEC §158).
    StartsWith,
    /// One of `values` (trunkdb SPEC §115).
    In,
    /// None of `values`: also where the field is missing.
    NotIn,
    Exists,
    Missing,
    /// The field holds a value of `kind` (trunkdb SPEC §159).
    IsKind,
    /// The field holds no value of `kind`: also where it is missing or null.
    IsNotKind,
}

/// A kind of value for `is_kind`, as trunkdb's filter text names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KindInput {
    Bool,
    Int,
    Float,
    /// Int or Float.
    Number,
    String,
    Binary,
    Array,
    Object,
    Id,
    Date,
}

impl KindInput {
    fn kind(self) -> Kind {
        match self {
            KindInput::Bool => Kind::Bool,
            KindInput::Int => Kind::Int,
            KindInput::Float => Kind::Float,
            KindInput::Number => Kind::Number,
            KindInput::String => Kind::String,
            KindInput::Binary => Kind::Binary,
            KindInput::Array => Kind::Array,
            KindInput::Object => Kind::Object,
            KindInput::Id => Kind::Id,
            KindInput::Date => Kind::DateTime,
        }
    }

    /// The input for a trunkdb kind; None for a kind of a later trunkdb.
    pub(crate) fn of(kind: Kind) -> Option<Self> {
        Some(match kind {
            Kind::Bool => KindInput::Bool,
            Kind::Int => KindInput::Int,
            Kind::Float => KindInput::Float,
            Kind::Number => KindInput::Number,
            Kind::String => KindInput::String,
            Kind::Binary => KindInput::Binary,
            Kind::Array => KindInput::Array,
            Kind::Object => KindInput::Object,
            Kind::Id => KindInput::Id,
            Kind::DateTime => KindInput::Date,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    String,
    Int,
    Float,
    Bool,
    Null,
    DateTime,
    Id,
}

/// A condition value as the user typed it. Text for every type, numbers
/// included: a JavaScript number would round a large integer and could
/// not tell `2` from `2.0`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ValueInput {
    #[serde(rename = "type")]
    pub value_type: ValueType,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct ConditionInput {
    pub field: String,
    pub operator: Operator,
    /// The value of a comparison, `contains` and `starts_with`; absent
    /// otherwise.
    pub value: Option<ValueInput>,
    /// The values of `in` and `not_in`, all of one type.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<ValueInput>,
    /// The kind of `is_kind` and `is_not_kind`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<KindInput>,
}

/// The list's filter: rows of typed conditions, all to hold, or a
/// condition in trunkdb's text (its SPEC §111).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterInput {
    Rows(Vec<ConditionInput>),
    Text(String),
}

impl Default for FilterInput {
    fn default() -> Self {
        FilterInput::Rows(Vec::new())
    }
}

impl FilterInput {
    /// The conditions, all to hold, as `Filter::and` takes them; the
    /// first mistake otherwise. Nothing runs unless all of it reads.
    pub(crate) fn conditions(&self) -> AppResult<Vec<Condition>> {
        match self {
            FilterInput::Rows(rows) => ConditionInput::all(rows),
            FilterInput::Text(text) => crate::filter_text::read(text),
        }
    }

    /// A filter of the conditions, without sort or paging.
    pub(crate) fn filter(&self) -> AppResult<Filter> {
        Ok(self
            .conditions()?
            .into_iter()
            .fold(Filter::new(), Filter::and))
    }
}

/// Which index the page query reads (trunkdb SPEC §132), where the
/// planner's rules would read another or none. The results are the same
/// with any hint; a hint that can't be followed fails the query.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HintInput {
    /// The index on these fields, in index order; `["_id"]` for the
    /// primary index.
    Index { fields: Vec<String> },
    /// No index: every document read.
    NoIndex,
}

impl HintInput {
    fn apply(&self, filter: Filter) -> Filter {
        match self {
            HintInput::Index { fields } => filter.use_index(fields.clone()),
            HintInput::NoIndex => filter.no_index(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SortInput {
    pub field: String,
    pub descending: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QueryRequest {
    /// Chosen by the caller and echoed in the result, so a late answer
    /// can be told from the one to the newest request.
    pub request_id: u64,
    pub collection: String,
    pub filter: FilterInput,
    pub sort: SortInput,
    /// Zero-based.
    pub page: usize,
    pub page_size: usize,
    /// The fields to read and show, as paths (trunkdb SPEC §106); `_id`
    /// always comes too. None: whole documents.
    #[serde(default)]
    pub select: Option<Vec<String>>,
    /// Fields left out of whole documents (trunkdb SPEC §143), for one
    /// too large to page through; empty: none. Not with `select`.
    #[serde(default)]
    pub except: Vec<String>,
    /// The index the page is read by; None: the planner's choice. Not
    /// for the count, which has no sort a hint could be for.
    #[serde(default)]
    pub hint: Option<HintInput>,
}

/// What kind of value a document or a table cell holds. Ordered as
/// `trunkdb fields` lists kinds that tie.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueKind {
    Null,
    Bool,
    Int,
    Float,
    String,
    Binary,
    Array,
    Object,
    Id,
    DateTime,
    Unknown,
}

/// A table cell: a short rendering for display only. Never a source to
/// rebuild a value from; the row's `json` is the faithful form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cell {
    pub kind: ValueKind,
    pub preview: String,
}

/// A document of the list. Every document is an object with its `_id`
/// (trunkdb SPEC §95).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResultRow {
    pub id: String,
    /// The document as pretty tagged JSON: whole, or the chosen fields.
    pub json: String,
    /// The top-level fields, `_id` included; with chosen fields, `_id`
    /// and each chosen path. A field the object lacks has no entry,
    /// which is how missing stays apart from a stored null.
    pub cells: BTreeMap<String, Cell>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QueryResult {
    pub request_id: u64,
    /// Documents matching the conditions, before paging.
    pub total: usize,
    /// The page returned: the requested one, or the last that exists.
    pub page: usize,
    pub page_size: usize,
    pub page_count: usize,
    pub rows: Vec<ResultRow>,
    /// Table columns for this page: `_id`, then the other top-level
    /// fields of its objects by name; with chosen fields, `_id` and
    /// those, in the order chosen.
    pub columns: Vec<String>,
    /// The chosen fields the rows hold; None: whole documents.
    pub select: Option<Vec<String>>,
    /// The fields left out of the rows, checked and without repeats.
    pub except: Vec<String>,
}

impl QueryRequest {
    pub const MAX_PAGE_SIZE: usize = 1000;
    const DEFAULT_SORT_FIELD: &'static str = "_id";

    pub(crate) fn conditions(&self) -> AppResult<Filter> {
        self.filter.filter()
    }

    /// The query for one page: `conditions`, sorted, skipping the pages
    /// before it.
    pub(crate) fn page_filter(&self, conditions: Filter, page: usize) -> AppResult<Filter> {
        if self.page_size == 0 || self.page_size > Self::MAX_PAGE_SIZE {
            return Err(AppError::invalid_input(format!(
                "The page size must be between 1 and {}.",
                Self::MAX_PAGE_SIZE
            )));
        }
        let filter = self
            .hinted(self.sorted(conditions))
            .skip(page * self.page_size)
            .limit(self.page_size);
        let filter = match self.chosen()? {
            Some(paths) => filter.select(paths),
            None => filter,
        };
        let hidden = self.hidden()?;
        Ok(match hidden.is_empty() {
            true => filter,
            false => filter.except(hidden),
        })
    }

    /// The fields to leave out, checked and without repeats.
    pub(crate) fn hidden(&self) -> AppResult<Vec<String>> {
        if self.except.is_empty() {
            return Ok(Vec::new());
        }
        if self.select.is_some() {
            return Err(AppError::invalid_input(
                "Choose the fields to show or the fields to hide, not both.",
            ));
        }
        let mut paths: Vec<String> = Vec::new();
        for (n, path) in self.except.iter().enumerate() {
            let problem = if path.is_empty() {
                Some("enter a field path.".to_string())
            } else if path == "_id" {
                Some("_id always comes.".to_string())
            } else if path.contains('[') {
                let whole = path.split('[').next().unwrap_or(path);
                Some(format!(
                    "hide the array \u{201c}{whole}\u{201d} itself, whole."
                ))
            } else {
                None
            };
            if let Some(problem) = problem {
                return Err(AppError::invalid_input(format!(
                    "Hidden field {}: {problem}",
                    n + 1
                )));
            }
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        Ok(paths)
    }

    /// The chosen paths, checked, without repeats and without `_id`,
    /// which comes anyway; None for whole documents.
    pub(crate) fn chosen(&self) -> AppResult<Option<Vec<String>>> {
        let Some(select) = &self.select else {
            return Ok(None);
        };
        let mut paths: Vec<String> = Vec::new();
        for (n, path) in select.iter().enumerate() {
            let problem = if path.is_empty() {
                Some("enter a field path.".to_string())
            } else if path.contains('[') {
                // trunkdb selects an array whole by its `[*]` path (its
                // §106.2); the column is the array's own path.
                let whole = path.split('[').next().unwrap_or(path);
                Some(format!(
                    "choose the array \u{201c}{whole}\u{201d} itself to see it whole."
                ))
            } else {
                None
            };
            if let Some(problem) = problem {
                return Err(AppError::invalid_input(format!(
                    "Column {}: {problem}",
                    n + 1
                )));
            }
            if path != "_id" && !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        Ok(Some(paths))
    }

    /// `filter` with the request's hint, if it has one.
    pub(crate) fn hinted(&self, filter: Filter) -> Filter {
        match &self.hint {
            Some(hint) => hint.apply(filter),
            None => filter,
        }
    }

    pub(crate) fn sorted(&self, filter: Filter) -> Filter {
        let field = match self.sort.field.as_str() {
            "" => Self::DEFAULT_SORT_FIELD,
            field => field,
        };
        let order = if self.sort.descending {
            SortOrder::Desc
        } else {
            SortOrder::Asc
        };
        filter.sort_by(field, order)
    }
}

impl ConditionInput {
    /// The rows as trunkdb conditions, or the first input error.
    pub(crate) fn all(conditions: &[ConditionInput]) -> AppResult<Vec<Condition>> {
        (conditions.iter().enumerate())
            .map(|(index, condition)| {
                condition.build().map_err(|problem| {
                    AppError::invalid_input(format!("Condition {}: {problem}", index + 1))
                })
            })
            .collect()
    }

    fn build(&self) -> Result<Condition, String> {
        if self.field.is_empty() {
            return Err("enter a field path.".into());
        }
        let field = self.field.as_str();
        let op = match self.operator {
            Operator::Exists => return Ok(Condition::exists(field)),
            Operator::Missing => return Ok(Condition::missing(field)),
            Operator::IsKind | Operator::IsNotKind => {
                let kind = self.kind.ok_or("choose a kind of value.")?.kind();
                let condition = Condition::is_kind(field, kind);
                return Ok(match self.operator {
                    Operator::IsNotKind => !condition,
                    _ => condition,
                });
            }
            Operator::In | Operator::NotIn => {
                if self.values.is_empty() {
                    return Err("enter at least one value.".into());
                }
                let values = (self.values.iter().enumerate())
                    .map(|(n, value)| {
                        value.parse().map_err(|problem| match self.values.len() {
                            1 => problem,
                            _ => format!("value {}: {problem}", n + 1),
                        })
                    })
                    .collect::<Result<Vec<Document>, String>>()?;
                let condition = Condition::is_in(field, values);
                return Ok(match self.operator {
                    Operator::NotIn => !condition,
                    _ => condition,
                });
            }
            Operator::Eq => Op::Eq,
            Operator::Ne => Op::Ne,
            Operator::Lt => Op::Lt,
            Operator::Lte => Op::Lte,
            Operator::Gt => Op::Gt,
            Operator::Gte => Op::Gte,
            Operator::Contains => Op::Contains,
            Operator::StartsWith => Op::StartsWith,
        };
        let value = self.value.as_ref().ok_or("a value is required.")?;
        if value.value_type != ValueType::String {
            match self.operator {
                Operator::Contains => {
                    return Err("\u{201c}contains\u{201d} takes a String value.".into());
                }
                Operator::StartsWith => {
                    return Err("\u{201c}starts with\u{201d} takes a String value.".into());
                }
                _ => {}
            }
        }
        Ok(Condition::compare(field, op, value.parse()?))
    }
}

impl ValueInput {
    /// A stored value as a row's typed input, which reads back as the
    /// same value; what a row can't hold names its kind.
    pub(crate) fn of(value: &Document) -> Result<ValueInput, &'static str> {
        let (value_type, text) = match value {
            Document::Null => (ValueType::Null, String::new()),
            Document::Bool(b) => (ValueType::Bool, b.to_string()),
            Document::Int(n) => (ValueType::Int, n.to_string()),
            // Rust's shortest spelling that parses back to the same float.
            Document::Float(f) => (ValueType::Float, f.to_string()),
            Document::String(s) => (ValueType::String, s.clone()),
            Document::DateTime(t) => (ValueType::DateTime, t.to_string()),
            Document::Id(id) => (ValueType::Id, id.to_string()),
            Document::Array(_) => return Err("an array"),
            Document::Object(_) => return Err("an object"),
            Document::Binary(_) => return Err("binary data"),
            _ => return Err("a value of a later trunkdb"),
        };
        Ok(ValueInput { value_type, text })
    }

    /// The typed value. Surrounding whitespace is ignored except in a
    /// String, which is taken exactly as entered.
    fn parse(&self) -> Result<Document, String> {
        let text = self.text.trim();
        match self.value_type {
            ValueType::String => Ok(Document::String(self.text.clone())),
            ValueType::Null => Ok(Document::Null),
            ValueType::Int => text.parse::<i64>().map(Document::Int).map_err(|_| {
                format!(
                    "\u{201c}{text}\u{201d} is not a whole number between {} and {}.",
                    i64::MIN,
                    i64::MAX
                )
            }),
            ValueType::Float => text
                .parse::<f64>()
                .map(Document::Float)
                .map_err(|_| format!("\u{201c}{text}\u{201d} is not a number.")),
            ValueType::Bool => match text {
                "true" => Ok(Document::Bool(true)),
                "false" => Ok(Document::Bool(false)),
                _ => Err("a Bool is true or false.".into()),
            },
            ValueType::DateTime => {
                text.parse::<DateTime>()
                    .map(Document::DateTime)
                    .map_err(|error| {
                        format!(
                            "\u{201c}{text}\u{201d} is not an RFC 3339 date-time such as \
                         2026-01-31T12:00:00Z ({error})."
                        )
                    })
            }
            ValueType::Id => text
                .parse::<DocId>()
                .map(Document::Id)
                .map_err(|error| format!("\u{201c}{text}\u{201d} is not an ID ({error}).")),
        }
    }
}

impl Session {
    /// One page of a collection. The total and the rows come from the
    /// same snapshot, which is released before this returns.
    pub fn query(&self, request: &QueryRequest) -> AppResult<QueryResult> {
        let conditions = request.conditions()?;
        // Checks the page size and the chosen fields before anything is
        // read.
        request.page_filter(conditions.clone(), 0)?;
        let chosen = request.chosen()?;
        let hidden = request.hidden()?;

        self.read(|database| {
            let snapshot = database.snapshot()?;
            let view = snapshot.collection::<Document>(&request.collection);
            let total = view.count(conditions.clone())?;
            let page_count = total.div_ceil(request.page_size);
            // A page that no longer exists becomes the last one that does.
            let page = request.page.min(page_count.saturating_sub(1));
            let documents = view.find(request.page_filter(conditions, page)?)?;

            let rows = documents
                .iter()
                .map(|document| ResultRow::new(document, chosen.as_deref()))
                .collect::<AppResult<Vec<ResultRow>>>()?;
            let columns = match &chosen {
                Some(paths) => std::iter::once("_id".to_string())
                    .chain(paths.iter().cloned())
                    .collect(),
                None => ResultRow::columns(&rows),
            };
            Ok(QueryResult {
                request_id: request.request_id,
                total,
                page,
                page_size: request.page_size,
                page_count,
                columns,
                rows,
                select: chosen,
                except: hidden,
            })
        })
    }
}

impl ResultRow {
    /// A row of the whole `document`, or of the `chosen` paths of it.
    fn new(document: &Document, chosen: Option<&[String]>) -> AppResult<Self> {
        // trunkdb holds nothing else since SPEC §95.
        let not_a_document = || {
            AppError::new(
                ErrorCategory::Internal,
                "trunkdb returned a document that is not an object with an ID.",
            )
        };
        let Document::Object(fields) = document else {
            return Err(not_a_document());
        };
        let Some(Document::Id(id)) = fields.get("_id") else {
            return Err(not_a_document());
        };
        let cells = match chosen {
            None => fields
                .iter()
                .map(|(name, value)| (name.clone(), Cell::new(value)))
                .collect(),
            Some(paths) => std::iter::once("_id")
                .chain(paths.iter().map(String::as_str))
                .filter_map(|path| Some((path.to_string(), Cell::new(value_at(document, path)?))))
                .collect(),
        };
        Ok(Self {
            id: id.to_string(),
            json: format!("{document:#}"),
            cells,
        })
    }

    /// `_id` first, then every other top-level field on the page by name.
    fn columns(rows: &[ResultRow]) -> Vec<String> {
        let names: BTreeSet<&str> = rows
            .iter()
            .flat_map(|row| row.cells.keys().map(String::as_str))
            .collect();
        let mut columns = Vec::with_capacity(names.len());
        if !names.is_empty() {
            columns.push("_id".to_string());
        }
        columns.extend(
            names
                .into_iter()
                .filter(|name| *name != "_id")
                .map(str::to_string),
        );
        columns
    }
}

/// The value at a dotted path through objects; None where it is missing.
/// A path doesn't walk into arrays, as trunkdb's selection doesn't
/// (its SPEC §106.2).
fn value_at<'a>(document: &'a Document, path: &str) -> Option<&'a Document> {
    path.split('.')
        .try_fold(document, |value, step| match value {
            Document::Object(fields) => fields.get(step),
            _ => None,
        })
}

impl ValueKind {
    pub(crate) fn of(document: &Document) -> Self {
        match document {
            Document::Null => Self::Null,
            Document::Bool(_) => Self::Bool,
            Document::Int(_) => Self::Int,
            Document::Float(_) => Self::Float,
            Document::String(_) => Self::String,
            Document::Binary(_) => Self::Binary,
            Document::Array(_) => Self::Array,
            Document::Object(_) => Self::Object,
            Document::Id(_) => Self::Id,
            Document::DateTime(_) => Self::DateTime,
            // `Document` is non-exhaustive: a type from a later trunkdb.
            _ => Self::Unknown,
        }
    }
}

impl Cell {
    /// Long enough to recognize a value, short enough for a table.
    const PREVIEW_CHARS: usize = 120;

    pub(crate) fn new(value: &Document) -> Self {
        let text = match value {
            Document::String(text) => text.clone(),
            Document::Id(id) => id.to_string(),
            Document::DateTime(time) => time.to_string(),
            Document::Binary(bytes) => format!("{} bytes", bytes.len()),
            Document::Float(float) if float.is_nan() => "NaN".to_string(),
            Document::Float(float) if float.is_infinite() => if *float > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            }
            .to_string(),
            // Compact tagged JSON: trunkdb's own spelling, so `2.0`
            // stays a float and a large integer keeps every digit.
            other => other.to_string(),
        };
        Self {
            kind: ValueKind::of(value),
            preview: Self::shorten(text),
        }
    }

    fn shorten(text: String) -> String {
        match text.char_indices().nth(Self::PREVIEW_CHARS) {
            Some((end, _)) => format!("{}\u{2026}", &text[..end]),
            None => text,
        }
    }
}
