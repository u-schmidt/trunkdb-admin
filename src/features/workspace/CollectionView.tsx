import { Braces, KeyRound, List, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AppError, CollectionSummary, Overview } from "../../ipc/types";
import { DocumentsPanel } from "../documents/DocumentsPanel";
import { FieldPathsProvider, useFieldPaths } from "../fields/FieldPathsContext";
import { FieldsPanel } from "../fields/FieldsPanel";
import { IndexPanel } from "../indexes/IndexPanel";

type Section = "documents" | "indexes" | "fields";

interface Props {
  sessionId: string;
  collection: CollectionSummary;
  /** false: read-only, so nothing here changes the database. */
  canMutate: boolean;
  onRefreshOverview: () => void;
  onOverview: (request: Promise<Overview>) => Promise<AppError | null>;
  /** Asks to delete this collection; confirmation follows elsewhere. */
  onDelete: () => void;
}

export function CollectionView({
  sessionId,
  collection,
  canMutate,
  onRefreshOverview,
  onOverview,
  onDelete,
}: Props) {
  const [section, setSection] = useState<Section>("documents");
  return (
    // Field paths are read once for every path input of the collection;
    // a new collection is a new view, so they start afresh.
    <FieldPathsProvider
      sessionId={sessionId}
      collection={collection.name}
      stored={collection.persisted}
    >
      <section className="collection" aria-labelledby="collection-heading">
        <header className="collection-header" data-tauri-drag-region>
          <div className="collection-title" data-tauri-drag-region>
            <h2 id="collection-heading" className="collection-name">
              {collection.name}
            </h2>
            {!collection.persisted && <span className="badge badge-warning">Not saved</span>}
            <ReadingNote />
            {canMutate && (
              <button type="button" className="danger-quiet" onClick={onDelete}>
                <Trash2 aria-hidden="true" />
                {collection.persisted ? "Delete collection…" : "Remove"}
              </button>
            )}
          </div>
          <div role="group" aria-label="Collection section" className="tabs">
            <button
              type="button"
              aria-pressed={section === "documents"}
              onClick={() => setSection("documents")}
            >
              <List aria-hidden="true" />
              Documents
            </button>
            <button
              type="button"
              aria-pressed={section === "indexes"}
              onClick={() => setSection("indexes")}
            >
              <KeyRound aria-hidden="true" />
              Indexes
            </button>
            <button
              type="button"
              aria-pressed={section === "fields"}
              onClick={() => setSection("fields")}
            >
              <Braces aria-hidden="true" />
              Fields
            </button>
          </div>
        </header>
        {/* Hidden rather than unmounted: filter, page and an open document
          draft survive a look at the indexes. */}
        <div className="collection-body" hidden={section !== "documents"}>
          <DocumentsPanel
            sessionId={sessionId}
            collection={collection}
            canMutate={canMutate}
            onRefreshOverview={onRefreshOverview}
          />
        </div>
        {section === "fields" && (
          <div className="collection-body">
            <FieldsPanel />
          </div>
        )}
        {section === "indexes" && (
          <div className="collection-body">
            <IndexPanel
              sessionId={sessionId}
              collection={collection}
              canMutate={canMutate}
              onOverview={onOverview}
            />
          </div>
        )}
      </section>
    </FieldPathsProvider>
  );
}

/**
 * While every document is read for the field paths. Always there, taking
 * the free room after the name, so the buttons beside it never move.
 */
function ReadingNote() {
  const { state } = useFieldPaths();
  return (
    <span className="collection-status muted">
      {state.status === "loading" && <span role="status">Reading field paths…</span>}
    </span>
  );
}
