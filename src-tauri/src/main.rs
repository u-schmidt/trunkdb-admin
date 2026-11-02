// No console window beside the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod menu;
mod state;
#[cfg(target_os = "macos")]
mod terminate;

use state::AppState;
use tauri::Manager;

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state_dir = app.path().app_local_data_dir()?;
            let state = AppState::new(&state_dir);
            let appearance = state.preferences.appearance();
            app.manage(state);
            menu::apply_appearance(app.handle(), appearance);
            app.set_menu(menu::build(app, appearance)?)?;
            #[cfg(target_os = "macos")]
            terminate::install(app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::recent_list,
            commands::recent_remove,
            commands::database_open,
            commands::database_create,
            commands::session_close,
            commands::session_overview,
            commands::collection_prepare,
            commands::collection_discard_virtual,
            commands::collection_query,
            commands::collection_explain,
            commands::collection_find_command,
            commands::collection_field_paths,
            commands::filter_to_text,
            commands::filter_to_rows,
            commands::query_statement,
            commands::groups_statement,
            commands::collection_groups,
            commands::collection_groups_explain,
            commands::collection_drop,
            commands::document_read,
            commands::document_format,
            commands::document_save,
            commands::document_delete,
            commands::index_create,
            commands::index_drop,
            commands::database_storage,
            commands::database_check,
            commands::database_export,
            commands::database_compact,
            commands::database_import,
            commands::app_set_unsaved_draft,
            commands::app_quit,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start TrunkDB Admin");

    app.run(|app, event| {
        // Quitting must not leave anything holding a database lock: wait
        // for running work and drop the handles before the process ends.
        if let tauri::RunEvent::Exit = event {
            app.state::<AppState>().sessions.close_all();
        }
    });
}
