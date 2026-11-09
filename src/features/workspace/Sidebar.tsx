import { HardDrive, LayoutDashboard, Plus, Table2, Wrench } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { AppError, CollectionSummary } from "../../ipc/types";
import type { DatabasePageName } from "./DatabasePage";

const PAGES: { page: DatabasePageName; label: string; icon: typeof Table2 }[] = [
  { page: "overview", label: "Overview", icon: LayoutDashboard },
  { page: "storage", label: "Storage", icon: HardDrive },
  { page: "tools", label: "Tools", icon: Wrench },
];

interface Props {
  /** null while the first overview is loading. */
  collections: CollectionSummary[] | null;
  /** The database page shown; null: a collection is. */
  page: DatabasePageName | null;
  selected: string | null;
  /** false: read-only, so no collection can be added. */
  canMutate: boolean;
  onPage: (page: DatabasePageName) => void;
  onSelect: (collection: string) => void;
  /** Resolves with the reason when the name is refused. */
  onPrepare: (name: string) => Promise<AppError | null>;
  onDiscardVirtual: (name: string) => void;
}

function Count({ collection }: { collection: CollectionSummary }) {
  if (!collection.persisted) return <span className="badge badge-warning">Not saved</span>;
  if (collection.count === null) {
    return (
      <span className="sidebar-count" title={collection.count_error ?? undefined}>
        count unavailable
      </span>
    );
  }
  return <span className="sidebar-count">{collection.count.toLocaleString("en")}</span>;
}

export function Sidebar({
  collections,
  page,
  selected,
  canMutate,
  onPage,
  onSelect,
  onPrepare,
  onDiscardVirtual,
}: Props) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (adding) return;
    setAdding(true);
    const refused = await onPrepare(name);
    setAdding(false);
    if (refused === null) {
      setName("");
      setProblem(null);
    } else {
      // The entered name stays, to be corrected.
      setProblem(refused.message);
    }
  };

  return (
    <nav className="sidebar" aria-label="Database">
      <h2 className="sidebar-heading">Database</h2>
      <ul className="sidebar-list">
        {PAGES.map(({ page: name, label, icon: Icon }) => (
          <li key={name} className="sidebar-row">
            <button
              type="button"
              className="sidebar-item"
              aria-current={page === name ? "page" : undefined}
              onClick={() => onPage(name)}
            >
              <Icon aria-hidden="true" />
              <span className="sidebar-name">{label}</span>
            </button>
          </li>
        ))}
      </ul>

      <h2 className="sidebar-heading">Collections</h2>
      {collections === null ? (
        <p className="sidebar-note muted">Loading…</p>
      ) : collections.length === 0 ? (
        <p className="sidebar-note muted">No collections yet.</p>
      ) : (
        <ul className="sidebar-list">
          {collections.map((collection) => (
            <li key={collection.name} className="sidebar-row">
              <button
                type="button"
                className="sidebar-item"
                aria-current={page === null && selected === collection.name ? "page" : undefined}
                onClick={() => onSelect(collection.name)}
              >
                <Table2 aria-hidden="true" />
                <span className="sidebar-name">{collection.name}</span>
                <Count collection={collection} />
              </button>
              {!collection.persisted && (
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Remove unsaved collection ${collection.name}`}
                  onClick={() => onDiscardVirtual(collection.name)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canMutate && (
        <form className="sidebar-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="new-collection">New collection</label>
          <div className="sidebar-form-row">
            <input
              id="new-collection"
              type="text"
              value={name}
              placeholder="name"
              onChange={(event) => setName(event.target.value)}
              aria-invalid={problem !== null}
              aria-describedby={problem !== null ? "new-collection-problem" : undefined}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button type="submit" disabled={adding || collections === null}>
              <Plus aria-hidden="true" />
              Add
            </button>
          </div>
          {problem !== null && (
            <p id="new-collection-problem" className="field-problem" role="alert">
              {problem}
            </p>
          )}
          <p className="muted sidebar-hint">Saved with its first document or index.</p>
        </form>
      )}
    </nav>
  );
}
