//! Application services of TrunkDB Admin.
//!
//! Everything the desktop shell does to a database goes through this
//! crate, which knows nothing about Tauri or the UI: the shell's commands
//! translate arguments and results, and the behavior lives — and is
//! tested — here.

mod documents;
mod error;
mod explain;
mod field_paths;
mod filter_text;
mod groups;
mod import;
mod indexes;
mod maintenance;
mod overview;
mod preferences;
mod query;
mod recent;
mod session;
mod state_file;
mod statement;
mod storage;

pub use documents::{DocumentView, SaveRequest, SavedDocument};
pub use error::{AppError, AppResult, ErrorCategory, TextPosition};
pub use explain::{AlternativeReport, ExplainReport, IndexReadReport, PlanKind, SortReport};
pub use field_paths::{FieldPath, FieldPaths, FieldPathsRequest, KindCount, MAX_PATHS};
pub use filter_text::{FilterRows, filter_to_rows, filter_to_text};
pub use groups::{
    ColumnInput, ColumnKind, GroupColumn, GroupRequest, GroupResult, GroupRow, GroupSort,
};
pub use import::ImportSummary;
pub use indexes::IndexRequest;
pub use maintenance::{CheckReport, CompactReport, ExportSummary};
pub use overview::{CollectionSummary, IndexSummary, Overview};
pub use preferences::{Appearance, Preferences};
pub use query::{
    Cell, ConditionInput, FilterInput, HintInput, KindInput, Operator, QueryRequest, QueryResult,
    ResultRow, SortInput, ValueInput, ValueKind, ValueType,
};
pub use recent::{RecentFile, RecentFiles};
pub use session::{
    BUNDLED_FORMAT, FileInfo, FormatUpgrade, Session, SessionInfo, SessionManager, TrunkdbBuild,
};
pub use statement::{groups_statement, query_statement};
pub use storage::{CollectionStorage, IndexStorage, PageUse, Recovery, StorageReport};
