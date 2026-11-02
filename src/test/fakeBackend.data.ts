import type {
  AppError,
  Cell,
  CollectionSummary,
  ExplainReport,
  FieldPath,
  FieldPaths,
  FieldPathsRequest,
  GroupColumn,
  GroupRequest,
  GroupResult,
  GroupRow,
  Overview,
  QueryRequest,
  QueryResult,
  RecentFile,
  ResultRow,
  SessionInfo,
  StorageReport,
} from "../ipc/types";

export function sessionInfo(path: string, sessionId = "s1", readOnly = false): SessionInfo {
  return {
    session_id: sessionId,
    path,
    file_name: path.split("/").pop() ?? path,
    can_mutate: !readOnly,
    file: {
      format_version: 12,
      page_size: 8192,
      pages: 12,
      free_pages: 2,
      created_by: "0.24.0",
      written_by: "0.24.0",
    },
  };
}

export function recentFile(path: string, exists = true, readOnly = false): RecentFile {
  return { path, file_name: path.split("/").pop() ?? path, exists, read_only: readOnly };
}

export function appError(category: AppError["category"], message: string): AppError {
  return { category, message, detail: null };
}

export function collection(name: string, count = 0, persisted = true): CollectionSummary {
  return { name, persisted, count, count_error: null, indexes: [] };
}

export function overviewOf(...collections: CollectionSummary[]): Overview {
  return { file: sessionInfo("/x").file, collections };
}

/** A row as the backend would describe `{"_id": ..., ...fields}`. */
export function objectRow(id: string, fields: Record<string, Cell> = {}): ResultRow {
  const cells: Record<string, Cell> = { _id: { kind: "id", preview: id }, ...fields };
  return { id, json: `{\n  "_id": {"$id": "${id}"}\n}`, cells };
}

/** The answer to `request` holding `rows`, as one page of `total` matches. */
export function resultFor(
  request: QueryRequest,
  rows: ResultRow[],
  total = rows.length,
): QueryResult {
  const columns = [
    ...new Set(rows.flatMap((row) => (row.cells === null ? [] : Object.keys(row.cells)))),
  ].sort((a, b) => (a === "_id" ? -1 : b === "_id" ? 1 : a.localeCompare(b)));
  return {
    request_id: request.request_id,
    total,
    page: request.page,
    page_size: request.page_size,
    page_count: Math.ceil(total / request.page_size),
    rows,
    columns: request.select === null ? columns : ["_id", ...request.select],
    select: request.select,
  };
}

/** The columns `request` asks for: its group fields, the count, then its columns. */
export function groupColumnsOf(request: GroupRequest): GroupColumn[] {
  const labels = { count: "count", sum: "sum", avg: "average", min: "min", max: "max" } as const;
  return [
    ...request.group_by.map((label) => ({ label, group: true, kind: null })),
    { label: "count", group: false, kind: "count" as const },
    ...request.columns.map((c) => {
      const what = c.kind === "count" ? "count" : `${labels[c.kind]} ${c.field}`;
      const condition = c.condition.trim();
      return {
        label: condition === "" ? what : `${what} where ${condition}`,
        group: false,
        kind: c.kind,
      };
    }),
  ];
}

/** A group row of string group values and a count; Show documents adds an `eq` each. */
export function groupRow(request: GroupRequest, values: string[], count: number): GroupRow {
  return {
    cells: [
      ...values.map((preview) => ({ kind: "string" as const, preview })),
      { kind: "int" as const, preview: String(count) },
    ],
    documents: (() => {
      const eqs = request.group_by.map((field, n) => ({
        field,
        operator: "eq" as const,
        value: { type: "string" as const, text: values[n] ?? "" },
      }));
      const filter = request.filter;
      if ("rows" in filter) return { rows: [...filter.rows, ...eqs] };
      const extra = eqs.map((eq) => `${eq.field} = ${JSON.stringify(eq.value.text)}`).join(" and ");
      return { text: filter.text === "" ? extra : `(${filter.text}) and ${extra}` };
    })(),
    no_documents: null,
  };
}

/** The answer to `request` holding `rows`, as one page of `total` groups. */
export function groupsFor(
  request: GroupRequest,
  rows: GroupRow[],
  total = rows.length,
): GroupResult {
  return {
    request_id: request.request_id,
    total,
    page: request.page,
    page_size: request.page_size,
    page_count: Math.ceil(total / request.page_size),
    columns: groupColumnsOf(request),
    rows,
  };
}

/** How groups were made: by default counted from the entries of `(status, created)`. */
export function groupsExplainOf(
  request: GroupRequest,
  overrides: Partial<ExplainReport> = {},
): ExplainReport {
  return {
    request_id: request.request_id,
    plan: "index_order",
    reads: [
      { index: "(status, created)", bounds: [], backward: false, entries: 300, covering: true },
    ],
    sort: null,
    skip: 0,
    limit: 0,
    keys_examined: 300,
    documents_examined: 0,
    documents_matched: 300,
    documents_returned: 3,
    from_entries: 300,
    groups: 3,
    elapsed_micros: 800,
    ...overrides,
  };
}

/** A promise settled by the test, to hold a request "in flight". */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** How `request`'s page was read: by default a walk of the primary
 * index in `_id` order (trunkdb §96), 100 entries, the page and those
 * before it, decided by the entries (§100): only the page read. */
export function explainOf(
  request: QueryRequest,
  overrides: Partial<ExplainReport> = {},
): ExplainReport {
  return {
    request_id: request.request_id,
    plan: "index_order",
    reads: [{ index: "_id", bounds: [], backward: false, entries: 100, covering: true }],
    sort: { from_index: 1, in_memory: 0 },
    skip: request.page * request.page_size,
    limit: request.page_size,
    keys_examined: 100,
    documents_examined: Math.min(request.page_size, 100),
    documents_matched: 100,
    documents_returned: Math.min(request.page_size, 100),
    from_entries: 0,
    groups: null,
    elapsed_micros: 1500,
    ...overrides,
  };
}

/** A storage report of `collections`, each 10 documents in one data page. */
export function storageOf(
  overrides: Partial<StorageReport> = {},
  ...collections: string[]
): StorageReport {
  return {
    page_size: 8192,
    pages: 12,
    page_use: {
      header: 1,
      catalog: 1,
      free: 2,
      data: collections.length,
      overflow: 0,
      index: 8 - collections.length,
      unaccounted: 0,
    },
    compacted_pages: 10,
    wal_bytes: 0,
    recovered: null,
    collections: collections.map((name) => ({
      name,
      documents: 10,
      data_pages: 1,
      overflow_pages: 0,
      document_bytes: 2048,
      free_bytes: 6000,
      indexes: [{ fields: ["_id"], entries: 10, pages: 1, depth: 1, key_bytes: 160 }],
    })),
    ...overrides,
  };
}

/** A field path counted in `documents` documents, of one kind or several. */
export function fieldPath(
  path: string,
  documents: number,
  kinds: [FieldPath["kinds"][number]["kind"], number][] = [["string", documents]],
  text = path,
): FieldPath {
  return {
    path,
    text,
    nameable: !path.split(".").some((name) => name.includes("`")),
    documents,
    kinds: kinds.map(([kind, n]) => ({ kind, documents: n })),
  };
}

export function fieldPathsOf(
  request: FieldPathsRequest,
  documents: number,
  ...paths: FieldPath[]
): FieldPaths {
  return { request_id: request.request_id, documents, paths, truncated: false };
}
