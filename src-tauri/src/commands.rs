//! Tauri commands: translate IPC arguments and results, and move the work
//! off the UI thread. Behavior belongs to `trunkdb-admin-core`.

use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use trunkdb_admin_core::{
    AppError, AppResult, CheckReport, CompactReport, ConditionInput, DocumentView, ExplainReport,
    ExportSummary, FieldPaths, FieldPathsRequest, FilterRows, FormatUpgrade, GroupRequest,
    GroupResult, ImportSummary, IndexRequest, Overview, QueryRequest, QueryResult, RecentFile,
    RecentFiles, SaveRequest, SavedDocument, Session, SessionInfo, StorageReport, TrunkdbBuild,
};

/// Database and filesystem work blocks, so it never runs on the thread
/// that keeps the window responsive.
async fn blocking<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::internal(format!("The operation was interrupted: {error}")))?
}

#[derive(Serialize)]
pub struct AppInfo {
    app_version: &'static str,
    trunkdb: TrunkdbBuild,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        trunkdb: TrunkdbBuild::CURRENT,
    }
}

#[tauri::command]
pub async fn recent_list(state: State<'_, AppState>) -> AppResult<Vec<RecentFile>> {
    let recents = Arc::clone(&state.recents);
    blocking(move || Ok(recents.list())).await
}

#[tauri::command]
pub async fn recent_remove(state: State<'_, AppState>, path: String) -> AppResult<Vec<RecentFile>> {
    let recents = Arc::clone(&state.recents);
    blocking(move || recents.remove(&path)).await
}

/// What open and create answer: the session, and the recent list as it is
/// now, so the frontend need not ask again.
#[derive(Serialize)]
pub struct Opened {
    session: SessionInfo,
    recent: Vec<RecentFile>,
}

impl Opened {
    fn new(session: &Session, recents: &RecentFiles) -> AppResult<Self> {
        let info = session.info()?;
        // The database is open either way; a recent list that can't be
        // saved must not turn that into a failure.
        let recent = recents
            .add(session.path(), !session.can_mutate())
            .unwrap_or_else(|_| recents.list());
        Ok(Self {
            session: info,
            recent,
        })
    }
}

/// Opens an existing database. For editing, a file of an older format is
/// refused with `format_upgrade` unless `upgrade` allows raising it.
#[tauri::command]
pub async fn database_open(
    state: State<'_, AppState>,
    path: PathBuf,
    read_only: bool,
    upgrade: bool,
) -> AppResult<Opened> {
    let sessions = Arc::clone(&state.sessions);
    let recents = Arc::clone(&state.recents);
    blocking(move || {
        let session = if read_only {
            sessions.open_read_only(&path)?
        } else if upgrade {
            sessions.open_upgrading(&path)?
        } else {
            sessions.open_existing(&path)?
        };
        Opened::new(&session, &recents)
    })
    .await
}

/// What opening `path` for editing would change about its file format;
/// null when nothing. Writes nothing.
#[tauri::command]
pub async fn database_format_upgrade(
    state: State<'_, AppState>,
    path: PathBuf,
) -> AppResult<Option<FormatUpgrade>> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.format_upgrade(&path)).await
}

#[tauri::command]
pub async fn database_create(state: State<'_, AppState>, path: PathBuf) -> AppResult<Opened> {
    let sessions = Arc::clone(&state.sessions);
    let recents = Arc::clone(&state.recents);
    blocking(move || {
        let session = sessions.create_new(&path)?;
        Opened::new(&session, &recents)
    })
    .await
}

/// Returns once the session's file locks are released.
#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.close(&session_id)).await
}

#[tauri::command]
pub async fn session_overview(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Overview> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.overview()).await
}

#[tauri::command]
pub async fn collection_prepare(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> AppResult<Overview> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.prepare_collection(&name)).await
}

#[tauri::command]
pub async fn collection_discard_virtual(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> AppResult<Overview> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.discard_virtual_collection(&name)).await
}

#[tauri::command]
pub async fn collection_query(
    state: State<'_, AppState>,
    session_id: String,
    request: QueryRequest,
) -> AppResult<QueryResult> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.query(&request)).await
}

/// Every field path of a collection's documents, counted.
/// Reads every document, so the frontend asks once and keeps it.
#[tauri::command]
pub async fn collection_field_paths(
    state: State<'_, AppState>,
    session_id: String,
    request: FieldPathsRequest,
) -> AppResult<FieldPaths> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.field_paths(&request)).await
}

/// The list's query as a `trunkdb find` command.
#[tauri::command]
pub async fn collection_find_command(
    state: State<'_, AppState>,
    session_id: String,
    request: QueryRequest,
) -> AppResult<String> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.find_command(&request)).await
}

/// The list's count and page as Rust. Needs no session.
#[tauri::command]
pub fn query_statement(request: QueryRequest) -> AppResult<String> {
    trunkdb_admin_core::query_statement(&request)
}

