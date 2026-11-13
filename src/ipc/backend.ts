import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppError,
  AppInfo,
  CheckReport,
  CompactReport,
  ConditionInput,
  DocumentView,
  ExplainReport,
  ExportSummary,
  FieldPaths,
  FieldPathsRequest,
  FilterRows,
  GroupRequest,
  GroupResult,
  ImportSummary,
  IndexRequest,
  Opened,
  Overview,
  QueryRequest,
  QueryResult,
  RecentFile,
  SavedDocument,
  SaveRequest,
  StorageReport,
  TextPosition,
} from "./types";

/**
 * Everything the UI may ask of the shell. Components depend on this
 * interface, so tests run against a fake and nothing else reaches Tauri.
 */
export interface Backend {
  appInfo(): Promise<AppInfo>;
  recentList(): Promise<RecentFile[]>;
  recentRemove(path: string): Promise<RecentFile[]>;
  /** Native dialog; null when the user cancels. */
  pickDatabaseToOpen(): Promise<string | null>;
  /** Native dialog; null when the user cancels. */
  pickDatabaseToCreate(): Promise<string | null>;
  /** `readOnly` writes nothing to the file or its WAL. */
  databaseOpen(path: string, readOnly: boolean): Promise<Opened>;
  databaseCreate(path: string): Promise<Opened>;
  /** Resolves once the file locks are released. */
  sessionClose(sessionId: string): Promise<void>;
  sessionOverview(sessionId: string): Promise<Overview>;
  collectionPrepare(sessionId: string, name: string): Promise<Overview>;
  collectionDiscardVirtual(sessionId: string, name: string): Promise<Overview>;
  collectionQuery(sessionId: string, request: QueryRequest): Promise<QueryResult>;
  /** Every field path of a collection's documents, counted; reads them all. */
  collectionFieldPaths(sessionId: string, request: FieldPathsRequest): Promise<FieldPaths>;
  /** The list's query as a `trunkdb find` command. */
  collectionFindCommand(sessionId: string, request: QueryRequest): Promise<string>;
  /** The list's count and page as the Rust calls that make them. */
  queryStatement(request: QueryRequest): Promise<string>;
  /** The groups' aggregate as the Rust calls that make it. */
  groupsStatement(request: GroupRequest): Promise<string>;
  /** Rows as filter text, printed by trunkdb. */
  filterToText(rows: ConditionInput[]): Promise<string>;
  /** Filter text as rows, or why it can't be. */
  filterToRows(text: string): Promise<FilterRows>;
  /** Runs the page `request` asks for once more, to say how it is read. */
  collectionExplain(sessionId: string, request: QueryRequest): Promise<ExplainReport>;
  /** One page of the documents counted by group (trunkdb SPEC §107). */
  collectionGroups(sessionId: string, request: GroupRequest): Promise<GroupResult>;
  /** Makes the groups `request` asks for once more, to say how they are made. */
  collectionGroupsExplain(sessionId: string, request: GroupRequest): Promise<ExplainReport>;
  collectionDrop(sessionId: string, name: string): Promise<Overview>;
  documentRead(sessionId: string, collection: string, id: string): Promise<DocumentView>;
  /** Validates editor text and returns it formatted; writes nothing. */
  documentFormat(json: string): Promise<string>;
  documentSave(sessionId: string, request: SaveRequest): Promise<SavedDocument>;
  documentDelete(sessionId: string, collection: string, id: string): Promise<void>;
  indexCreate(sessionId: string, request: IndexRequest): Promise<Overview>;
  indexDrop(sessionId: string, collection: string, fields: string[]): Promise<Overview>;
  /** Reads every page in use: asked for separately, not with each overview. */
  databaseStorage(sessionId: string): Promise<StorageReport>;
  /** Rejects unless the check ran to its end. */
  databaseCheck(sessionId: string): Promise<CheckReport>;
  /**
   * Native save dialog for the export; null when the user cancels. It asks
   * before an existing file is chosen, which is the confirmation to replace.
   */
  pickExportDestination(suggestedName: string): Promise<string | null>;
  /** Rejects with `already_exists` unless `overwrite` allows replacing. */
  databaseExport(
    sessionId: string,
    destination: string,
    overwrite: boolean,
  ): Promise<ExportSummary>;
  /** Rebuilds the file into as few pages as it needs. */
  databaseCompact(sessionId: string): Promise<CompactReport>;
  /** Native open dialog for an export to import; null when cancelled. */
  pickExportToImport(): Promise<string | null>;
  /** Native save dialog for the new database an import makes; null when cancelled. */
  pickImportDestination(suggestedName: string): Promise<string | null>;
  /**
   * Imports the export at `source` into a new database at `destination`,
   * which must not exist. Opens nothing.
   */
  databaseImport(source: string, destination: string): Promise<ImportSummary>;
  /**
   * Calls `handler` when the user asks to quit or to close the window.
   * Nothing quits by itself: the handler decides and then calls `quit`.
   * Returns the function that stops listening.
   */
  onQuitRequested(handler: () => void): () => void;
  /**
   * Tells the shell whether a modified document draft exists. A quit from
   * outside the app (Dock, AppleScript, logout) asks via `onQuitRequested`
   * only while one does; otherwise it ends the app at once.
   */
  setUnsavedDraft(unsaved: boolean): Promise<void>;
  /** Releases every database and ends the app. */
  quit(): Promise<void>;
}

