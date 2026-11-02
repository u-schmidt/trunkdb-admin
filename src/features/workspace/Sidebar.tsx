import { useState, type FormEvent } from "react";
import type { AppError, CollectionSummary } from "../../ipc/types";

interface Props {
  /** null while the first overview is loading. */
  collections: CollectionSummary[] | null;
  selected: string | null;
  /** false: read-only, so no collection can be added. */
  canMutate: boolean;
  onSelect: (collection: string | null) => void;
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
  selected,
  canMutate,
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
      <button
        type="button"
        className="sidebar-item"
        aria-current={selected === null ? "page" : undefined}
        onClick={() => onSelect(null)}
      >
        Database
      </button>

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
                aria-current={selected === collection.name ? "page" : undefined}
                onClick={() => onSelect(collection.name)}
              >
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
