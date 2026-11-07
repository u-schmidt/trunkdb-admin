import { Database, Lock, LogOut, Pencil } from "lucide-react";
import appIcon from "../../../src-tauri/icons/app-icon.svg";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDraftGuard } from "../../app/DraftGuard";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorNotice } from "../../components/ErrorNotice";
import { shortenHome } from "../../components/shortenHome";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import type { AppError, AppInfo, CollectionSummary, Overview, SessionInfo } from "../../ipc/types";
import { useDatabaseTools } from "../tools/useDatabaseTools";
import { CollectionView } from "./CollectionView";
import { DatabaseOverview } from "./DatabaseOverview";
import { Sidebar } from "./Sidebar";

interface Props {
  session: SessionInfo;
  appInfo: AppInfo | null;
  closing: boolean;
  /** Reopening the file the other way is under way. */
  switching: boolean;
  onClose: () => void;
  /** Reopens the file for editing, or read-only. */
  onSwitchMode: () => void;
  /** Leaves this database for another, as from the recent files. */
  onOpenOther: (path: string) => void;
}

/**
 * The open database as an app window: a navy column with the file, its
 * collections and Close; the selected area beside it; a status bar below.
 */
export function Workspace({
  session,
  appInfo,
  closing,
  switching,
  onClose,
  onSwitchMode,
  onOpenOther,
}: Props) {
  const backend = useBackend();
  const guard = useDraftGuard();
  const sessionId = session.session_id;
  const canMutate = session.can_mutate;
  // Above the overview screen, so a report outlives a look at a collection.
  // After a compaction the overview's counts and pages are read again;
  // `refresh` is made below, so it is reached through a ref.
  const afterCompact = useRef<() => void>(() => undefined);
  const onCompacted = useCallback(() => afterCompact.current(), []);
  const tools = useDatabaseTools(sessionId, session.file_name, onCompacted);
  const [deleting, setDeleting] = useState<CollectionSummary | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The database page is shown over the selected collection, which stays
  // mounted beneath it: a look at the file facts or a run of the tools
  // costs neither the filter and page nor an open document draft.
  const [onDatabasePage, setOnDatabasePage] = useState(true);
  // Overviews arrive from refreshes and from collection changes; only the
  // answer to the newest request may be shown.
  const newest = useRef(0);

  const show = useCallback(async (request: Promise<Overview>): Promise<AppError | null> => {
    const mine = ++newest.current;
    try {
      const answer = await request;
      if (mine === newest.current) {
        setOverview(answer);
        setError(null);
      }
      return null;
    } catch (thrown) {
      return toAppError(thrown);
    }
  }, []);

  const refresh = useCallback(() => {
    void show(backend.sessionOverview(sessionId)).then((failed) => failed && setError(failed));
  }, [backend, sessionId, show]);
  useEffect(() => {
    afterCompact.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const mine = ++newest.current;
    backend.sessionOverview(sessionId).then(
      (answer) => {
        if (mine !== newest.current) return;
        setOverview(answer);
        setError(null);
      },
      (thrown: unknown) => mine === newest.current && setError(toAppError(thrown)),
    );
    return () => {
      newest.current = Number.MAX_SAFE_INTEGER;
    };
  }, [backend, sessionId]);

  /** Only another collection leaves the draft; the database page does not. */
  const select = (name: string | null) => {
    if (name === null) setOnDatabasePage(true);
    else if (name === selected) setOnDatabasePage(false);
    else {
      guard.requestLeave(() => {
        setSelected(name);
        setOnDatabasePage(false);
      });
    }
  };

  const prepare = async (name: string) => {
    const refused = await show(backend.collectionPrepare(sessionId, name));
    if (refused === null) select(name);
    return refused;
  };

  const discardVirtual = (name: string) => {
    const discard = () =>
      void show(backend.collectionDiscardVirtual(sessionId, name)).then((failed) => {
        if (failed !== null) setError(failed);
        else setSelected((current) => (current === name ? null : current));
      });
    // Only the collection on screen can hold the draft.
    if (name === selected) guard.requestLeave(discard);
    else discard();
  };

  const requestDelete = (collection: CollectionSummary) => {
    if (collection.persisted) guard.requestLeave(() => setDeleting(collection));
    else discardVirtual(collection.name);
  };

  const dropCollection = async (name: string) => {
    const failed = await show(backend.collectionDrop(sessionId, name));
    if (failed === null) setSelected((current) => (current === name ? null : current));
    return failed;
  };

  const collections = overview?.collections ?? null;
  const current = collections?.find((collection) => collection.name === selected) ?? null;

  return (
    <div className="workspace">
      <div className="shell-side">
        <div className="shell-brand">
          <img src={appIcon} alt="" />
          <span>
            TrunkDB <span className="shell-brand-part">Admin</span>
          </span>
        </div>

        <header className="workspace-header">
          <h1>
            <Database aria-hidden="true" />
            <span className="workspace-file">{session.file_name}</span>
            {!canMutate && <span className="badge workspace-mode">Read-only</span>}
          </h1>
          <p className="workspace-path" title={session.path}>
            {shortenHome(session.path)}
          </p>
          <button
            type="button"
            className="shell-quiet"
            onClick={onSwitchMode}
            disabled={closing || switching}
          >
            {canMutate ? <Lock aria-hidden="true" /> : <Pencil aria-hidden="true" />}
            {switching ? "Reopening…" : canMutate ? "Reopen read-only" : "Open for editing"}
          </button>
          {closing && tools.busy && (
            <span className="workspace-waiting" role="status">
              Waiting for the running tool to finish…
            </span>
          )}
        </header>

        <Sidebar
          collections={collections}
          selected={onDatabasePage ? null : (current?.name ?? null)}
          canMutate={canMutate}
          onSelect={select}
          onPrepare={prepare}
          onDiscardVirtual={discardVirtual}
        />

        <div className="shell-foot">
          <button type="button" onClick={onClose} disabled={closing || switching}>
            <LogOut aria-hidden="true" />
            {closing ? "Closing…" : "Close database"}
          </button>
        </div>
      </div>

      <main className="workspace-main">
        {error !== null && (
          <ErrorNotice error={error} onDismiss={() => setError(null)}>
            <button type="button" onClick={refresh}>
              Try again
            </button>
          </ErrorNotice>
        )}
        {(current === null || onDatabasePage) && (
          <DatabaseOverview
            sessionId={sessionId}
            path={session.path}
            file={overview?.file ?? session.file}
            appInfo={appInfo}
            collections={collections}
            canMutate={canMutate}
            onSelect={select}
            tools={tools}
            onOpenImported={onOpenOther}
          />
        )}
        {current !== null && (
          // Keyed: another collection starts with its own filter and page.
          <div className="workspace-layer" hidden={onDatabasePage}>
            <CollectionView
              key={current.name}
              sessionId={sessionId}
              collection={current}
              canMutate={canMutate}
              onRefreshOverview={refresh}
              onOverview={show}
              onDelete={() => requestDelete(current)}
            />
          </div>
        )}
      </main>

      <footer className="status-bar">
        <span className={canMutate ? "status-mode" : "status-mode read-only"}>
          {canMutate ? "Open for editing" : "Read-only"}
        </span>
        <span>File format {(overview?.file ?? session.file).format_version}</span>
        {appInfo !== null && <span>trunkdb {appInfo.trunkdb.version}</span>}
        {collections !== null && (
          <span className="status-end">
            {collections.length === 1 ? "1 collection" : `${collections.length} collections`}
          </span>
        )}
      </footer>

      {deleting !== null && (
        <ConfirmDialog
          title="Delete collection?"
          confirmLabel="Delete collection"
          onConfirm={() => dropCollection(deleting.name)}
          onClose={() => setDeleting(null)}
        >
          <p>
            The collection “{deleting.name}” will be removed with{" "}
            {deleting.count === null
              ? "all its documents"
              : `its ${deleting.count.toLocaleString("en")} ${deleting.count === 1 ? "document" : "documents"}`}{" "}
            and all its indexes. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
