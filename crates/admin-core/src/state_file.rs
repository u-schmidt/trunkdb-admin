//! Small JSON files in the app's local state directory (recent files,
//! preferences). Reading never fails: a missing or unreadable file is the
//! default, so losing app state cannot keep the app from starting.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::Path;

pub(crate) fn load<T: DeserializeOwned + Default>(file: &Path) -> T {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Written beside and renamed, so a crash leaves the previous file.
pub(crate) fn store<T: Serialize>(file: &Path, value: &T, what: &str) -> AppResult<()> {
    let failed =
        |error: std::io::Error| AppError::from_io(&error, &format!("{what} cannot be saved."));
    if let Some(directory) = file.parent() {
        std::fs::create_dir_all(directory).map_err(failed)?;
    }
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| AppError::internal(error.to_string()))?;
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(failed)?;
    std::fs::rename(&temporary, file).map_err(failed)
}
