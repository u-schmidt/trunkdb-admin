//! Filters as text: a condition in trunkdb's language
//! (its SPEC §111), read and printed by trunkdb. Here: where a mistake
//! is, in the units the frontend counts; rows printed as text and text
//! taken back into rows where it has their shape (trunkdb §111.7); and
//! the list's query as a `trunkdb find` command.

use crate::error::{AppError, AppResult, TextPosition};
use crate::query::{ConditionInput, Operator, QueryRequest, ValueInput};
use crate::session::Session;
use serde::Serialize;
use trunkdb::Document;
use trunkdb::query::{Condition, Filter, Op, ParseFilterError};

/// The clauses trunkdb's text has beyond a condition, which the list
/// sets with controls of its own.
const CLAUSES: [&str; 4] = ["select", "order", "limit", "offset"];

/// The conditions a text says, as `Filter::and` takes them: an `and` of
/// several is several, as trunkdb's own parser has it (its §111.1). The
/// empty text is no condition.
pub(crate) fn read(text: &str) -> AppResult<Vec<Condition>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    match text.parse::<Condition>() {
        Ok(Condition::All(conditions)) if conditions.len() >= 2 => Ok(conditions),
        Ok(condition) => Ok(vec![condition]),
        Err(error) => Err(mistake(text, &error)),
    }
}

fn mistake(text: &str, error: &ParseFilterError) -> AppError {
    // trunkdb's offset is in bytes and on a character boundary.
    let offset = error.offset().min(text.len());
    let before = &text[..offset];
    let line_start = before.rfind('\n').map_or(0, |at| at + 1);
    let position = TextPosition {
        line: before.matches('\n').count() + 1,
        column: before[line_start..].chars().count() + 1,
        index: before.encode_utf16().count(),
    };
    let rest = &text[offset..];
    let word: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    let message = if CLAUSES
        .iter()
        .any(|clause| word.eq_ignore_ascii_case(clause))
    {
        "The filter text doesn't read. Sort, page size and columns are set with \
         their own controls."
    } else {
        "The filter text doesn't read."
    };
    AppError::invalid_input(message)
        .with_detail(error.to_string())
        .at(position)
}

/// Conditions printed as trunkdb prints a filter's: joined by `and`,
/// parentheses only where needed. Empty for none.
pub(crate) fn print(conditions: Vec<Condition>) -> String {
    conditions
        .into_iter()
        .fold(Filter::new(), Filter::and)
        .to_string()
}

/// Rows as text; always possible.
pub fn filter_to_text(rows: &[ConditionInput]) -> AppResult<String> {
    Ok(print(ConditionInput::all(rows)?))
}

/// Text taken back into rows, or why it can't be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterRows {
    Rows(Vec<ConditionInput>),
    Reason(String),
}

/// The text as rows, where it is an `and` of conditions each of which a
/// row can say (trunkdb §111.7): a comparison the rows offer with a value
/// of one of their types, `exists(…)` or `not exists(…)`.
pub fn filter_to_rows(text: &str) -> FilterRows {
    let conditions = match read(text) {
        Ok(conditions) => conditions,
        Err(error) => {
            return FilterRows::Reason(format!(
                "The text doesn't read yet: {}",
                error.detail.unwrap_or(error.message)
            ));
        }
    };
    let mut rows = Vec::new();
    match collect(&conditions, &mut rows) {
        Ok(()) => FilterRows::Rows(rows),
        Err(what) => FilterRows::Reason(format!("This filter has {what}, which rows can't show.")),
    }
}

fn collect(conditions: &[Condition], rows: &mut Vec<ConditionInput>) -> Result<(), String> {
    for condition in conditions {
        match condition {
            Condition::All(inner) => collect(inner, rows)?,
            other => rows.push(row(other)?),
        }
    }
    Ok(())
}

fn row(condition: &Condition) -> Result<ConditionInput, String> {
    let row = |field: &str, operator, value| ConditionInput {
        field: field.to_string(),
        operator,
        value,
    };
    match condition {
        Condition::Exists { field, .. } => Ok(row(field, Operator::Exists, None)),
        Condition::Not(inner) => match inner.as_ref() {
            Condition::Exists { field, .. } => Ok(row(field, Operator::Missing, None)),
            _ => Err("a `not`".into()),
        },
        Condition::Compare {
            field, op, value, ..
        } => {
            let operator = match op {
                Op::Eq => Operator::Eq,
                Op::Ne => Operator::Ne,
                Op::Lt => Operator::Lt,
                Op::Lte => Operator::Lte,
                Op::Gt => Operator::Gt,
                Op::Gte => Operator::Gte,
                Op::Contains if matches!(value, Document::String(_)) => Operator::Contains,
                Op::Contains => return Err("`contains` with a value that isn't a string".into()),
                Op::StartsWith => return Err("`starts with`".into()),
                _ => return Err("an operator rows don't offer".into()),
            };
            let value = ValueInput::of(value).map_err(|what| format!("{what} as a value"))?;
            Ok(row(field, operator, Some(value)))
        }
        Condition::Any(_) => Err("an `or` (or an `in`)".into()),
        Condition::Size { .. } => Err("`size(…)`".into()),
        Condition::ElemMatch { .. } => Err("`has`".into()),
        Condition::IsKind { .. } => Err("a test of a value's kind (`is …`)".into()),
        _ => Err("a condition of a later trunkdb".into()),
    }
}

impl Session {
    /// The list's query as a `trunkdb find` command: the
    /// conditions, the sort unless it is `_id` ascending, and the chosen
    /// fields; not the page. Quoted for a POSIX shell.
    pub fn find_command(&self, request: &QueryRequest) -> AppResult<String> {
        let mut filter = request.conditions()?;
        let default_sort = matches!(request.sort.field.as_str(), "" | "_id");
        if !(default_sort && !request.sort.descending) {
            filter = request.sorted(filter);
        }
        if let Some(paths) = request.chosen()? {
            filter = filter.select(paths);
        }
        let path = self.path().display().to_string();
        let mut command = format!(
            "trunkdb find {} {}",
            shell_word(&path),
            shell_word(&request.collection)
        );
        let text = filter.to_string();
        if !text.is_empty() {
            command.push(' ');
            command.push_str(&quoted(&text));
        }
        Ok(command)
    }
}

/// Bare where a shell takes it as one word unchanged, quoted otherwise.
fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./:@%+=,".contains(c));
    if plain {
        word.to_string()
    } else {
        quoted(word)
    }
}

/// In single quotes, a `'` inside as `'\''`.
fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_quoted_only_where_a_shell_needs_it() {
        assert_eq!(shell_word("/data/app.trunkdb"), "/data/app.trunkdb");
        assert_eq!(shell_word("tasks"), "tasks");
        assert_eq!(shell_word("my tasks"), "'my tasks'");
        assert_eq!(shell_word("it's"), r"'it'\''s'");
        assert_eq!(shell_word(""), "''");
        assert_eq!(shell_word("a$b"), "'a$b'");
    }
}
