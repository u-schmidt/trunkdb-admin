//! App preferences, kept in the app's local state directory beside the
//! recent files list and never inside a database.

use crate::error::AppResult;
use crate::state_file;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Light or dark, or whatever the system uses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    pub const ALL: [Appearance; 3] = [Appearance::System, Appearance::Light, Appearance::Dark];
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct Stored {
    appearance: Appearance,
}

pub struct Preferences {
    file: PathBuf,
    /// Serializes read-modify-write of the state file within the app.
    guard: Mutex<()>,
}

impl Preferences {
    /// `file` is where the preferences are stored; it need not exist yet.
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self {
            file: file.into(),
            guard: Mutex::new(()),
        }
    }

    /// The stored choice; `System` when none is stored or it is unreadable.
    pub fn appearance(&self) -> Appearance {
        let _guard = self.guard.lock().unwrap_or_else(|e| e.into_inner());
        state_file::load::<Stored>(&self.file).appearance
    }

    pub fn set_appearance(&self, appearance: Appearance) -> AppResult<()> {
        let _guard = self.guard.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored: Stored = state_file::load(&self.file);
        stored.appearance = appearance;
        state_file::store(&self.file, &stored, "The preferences")
    }
}
