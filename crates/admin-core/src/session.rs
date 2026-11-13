//! Open databases as explicit sessions.
//!
//! A `Session` is the only owner of its `trunkdb::Database`. Work borrows
//! the handle for the length of one closure and never keeps a clone, so
//! closing can wait for running work and then know its file locks are gone.

use crate::error::{AppError, AppResult, ErrorCategory};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use trunkdb::{Database, OpenOptions};

/// The trunkdb build linked into this binary, from the lockfile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrunkdbBuild {
    pub version: &'static str,
    pub revision: &'static str,
}

impl TrunkdbBuild {
    pub const CURRENT: TrunkdbBuild = TrunkdbBuild {
        version: env!("TRUNKDB_VERSION"),
        revision: env!("TRUNKDB_REVISION"),
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileInfo {
    pub format_version: u32,
    pub page_size: usize,
    pub pages: u64,
    pub free_pages: usize,
    /// The trunkdb release that created the file, as text (`0.24.0`);
    /// `None` where the header doesn't say (trunkdb SPEC §125).
    pub created_by: Option<String>,
    /// The trunkdb release that wrote the file last; `None` where an
    /// older build did.
    pub written_by: Option<String>,
}

impl From<trunkdb::FileInfo> for FileInfo {
    fn from(info: trunkdb::FileInfo) -> Self {
        FileInfo {
            format_version: info.format_version,
            page_size: info.page_size,
            pages: info.pages,
            free_pages: info.free_pages,
            created_by: info.created_by.map(|release| release.to_string()),
            written_by: info.written_by.map(|release| release.to_string()),
        }
    }
}

/// What a successful open or create returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub path: String,
    pub file_name: String,
    pub can_mutate: bool,
    pub file: FileInfo,
}

pub struct Session {
    id: String,
    path: PathBuf,
    /// Set first when closing, so new work is refused instead of queueing
    /// behind the close.
    closing: AtomicBool,
    /// `None` once closed. Work holds the read side; `close` takes the
    /// write side, which is what makes it wait for running work.
    database: RwLock<Option<Database>>,
    /// One mutation at a time per session.
    mutations: Mutex<()>,
    /// Collection names prepared in this session but not stored yet.
    /// They live and end with the session.
    virtual_collections: Mutex<Vec<String>>,
    /// Opened with trunkdb's read-only open (trunkdb SPEC §88):
    /// nothing is written to the file or its WAL.
    read_only: bool,
}

impl Session {
    fn new(id: String, path: PathBuf, database: Database, read_only: bool) -> Self {
        Self {
            id,
            path,
            closing: AtomicBool::new(false),
            database: RwLock::new(Some(database)),
            mutations: Mutex::new(()),
            virtual_collections: Mutex::new(Vec::new()),
            read_only,
        }
    }

    pub(crate) fn virtual_collections(&self) -> MutexGuard<'_, Vec<String>> {
        self.virtual_collections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether this session may change its database: the single place
    /// that answers it. A read-only session may not.
    pub fn can_mutate(&self) -> bool {
        !self.read_only
    }

    /// Runs read-only work on the database, or fails if the session is
    /// closed or closing.
    pub fn read<R>(&self, work: impl FnOnce(&Database) -> AppResult<R>) -> AppResult<R> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(AppError::session_closed());
        }
        let guard = self.database.read().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(database) => work(database),
            None => Err(AppError::session_closed()),
        }
    }

    /// Runs a mutation, after any other mutation of this session.
    pub fn write<R>(&self, work: impl FnOnce(&Database) -> AppResult<R>) -> AppResult<R> {
        if !self.can_mutate() {
            return Err(AppError::read_only());
        }
        let _one_at_a_time: MutexGuard<'_, ()> =
            self.mutations.lock().unwrap_or_else(|e| e.into_inner());
        self.read(work)
    }

    pub fn info(&self) -> AppResult<SessionInfo> {
        let file = self.file_info()?;
        Ok(SessionInfo {
            session_id: self.id.clone(),
            path: self.path.display().to_string(),
            file_name: self
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            can_mutate: self.can_mutate(),
            file,
        })
    }

    pub fn file_info(&self) -> AppResult<FileInfo> {
        self.read(|database| Ok(FileInfo::from(database.file_info()?)))
    }

    /// Refuses new work, waits for running work, then drops the database
    /// and with it its file locks. Safe to call more than once.
    fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let database = self
            .database
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        drop(database);
    }
}

