use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use trunkdb_admin_core::{ListWatcher, Preferences, RecentFiles, SessionManager};

/// A session's list watch: the collection it watches and the watcher.
pub struct Watch {
    pub collection: String,
    /// Held, never read: dropping it stops the watch.
    #[allow(dead_code)]
    pub watcher: ListWatcher,
}

/// The services shared by all commands. `Arc`s, because each command
/// moves its work onto a blocking thread.
pub struct AppState {
    pub sessions: Arc<SessionManager>,
    pub recents: Arc<RecentFiles>,
    pub preferences: Preferences,
    /// Whether the frontend has a modified document draft; read when macOS
    /// asks whether the app may terminate (`terminate.rs`).
    unsaved_draft: AtomicBool,
    /// The list watch of each session that has one. Dropping a watcher
    /// stops it, so closing a session removes its entry.
    watchers: Arc<Mutex<HashMap<String, Watch>>>,
}

impl AppState {
    /// `state_dir` is the app's local state directory.
    pub fn new(state_dir: &Path) -> Self {
        Self {
            sessions: Arc::new(SessionManager::new()),
            recents: Arc::new(RecentFiles::new(state_dir.join("recent-files.json"))),
            preferences: Preferences::new(state_dir.join("preferences.json")),
            unsaved_draft: AtomicBool::new(false),
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// The shared watcher map, for the commands that start and stop watches.
    pub fn watchers_handle(&self) -> Arc<Mutex<HashMap<String, Watch>>> {
        Arc::clone(&self.watchers)
    }

    pub fn has_unsaved_draft(&self) -> bool {
        self.unsaved_draft.load(Ordering::SeqCst)
    }

    pub fn set_unsaved_draft(&self, unsaved: bool) {
        self.unsaved_draft.store(unsaved, Ordering::SeqCst);
    }
}
