import type { KeyboardEvent } from "react";
import type { Cell, ResultRow, SortInput } from "../../ipc/types";
import { KIND_LABELS } from "./kinds";

interface Props {
  rows: ResultRow[];
  columns: string[];
  /** Set when the columns are chosen paths, which sort as paths. */
  paths?: boolean;
  /** The sort the rows are in; a header click asks for another. */
  sort: SortInput;
  onSort: (sort: SortInput) => void;
  selected: number | null;
  onSelect: (index: number) => void;
}

function CellValue({ cell }: { cell: Cell | undefined }) {
  if (cell === undefined) {
    // Not stored at all: visibly something else than a stored null.
    return (
      <span className="cell-missing" title="This document has no such field">
        missing
      </span>
    );
  }
  if (cell.kind === "id") {
    // Its start is the time it was made, alike on a page; its end tells
    // documents apart. The whole ID is in the tooltip and the document.
    return (
      <span className="cell-value kind-id" title={`${KIND_LABELS.id}: ${cell.preview}`}>
        {shortId(cell.preview)}
      </span>
    );
  }
  const text = cell.kind === "string" ? JSON.stringify(cell.preview) : cell.preview;
  return (
    <span className={`cell-value kind-${cell.kind}`} title={KIND_LABELS[cell.kind]}>
      {text}
    </span>
  );
}

/** "0192f3a0…0001": an ID's first eight and last four characters. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/**
 * The same page as a table: one column per top-level field found on it.
 * Nested values are compact previews; selecting a row shows its full JSON.
 */
export function TableResults({
  rows,
  columns,
  paths = false,
  sort,
  onSort,
  selected,
  onSelect,
}: Props) {
  const sortedBy = sort.field === "" ? "_id" : sort.field;
  const onKey = (event: KeyboardEvent, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(index);
    }
  };
  return (
    <div className="table-scroll">
      <table className="results-table" aria-label="Documents as table">
        <thead>
          <tr>
            {columns.map((name) => {
              // A field name with a dot would be read as a nested path: it
              // can't be sorted by. A chosen column is a path already.
              if (!paths && name.includes(".")) {
                return (
                  <th key={name} scope="col">
                    {name}
                  </th>
                );
              }
              const current = name === sortedBy;
              return (
                <th
                  key={name}
                  scope="col"
                  aria-sort={current ? (sort.descending ? "descending" : "ascending") : undefined}
                >
                  <button
                    type="button"
                    className="sort-header"
                    title={`Sort by ${name}`}
                    onClick={() =>
                      onSort({ field: name, descending: current ? !sort.descending : false })
                    }
                  >
                    {name}
                    {current && (
                      <span className="sort-arrow" aria-hidden="true">
                        {sort.descending ? " ▼" : " ▲"}
                      </span>
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.id}
              tabIndex={0}
              aria-selected={index === selected}
              className={index === selected ? "selected" : undefined}
              onClick={() => onSelect(index)}
              onKeyDown={(event) => onKey(event, index)}
            >
              {columns.map((name) => (
                <td key={name}>
                  <CellValue cell={row.cells[name]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
