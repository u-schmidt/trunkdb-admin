//! Import into a new database. trunkdb's import isn't atomic
//! (its SPEC §30.3): a line that doesn't read, or an id that exists
//! already, stops it with everything before kept. So it never runs into
//! a database that is open: it runs into a temporary database beside
//! the destination, which becomes the destination only when complete,
//! closed and synced, and never in place of a file that is there.

use crate::error::{AppError, AppResult, ErrorCategory};
use crate::maintenance::{ProtectedFiles, wal_of};
use crate::session::SessionManager;
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use trunkdb::{Database, ImportOptions};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportSummary {
    /// The new database, symlinks resolved.
    pub path: String,
    pub collections: usize,
    pub documents: usize,
    pub bytes: u64,
}

impl SessionManager {
    /// Reads the export at `source` into a new database at
    /// `destination`, which must not exist. Waits for nothing open and
    /// changes nothing open; app exit waits for it (`close_all`).
    pub fn import_into_new(&self, source: &Path, destination: &Path) -> AppResult<ImportSummary> {
        let _running = self.import_running()?;
        let destination = Self::checked_destination(destination)?;
        let open = self.open_paths();
        if ProtectedFiles::of_databases(open.iter().map(PathBuf::as_path)).contains(source) {
            return Err(AppError::invalid_input(
                "An open database can't be imported. Export it, and import the export.",
            ));
        }
        let input = File::open(source)
            .map_err(|error| AppError::from_io(&error, "The export cannot be opened."))?;
        if input.metadata().is_ok_and(|meta| meta.is_dir()) {
            return Err(AppError::invalid_input(
                "This is a folder. Choose an export file.",
            ));
        }

        let target = ImportTarget::create(&destination)?;
        let summary = {
            let database = Database::open(&target.temporary).map_err(AppError::from)?;
            let imported = database
                .import_with(BufReader::new(input), ImportOptions::default())
                .map_err(Self::import_error)?;
            // Closed before it moves: the WAL is written back and empty.
            drop(database);
            imported
        };
        let bytes = target.publish()?;
        Ok(ImportSummary {
            path: destination.display().to_string(),
            collections: summary.collections,
            documents: summary.documents,
            bytes,
        })
    }

    /// The destination resolved, refused if anything is there: an
    /// import never replaces a file, as Create never does.
    fn checked_destination(destination: &Path) -> AppResult<PathBuf> {
        if destination.as_os_str().is_empty() || destination.file_name().is_none() {
            return Err(AppError::invalid_input(
                "Choose where the new database goes.",
            ));
        }
        let absolute = std::path::absolute(destination)
            .map_err(|error| AppError::from_io(&error, "The path cannot be used."))?;
        let resolved = ProtectedFiles::resolved(&absolute);
        if std::fs::symlink_metadata(&resolved).is_ok() {
            return Err(ImportTarget::exists(&resolved));
        }
        Ok(resolved)
    }

    /// What a failed import says: the export, not the app,
    /// is at fault where a line doesn't read or an id comes twice.
    fn import_error(error: trunkdb::Error) -> AppError {
        match &error {
            trunkdb::Error::Import { .. } => {
                AppError::invalid_input("The export can't be read. Nothing was created.")
                    .with_detail(error.to_string())
            }
            trunkdb::Error::DuplicateId { .. } => AppError::invalid_input(
                "The export holds one document ID twice. Nothing was created.",
            )
            .with_detail(error.to_string()),
            _ => AppError::from(error),
        }
    }
}

/// A database being imported into: a temporary file beside the
/// destination, which becomes the destination only through `publish`.
/// Dropped unpublished — on any failure — it removes the temporary file
/// and its WAL, and the destination is never made.
struct ImportTarget {
    destination: PathBuf,
    temporary: PathBuf,
    published: bool,
}

impl ImportTarget {
    fn create(destination: &Path) -> AppResult<Self> {
        let directory = destination.parent().unwrap_or(Path::new("."));
        let name = destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        // `create_new` makes the name this import's alone; the empty file
        // is what trunkdb bootstraps a new database in, as Create does.
        for attempt in 0u32.. {
            let temporary = directory.join(format!(
                ".{name}.{}-{attempt}.importing",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(_) => {
                    return Ok(Self {
                        destination: destination.to_path_buf(),
                        temporary,
                        published: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(AppError::from_io(
                        &error,
                        "The new database cannot be created in that folder.",
                    ));
                }
            }
        }
        unreachable!("the loop returns")
    }

    fn exists(destination: &Path) -> AppError {
        AppError::new(
            ErrorCategory::AlreadyExists,
            "A file with this name already exists. Nothing was changed; choose another name.",
        )
        .with_detail(destination.display().to_string())
    }

    fn failed(error: &std::io::Error) -> AppError {
        AppError::from_io(
            error,
            "Writing the new database failed. Nothing was created.",
        )
    }

    /// Makes the closed, synced database the destination; its size.
    fn publish(mut self) -> AppResult<u64> {
        // Closed cleanly, trunkdb leaves an empty WAL file; one that isn't
        // empty would hold pages the file lacks, and must not be lost.
        let wal = wal_of(&self.temporary);
        match std::fs::metadata(&wal) {
            Ok(meta) if meta.len() == 0 => {
                std::fs::remove_file(&wal).map_err(|error| Self::failed(&error))?;
            }
            Ok(_) => {
                return Err(AppError::internal(
                    "The new database was not closed cleanly. Nothing was created.",
                ));
            }
            Err(_) => {}
        }
        let file = File::open(&self.temporary).map_err(|error| Self::failed(&error))?;
        file.sync_all().map_err(|error| Self::failed(&error))?;
        let bytes = file.metadata().map_err(|error| Self::failed(&error))?.len();
        drop(file);

        // A hard link fails if the name is taken, which a rename would
        // not: a file that appeared meanwhile is not replaced.
        match std::fs::hard_link(&self.temporary, &self.destination) {
            Ok(()) => {
                self.published = true;
                let _ = std::fs::remove_file(&self.temporary);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Self::exists(&self.destination));
            }
            Err(error) => return Err(Self::failed(&error)),
        }
        // The new name is durable once its directory is; best effort.
        if let Some(directory) = self.destination.parent()
            && let Ok(directory) = File::open(directory)
        {
            let _ = directory.sync_all();
        }
        Ok(bytes)
    }
}

impl Drop for ImportTarget {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.temporary);
            let _ = std::fs::remove_file(wal_of(&self.temporary));
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

    #[test]
    fn a_destination_that_appears_during_the_import_is_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("new.trunkdb");
        let target = ImportTarget::create(&destination).unwrap();
        drop(Database::open(&target.temporary).unwrap());
        std::fs::write(&destination, b"someone else's file").unwrap();

        let error = target.publish().unwrap_err();

        assert_eq!(error.category, ErrorCategory::AlreadyExists);
        assert_eq!(std::fs::read(&destination).unwrap(), b"someone else's file");
        assert_eq!(
            names(dir.path()),
            ["new.trunkdb"],
            "the temporary files gone"
        );
    }

    #[test]
    fn a_wal_that_is_not_empty_is_never_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("new.trunkdb");
        let target = ImportTarget::create(&destination).unwrap();
        drop(Database::open(&target.temporary).unwrap());
        std::fs::write(wal_of(&target.temporary), b"pages").unwrap();

        assert!(target.publish().is_err());
        assert!(!destination.exists());
        assert!(names(dir.path()).is_empty());
    }
}
