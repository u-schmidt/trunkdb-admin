import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { ErrorNotice } from "../../components/ErrorNotice";
import type {
  Cell,
  ColumnInput,
  FilterInput,
  GroupColumn,
  GroupResult,
  GroupSort,
} from "../../ipc/types";
import { isEmptyFilter } from "./filter";
import { KIND_LABELS } from "./kinds";
import { Pager } from "./Pager";
import type { GroupSettings, Groups } from "./useGroups";
import { useFieldPaths } from "../fields/FieldPathsContext";

const COLUMN_LABELS: Record<ColumnInput["kind"], string> = {
  count: "Count",
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  count_distinct: "Distinct values",
  first: "First value",
  last: "Last value",
};

/** Columns that take an order: the value of the first or last document. */
const isOrdered = (kind: ColumnInput["kind"]) => kind === "first" || kind === "last";

const MAX_GROUP_FIELDS = 3;
const GROUPS = ["group", "groups"] as const;

interface Field {
  key: number;
  path: string;
}

interface Column {
  key: number;
  kind: ColumnInput["kind"];
  field: string;
  /** trunkdb filter text; empty: every document of the group. */
  condition: string;
  /** For first and last: the field ordering the group; empty: by ID. */
  by: string;
}

interface Props {
  groups: Groups;
  /** Lists a group's documents: the filter and an `eq` per group field. */
  onShowDocuments: (filter: FilterInput) => void;
  /** Run groups: the filter as typed, with these settings. */
  onRun: (settings: GroupSettings) => void;
  /** Kept current with the settings as set, so the filter's Run can group too. */
  settingsRef: RefObject<GroupSettings | null>;
}

/**
 * The documents the filter finds, counted by group (trunkdb SPEC §107).
 * trunkdb groups, counts and sorts them; nothing is reordered here.
 */
