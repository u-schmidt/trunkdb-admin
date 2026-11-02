//! Recently opened databases, kept in the app's local state directory and
//! never inside a database.

use crate::error::AppResult;
use crate::state_file;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecentFile {
    pub path: String,
    pub file_name: String,
    /// Whether a file is there right now. A stale entry stays listed until
    /// the user removes it; it is never opened or recreated on its own.
    pub exists: bool,
    /// It was last opened read-only, and opens that way again.
    pub read_only: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    paths: Vec<String>,
    /// The entries of `paths` last opened read-only. Absent in a list
    /// written before read-only opening existed: all of them opened for
    /// editing.
    #[serde(default)]
    read_only: Vec<String>,
}

impl Stored {
    fn entries(self) -> Vec<RecentFile> {
        let read_only = self.read_only;
        self.paths
            .into_iter()
            .map(|path| {
                let opened_read_only = read_only.contains(&path);
                RecentFiles::entry(path, opened_read_only)
            })
            .collect()
    }
}

pub struct RecentFiles {
    file: PathBuf,
    /// Serializes read-modify-write of the state file within the app.
    guard: Mutex<()>,
}

impl RecentFiles {
    /// Most recently used first.
    pub const MAX_ENTRIES: usize = 10;

    /// `file` is where the list is stored; it need not exist yet.
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self {
            file: file.into(),
            guard: Mutex::new(()),
        }
    }

    pub fn list(&self) -> Vec<RecentFile> {
        let _guard = self.guard.lock().unwrap_or_else(|e| e.into_inner());
        self.load().entries()
    }

    /// Puts `path` first, once, remembering how it was opened.
    pub fn add(&self, path: &Path, read_only: bool) -> AppResult<Vec<RecentFile>> {
        let path = path.display().to_string();
        self.change(|stored| {
            stored.paths.retain(|existing| *existing != path);
            stored.paths.insert(0, path.clone());
            stored.paths.truncate(Self::MAX_ENTRIES);
            stored.read_only.retain(|existing| *existing != path);
            if read_only {
                stored.read_only.push(path);
            }
        })
    }

    pub fn remove(&self, path: &str) -> AppResult<Vec<RecentFile>> {
        self.change(|stored| stored.paths.retain(|existing| existing != path))
    }

    fn change(&self, change: impl FnOnce(&mut Stored)) -> AppResult<Vec<RecentFile>> {
        let _guard = self.guard.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.load();
        change(&mut stored);
        // Only modes of listed paths are kept.
        let Stored { paths, read_only } = &mut stored;
        read_only.retain(|path| paths.contains(path));
        self.store(&stored)?;
        Ok(stored.entries())
    }

    fn load(&self) -> Stored {
        state_file::load(&self.file)
    }

    fn store(&self, stored: &Stored) -> AppResult<()> {
        state_file::store(&self.file, stored, "The recent files list")
    }

    fn entry(path: String, read_only: bool) -> RecentFile {
        let as_path = Path::new(&path);
        RecentFile {
            file_name: as_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone()),
            exists: as_path.is_file(),
            path,
            read_only,
        }
    }
}