/// The groups' aggregate as Rust. Needs no session.
#[tauri::command]
pub fn groups_statement(request: GroupRequest) -> AppResult<String> {
    trunkdb_admin_core::groups_statement(&request)
}

/// Filter rows as text. Needs no session: trunkdb prints it.
#[tauri::command]
pub fn filter_to_text(rows: Vec<ConditionInput>) -> AppResult<String> {
    trunkdb_admin_core::filter_to_text(&rows)
}

/// Filter text as rows, or why it can't be.
#[tauri::command]
pub fn filter_to_rows(text: String) -> FilterRows {
    trunkdb_admin_core::filter_to_rows(&text)
}

/// How trunkdb reads the page `request` asks for (trunkdb SPEC §94). Runs
/// the query once more, so only on demand.
#[tauri::command]
pub async fn collection_explain(
    state: State<'_, AppState>,
    session_id: String,
    request: QueryRequest,
) -> AppResult<ExplainReport> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.explain(&request)).await
}

/// One page of the documents counted by group (trunkdb SPEC §107).
#[tauri::command]
pub async fn collection_groups(
    state: State<'_, AppState>,
    session_id: String,
    request: GroupRequest,
) -> AppResult<GroupResult> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.groups(&request)).await
}

/// How trunkdb makes the groups `request` asks for. Runs them once more,
/// so only on demand.
#[tauri::command]
pub async fn collection_groups_explain(
    state: State<'_, AppState>,
    session_id: String,
    request: GroupRequest,
) -> AppResult<ExplainReport> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.explain_groups(&request)).await
}

#[tauri::command]
pub async fn document_read(
    state: State<'_, AppState>,
    session_id: String,
    collection: String,
    id: String,
) -> AppResult<DocumentView> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.read_document(&collection, &id)).await
}

/// Validates editor text and returns it as trunkdb formats it. Touches no
/// database, so it needs no session.
#[tauri::command]
pub async fn document_format(json: String) -> AppResult<String> {
    blocking(move || DocumentView::format_body(&json)).await
}

#[tauri::command]
pub async fn document_save(
    state: State<'_, AppState>,
    session_id: String,
    request: SaveRequest,
) -> AppResult<SavedDocument> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.save_document(&request)).await
}

#[tauri::command]
pub async fn document_delete(
    state: State<'_, AppState>,
    session_id: String,
    collection: String,
    id: String,
) -> AppResult<()> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.delete_document(&collection, &id)).await
}

#[tauri::command]
pub async fn collection_drop(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> AppResult<Overview> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.drop_collection(&name)).await
}

#[tauri::command]
pub async fn index_create(
    state: State<'_, AppState>,
    session_id: String,
    request: IndexRequest,
) -> AppResult<Overview> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.create_index(&request)).await
}

#[tauri::command]
pub async fn index_drop(
    state: State<'_, AppState>,
    session_id: String,
    collection: String,
    fields: Vec<String>,
) -> AppResult<Overview> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.drop_index(&collection, &fields)).await
}

/// Where the file's space goes. Reads every page in use, so the overview
/// asks for it separately, not with every refresh.
#[tauri::command]
pub async fn database_storage(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<StorageReport> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.storage()).await
}

/// Runs to completion or fails; never returns a partial report.
#[tauri::command]
pub async fn database_check(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<CheckReport> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.check()).await
}

/// Streams the export to `destination` in the backend; no document
/// passes through the frontend.
#[tauri::command]
pub async fn database_export(
    state: State<'_, AppState>,
    session_id: String,
    destination: PathBuf,
    overwrite: bool,
) -> AppResult<ExportSummary> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.export(&destination, overwrite)).await
}

/// Compacts the open database: a write, one at a time.
#[tauri::command]
pub async fn database_compact(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<CompactReport> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.get(&session_id)?.compact()).await
}

/// Imports an export into a new database; no session: it
/// makes a file. The new file joins the recent files when it is opened.
#[tauri::command]
pub async fn database_import(
    state: State<'_, AppState>,
    source: PathBuf,
    destination: PathBuf,
) -> AppResult<ImportSummary> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || sessions.import_into_new(&source, &destination)).await
}

/// Whether a modified document draft exists, for a quit from outside the
/// app. Synchronous, so the reports apply in the order they were sent.
#[tauri::command]
pub fn app_set_unsaved_draft(state: State<'_, AppState>, unsaved: bool) {
    state.set_unsaved_draft(unsaved);
}

/// Ends the app once the frontend has settled any unsaved draft. Waits
/// for running database work and releases every file's locks first.
#[tauri::command]
pub async fn app_quit(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let sessions = Arc::clone(&state.sessions);
    blocking(move || {
        sessions.close_all();
        Ok(())
    })
    .await?;
    app.exit(0);
    Ok(())
}
