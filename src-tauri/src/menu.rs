//! The application menu. It is the default macOS menu except for Quit:
//! the predefined Quit item terminates the process at once, which would
//! discard an unsaved document draft without asking. This one asks the
//! frontend instead, which settles the draft and then calls `app_quit`.
//! It adds View → Appearance, which sets the app's appearance natively; the
//! web view's `prefers-color-scheme` follows, so the styles need no switch.

use crate::state::AppState;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, Theme, Wry};
use trunkdb_admin_core::Appearance;

/// What the frontend listens for.
pub const QUIT_REQUESTED: &str = "quit-requested";
const QUIT_ID: &str = "quit";

/// The appearance items, kept to move the checkmark.
struct AppearanceItems(Vec<(Appearance, CheckMenuItem<Wry>)>);

pub fn build(app: &App, appearance: Appearance) -> tauri::Result<Menu<Wry>> {
    let quit = MenuItemBuilder::with_id(QUIT_ID, "Quit TrunkDB Admin")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let application = SubmenuBuilder::new(app, "TrunkDB Admin")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    // Present so the standard shortcuts reach text fields and the editor.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let appearance_items = Appearance::ALL
        .into_iter()
        .map(|choice| {
            CheckMenuItemBuilder::with_id(appearance_id(choice), appearance_label(choice))
                .checked(choice == appearance)
                .build(app)
                .map(|item| (choice, item))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let mut appearance_menu = SubmenuBuilder::new(app, "Appearance");
    for (_, item) in &appearance_items {
        appearance_menu = appearance_menu.item(item);
    }
    let view = SubmenuBuilder::new(app, "View")
        .item(&appearance_menu.build()?)
        .build()?;
    app.manage(AppearanceItems(appearance_items));
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&application, &edit, &view, &window])
        .build()
}

pub fn handle(app: &AppHandle, id: &str) {
    if id == QUIT_ID {
        if !request_quit(app) {
            // Nobody left to ask: quit rather than become unquittable.
            app.exit(0);
        }
    } else if let Some(choice) = Appearance::ALL
        .into_iter()
        .find(|&choice| appearance_id(choice) == id)
    {
        choose_appearance(app, choice);
    }
}

/// Asks the frontend to settle any draft and quit; false if it cannot be
/// asked.
pub fn request_quit(app: &AppHandle) -> bool {
    app.emit(QUIT_REQUESTED, ()).is_ok()
}

/// Applies the appearance to the whole app; `System` follows macOS.
pub fn apply_appearance(app: &AppHandle, appearance: Appearance) {
    app.set_theme(match appearance {
        Appearance::System => None,
        Appearance::Light => Some(Theme::Light),
        Appearance::Dark => Some(Theme::Dark),
    });
}

fn choose_appearance(app: &AppHandle, choice: Appearance) {
    apply_appearance(app, choice);
    // A click toggles the clicked item; the menu is a choice of one.
    for (appearance, item) in &app.state::<AppearanceItems>().0 {
        let _ = item.set_checked(*appearance == choice);
    }
    // The choice is in effect either way; only keeping it failed.
    if let Err(error) = app.state::<AppState>().preferences.set_appearance(choice) {
        eprintln!("{error}");
    }
}

fn appearance_id(appearance: Appearance) -> &'static str {
    match appearance {
        Appearance::System => "appearance-system",
        Appearance::Light => "appearance-light",
        Appearance::Dark => "appearance-dark",
    }
}

fn appearance_label(appearance: Appearance) -> &'static str {
    match appearance {
        Appearance::System => "Use System Setting",
        Appearance::Light => "Light",
        Appearance::Dark => "Dark",
    }
}
