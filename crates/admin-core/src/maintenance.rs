//! Consistency checking, whole-database export and
//! compaction.
//!
//! The export format is trunkdb's own tagged JSON Lines, streamed by
//! trunkdb into a file. What this module adds is care for the files
//! involved: the output can never be the database or its write-ahead
//! log, and an existing file is replaced only by a complete export.

use crate::error::{AppError, AppResult, ErrorCategory};
use crate::session::Session;
use serde::Serialize;
use std::fs::{File, OpenOptions};
#[cfg(test)]
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckReport {
    pub collections: usize,
    pub documents: usize,
    pub pages: u64,
    /// Everything trunkdb found, in its words. Empty means clean.
    pub problems: Vec<String>,
}

/// What a compaction did (trunkdb SPEC §41): the file's pages before
/// and after. Equal when it was already as small; then nothing was
/// written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompactReport {
    pub pages_before: u64,
    pub pages_after: u64,
    pub page_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportSummary {
    /// Where the export was written, symlinks resolved.
    pub path: String,
    pub collections: usize,
    pub documents: usize,
    pub bytes: u64,
}

impl Session {
    /// Reads and checks the whole file. A report is returned only when
    /// the check ran to its end; anything else is an error, never a
    /// report without problems.
    pub fn check(&self) -> AppResult<CheckReport> {
        self.read(|database| {
            let report = database.check()?;
            Ok(CheckReport {
                collections: report.collections,
                documents: report.documents,
                pages: report.pages,
                problems: report.problems,
            })
        })
    }

    /// Rebuilds the file into as few pages as it needs. A
    /// write: refused in a read-only session, and one at a time with the
    /// session's other writes. Documents, ids and indexes don't change.
    pub fn compact(&self) -> AppResult<CompactReport> {
        self.write(|database| {
            let page_size = database.file_info()?.page_size as u64;
            let compacted = database.compact()?;
            Ok(CompactReport {
                pages_before: compacted.pages_before,
                pages_after: compacted.pages_after,
                page_size,
            })
        })
    }

    /// Exports every persisted collection, with document IDs and index
    /// definitions, to `destination`. An existing file is replaced only
    /// with `overwrite`, and only once the export is complete and synced.
    pub fn export(&self, destination: &Path, overwrite: bool) -> AppResult<ExportSummary> {
        self.read(|database| {
            let protected = ProtectedFiles::of_database(self.path());
            let mut output = ExportOutput::create(destination, overwrite, &protected)?;
            // trunkdb buffers and flushes the stream itself.
            let summary = database.export(output.file())?;
            let (path, bytes) = output.publish(&protected)?;
            Ok(ExportSummary {
                path: path.display().to_string(),
                collections: summary.collections,
                documents: summary.documents,
                bytes,
            })
        })
    }
}

/// The files an export must never write to, and an import never read:
/// a database and its WAL.
pub(crate) struct ProtectedFiles(Vec<PathBuf>);

impl ProtectedFiles {
    pub(crate) fn of_database(database: &Path) -> Self {
        Self::of_databases(std::iter::once(database))
    }

    pub(crate) fn of_databases<'p>(databases: impl IntoIterator<Item = &'p Path>) -> Self {
        Self(
            databases
                .into_iter()
                .flat_map(|database| [database.to_path_buf(), wal_of(database)])
                .collect(),
        )
    }

    /// Whether `candidate` is one of them under any name: the same path
    /// once symlinks are resolved, or the same file through a hard link.
    pub(crate) fn contains(&self, candidate: &Path) -> bool {
        self.0.iter().any(|protected| {
            if Self::resolved(candidate) == Self::resolved(protected) {
                return true;
            }
            match (std::fs::metadata(candidate), std::fs::metadata(protected)) {
                (Ok(a), Ok(b)) => Self::same_inode(&a, &b),
                _ => false,
            }
        })
    }

    /// The path with symlinks resolved; for a file that does not exist
    /// yet, its resolved directory with the file name.
    pub(crate) fn resolved(path: &Path) -> PathBuf {
        if let Ok(resolved) = std::fs::canonicalize(path) {
            return resolved;
        }
        match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => {
                let parent = if parent.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    parent
                };
                std::fs::canonicalize(parent)
                    .map(|parent| parent.join(name))
                    .unwrap_or_else(|_| path.to_path_buf())
            }
            _ => path.to_path_buf(),
        }
    }

    #[cfg(unix)]
    fn same_inode(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }

    #[cfg(not(unix))]
    fn same_inode(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
        false
    }

    fn refusal() -> AppError {
        AppError::invalid_input(
            "The export cannot be written to the open database or its write-ahead log. \
             Choose another file.",
        )
    }
}

/// Where trunkdb keeps a database's write-ahead log: beside it, as
/// `<path>.wal`.
pub(crate) fn wal_of(database: &Path) -> PathBuf {
    let mut wal = database.as_os_str().to_os_string();
    wal.push(".wal");
    PathBuf::from(wal)
}

/// An export being written: a temporary file beside the destination,
/// which becomes the destination only through `publish`. Dropped
/// unpublished — on any failure — it removes the temporary file, and the
/// destination is as it was.
struct ExportOutput {
    destination: PathBuf,
    temporary: PathBuf,
    file: Option<File>,
    overwrite: bool,
    published: bool,
}

