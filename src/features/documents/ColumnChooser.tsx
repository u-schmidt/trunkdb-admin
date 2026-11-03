import { useRef, useState, type FormEvent } from "react";
import { useFieldPaths } from "../fields/FieldPathsContext";

interface Row {
  key: number;
  path: string;
}

/** Show only the fields listed, or every field but those. */
export type ColumnMode = "only" | "except";

interface Props {
  /** The paths to start from: the chosen or hidden ones, or the page's fields. */
  initial: string[];
  initialMode?: ColumnMode;
  /** Whether fields are chosen or hidden now, so that All fields means something. */
  choosing: boolean;
  /** The fields to show, or null with the fields to hide (trunkdb SPEC §143). */
  onChoose: (select: string[] | null, except: string[]) => void;
  onClose: () => void;
}

/**
 * The fields the list reads and shows (trunkdb SPEC §106): paths, nested
 * ones included, in order. `_id` always comes; the backend checks the
 * paths.
 */
export function ColumnChooser({
  initial,
  initialMode = "only",
  choosing,
  onChoose,
  onClose,
}: Props) {
  const [mode, setMode] = useState<ColumnMode>(initialMode);
  // Suggestions from the collection's documents.
  const paths = useFieldPaths();
  const nextKey = useRef(initial.length);
  const [rows, setRows] = useState<Row[]>(() => initial.map((path, key) => ({ key, path })));

  const move = (index: number, by: number) =>
    setRows((current) => {
      const moved = current[index];
      const other = current[index + by];
      if (moved === undefined || other === undefined) return current;
      const next = [...current];
      next[index] = other;
      next[index + by] = moved;
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const paths = rows.map((row) => row.path);
    if (mode === "only") onChoose(paths, []);
    else onChoose(null, paths);
  };

  return (
    <form className="filter column-chooser" onSubmit={submit} aria-label="Columns">
      <div role="group" aria-label="Which fields" className="segmented">
        <button type="button" aria-pressed={mode === "only"} onClick={() => setMode("only")}>
          Only these
        </button>
        <button type="button" aria-pressed={mode === "except"} onClick={() => setMode("except")}>
          All but these
        </button>
      </div>
      <p className="muted">
        {mode === "only"
          ? "Only these fields are read and shown, nested paths such as address.city included; _id always comes."
          : "Every field but these is read and shown, for one too large to page through; a nested path such as address.zip leaves the rest of its object."}{" "}
        Opening a document shows it whole.
      </p>
      <ol className="filter-rows">
        {rows.map((row, index) => {
          const n = index + 1;
          return (
            <li key={row.key} className="filter-row">
              <span className="filter-joiner">{n}.</span>
              <input
                type="text"
                className="filter-field"
                aria-label={`Column ${n} path`}
                placeholder="field or nested.path"
                value={row.path}
                list={paths.listPlain}
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
                className="quiet"
                aria-label={`Move column ${n} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="quiet"
                aria-label={`Move column ${n} down`}
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="quiet"
                aria-label={`Remove column ${n}`}
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ol>
      <div className="filter-footer">
        <button
          type="button"
          onClick={() => setRows((current) => [...current, { key: nextKey.current++, path: "" }])}
        >
          Add column
        </button>
        <span className="filter-run">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!choosing} onClick={() => onChoose(null, [])}>
            All fields
          </button>
          <button type="submit" className="primary">
            {mode === "only" ? "Show these columns" : "Hide these fields"}
          </button>
        </span>
      </div>
    </form>
  );
}
