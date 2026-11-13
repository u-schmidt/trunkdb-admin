//! The app's error contract: a stable category the UI can branch on, a
//! readable message, and trunkdb's own wording where it adds something.

use serde::Serialize;
use std::io;

/// What kind of failure this is. The frontend decides presentation and
/// follow-up (retry, refresh, remove a recent entry) from this, never by
/// parsing messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    InvalidInput,
    InvalidJson,
    FileNotFound,
    TargetNotFound,
    AlreadyExists,
    Locked,
    /// An open for editing that would raise an older file format; asked
    /// for with the upgrade, it opens.
    FormatUpgrade,
    NotADatabase,
    UnsupportedFormat,
    PermissionDenied,
    UniqueConflict,
    DamagedData,
    SnapshotExpired,
    RecoveryRequired,
    SessionClosed,
    /// A write asked of a database opened read-only.
    ReadOnly,
    Busy,
    Io,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub category: ErrorCategory,
    /// One sentence a user can act on.
    pub message: String,
    /// The underlying message (trunkdb's or the OS's), when it says more.
    pub detail: Option<String>,
    /// Where in a filter text the mistake is; None otherwise.
    pub at: Option<TextPosition>,
}

/// A place in a text the user typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TextPosition {
    /// From 1.
    pub line: usize,
    /// From 1, in characters.
    pub column: usize,
    /// From 0, in UTF-16 code units, as JavaScript indexes a string.
    pub index: usize,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(category: ErrorCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: message.into(),
            detail: None,
            at: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn at(mut self, position: TextPosition) -> Self {
        self.at = Some(position);
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::InvalidInput, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::TargetNotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Internal, message)
    }

    pub fn read_only() -> Self {
        Self::new(
            ErrorCategory::ReadOnly,
            "The database is open read-only. Open it for editing to change it.",
        )
    }

    pub fn session_closed() -> Self {
        Self::new(
            ErrorCategory::SessionClosed,
            "This database is no longer open.",
        )
    }

    /// An I/O failure outside trunkdb (recent files, export output), where
    /// `InvalidData` has no database meaning.
    pub fn from_io(error: &io::Error, context: &str) -> Self {
        let category = match error.kind() {
            io::ErrorKind::NotFound => ErrorCategory::FileNotFound,
            io::ErrorKind::PermissionDenied => ErrorCategory::PermissionDenied,
            io::ErrorKind::AlreadyExists => ErrorCategory::AlreadyExists,
            _ => ErrorCategory::Io,
        };
        Self::new(category, context).with_detail(error.to_string())
    }

    /// An I/O failure reported by trunkdb. A file it can't read at all
    /// is `Error::Format` (trunkdb SPEC §92, `from_format`), so here the
    /// kind says the rest: `WouldBlock` is another open holding the file,
    /// and `InvalidData` is damage.
    fn from_database_io(error: &io::Error) -> Self {
        let detail = error.to_string();
        let (category, message) = match error.kind() {
            io::ErrorKind::NotFound => (ErrorCategory::FileNotFound, "The file does not exist."),
            io::ErrorKind::WouldBlock => (
                ErrorCategory::Locked,
                "The database is in use by another program. Close it there and try again.",
            ),
            io::ErrorKind::PermissionDenied => (
                ErrorCategory::PermissionDenied,
                "Your permissions don't allow this access to the file.",
            ),
            // How trunkdb refuses an argument: an index path it does not
            // allow, a name that is too long. Its message is the reason.
            io::ErrorKind::InvalidInput => (
                ErrorCategory::InvalidInput,
                "trunkdb does not accept this input.",
            ),
            io::ErrorKind::InvalidData | io::ErrorKind::UnexpectedEof => (
                ErrorCategory::DamagedData,
                "The database file is damaged or incomplete.",
            ),
            _ => (ErrorCategory::Io, "Reading or writing the file failed."),
        };
        Self::new(category, message).with_detail(detail)
    }

    /// A file, or the WAL beside it, that the bundled trunkdb can't read
    /// at all. Nothing was changed.
    fn from_format(error: &trunkdb::FormatError) -> Self {
        use trunkdb::FormatError;
        let unsupported = |message: String| Self::new(ErrorCategory::UnsupportedFormat, message);
        let app_error = match error {
            FormatError::NotTrunkdb => Self::new(
                ErrorCategory::NotADatabase,
                "This file is not a trunkdb database.",
            ),
            FormatError::Unversioned => unsupported(
                "This database was written by a very early trunkdb, before file formats had \
                 versions. The bundled trunkdb cannot open it."
                    .into(),
            ),
            FormatError::Newer { found, current, .. } => unsupported(format!(
                "This database has file format {found}, newer than the bundled trunkdb \
                 reads ({current}). Open it with a newer TrunkDB Admin."
            )),
            FormatError::Older {
                found,
                oldest,
                current,
                ..
            } => unsupported(format!(
                "This database has file format {found}; the bundled trunkdb reads formats \
                 {oldest} to {current}. Export it with the trunkdb that wrote it, and import \
                 the export into a new database."
            )),
            FormatError::WalNotTrunkdb => unsupported(
                "The write-ahead log beside this database is not a trunkdb log the bundled \
                 trunkdb can read."
                    .into(),
            ),
            FormatError::WalVersion { found, .. } => unsupported(format!(
                "The write-ahead log beside this database has version {found}, which the \
                 bundled trunkdb cannot read. A newer trunkdb probably left it after a crash; \
                 open the database with that one first."
            )),
            // Left by a crash beside another copy of the file (trunkdb
            // SPEC §183); trunkdb's detail names the WAL and what to do.
            FormatError::WalNotThisFiles { .. } => unsupported(
                "The write-ahead log beside this database belongs to another database file, \
                 or to another copy of this one, so it is not replayed. Nothing was changed. \
                 To open this file as it is, move the log aside; if it belongs to another copy, \
                 put that copy back beside it and open that."
                    .into(),
            ),
            FormatError::NotAnObject { collection, id, .. } => unsupported(format!(
                "Collection \u{201c}{collection}\u{201d} holds a document that is not an object \
                 ({id}). The bundled trunkdb requires every document to be an object. Open the \
                 database with trunkdb 0.19.0, delete or wrap such documents, and open it here \
                 again."
            )),
            _ => unsupported("This file has a format the bundled trunkdb cannot read.".into()),
        };
        app_error.with_detail(error.to_string())
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{} ({detail})", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for AppError {}

impl From<trunkdb::Error> for AppError {
    fn from(error: trunkdb::Error) -> Self {
        use trunkdb::Error;
        let detail = error.to_string();
        let (category, message) = match &error {
            Error::Io(io) => return Self::from_database_io(io),
            Error::Format(format) => return Self::from_format(format),
            Error::Document(_) => (
                ErrorCategory::InvalidInput,
                "The document cannot be stored as it is.",
            ),
            Error::DuplicateValue { .. } => (
                ErrorCategory::UniqueConflict,
                "A unique index does not allow this value twice.",
            ),
            Error::DuplicateId { .. } => (
                ErrorCategory::UniqueConflict,
                "A document with this ID already exists.",
            ),
            Error::NotFound { .. } => (
                ErrorCategory::TargetNotFound,
                "The document no longer exists.",
            ),
            Error::SnapshotTooOld => (
                ErrorCategory::SnapshotExpired,
                "The data changed while it was being read. Refresh and try again.",
            ),
            // A read in this app, or a reader in another process
            // (trunkdb SPEC §185.4), keeps a compaction out.
            Error::SnapshotOpen => (
                ErrorCategory::Busy,
                "A read is still running, here or in another program. Try again once it is done.",
            ),
            // The commit reached the log but not the file: its outcome is
            // decided by the next open, so nothing here may claim rollback.
            Error::Poisoned => (
                ErrorCategory::RecoveryRequired,
                "A write did not complete. Close and reopen the database to recover it; \
                 the last change may or may not have been saved.",
            ),
            Error::ReadOnly => (
                ErrorCategory::ReadOnly,
                "The database is open read-only. Open it for editing to change it.",
            ),
            // A hint names an index the collection lacks or can't read
            // for the filter (trunkdb SPEC §132); the detail says which.
            Error::Hint { .. } => (
                ErrorCategory::InvalidInput,
                "The index the query asks for can't be used for it.",
            ),
            // A line of an export that doesn't read (trunkdb SPEC §30).
            Error::Import { .. } => (ErrorCategory::InvalidInput, "The export can't be read."),
            Error::NotAnObject { .. } => (
                ErrorCategory::InvalidInput,
                "A document must be a JSON object: { \u{2026} }.",
            ),
            _ => (ErrorCategory::Internal, "The database reported an error."),
        };
        Self::new(category, message).with_detail(detail)
    }
}