/// All open sessions. Phase 1 allows one at a time as a product rule
/// (`max_sessions`); nothing else here assumes a single database.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
    /// Differs per app run, so an ID left over in a stale frontend state
    /// can never name a session of a later run.
    run: u64,
    max_sessions: usize,
    /// Held shared by each running import, exclusively by
    /// `close_all`, which so waits for them; `true` once closed, so app
    /// exit starts no new one.
    imports: RwLock<bool>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        let run = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos() as u64)
            .unwrap_or_default();
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            run,
            max_sessions: 1,
            imports: RwLock::new(false),
        }
    }

    /// Opens a database that must already exist. trunkdb's own open would
    /// create a missing file and bootstrap an empty one, so both are
    /// refused here first: opening never creates a database.
    pub fn open_existing(&self, path: &Path) -> AppResult<Arc<Session>> {
        self.open(path, false)
    }

    /// Opens a database that must already exist without writing to it or
    /// its WAL (trunkdb SPEC §88): a WAL left by a crash is recovered in
    /// memory only, an older file is not stamped with the current format,
    /// and the file only has to be readable. Other programs may read and
    /// write beside it (trunkdb SPEC §185): a read takes the readers' lock
    /// only while it runs.
    pub fn open_read_only(&self, path: &Path) -> AppResult<Arc<Session>> {
        self.open(path, true)
    }

    fn open(&self, path: &Path, read_only: bool) -> AppResult<Arc<Session>> {
        let path = Self::absolute(path)?;
        let metadata = std::fs::metadata(&path)
            .map_err(|error| AppError::from_io(&error, "The file cannot be opened."))?;
        if !metadata.is_file() {
            return Err(AppError::new(
                ErrorCategory::NotADatabase,
                "This is not a file.",
            ));
        }
        if metadata.len() == 0 {
            return Err(AppError::new(
                ErrorCategory::NotADatabase,
                "This file is empty, not a trunkdb database. Use Create to make a new one.",
            ));
        }
        self.register(path, read_only, |path| {
            Ok(Database::open_with(
                path,
                OpenOptions::default().read_only(read_only),
            )?)
        })
    }

    /// Creates a new database and opens it. An existing target, of any
    /// kind, is refused and left as it is.
    pub fn create_new(&self, path: &Path) -> AppResult<Arc<Session>> {
        let path = Self::absolute(path)?;
        self.register(path, false, |path| {
            // `create_new` is the atomic "must not exist" check; trunkdb
            // then finds an empty file and bootstraps it.
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::AlreadyExists => AppError::new(
                        ErrorCategory::AlreadyExists,
                        "A file with this name already exists. Nothing was changed; \
                         choose another name, or use Open for an existing database.",
                    ),
                    _ => AppError::from_io(&error, "The file cannot be created."),
                })?;
            Database::open(path).map_err(|error| {
                // Only what this call made, and only while still empty.
                if std::fs::metadata(path).is_ok_and(|created| created.len() == 0) {
                    let _ = std::fs::remove_file(path);
                }
                AppError::from(error)
            })
        })
    }

    fn register(
        &self,
        path: PathBuf,
        read_only: bool,
        open: impl FnOnce(&Path) -> AppResult<Database>,
    ) -> AppResult<Arc<Session>> {
        // Held across the open: it is the reservation of the one slot.
        let mut sessions = self.lock();
        if sessions.len() >= self.max_sessions {
            return Err(AppError::new(
                ErrorCategory::Busy,
                "Another database is open. Close it first.",
            ));
        }
        let database = open(&path)?;
        // After the open, so a created file resolves too. Symlinks are
        // resolved so one file has one name in the recent list.
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        let id = format!(
            "s{:x}-{}",
            self.run,
            self.next_id.fetch_add(1, Ordering::SeqCst)
        );
        let session = Arc::new(Session::new(id.clone(), path, database, read_only));
        sessions.insert(id, Arc::clone(&session));
        Ok(session)
    }

    /// The session a request addresses, or `SessionClosed`: a request for
    /// a closed session fails without reaching any other one.
    pub fn get(&self, session_id: &str) -> AppResult<Arc<Session>> {
        self.lock()
            .get(session_id)
            .cloned()
            .ok_or_else(AppError::session_closed)
    }

    /// Closes the session and returns once its file locks are released.
    pub fn close(&self, session_id: &str) -> AppResult<()> {
        let session = self
            .lock()
            .remove(session_id)
            .ok_or_else(AppError::session_closed)?;
        session.close();
        Ok(())
    }

    /// The paths of the open databases.
    pub(crate) fn open_paths(&self) -> Vec<PathBuf> {
        self.lock()
            .values()
            .map(|session| session.path().to_path_buf())
            .collect()
    }

    /// A running import's hold: app exit waits for it to end.
    pub(crate) fn import_running(&self) -> AppResult<std::sync::RwLockReadGuard<'_, bool>> {
        let closed = self.imports.read().unwrap_or_else(|e| e.into_inner());
        if *closed {
            return Err(AppError::new(
                ErrorCategory::Busy,
                "The app is quitting; nothing new is started.",
            ));
        }
        Ok(closed)
    }

    /// For app exit: waits for running imports, starts no new one, and
    /// closes every session.
    pub fn close_all(&self) {
        *self.imports.write().unwrap_or_else(|e| e.into_inner()) = true;
        let sessions: Vec<Arc<Session>> = self.lock().drain().map(|(_, session)| session).collect();
        for session in sessions {
            session.close();
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<Session>>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn absolute(path: &Path) -> AppResult<PathBuf> {
        if path.as_os_str().is_empty() {
            return Err(AppError::invalid_input("No file was chosen."));
        }
        std::path::absolute(path)
            .map_err(|error| AppError::from_io(&error, "The path cannot be used."))
    }
}