impl ExportOutput {
    fn create(destination: &Path, overwrite: bool, protected: &ProtectedFiles) -> AppResult<Self> {
        if destination.file_name().is_none() {
            return Err(AppError::invalid_input("Choose a file to export to."));
        }
        // A symlink is followed: the export replaces what it points to.
        let destination = ProtectedFiles::resolved(destination);
        if protected.contains(&destination) {
            return Err(ProtectedFiles::refusal());
        }
        match std::fs::metadata(&destination) {
            Ok(existing) if existing.is_dir() => {
                return Err(AppError::invalid_input(
                    "The export destination is a folder. Choose a file.",
                ));
            }
            Ok(_) if !overwrite => return Err(Self::exists(&destination)),
            _ => {}
        }

        let directory = destination.parent().unwrap_or(Path::new("."));
        let name = destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        // `create_new` makes the name this export's alone, whatever else
        // is in the directory.
        for attempt in 0u32.. {
            let temporary = directory.join(format!(
                ".{name}.{}-{attempt}.exporting",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => {
                    return Ok(Self {
                        destination,
                        temporary,
                        file: Some(file),
                        overwrite,
                        published: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(AppError::from_io(
                        &error,
                        "The export file cannot be created in that folder.",
                    ));
                }
            }
        }
        unreachable!("the loop returns")
    }

    fn file(&mut self) -> &mut File {
        self.file.as_mut().expect("open until published")
    }

    fn failed(error: &std::io::Error) -> AppError {
        AppError::from_io(error, "Writing the export failed. No file was changed.")
    }

    fn exists(destination: &Path) -> AppError {
        AppError::new(
            ErrorCategory::AlreadyExists,
            "A file with this name already exists.",
        )
        .with_detail(destination.display().to_string())
    }

    /// Makes the finished, synced export the destination. Returns the
    /// destination and its size.
    fn publish(mut self, protected: &ProtectedFiles) -> AppResult<(PathBuf, u64)> {
        let file = self.file.take().expect("published once");
        file.sync_all().map_err(|error| Self::failed(&error))?;
        let bytes = file.metadata().map_err(|error| Self::failed(&error))?.len();
        drop(file);

        // Checked again: the destination may have become a link to the
        // database while the export ran.
        if protected.contains(&self.destination) {
            return Err(ProtectedFiles::refusal());
        }
        if self.overwrite {
            // Atomic: the old file is there until the new one is.
            std::fs::rename(&self.temporary, &self.destination)
                .map_err(|error| Self::failed(&error))?;
        } else {
            // A hard link fails if the name is taken, which a rename
            // would not: a file that appeared meanwhile is not replaced.
            match std::fs::hard_link(&self.temporary, &self.destination) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&self.temporary);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(Self::exists(&self.destination));
                }
                Err(error) => return Err(Self::failed(&error)),
            }
        }
        self.published = true;
        // The new name is durable once its directory is; best effort.
        if let Some(directory) = self.destination.parent()
            && let Ok(directory) = File::open(directory)
        {
            let _ = directory.sync_all();
        }
        Ok((self.destination.clone(), bytes))
    }
}

impl Drop for ExportOutput {
    fn drop(&mut self) {
        if !self.published {
            self.file.take();
            let _ = std::fs::remove_file(&self.temporary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn nothing_protected() -> ProtectedFiles {
        ProtectedFiles(Vec::new())
    }

    #[test]
    fn an_abandoned_export_leaves_the_existing_destination_and_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.jsonl");
        std::fs::write(&destination, b"previous export").unwrap();

        {
            let mut output =
                ExportOutput::create(&destination, true, &nothing_protected()).unwrap();
            output.file().write_all(b"half of a new ex").unwrap();
            assert_eq!(names(dir.path()).len(), 2, "written beside, not into");
            assert_eq!(std::fs::read(&destination).unwrap(), b"previous export");
            // Serialization fails here: the output is dropped unpublished.
        }

        assert_eq!(std::fs::read(&destination).unwrap(), b"previous export");
        assert_eq!(names(dir.path()), ["out.jsonl"]);
    }

    #[test]
    fn a_file_that_appears_during_the_export_is_not_replaced_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.jsonl");
        let mut output = ExportOutput::create(&destination, false, &nothing_protected()).unwrap();
        output.file().write_all(b"export").unwrap();
        std::fs::write(&destination, b"someone else's file").unwrap();

        let error = output.publish(&nothing_protected()).unwrap_err();

        assert_eq!(error.category, ErrorCategory::AlreadyExists);
        assert_eq!(std::fs::read(&destination).unwrap(), b"someone else's file");
        assert_eq!(names(dir.path()), ["out.jsonl"]);
    }

    #[test]
    fn a_destination_that_becomes_the_database_during_the_export_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("db.trunkdb");
        std::fs::write(&database, b"database bytes").unwrap();
        let protected = ProtectedFiles::of_database(&database);
        let destination = dir.path().join("out.jsonl");
        let mut output = ExportOutput::create(&destination, true, &protected).unwrap();
        output.file().write_all(b"export").unwrap();
        std::fs::hard_link(&database, &destination).unwrap();

        let error = output.publish(&protected).unwrap_err();

        assert_eq!(error.category, ErrorCategory::InvalidInput);
        assert_eq!(std::fs::read(&database).unwrap(), b"database bytes");
        assert_eq!(names(dir.path()), ["db.trunkdb", "out.jsonl"]);
    }

    #[test]
    fn published_output_is_complete_and_replaces_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.jsonl");
        std::fs::write(&destination, b"old").unwrap();
        let mut output = ExportOutput::create(&destination, true, &nothing_protected()).unwrap();
        output.file().write_all(b"new export").unwrap();

        let (path, bytes) = output.publish(&nothing_protected()).unwrap();

        assert_eq!(path, std::fs::canonicalize(&destination).unwrap());
        assert_eq!(bytes, 10);
        assert_eq!(std::fs::read(&destination).unwrap(), b"new export");
        assert_eq!(names(dir.path()), ["out.jsonl"]);
    }
}
