import { FilePlus, FolderOpen, Import, Lock } from "lucide-react";
import appIcon from "../../../src-tauri/icons/app-icon.svg";
import { shortenHome } from "../../components/shortenHome";
import type { AppInfo, RecentFile } from "../../ipc/types";

interface Props {
  appInfo: AppInfo | null;
  recent: RecentFile[];
  busy: boolean;
  onOpen: () => void;
  /** Opens without writing to the file or its WAL. */
  onOpenReadOnly: () => void;
  onCreate: () => void;
  /** Imports an export into a new database and opens it. */
  onImport: () => void;
  /** Opens the way the entry was last opened. */
  onOpenRecent: (entry: RecentFile) => void;
  onRemoveRecent: (path: string) => void;
}

/** Shown while no database is open: nothing here acts on a database. */
export function StartScreen({
  appInfo,
  recent,
  busy,
  onOpen,
  onOpenReadOnly,
  onCreate,
  onImport,
  onOpenRecent,
  onRemoveRecent,
}: Props) {
  return (
    <main className="start" data-tauri-drag-region>
      <header className="start-header">
        <img src={appIcon} alt="" />
        <div>
          <h1>
            TrunkDB <span className="brand-part">Admin</span>
          </h1>
          <p className="muted">Inspect and manage local trunkdb databases.</p>
        </div>
      </header>

      <div className="start-actions">
        <button type="button" className="primary" onClick={onOpen} disabled={busy}>
          <FolderOpen aria-hidden="true" />
          Open database…
        </button>
        <button type="button" onClick={onOpenReadOnly} disabled={busy}>
          <Lock aria-hidden="true" />
          Open read-only…
        </button>
        <button type="button" onClick={onCreate} disabled={busy}>
          <FilePlus aria-hidden="true" />
          Create database…
        </button>
        <button type="button" onClick={onImport} disabled={busy}>
          <Import aria-hidden="true" />
          Import…
        </button>
      </div>

      <section aria-labelledby="recent-heading" className="recent">
        <h2 id="recent-heading">Recent databases</h2>
        {recent.length === 0 ? (
          <p className="muted">No database has been opened yet.</p>
        ) : (
          <ul className="recent-list">
            {recent.map((entry) => (
              <li key={entry.path} className="recent-item">
                <button
                  type="button"
                  className="recent-open"
                  onClick={() => onOpenRecent(entry)}
                  disabled={busy}
                  aria-label={`Open ${shortenHome(entry.path)}${entry.read_only ? " read-only" : ""}`}
                >
                  <span className="recent-name">{entry.file_name}</span>
                  <span className="recent-path">{shortenHome(entry.path)}</span>
                </button>
                {entry.read_only && <span className="badge">Read-only</span>}
                {!entry.exists && <span className="badge badge-warning">File not found</span>}
                <button
                  type="button"
                  className="quiet"
                  onClick={() => onRemoveRecent(entry.path)}
                  disabled={busy}
                  aria-label={`Remove ${shortenHome(entry.path)} from recent databases`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {appInfo !== null && (
        <footer className="start-footer muted">
          TrunkDB Admin {appInfo.app_version} · trunkdb {appInfo.trunkdb.version} (
          {appInfo.trunkdb.revision.slice(0, 7)})
        </footer>
      )}
    </main>
  );
}