export function GroupsView({ groups, onShowDocuments, onRun, settingsRef }: Props) {
  // Suggestions from the collection's documents.
  const paths = useFieldPaths();
  const { result, applied, loading, error } = groups;
  const [unwinds, setUnwinds] = useState<Field[]>([]);
  const [fields, setFields] = useState<Field[]>([{ key: 0, path: "" }]);
  const [columns, setColumns] = useState<Column[]>([]);
  const nextKey = useRef(1);
  const [dismissed, setDismissed] = useState<object | null>(null);

  const pageSize = applied?.settings.pageSize ?? 50;
  const settings = (): GroupSettings => ({
    unwind: unwinds.map((unwind) => unwind.path),
    groupBy: fields.map((field) => field.path),
    columns: columns.map(({ kind, field, condition, by }) => ({
      kind,
      field,
      condition,
      // Only first and last are ordered; a hidden order isn't sent.
      by: isOrdered(kind) ? by : "",
    })),
    // The columns may have changed: the group order again.
    sort: null,
    pageSize,
  });
  useEffect(() => {
    settingsRef.current = settings();
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onRun(settings());
  };
  // A header or the page size changes what was run, not the form.
  const rerun = (patch: Partial<GroupSettings>) => {
    if (applied === null) return;
    groups.run({ ...applied, settings: { ...applied.settings, ...patch } });
  };

  return (
    <div className="groups">
      <form className="filter group-form" onSubmit={submit} aria-label="Group by">
        <p className="muted">
          Counts the documents the filter finds, per value of the fields below. A missing field is
          counted with null. A column with a condition takes in only the documents it finds. Unwind
          an array to count its elements: each document becomes one per element, and{" "}
          <code>items.sku</code> names a field of that element.
        </p>
        {unwinds.length > 0 && (
          <ol className="filter-rows">
            {unwinds.map((unwind, index) => (
              <li key={unwind.key} className="filter-row">
                <span className="filter-joiner">{index === 0 ? "Unwind" : "then"}</span>
                <input
                  type="text"
                  className="filter-field"
                  aria-label={`Unwind ${index + 1}`}
                  placeholder="array field, e.g. items"
                  value={unwind.path}
                  list={paths.listPlain}
                  onFocus={paths.ensure}
                  onChange={(event) =>
                    setUnwinds((current) =>
                      current.map((u) =>
                        u.key === unwind.key ? { ...u, path: event.target.value } : u,
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
                  aria-label={`Remove unwind ${index + 1}`}
                  onClick={() =>
                    setUnwinds((current) => current.filter((u) => u.key !== unwind.key))
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        {fields.length === 0 ? (
          <p className="muted">No group fields: all matching documents are one group.</p>
        ) : (
          <ol className="filter-rows">
            {fields.map((field, index) => (
              <li key={field.key} className="filter-row">
                <span className="filter-joiner">{index === 0 ? "Group by" : "then"}</span>
                <input
                  type="text"
                  className="filter-field"
                  aria-label={`Group field ${index + 1}`}
                  placeholder="field or nested.path"
                  value={field.path}
                  list={paths.listPlain}
                  onFocus={paths.ensure}
                  onChange={(event) =>
                    setFields((current) =>
                      current.map((f) =>
                        f.key === field.key ? { ...f, path: event.target.value } : f,
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
                  aria-label={`Remove group field ${index + 1}`}
                  onClick={() => setFields((current) => current.filter((f) => f.key !== field.key))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        <ol className="filter-rows">
          <li className="filter-row">
            <span className="filter-joiner">Columns</span>
            <span>count</span>
          </li>
          {columns.map((column, index) => {
            const n = index + 1;
            const change = (patch: Partial<Column>) =>
              setColumns((current) =>
                current.map((c) => (c.key === column.key ? { ...c, ...patch } : c)),
              );
            return (
              <li key={column.key} className="filter-row">
                <span className="filter-joiner">and</span>
                <select
                  aria-label={`Column ${n} kind`}
                  value={column.kind}
                  onChange={(event) => change({ kind: event.target.value as Column["kind"] })}
                >
                  {Object.entries(COLUMN_LABELS).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
                {column.kind !== "count" && (
                  <>
                    <span>of</span>
                    <input
                      type="text"
                      className="filter-field"
                      aria-label={`Column ${n} field`}
                      placeholder="field or nested.path"
                      value={column.field}
                      list={paths.listPlain}
                      onFocus={paths.ensure}
                      onChange={(event) => change({ field: event.target.value })}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                  </>
                )}
                {isOrdered(column.kind) && (
                  <>
                    <span>ordered by</span>
                    <input
                      type="text"
                      className="filter-field"
                      aria-label={`Column ${n} order`}
                      title="The field that orders the group's documents; empty: by ID, the order they were made in"
                      placeholder="_id (as made)"
                      value={column.by}
                      list={paths.listPlain}
                      onFocus={paths.ensure}
                      onChange={(event) => change({ by: event.target.value })}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                  </>
                )}
                <span>where</span>
                <input
                  type="text"
                  className="filter-field column-condition"
                  aria-label={`Column ${n} condition`}
                  title="Filter text, as in the Text filter; empty: every document of the group"
                  placeholder='optional, e.g. status = "open"'
                  value={column.condition}
                  onChange={(event) => change({ condition: event.target.value })}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Remove column ${n}`}
                  onClick={() =>
                    setColumns((current) => current.filter((c) => c.key !== column.key))
                  }
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
            title="Count the elements of an array: each document becomes one per element"
            onClick={() =>
              setUnwinds((current) => [...current, { key: nextKey.current++, path: "" }])
            }
          >
            Add unwind
          </button>
          <button
            type="button"
            disabled={fields.length >= MAX_GROUP_FIELDS}
            onClick={() =>
              setFields((current) => [...current, { key: nextKey.current++, path: "" }])
            }
          >
            Add group field
          </button>
          <button
            type="button"
            onClick={() =>
              setColumns((current) => [
                ...current,
                { key: nextKey.current++, kind: "sum", field: "", condition: "", by: "" },
              ])
            }
          >
            Add column
          </button>
          <span className="filter-run">
            {loading && <span className="muted">Grouping…</span>}
            <button type="submit" className="primary">
              Run groups
            </button>
          </span>
        </div>
      </form>
      {error !== null && dismissed !== error && (
        <ErrorNotice error={error} onDismiss={() => setDismissed(error)} />
      )}
      <div className="results" aria-busy={loading}>
        {result === null ? (
          <p className="state muted">
            {loading ? "Grouping documents…" : "Choose how to group and press Run groups."}
          </p>
        ) : result.total === 0 ? (
          <p className="state muted" role="status">
            {applied !== null && !isEmptyFilter(applied.filter)
              ? "No documents match the filter."
              : "This collection has no documents."}
          </p>
        ) : (
          <GroupTable
            result={result}
            sort={applied?.settings.sort ?? null}
            onSort={(sort) => rerun({ sort })}
            onShowDocuments={onShowDocuments}
          />
        )}
      </div>
      {result !== null && (
        <Pager
          result={result}
          units={GROUPS}
          busy={loading}
          onPage={groups.goToPage}
          onPageSize={(size) => rerun({ pageSize: size })}
        />
      )}
    </div>
  );
}

function CellValue({ cell }: { cell: Cell }) {
  const text = cell.kind === "string" ? JSON.stringify(cell.preview) : cell.preview;
  return (
    <span className={`cell-value kind-${cell.kind}`} title={KIND_LABELS[cell.kind]}>
      {text}
    </span>
  );
}

/** Right-aligned: the computed columns, except a value taken from a document. */
function isNumeric(column: GroupColumn): boolean {
  return !column.group && column.kind !== null && !isOrdered(column.kind);
}

/** The first click on a count sorts the biggest groups first; others start ascending. */
function nextSort(column: GroupColumn, at: number, current: GroupSort | null): GroupSort {
  if (current?.column === at) return { column: at, descending: !current.descending };
  return { column: at, descending: column.kind === "count" || column.kind === "count_distinct" };
}

function GroupTable({
  result,
  sort,
  onSort,
  onShowDocuments,
}: {
  result: GroupResult;
  sort: GroupSort | null;
  onSort: (sort: GroupSort) => void;
  onShowDocuments: (filter: FilterInput) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="results-table" aria-label="Groups">
        <thead>
          <tr>
            {result.columns.map((column, at) => {
              const current = sort?.column === at;
              return (
                <th
                  key={at}
                  scope="col"
                  className={isNumeric(column) ? "numeric" : undefined}
                  aria-sort={current ? (sort.descending ? "descending" : "ascending") : undefined}
                >
                  <button
                    type="button"
                    className="sort-header"
                    title={
                      column.group
                        ? `Sort by ${column.label}; a missing field is counted with null`
                        : `Sort by ${column.label}`
                    }
                    onClick={() => onSort(nextSort(column, at, sort))}
                  >
                    {column.label}
                    {current && (
                      <span className="sort-arrow" aria-hidden="true">
                        {sort.descending ? " ▼" : " ▲"}
                      </span>
                    )}
                  </button>
                </th>
              );
            })}
            <th scope="col">
              <span className="sr-only">Documents</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {row.cells.map((cell, at) => (
                <td
                  key={at}
                  className={
                    result.columns[at] !== undefined && isNumeric(result.columns[at])
                      ? "numeric"
                      : undefined
                  }
                >
                  <CellValue cell={cell} />
                </td>
              ))}
              <td>
                {/* A disabled button shows no tooltip of its own in every
                    browser: the reason is on its wrapper too. */}
                <span title={row.no_documents ?? undefined}>
                  <button
                    type="button"
                    className="quiet"
                    disabled={row.documents === null}
                    title={row.no_documents ?? "List the documents of this group"}
                    aria-label={`Show documents of group ${result.page * result.page_size + index + 1}`}
                    aria-description={row.no_documents ?? undefined}
                    onClick={() => row.documents !== null && onShowDocuments(row.documents)}
                  >
                    Show documents
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
