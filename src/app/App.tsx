import { useCallback, useEffect, useRef, useState } from "react";
import { DraftGuardProvider, useDraftGuard } from "./DraftGuard";
import { ErrorNotice } from "../components/ErrorNotice";
import { StartScreen } from "../features/start/StartScreen";
import { Workspace } from "../features/workspace/Workspace";
import { toAppError } from "../ipc/backend";
import { useBackend } from "../ipc/BackendContext";
import { importedName } from "../features/tools/useDatabaseTools";
import type {
  AppError,
  AppInfo,
  ImportSummary,
  Opened,
  RecentFile,
  SessionInfo,
} from "../ipc/types";

type Pending = "opening" | "closing" | null;

interface Failure {
  error: AppError;
  /** The file the failed action was about, if any. */
  path?: string | undefined;
  /** It was an open for editing, so Open read-only may still work. */
  editing?: boolean | undefined;
}

/** A failed open or create, with the file it was about. */
class PathFailure {
  constructor(
    readonly error: AppError,
    readonly path: string,
    readonly editing: boolean,
  ) {}
}

export function App() {
  return (
    <DraftGuardProvider>
      <AppContent />
    </DraftGuardProvider>
  );
}

function AppContent() {
  const backend = useBackend();
  const guard = useDraftGuard();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // The import the open database came from, said once above it.
  const [imported, setImported] = useState<ImportSummary | null>(null);
  // State updates are asynchronous; this is what actually keeps a second
  // click from starting a second open, create or close.
  const inFlight = useRef(false);

  useEffect(() => {
    let current = true;
    backend
      .appInfo()
      .then((info) => current && setAppInfo(info))
      .catch((thrown: unknown) => current && setFailure({ error: toAppError(thrown) }));
    backend
      .recentList()
      .then((list) => current && setRecent(list))
      .catch((thrown: unknown) => current && setFailure({ error: toAppError(thrown) }));
    return () => {
      current = false;
    };
  }, [backend]);

  // Quit and the window's close button ask here first, so a modified
  // draft gets its Save / Discard / Cancel before anything ends.
  useEffect(
    () => backend.onQuitRequested(() => guard.requestLeave(() => void backend.quit())),
    [backend, guard],
  );

  /** Runs one open/create/close at a time; reports its failure. */
  const exclusively = useCallback(
    async (kind: Exclude<Pending, null>, action: () => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(kind);
      setFailure(null);
      try {
        await action();
      } catch (thrown) {
        setFailure(
          thrown instanceof PathFailure
            ? { error: thrown.error, path: thrown.path, editing: thrown.editing }
            : { error: toAppError(thrown) },
        );
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [],
  );

  /** Opens or creates `path` and shows the workspace for it. */
  const enter = async (path: string, request: Promise<Opened>, editing: boolean) => {
    let opened: Opened;
    try {
      opened = await request;
    } catch (thrown) {
      throw new PathFailure(toAppError(thrown), path, editing);
    }
    setSession(opened.session);
    setRecent(opened.recent);
  };

  const open = (path: string, readOnly: boolean) =>
    enter(path, backend.databaseOpen(path, readOnly), !readOnly);

  const openPath = (path: string, readOnly: boolean) =>
    exclusively("opening", () => open(path, readOnly));

  const openWithDialog = (readOnly: boolean) =>
    exclusively("opening", async () => {
      const path = await backend.pickDatabaseToOpen();
      if (path !== null) await open(path, readOnly);
    });

  const createWithDialog = () =>
    exclusively("opening", async () => {
      const path = await backend.pickDatabaseToCreate();
      if (path !== null) await enter(path, backend.databaseCreate(path), true);
    });

  const removeRecent = (path: string) => {
    backend
      .recentRemove(path)
      .then((list) => {
        setRecent(list);
        setFailure((current) => (current?.path === path ? null : current));
      })
      .catch((thrown: unknown) => setFailure({ error: toAppError(thrown) }));
  };

  const closeSession = () => guard.requestLeave(closeNow);

  /**
   * Closes the session and opens its file the other way. A
   * failed open ends on the start screen, with the reason.
   */
  const switchMode = () => {
    if (session !== null) leaveFor(session.path, session.can_mutate);
  };

  /**
   * Closes the session, after the draft guard, and opens `path`: the same
   * file the other way, or a new one an import made. A
   * failed open ends on the start screen, with the reason.
   */
  const leaveFor = (path: string, readOnly: boolean) =>
    guard.requestLeave(() => {
      if (session === null) return;
      const leaving = session;
      void exclusively("opening", async () => {
        try {
          await backend.sessionClose(leaving.session_id);
        } catch (thrown) {
          if (toAppError(thrown).category !== "session_closed") throw thrown;
        }
        setSession(null);
        setRecent(await backend.recentList());
        await open(path, readOnly);
      });
    });

  /**
   * Imports an export into a new database and opens it: from
   * the start screen there is nothing to leave.
   */
  const importWithDialogs = () =>
    exclusively("opening", async () => {
      const source = await backend.pickExportToImport();
      if (source === null) return;
      const destination = await backend.pickImportDestination(importedName(source));
      if (destination === null) return;
      let summary: ImportSummary;
      try {
        summary = await backend.databaseImport(source, destination);
      } catch (thrown) {
        throw new PathFailure(toAppError(thrown), source, false);
      }
      setImported(summary);
      await open(summary.path, false);
    });

  const closeNow = () => {
    if (session === null) return;
    const closing = session;
    void exclusively("closing", async () => {
      try {
        await backend.sessionClose(closing.session_id);
      } catch (thrown) {
        // Already closed on the backend is still closed.
        if (toAppError(thrown).category !== "session_closed") throw thrown;
      }
      setSession(null);
      // "File not found" flags may have changed while it was open.
      setRecent(await backend.recentList());
    });
  };

  const notice = failure !== null && (
    <ErrorNotice error={failure.error} subject={failure.path} onDismiss={() => setFailure(null)}>
      {failure.error.category === "permission_denied" &&
        failure.editing === true &&
        failure.path !== undefined &&
        session === null && (
          <button type="button" onClick={() => void openPath(failure.path as string, true)}>
            Open read-only
          </button>
        )}
      {failure.error.category === "file_not_found" &&
        failure.path !== undefined &&
        recent.some((entry) => entry.path === failure.path) && (
          <button type="button" onClick={() => removeRecent(failure.path as string)}>
            Remove from recent
          </button>
        )}
    </ErrorNotice>
  );

  if (session === null) {
    return (
      <div className="app">
        {notice}
        <StartScreen
          appInfo={appInfo}
          recent={recent}
          busy={pending !== null}
          onOpen={() => void openWithDialog(false)}
          onOpenReadOnly={() => void openWithDialog(true)}
          onCreate={() => void createWithDialog()}
          onImport={() => void importWithDialogs()}
          onOpenRecent={(entry) => void openPath(entry.path, entry.read_only)}
          onRemoveRecent={removeRecent}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {notice}
      {imported !== null && imported.path === session.path && (
        <div className="notice notice-info" role="status">
          <p className="notice-message">
            <span className="notice-label">Imported</span>{" "}
            {imported.collections.toLocaleString("en")}{" "}
            {imported.collections === 1 ? "collection" : "collections"} and{" "}
            {imported.documents.toLocaleString("en")}{" "}
            {imported.documents === 1 ? "document" : "documents"} into this new database.
          </p>
          <button type="button" className="quiet" onClick={() => setImported(null)}>
            Dismiss
          </button>
        </div>
      )}
      <Workspace
        key={session.session_id}
        session={session}
        appInfo={appInfo}
        closing={pending === "closing"}
        switching={pending === "opening"}
        onClose={closeSession}
        onSwitchMode={switchMode}
        onOpenOther={(path) => leaveFor(path, false)}
      />
    </div>
  );
}
