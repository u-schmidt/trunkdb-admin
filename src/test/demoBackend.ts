import type { Backend } from "../ipc/backend";
import type {
  Cell,
  ConditionInput,
  FilterInput,
  GroupRequest,
  GroupRow,
  Overview,
  QueryRequest,
  ResultRow,
  ValueInput,
  ValueKind,
} from "../ipc/types";
import {
  collection,
  groupColumnsOf,
  groupsExplainOf,
  groupsFor,
  recentFile,
  resultFor,
  sessionInfo,
} from "./fakeBackend.data";

/**
 * Sample data for looking at the UI in a plain browser (`npm run dev`
 * without Tauri). It imitates the backend only as far as layout needs: it
 * filters on `eq` alone and knows nothing of trunkdb's semantics.
 */
const PATH = "/Users/demo/Documents/shop.trunkdb";

const people: ResultRow[] = Array.from({ length: 137 }, (_, n) => {
  const id = `0192f3a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const fields: Record<string, Cell> = {
    _id: { kind: "id", preview: id },
    name: { kind: "string", preview: ["Anna Schmidt", "Bo Lind", "Chidi Okafor"][n % 3] ?? "" },
    age: { kind: "int", preview: String(20 + (n % 50)) },
    score: { kind: "float", preview: `${n % 7}.5` },
    active: { kind: "bool", preview: String(n % 2 === 0) },
    address: { kind: "object", preview: `{"city":"Berlin","zip":"10${n}"}` },
    tags: { kind: "array", preview: `["a","b",${n}]` },
    joined: { kind: "date_time", preview: "2026-03-01T12:00:00Z" },
  };
  if (n % 4 === 0) fields.note = { kind: "null", preview: "null" };
  if (n % 5 === 0) delete fields.age;
  const json = `{\n  "_id": {\n    "$id": "${id}"\n  },\n  "name": "${fields.name?.preview}",\n  "age": ${20 + (n % 50)},\n  "score": ${n % 7}.5,\n  "active": ${n % 2 === 0},\n  "address": {\n    "city": "Berlin",\n    "zip": "10${n}"\n  },\n  "tags": [\n    "a",\n    "b",\n    ${n}\n  ],\n  "joined": {\n    "$date": "2026-03-01T12:00:00Z"\n  },\n  "big": 9223372036854775807\n}`;
  return { id, json, cells: fields };
});

/** One value of a kind each, under `value`. */
function valueRow(n: number, cell: Cell, json: string): ResultRow {
  const id = `0192f3a0-0000-7000-8000-${(0xf00 + n).toString(16).padStart(12, "0")}`;
  return {
    id,
    json: `{\n  "_id": {\n    "$id": "${id}"\n  },\n  "value": ${json}\n}`,
    cells: { _id: { kind: "id", preview: id }, value: cell },
  };
}

const mixed: ResultRow[] = [
  valueRow(1, { kind: "array", preview: "[1,2]" }, "[\n    1,\n    2\n  ]"),
  valueRow(2, { kind: "string", preview: "just text" }, '"just text"'),
  valueRow(3, { kind: "float", preview: "2.0" }, "2.0"),
  ...people.slice(0, 2),
];

const rowsOf: Record<string, ResultRow[]> = { people, mixed, empty: [] };

/**
 * Filter text, as far as sample data goes: the frontend never reads it,
 * and here no trunkdb does. Text this backend printed from rows reads back
 * as those rows; other text matches every document; text with `??` is a
 * mistake there, to show how one looks.
 */
const printed = new Map<string, ConditionInput[]>();

const SYMBOLS: Record<string, string> = {
  eq: "=",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  contains: "contains",
  starts_with: "starts with",
};

/** A typed value in the filter language. */
function showValue(value: ValueInput | null): string {
  if (value === null || value.type === "null") return "null";
  if (value.type === "string") return JSON.stringify(value.text);
  if (value.type === "id") return `id("${value.text}")`;
  if (value.type === "date_time") return `date("${value.text}")`;
  return value.text;
}

function printRows(rows: ConditionInput[]): string {
  const text = rows
    .map((row) => {
      if (row.operator === "exists") return `exists(${row.field})`;
      if (row.operator === "missing") return `not exists(${row.field})`;
      if (row.operator === "is_kind") return `${row.field} is ${row.kind ?? "string"}`;
      if (row.operator === "is_not_kind") return `${row.field} is not ${row.kind ?? "string"}`;
      if (row.operator === "in" || row.operator === "not_in") {
        const list = (row.values ?? []).map(showValue).join(", ");
        return `${row.field} ${row.operator === "in" ? "in" : "not in"} (${list})`;
      }
      return `${row.field} ${SYMBOLS[row.operator] ?? row.operator} ${showValue(row.value)}`;
    })
    .join(" and ");
  printed.set(text, rows);
  return text;
}

/** The rows a filter says, or null for text that matches everything here. */
function conditionsIn(filter: FilterInput): ConditionInput[] | null {
  if ("rows" in filter) return filter.rows;
  const text = filter.text.trim();
  if (text === "") return [];
  const mistake = filter.text.indexOf("??");
  if (mistake >= 0) {
    const before = filter.text.slice(0, mistake);
    const line = before.split("\n").length;
    const column = mistake - before.lastIndexOf("\n");
    throw {
      category: "invalid_input",
      message: "The filter text doesn't read.",
      detail: `expected a value, found \`?\` at line ${line} column ${column}`,
      at: { line, column, index: mistake },
    };
  }
  return printed.get(text) ?? null;
}

