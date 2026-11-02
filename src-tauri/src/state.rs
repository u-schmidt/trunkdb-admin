use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use trunkdb_admin_core::{Preferences, RecentFiles, SessionManager};

/// The services shared by all commands. `Arc`s, because each command
/// moves its work onto a blocking thread.
pub struct AppState {
    pub sessions: Arc<SessionManager>,
    pub recents: Arc<RecentFiles>,
    pub preferences: Preferences,
    /// Whether the frontend has a modified document draft; read when macOS
    /// asks whether the app may terminate (`terminate.rs`).
    unsaved_draft: AtomicBool,
}

impl AppState {
    /// `state_dir` is the app's local state directory.
    pub fn new(state_dir: &Path) -> Self {
        Self {
            sessions: Arc::new(SessionManager::new()),
            recents: Arc::new(RecentFiles::new(state_dir.join("recent-files.json"))),
            preferences: Preferences::new(state_dir.join("preferences.json")),
            unsaved_draft: AtomicBool::new(false),
        }
    }

    pub fn has_unsaved_draft(&self) -> bool {
        self.unsaved_draft.load(Ordering::SeqCst)
    }

    pub fn set_unsaved_draft(&self, unsaved: bool) {
        self.unsaved_draft.store(unsaved, Ordering::SeqCst);
    }
}
