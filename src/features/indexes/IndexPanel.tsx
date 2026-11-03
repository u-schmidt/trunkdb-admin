import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useBackend } from "../../ipc/BackendContext";
import type { AppError, CollectionSummary, IndexSummary, Overview } from "../../ipc/types";
import { useFieldPaths } from "../fields/FieldPathsContext";

interface Props {
  sessionId: string;
  collection: CollectionSummary;
  /** false: read-only, so indexes are listed only. */
  canMutate: boolean;
  /** Shows the overview a change returns; resolves with its failure. */
  onOverview: (request: Promise<Overview>) => Promise<AppError | null>;
}

interface FieldRow {
  key: number;
  path: string;
}

const indexName = (fields: string[]) =>
  fields.length === 1 ? (fields[0] ?? "") : `(${fields.join(", ")})`;

const options = (index: IndexSummary) =>
  [index.unique && "unique", index.sparse && "sparse"].filter(Boolean).join(", ") || "none";

/** A collection's indexes: the fixed primary one, and the secondary ones to manage. */
export function IndexPanel({ sessionId, collection, canMutate, onOverview }: Props) {
  // Suggestions from the collection's documents.
  const paths = useFieldPaths();
  const backend = useBackend();
  const [rows, setRows] = useState<FieldRow[]>([{ key: 0, path: "" }]);
  const nextKey = useRef(1);
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<AppError | null>(null);
  const [dropping, setDropping] = useState<IndexSummary | null>(null);
  const inFlight = useRef(false);

  const move = (index: number, by: number) =>
    setRows((current) => {
      const target = index + by;
      const moved = current[index];
      const other = current[target];
      if (moved === undefined || other === undefined) return current;
      const next = [...current];
      next[index] = other;
      next[target] = moved;
      return next;
    });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    const failed = await onOverview(
      backend.indexCreate(sessionId, {
        collection: collection.name,
        fields: rows.map((row) => row.path),
        unique,
        sparse,
      }),
    );
    inFlight.current = false;
    setCreating(false);
    setProblem(failed);
    // On failure the form stays as entered, to be corrected.
    if (failed === null) {
      setRows([{ key: nextKey.current++, path: "" }]);
      setUnique(false);
      setSparse(false);
    }
  };

  return (
    <div className="indexes">
      {collection.persisted ? (
        <div className="table-scroll">
          <table className="plain-table" aria-label="Indexes">
            <thead>
              <tr>
                <th scope="col">Fields (in order)</th>
                <th scope="col">Kind</th>
                <th scope="col">Options</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>_id</code>
                </td>
                <td>Primary · automatic, cannot be changed</td>
                <td>unique</td>
                <td />
              </tr>
              {collection.indexes.map((index) => (
                <tr key={index.fields.join("\u0000")}>
                  <td>
                    <code>{index.fields.join(", ")}</code>
                  </td>
                  <td>{index.fields.length > 1 ? "Secondary · compound" : "Secondary"}</td>
                  <td>{options(index)}</td>
                  <td className="numeric">
                    {canMutate && (
                      <button
                        type="button"
                        className="danger-quiet"
                        aria-label={`Drop index ${indexName(index.fields)}`}
                        onClick={() => setDropping(index)}
                      >
                        Drop…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">
          This collection is not saved yet, so it has no indexes, not even the automatic one on _id.
          Creating an index saves it.
        </p>
      )}

      {canMutate && (
        <form
          className="panel index-form"
          aria-label="Create index"
          onSubmit={(event) => void create(event)}
        >
          <h3>Create index</h3>
          <ol className="index-fields">
            {rows.map((row, index) => (
              <li key={row.key} className="index-field">
                <span className="muted">{index + 1}</span>
                <input
                  type="text"
                  aria-label={`Index field ${index + 1}`}
                  placeholder="field, nested.path or tags[*]"
                  value={row.path}
                  list={paths.listAll}
                  onFocus={paths.ensure}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((r) =>
                        r.key === row.key ? { ...r, path: event.target.value } : r,
                      ),
                    )
                  }
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <button
                  type="button"
                  className="icon"
                  aria-label={`Move field ${index + 1} up`}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Move field ${index + 1} down`}
                  onClick={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                >
                  <ArrowDown aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Remove field ${index + 1}`}
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                  disabled={rows.length === 1}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
          <div className="index-options">
            <button
              type="button"
              onClick={() =>
                setRows((current) => [...current, { key: nextKey.current++, path: "" }])
              }
            >
              <Plus aria-hidden="true" />
              Add field
            </button>
            <label>
              <input
                type="checkbox"
                checked={unique}
                onChange={(event) => setUnique(event.target.checked)}
              />
              Unique
            </label>
            <label>
              <input
                type="checkbox"
                checked={sparse}
                onChange={(event) => setSparse(event.target.checked)}
              />
              Sparse
            </label>
          </div>
          <p className="muted">
            To index the elements of an array, end the path with [*], as in tags[*]. An index on the
            array field itself has no entries for documents where it holds an array.
          </p>
          {rows.length > 1 && (
            <p className="muted">
              A compound index: the order of the fields matters, and none may be an array path.
            </p>
          )}
          {problem !== null && (
            <p className="field-problem" role="alert">
              {problem.message}
              {problem.detail !== null && ` (${problem.detail})`}
            </p>
          )}
          <div>
            <button type="submit" className="primary" disabled={creating}>
              <Plus aria-hidden="true" />
              {creating ? "Creating…" : "Create index"}
            </button>
          </div>
        </form>
      )}

      {dropping !== null && (
        <ConfirmDialog
          title="Drop index?"
          confirmLabel="Drop index"
          onConfirm={() =>
            onOverview(backend.indexDrop(sessionId, collection.name, dropping.fields))
          }
          onClose={() => setDropping(null)}
        >
          <p>
            The index on <code>{indexName(dropping.fields)}</code> ({options(dropping)}) of “
            {collection.name}” will be removed. The documents stay.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