/**
 * A column's condition, as far as this backend reads one: `field = value`
 * joined by `and`, a value quoted or not. Anything else takes in every row.
 */
function meetsColumn(row: ResultRow, condition: string): boolean {
  if (condition.trim() === "") return true;
  return condition.split(/\s+and\s+/i).every((part) => {
    const match = /^\s*([\w.]+)\s*=\s*(.+?)\s*$/.exec(part);
    if (match === null) return true;
    const [, field = "", value = ""] = match;
    const text = value.startsWith('"') ? value.slice(1, -1) : value;
    return row.cells[field]?.preview === text;
  });
}

function matchesFilter(row: ResultRow, filter: FilterInput): boolean {
  const conditions = conditionsIn(filter);
  return conditions === null || conditions.every((condition) => matches(row, condition));
}

/** A group's documents: the filter and an `eq` per group value, as the filter is. */
function drill(request: GroupRequest, values: Cell[]): FilterInput {
  const eqs: ConditionInput[] = request.group_by.map((field, n) => ({
    field,
    operator: "eq",
    value: { type: "string", text: values[n]?.preview ?? "" },
  }));
  const filter = request.filter;
  if ("rows" in filter) return { rows: [...filter.rows, ...eqs] };
  const known = conditionsIn(filter);
  const extra = printRows(eqs);
  const text = filter.text.trim() === "" ? extra : `(${filter.text.trim()}) and ${extra}`;
  if (known !== null) printed.set(text, [...known, ...eqs]);
  return { text };
}

/** Roughly what trunkdb does, on the cells' previews; enough for a look at the layout. */
function matches(row: ResultRow, condition: ConditionInput): boolean {
  const cell = row.cells[condition.field];
  const preview = cell?.preview;
  const text = condition.value?.text ?? "";
  const kindOf = (kind: string | undefined) =>
    cell !== undefined &&
    (kind === "number"
      ? cell.kind === "int" || cell.kind === "float"
      : cell.kind === (kind === "date" ? "date_time" : kind));
  const among = () => (condition.values ?? []).some((value) => value.text === preview);
  switch (condition.operator) {
    case "exists":
      return cell !== undefined;
    case "missing":
      return cell === undefined;
    case "ne":
      return preview !== text;
    case "contains":
      return preview?.toLowerCase().includes(text.toLowerCase()) ?? false;
    case "starts_with":
      return preview?.startsWith(text) ?? false;
    case "in":
      return among();
    case "not_in":
      return !among();
    case "is_kind":
      return kindOf(condition.kind);
    case "is_not_kind":
      return !kindOf(condition.kind);
    default:
      return preview === text;
  }
}

