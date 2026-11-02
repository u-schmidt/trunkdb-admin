//! App preferences: the appearance choice.

use trunkdb_admin_core::{Appearance, Preferences};

#[test]
fn appearance_defaults_to_system_and_is_kept_across_instances() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state/preferences.json");
    let preferences = Preferences::new(&file);
    assert_eq!(preferences.appearance(), Appearance::System);

    for appearance in Appearance::ALL.into_iter().rev() {
        preferences.set_appearance(appearance).unwrap();
        assert_eq!(Preferences::new(&file).appearance(), appearance);
    }
}

#[test]
fn an_unreadable_or_unknown_file_means_system_and_is_replaced_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("preferences.json");
    let preferences = Preferences::new(&file);

    for content in ["not json", r#"{"appearance":"sepia"}"#, "{}"] {
        std::fs::write(&file, content).unwrap();
        assert_eq!(preferences.appearance(), Appearance::System, "{content}");
    }

    std::fs::write(&file, "not json").unwrap();
    preferences.set_appearance(Appearance::Dark).unwrap();
    assert_eq!(preferences.appearance(), Appearance::Dark);
}

#[test]
fn a_failed_save_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    // The state directory's place is taken by a file.
    std::fs::write(dir.path().join("state"), b"x").unwrap();
    let preferences = Preferences::new(dir.path().join("state/preferences.json"));

    let error = preferences.set_appearance(Appearance::Light).unwrap_err();
    assert_eq!(error.message, "The preferences cannot be saved.");
    assert_eq!(preferences.appearance(), Appearance::System);
}