const DATABASE_FILTERS = [
  { name: "trunkdb database", extensions: ["trunkdb", "db"] },
  { name: "All files", extensions: ["*"] },
];

export const tauriBackend: Backend = {
  appInfo: () => invoke("app_info"),
  recentList: () => invoke("recent_list"),
  recentRemove: (path) => invoke("recent_remove", { path }),
  pickDatabaseToOpen: () =>
    open({ title: "Open database", multiple: false, directory: false, filters: DATABASE_FILTERS }),
  pickDatabaseToCreate: () =>
    save({
      title: "Create database",
      defaultPath: "untitled.trunkdb",
      filters: DATABASE_FILTERS.slice(0, 1),
    }),
  databaseOpen: (path, readOnly) => invoke("database_open", { path, readOnly }),
  databaseCreate: (path) => invoke("database_create", { path }),
  sessionClose: (sessionId) => invoke("session_close", { sessionId }),
  sessionOverview: (sessionId) => invoke("session_overview", { sessionId }),
  collectionPrepare: (sessionId, name) => invoke("collection_prepare", { sessionId, name }),
  collectionDiscardVirtual: (sessionId, name) =>
    invoke("collection_discard_virtual", { sessionId, name }),
  collectionQuery: (sessionId, request) => invoke("collection_query", { sessionId, request }),
  collectionExplain: (sessionId, request) => invoke("collection_explain", { sessionId, request }),
  collectionFieldPaths: (sessionId, request) =>
    invoke("collection_field_paths", { sessionId, request }),
  collectionFindCommand: (sessionId, request) =>
    invoke("collection_find_command", { sessionId, request }),
  queryStatement: (request) => invoke("query_statement", { request }),
  groupsStatement: (request) => invoke("groups_statement", { request }),
  filterToText: (rows) => invoke("filter_to_text", { rows }),
  filterToRows: (text) => invoke("filter_to_rows", { text }),
  collectionGroups: (sessionId, request) => invoke("collection_groups", { sessionId, request }),
  collectionGroupsExplain: (sessionId, request) =>
    invoke("collection_groups_explain", { sessionId, request }),
  collectionDrop: (sessionId, name) => invoke("collection_drop", { sessionId, name }),
  documentRead: (sessionId, collection, id) =>
    invoke("document_read", { sessionId, collection, id }),
  documentFormat: (json) => invoke("document_format", { json }),
  documentSave: (sessionId, request) => invoke("document_save", { sessionId, request }),
  documentDelete: (sessionId, collection, id) =>
    invoke("document_delete", { sessionId, collection, id }),
  indexCreate: (sessionId, request) => invoke("index_create", { sessionId, request }),
  indexDrop: (sessionId, collection, fields) =>
    invoke("index_drop", { sessionId, collection, fields }),
  databaseStorage: (sessionId) => invoke("database_storage", { sessionId }),
  databaseCheck: (sessionId) => invoke("database_check", { sessionId }),
  pickExportDestination: (suggestedName) =>
    save({
      title: "Export database",
      defaultPath: suggestedName,
      filters: [{ name: "TrunkDB tagged JSON Lines", extensions: ["jsonl"] }],
    }),
  databaseExport: (sessionId, destination, overwrite) =>
    invoke("database_export", { sessionId, destination, overwrite }),
  databaseCompact: (sessionId) => invoke("database_compact", { sessionId }),
  pickExportToImport: () =>
    open({
      title: "Import an export",
      multiple: false,
      directory: false,
      filters: [
        { name: "TrunkDB tagged JSON Lines", extensions: ["jsonl"] },
        { name: "All files", extensions: ["*"] },
      ],
    }),
  pickImportDestination: (suggestedName) =>
    save({
      title: "New database from the export",
      defaultPath: suggestedName,
      filters: DATABASE_FILTERS.slice(0, 1),
    }),
  databaseImport: (source, destination) => invoke("database_import", { source, destination }),
  onQuitRequested: (handler) => {
    // Cmd+Q and the Quit menu item arrive as an event from the shell; the
    // window's close button as a close request, which is held back here.
    const stopMenu = listen("quit-requested", handler);
    const stopClose = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      handler();
    });
    return () => {
      void stopMenu.then((stop) => stop());
      void stopClose.then((stop) => stop());
    };
  },
  setUnsavedDraft: (unsaved) => invoke("app_set_unsaved_draft", { unsaved }),
  quit: () => invoke("app_quit"),
};

/**
 * Commands reject with the backend's AppError. Anything else (a transport
 * failure, a bug) becomes an internal error rather than an unreadable one.
 */
export function toAppError(thrown: unknown): AppError {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "category" in thrown &&
    "message" in thrown &&
    typeof thrown.category === "string" &&
    typeof thrown.message === "string"
  ) {
    const detail = "detail" in thrown && typeof thrown.detail === "string" ? thrown.detail : null;
    const at = "at" in thrown ? textPosition(thrown.at) : null;
    return {
      category: thrown.category as AppError["category"],
      message: thrown.message,
      detail,
      at,
    };
  }
  return {
    category: "internal",
    message: "The app could not complete the request.",
    detail: thrown instanceof Error ? thrown.message : String(thrown),
  };
}

/** A filter text's place, when `value` is one. */
function textPosition(value: unknown): TextPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const { line, column, index } = value as Record<string, unknown>;
  return typeof line === "number" && typeof column === "number" && typeof index === "number"
    ? { line, column, index }
    : null;
}