/** The cell at a dotted path: nested values are read from an object cell's preview. */
function cellAt(row: ResultRow, path: string): Cell | undefined {
  const [first = "", ...rest] = path.split(".");
  const top = row.cells[first];
  if (rest.length === 0 || top === undefined) return top;
  if (top.kind !== "object") return undefined;
  let value: unknown = JSON.parse(top.preview);
  for (const step of rest) {
    value =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)[step]
        : undefined;
  }
  if (value === undefined) return undefined;
  if (typeof value === "string") return { kind: "string", preview: value };
  if (typeof value === "number") return { kind: "int", preview: String(value) };
  return { kind: "object", preview: JSON.stringify(value) };
}

/** A row of the chosen paths of `row` (trunkdb §106), its JSON flat. */
function chosen(row: ResultRow, select: string[]): ResultRow {
  const cells: Record<string, Cell> = {};
  for (const path of ["_id", ...select]) {
    const cell = cellAt(row, path);
    if (cell !== undefined) cells[path] = cell;
  }
  const fields = Object.entries(cells)
    .map(([path, cell]) => `  ${JSON.stringify(path)}: ${JSON.stringify(cell.preview)}`)
    .join(",\n");
  return { id: row.id, json: `{\n${fields}\n}`, cells };
}

export function demoBackend(): Backend {
  const virtuals: string[] = [];
  // How each file was last opened, as the recent list remembers it.
  const readOnlyPaths = new Set<string>(["/Users/demo/Backups/tasks-2026-10-01.trunkdb"]);
  let readOnly = false;
  const recents = () =>
    [PATH, ...readOnlyPaths, ARCHIVE, "/Users/demo/old/gone.trunkdb"]
      .filter((path, at, all) => all.indexOf(path) === at)
      .map((path) => recentFile(path, !path.includes("gone"), readOnlyPaths.has(path)));
  // As the storage report below has it: a file an older trunkdb made,
  // which this one has written since.
  const upgraded = {
    format_version: 17,
    page_size: 8192,
    pages: 214,
    free_pages: 18,
    created_by: "0.24.0",
    written_by: "0.40.0",
  };
  // The archived file is still as trunkdb 0.24.0 left it, until it is
  // opened for editing with the upgrade.
  const ARCHIVE = "/Users/demo/Archive/notes-2024.trunkdb";
  let archiveUpgraded = false;
  const fileOf = (path: string) =>
    path === ARCHIVE && !archiveUpgraded
      ? { ...upgraded, format_version: 12, written_by: "0.24.0" }
      : upgraded;
  let file = upgraded;
  const overview = (): Overview => ({
    file,
    collections: [
      collection("empty", 0),
      { ...collection("mixed", mixed.length) },
      {
        ...collection("people", people.length),
        indexes: [
          { fields: ["name"], unique: false, sparse: false },
          { fields: ["address.city", "age"], unique: true, sparse: true },
        ],
      },
      ...virtuals.map((name) => collection(name, 0, false)),
    ],
  });
  const bodyOf = (row: ResultRow) => row.json.replace(/^\{\n {2}"_id": \{[^}]*\},\n/, "{\n");
  const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 80));
  return {
    appInfo: async () => ({
      app_version: "0.1.0",
      trunkdb: { version: "0.40.0", revision: "f4ae88cc506a604d5d205701d8b6ec77a302e285" },
    }),
    recentList: async () => recents(),
    recentRemove: async (path) => recents().filter((entry) => entry.path !== path),
    pickDatabaseToOpen: async () => PATH,
    pickDatabaseToCreate: async () => "/Users/demo/Documents/new.trunkdb",
    databaseOpen: async (path, asReadOnly, upgrade = false) => {
      if (path.includes("gone")) {
        throw { category: "file_not_found", message: "The file cannot be opened.", detail: null };
      }
      if (path.includes("Backups") && !asReadOnly) {
        throw {
          category: "permission_denied",
          message: "Your permissions don't allow this access to the file.",
          detail: "Permission denied (os error 13)",
        };
      }
      if (path === ARCHIVE && !asReadOnly) {
        if (!upgrade && !archiveUpgraded) {
          throw {
            category: "format_upgrade",
            message: "Opening this file for editing would change its format from 12 to 17.",
            detail: null,
          };
        }
        archiveUpgraded = true;
      }
      file = fileOf(path);
      readOnly = asReadOnly;
      if (asReadOnly) readOnlyPaths.add(path);
      else readOnlyPaths.delete(path);
      return { session: { ...sessionInfo(path, "s1", asReadOnly), file }, recent: recents() };
    },
    databaseFormatUpgrade: async (path) =>
      path === ARCHIVE && !archiveUpgraded
        ? { format_version: 12, written_by: "0.24.0", becomes: 17, bundled_release: "0.40.0" }
        : null,
    databaseCreate: async (path) => ({ session: sessionInfo(path), recent: [recentFile(path)] }),
    sessionClose: async () => undefined,
    sessionOverview: () => later(overview()),
    collectionPrepare: async (_session, name) => {
      if (name === "" || overview().collections.some((c) => c.name === name)) {
        throw { category: "already_exists", message: `“${name}” cannot be added.`, detail: null };
      }
      virtuals.push(name);
      return overview();
    },
    collectionDiscardVirtual: async (_session, name) => {
      virtuals.splice(virtuals.indexOf(name), 1);
      return overview();
    },
    collectionDrop: async () => overview(),
    documentRead: async (_session, _collection, id) => {
      const row = people.find((candidate) => candidate.id === id);
      if (row === undefined) {
        throw {
          category: "target_not_found",
          message: "This document no longer exists.",
          detail: null,
        };
      }
      return later({ id, json: bodyOf(row) });
    },
    documentFormat: async (json) => json,
    documentSave: async (_session, request) => {
      if (request.json.trim() === "") {
        throw { category: "invalid_json", message: "The text is not valid JSON.", detail: "EOF" };
      }
      return later({
        document: { id: request.id ?? "0192f3a0-0000-7000-8000-00000000ffff", json: request.json },
        created: request.id === null,
        matches_filter: !request.json.includes("outside"),
      });
    },
    documentDelete: async () => undefined,
    indexCreate: async () => overview(),
    indexDrop: async () => overview(),
    databaseStorage: () =>
      later({
        page_size: 8192,
        pages: 214,
        page_use: {
          header: 1,
          catalog: 1,
          free: 18,
          data: 121,
          overflow: 9,
          index: 64,
          unaccounted: 0,
        },
        compacted_pages: 171,
        wal_bytes: 0,
        recovered: { pages: 3, in_memory: readOnly },
        collections: [
          {
            name: "empty",
            documents: 0,
            data_pages: 0,
            overflow_pages: 0,
            document_bytes: 0,
            free_bytes: 0,
            indexes: [{ fields: ["_id"], entries: 0, pages: 1, depth: 1, key_bytes: 0 }],
          },
          {
            name: "mixed",
            documents: 5,
            data_pages: 1,
            overflow_pages: 0,
            document_bytes: 412,
            free_bytes: 7710,
            indexes: [{ fields: ["_id"], entries: 5, pages: 1, depth: 1, key_bytes: 80 }],
          },
          {
            name: "people",
            documents: 137,
            data_pages: 120,
            overflow_pages: 9,
            document_bytes: 803_211,
            free_bytes: 151_330,
            indexes: [
              { fields: ["_id"], entries: 137, pages: 2, depth: 2, key_bytes: 2192 },
              { fields: ["address.city"], entries: 137, pages: 3, depth: 2, key_bytes: 3120 },
            ],
          },
        ],
      }),
    databaseCheck: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              collections: 3,
              documents: 142,
              pages: 12,
              problems: [
                "page 9 is damaged: its checksum doesn't match",
                '"people": 32 documents can\'t be read, on damaged page 9',
              ],
            }),
          700,
        ),
      ),
    pickExportDestination: async (name) => `/Users/demo/Documents/${name}`,
    databaseExport: async (_session, destination, overwrite) => {
      if (!overwrite) {
        throw {
          category: "already_exists",
          message: "A file with this name already exists.",
          detail: destination,
        };
      }
      return later({ path: destination, collections: 3, documents: 142, bytes: 48213 });
    },
    // Sample data: the storage report's estimate, as trunkdb's is exact.
    databaseCompact: () => later({ pages_before: 214, pages_after: 171, page_size: 8192 }),
    pickExportToImport: async () => "/Users/demo/Exports/shop.jsonl",
    pickImportDestination: async (name) => `/Users/demo/Documents/${name}`,
    databaseImport: (source, destination) => {
      if (source.includes("broken")) {
        return Promise.reject({
          category: "invalid_input",
          message: "The export can't be read. Nothing was created.",
          detail: "line 12: expected a document",
        });
      }
      return later({ path: destination, collections: 3, documents: 142, bytes: 1_753_088 });
    },
    onQuitRequested: () => () => undefined,
    setUnsavedDraft: async () => undefined,
    quit: async () => undefined,
    collectionQuery: (_session, request: QueryRequest) => {
      let conditions: ConditionInput[];
      try {
        conditions = conditionsIn(request.filter) ?? [];
      } catch (mistake) {
        return Promise.reject(mistake);
      }
      const bad = conditions.findIndex((c) => c.field === "");
      if (bad >= 0) {
        return Promise.reject({
          category: "invalid_input",
          message: `Condition ${bad + 1}: enter a field path.`,
          detail: null,
        });
      }
      const all = (rowsOf[request.collection] ?? []).filter((row) =>
        matchesFilter(row, request.filter),
      );
      const ordered = request.sort.descending ? [...all].reverse() : all;
      const start = request.page * request.page_size;
      const page = ordered.slice(start, start + request.page_size);
      const select = request.select?.filter((path) => path !== "_id") ?? null;
      const hidden = request.except;
      const shown =
        select !== null
          ? page.map((row) => chosen(row, select))
          : hidden.length > 0
            ? page.map((row) =>
                chosen(
                  row,
                  Object.keys(row.cells).filter((f) => !hidden.includes(f)),
                ),
              )
            : page;
      return later(resultFor({ ...request, select }, shown, all.length));
    },
    // Top-level fields only, grouped by their previews; a scan of every
    // document, except by `name` alone, which its index counts.
    collectionGroups: (_session, request: GroupRequest) => {
      const fields = request.columns.filter((c) => c.kind !== "count").map((c) => c.field);
      const bad = [...request.group_by, ...fields].findIndex((field) => field === "");
      if (bad >= 0) {
        return Promise.reject({
          category: "invalid_input",
          message: "A group field or column needs a field path.",
          detail: null,
        });
      }
      const all = (rowsOf[request.collection] ?? []).filter((row) =>
        matchesFilter(row, request.filter),
      );
      const null_: Cell = { kind: "null", preview: "null" };
      const groups = new Map<string, ResultRow[]>();
      for (const row of all) {
        const key = JSON.stringify(request.group_by.map((f) => row.cells[f] ?? null_));
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const numbers = (rows: ResultRow[], field: string) =>
        rows.map((row) => Number(row.cells[field]?.preview)).filter((n) => !Number.isNaN(n));
      const rows: GroupRow[] = [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, members]) => {
          const values = JSON.parse(key) as Cell[];
          const columns: Cell[] = request.columns.map((column) => {
            const taken = members.filter((row) => meetsColumn(row, column.condition));
            if (column.kind === "count") return { kind: "int", preview: String(taken.length) };
            if (column.kind === "count_distinct") {
              const seen = new Set(taken.map((row) => row.cells[column.field]?.preview));
              seen.delete(undefined);
              return { kind: "int", preview: String(seen.size) };
            }
            if (column.kind === "first" || column.kind === "last") {
              const at = column.kind === "first" ? taken[0] : taken[taken.length - 1];
              return at?.cells[column.field] ?? null_;
            }
            const found = numbers(taken, column.field);
            if (found.length === 0) return null_;
            const value =
              column.kind === "sum"
                ? found.reduce((a, b) => a + b, 0)
                : column.kind === "avg"
                  ? found.reduce((a, b) => a + b, 0) / found.length
                  : column.kind === "min"
                    ? Math.min(...found)
                    : Math.max(...found);
            return { kind: column.kind === "avg" ? "float" : "int", preview: String(value) };
          });
          const drillable = values.every((v) => v.kind !== "array" && v.kind !== "object");
          return {
            cells: [...values, { kind: "int", preview: String(members.length) }, ...columns],
            documents: drillable ? drill(request, values) : null,
            no_documents: drillable
              ? null
              : "This value is an object, which rows can't hold. Switch the filter to Text to show these documents.",
          };
        });
      const sort = request.sort;
      if (sort !== null) {
        const at = (row: GroupRow) => row.cells[sort.column]?.preview ?? "";
        const numeric = groupColumnsOf(request)[sort.column]?.group === false;
        rows.sort((a, b) => {
          const order = numeric ? Number(at(a)) - Number(at(b)) : at(a).localeCompare(at(b));
          return sort.descending ? -order : order;
        });
      }
      const pageCount = Math.ceil(rows.length / request.page_size);
      const page = Math.min(request.page, Math.max(0, pageCount - 1));
      const start = page * request.page_size;
      return later({
        ...groupsFor(
          { ...request, page },
          rows.slice(start, start + request.page_size),
          rows.length,
        ),
      });
    },
    collectionGroupsExplain: (_session, request: GroupRequest) => {
      const matching = (rowsOf[request.collection] ?? []).filter((row) =>
        matchesFilter(row, request.filter),
      ).length;
      const byName =
        request.collection === "people" &&
        request.group_by.length === 1 &&
        request.group_by[0] === "name" &&
        request.columns.length === 0 &&
        (conditionsIn(request.filter) ?? []).every((c) => c.field === "name");
      return later(
        byName
          ? groupsExplainOf(request, {
              reads: [
                { index: "name", bounds: [], backward: false, entries: matching, covering: true },
              ],
              keys_examined: matching,
              documents_matched: matching,
              from_entries: matching,
              groups: 3,
            })
          : groupsExplainOf(request, {
              plan: "scan",
              reads: [],
              keys_examined: 0,
              documents_examined: (rowsOf[request.collection] ?? []).length,
              documents_matched: matching,
              from_entries: 0,
            }),
      );
    },
    // The plans `people` would get from its index on `name`; nothing else
    // is indexed. Sorted by `_id`, a walk of the primary index (trunkdb §96).
    // Top-level fields of the sample rows, counted per document.
    collectionFieldPaths: async (_session, request) => {
      const rows = rowsOf[request.collection] ?? [];
      const counts = new Map<string, Map<ValueKind, number>>();
      for (const row of rows) {
        for (const [name, cell] of Object.entries(row.cells)) {
          const kinds = counts.get(name) ?? new Map<ValueKind, number>();
          kinds.set(cell.kind, (kinds.get(cell.kind) ?? 0) + 1);
          counts.set(name, kinds);
        }
      }
      const names = [...counts.keys()].sort((a, b) =>
        a === "_id" ? -1 : b === "_id" ? 1 : a < b ? -1 : 1,
      );
      return later({
        request_id: request.request_id,
        documents: rows.length,
        truncated: false,
        paths: names.map((name) => {
          const kinds = [...(counts.get(name) ?? new Map<ValueKind, number>()).entries()]
            .map(([kind, documents]) => ({ kind, documents }))
            .sort((a, b) => b.documents - a.documents);
          return {
            path: name,
            text: name,
            nameable: true,
            documents: kinds.reduce((sum, k) => sum + k.documents, 0),
            kinds,
          };
        }),
      });
    },
    filterToText: async (rows) => printRows(rows),
    filterToRows: async (text) => {
      if (text.trim() === "") return { rows: [] };
      const rows = printed.get(text.trim());
      return rows !== undefined
        ? { rows }
        : { reason: "The sample data takes back into rows only text it made from rows." };
    },
    // Roughly what admin-core writes; the real one is trunkdb's text.
    queryStatement: async (request) => {
      const conditions =
        "rows" in request.filter ? printRows(request.filter.rows) : request.filter.text.trim();
      const count = conditions === "" ? "Filter::new()" : `r#"${conditions}"#.parse::<Filter>()?`;
      const sort = `order by ${request.sort.field}${request.sort.descending ? " desc" : ""}`;
      const skip = request.page * request.page_size;
      const page = `${conditions === "" ? "" : `${conditions} `}${sort} limit ${request.page_size}${skip > 0 ? ` offset ${skip}` : ""}`;
      return [
        `let collection = db.collection::<Document>("${request.collection}");`,
        `let total = collection.count(${count})?;`,
        `// The page shown: documents ${skip + 1} to ${skip + request.page_size} of \`total\`.`,
        `let page = collection.find(r#"${page}"#.parse::<Filter>()?)?;`,
        "",
      ].join("\n");
    },
    groupsStatement: async (request) => {
      const conditions =
        "rows" in request.filter ? printRows(request.filter.rows) : request.filter.text.trim();
      const calls = [
        ...request.unwind.map((field) => `.unwind("${field}")`),
        ...request.group_by.map((field) => `.group_by("${field}")`),
        ".count()",
        '.named("#0")',
        ...request.columns.flatMap((column, n) => [
          column.kind === "count" ? ".count()" : `.${column.kind}("${column.field}")`,
          ...(column.by.trim() === "" ? [] : [`.by("${column.by.trim()}")`]),
          ...(column.condition.trim() === ""
            ? []
            : [`.filter(r#"${column.condition.trim()}"#.parse()?)`]),
          `.named("#${n + 1}")`,
        ]),
      ];
      const first = request.page * request.page_size + 1;
      return [
        `let collection = db.collection::<Document>("${request.collection}");`,
        `let filter: Filter = ${conditions === "" ? "Filter::new()" : `r#"${conditions}"#.parse()?`};`,
        "// Column names are the app's own; the table shows labels.",
        `let aggregate = Aggregate::new()${calls.map((call) => `\n    ${call}`).join("")};`,
        "let rows = collection.aggregate(filter, &aggregate)?;",
        `// The page shown: groups ${first} to ${first + request.page_size - 1} of \`rows\`.`,
        "",
      ].join("\n");
    },
    collectionFindCommand: async (_session, request) => {
      const conditions =
        "rows" in request.filter ? printRows(request.filter.rows) : request.filter.text;
      const sort =
        request.sort.field === "_id" && !request.sort.descending
          ? ""
          : ` order by ${request.sort.field}${request.sort.descending ? " desc" : ""}`;
      const select = request.select === null ? "" : `select ${request.select.join(", ")} where `;
      const filter = `${conditions === "" ? "" : select + conditions}${sort}`.trim();
      return `trunkdb find ${PATH} ${request.collection}${filter === "" ? "" : ` '${filter}'`}`;
    },
    collectionExplain: (_session, request: QueryRequest) => {
      const rows = rowsOf[request.collection] ?? [];
      const matching = rows.filter((row) => matchesFilter(row, request.filter)).length;
      const skip = request.page * request.page_size;
      const returned = Math.max(0, Math.min(request.page_size, matching - skip));
      const conditions = conditionsIn(request.filter) ?? [];
      const named = conditions.find((c) => c.field === "name" && c.operator === "eq");
      const report = {
        request_id: request.request_id,
        skip,
        limit: request.page_size,
        documents_returned: returned,
        from_entries: 0,
        groups: null,
        elapsed_micros: 840,
        hinted: request.hint !== null,
        // What trunkdb passes over (its §133), roughly: a scan, the
        // primary index, and the name index where people have one.
        alternatives: [
          {
            plan: "scan" as const,
            indexes: [],
            // A scan walks the primary index: an entry per document.
            entries: rows.length,
            more_than: false,
            reads_documents: true,
            fewer: false,
            hint: { kind: "no_index" as const },
          },
          {
            plan: "index_order" as const,
            indexes: ["_id"],
            entries: Math.min(rows.length, skip + request.page_size),
            more_than: false,
            reads_documents: conditions.length > 0,
            fewer: false,
            hint: { kind: "index" as const, fields: ["_id"] },
          },
          ...(request.collection === "people"
            ? [
                {
                  plan: "index" as const,
                  indexes: ["name"],
                  entries: rows.length,
                  more_than: false,
                  reads_documents: true,
                  fewer: false,
                  hint: { kind: "index" as const, fields: ["name"] },
                },
              ]
            : []),
        ],
      };
      // Entries decide where the filter names only the index's field
      // (trunkdb §100): documents are read only to be shown.
      const onlyOn = (field: string) => conditions.every((c) => c.field === field);
      if (request.collection === "people" && named !== undefined) {
        const covering = onlyOn("name");
        return later({
          ...report,
          plan: "index" as const,
          reads: [
            {
              index: "name",
              bounds: [`name = "${named.value?.text ?? ""}"`],
              backward: false,
              entries: matching,
              covering,
            },
          ],
          sort: { from_index: 0, in_memory: 1 },
          keys_examined: matching,
          documents_examined: covering ? returned : matching,
          documents_matched: matching,
        });
      }
      if (request.collection === "people" && request.sort.field === "name") {
        const read = Math.min(rows.length, skip + request.page_size + 1);
        const covering = onlyOn("name");
        return later({
          ...report,
          plan: "index_order" as const,
          reads: [
            {
              index: "name",
              bounds: [],
              backward: request.sort.descending,
              entries: read,
              covering,
            },
          ],
          sort: { from_index: 1, in_memory: 0 },
          keys_examined: read,
          documents_examined: covering ? returned : read,
          documents_matched: Math.min(matching, skip + request.page_size),
        });
      }
      if (request.sort.field === "_id") {
        // Read up to the page's last match, every document checked.
        const wanted = skip + request.page_size;
        const order = request.sort.descending ? [...rows].reverse() : rows;
        let read = 0;
        let found = 0;
        for (const row of order) {
          if (found === wanted) break;
          read += 1;
          if (matchesFilter(row, request.filter)) found += 1;
        }
        const covering = onlyOn("_id");
        return later({
          ...report,
          plan: "index_order" as const,
          reads: [
            {
              index: "_id",
              bounds: [],
              backward: request.sort.descending,
              entries: read,
              covering,
            },
          ],
          sort: { from_index: 1, in_memory: 0 },
          keys_examined: read,
          documents_examined: covering ? returned : read,
          documents_matched: found,
        });
      }
      return later({
        ...report,
        plan: "scan" as const,
        reads: [
          {
            index: "_id",
            bounds: [],
            backward: false,
            entries: rows.length,
            covering: conditions.length === 0,
          },
        ],
        sort: { from_index: 0, in_memory: 1 },
        keys_examined: rows.length,
        documents_examined: rows.length,
        documents_matched: matching,
      });
    },
  };
}
