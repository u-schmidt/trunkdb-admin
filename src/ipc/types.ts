// The IPC contract with the Rust backend. These mirror the DTOs in
// crates/admin-core; they are the app's own types, not trunkdb's.

export type ErrorCategory =
  | "invalid_input"
  | "invalid_json"
  | "file_not_found"
  | "target_not_found"
  | "already_exists"
  | "locked"
  | "not_a_database"
  | "unsupported_format"
  | "permission_denied"
  | "unique_conflict"
  | "damaged_data"
  | "snapshot_expired"
  | "recovery_required"
  | "session_closed"
  | "read_only"
  | "busy"
  | "io"
  | "internal";

export interface AppError {
  category: ErrorCategory;
  message: string;
  detail: string | null;
  /** Where in a filter text the mistake is. */
  at?: TextPosition | null;
}

export interface TextPosition {
  /** From 1. */
  line: number;
  /** From 1, in characters. */
  column: number;
  /** From 0, in UTF-16 code units: a JavaScript string index. */
  index: number;
}

export interface TrunkdbBuild {
  version: string;
  revision: string;
}

export interface AppInfo {
  app_version: string;
  trunkdb: TrunkdbBuild;
}

export interface FileInfo {
  format_version: number;
  page_size: number;
  pages: number;
  free_pages: number;
  /** The trunkdb release that created the file (`0.24.0`); null where
   * the file doesn't say (trunkdb SPEC §125). */
  created_by: string | null;
  /** The trunkdb release that wrote the file last; null where an older
   * trunkdb did. */
  written_by: string | null;
}

export interface SessionInfo {
  session_id: string;
  path: string;
  file_name: string;
  /** false for a database opened read-only. */
  can_mutate: boolean;
  file: FileInfo;
}

export interface RecentFile {
  path: string;
  file_name: string;
  exists: boolean;
  /** Last opened read-only, and opened that way again. */
  read_only: boolean;
}

export interface Opened {
  session: SessionInfo;
  recent: RecentFile[];
}

export interface IndexSummary {
  /** In index order. */
  fields: string[];
  unique: boolean;
  sparse: boolean;
}

export interface CollectionSummary {
  name: string;
  /** false for a virtual collection: prepared in this session, not stored. */
  persisted: boolean;
  /** null when the count could not be read, which is not zero. */
  count: number | null;
  count_error: string | null;
  indexes: IndexSummary[];
}

export interface Overview {
  file: FileInfo;
  collections: CollectionSummary[];
}

export const OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "starts_with",
  "in",
  "not_in",
  "exists",
  "missing",
  "is_kind",
  "is_not_kind",
] as const;
export type Operator = (typeof OPERATORS)[number];

/** A kind of value for `is_kind`, as trunkdb's filter text names it (its SPEC §159). */
export const KINDS = [
  "string",
  "int",
  "float",
  "number",
  "bool",
  "date",
  "id",
  "array",
  "object",
  "binary",
] as const;
export type Kind = (typeof KINDS)[number];

export const VALUE_TYPES = ["string", "int", "float", "bool", "null", "date_time", "id"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** Always text, numbers included: the backend parses and validates it. */
export interface ValueInput {
  type: ValueType;
  text: string;
}

export interface ConditionInput {
  field: string;
  operator: Operator;
  /** The value of a comparison, contains and starts_with; null otherwise. */
  value: ValueInput | null;
  /** The values of in and not_in, all of one type; absent otherwise. */
  values?: ValueInput[];
  /** The kind of is_kind and is_not_kind; absent otherwise. */
  kind?: Kind;
}

/**
 * The list's filter: rows of typed conditions, all to hold, or a condition
 * in trunkdb's text (its SPEC §111). The frontend never
 * reads the text; trunkdb does.
 */
export type FilterInput = { rows: ConditionInput[] } | { text: string };

/** Filter text taken back into rows, or why it can't be. */
export type FilterRows = { rows: ConditionInput[] } | { reason: string };

/**
 * Which index the page is read by (trunkdb SPEC §132), where trunkdb's
 * rules would read another or none. The rows are the same with any hint.
 */
export type HintInput = { kind: "index"; fields: string[] } | { kind: "no_index" };

export interface SortInput {
  field: string;
  descending: boolean;
}

export interface QueryRequest {
  request_id: number;
  collection: string;
  filter: FilterInput;
  sort: SortInput;
  /** Zero-based. */
  page: number;
  page_size: number;
  /** The fields to read and show, as paths (trunkdb SPEC §106); `_id` comes too. null: whole documents. */
  select: string[] | null;
  /** Fields left out of whole documents (trunkdb SPEC §143); empty: none. Not with `select`. */
  except: string[];
  /** The index the page is read by; null: trunkdb's choice. Not for the count. */
  hint: HintInput | null;
}

export type ValueKind =
  | "null"
  | "bool"
  | "int"
  | "float"
  | "string"
  | "binary"
  | "array"
  | "object"
  | "id"
  | "date_time"
  | "unknown";

/** For display only; never a source to rebuild a value from. */
export interface Cell {
  kind: ValueKind;
  preview: string;
}

/** A document of the list: every document is an object with its ID (trunkdb SPEC §95). */
export interface ResultRow {
  id: string;
  /** The document as pretty tagged JSON, whole or its chosen fields, exactly as the backend wrote it. */
  json: string;
  /** The top-level fields, `_id` included, or `_id` and each chosen path; a missing field has no entry. */
  cells: Record<string, Cell>;
}

export interface QueryResult {
  request_id: number;
  total: number;
  page: number;
  page_size: number;
  page_count: number;
  rows: ResultRow[];
  columns: string[];
  /** The chosen fields the rows hold, checked and without repeats; null: whole documents. */
  select: string[] | null;
  /** The fields left out of the rows, checked and without repeats. */
  except: string[];
}

export type ColumnKind =
  "count" | "sum" | "avg" | "min" | "max" | "count_distinct" | "first" | "last";

/** A column besides the count, which every group has. */
export interface ColumnInput {
  kind: ColumnKind;
  /** The field it sums, averages or finds the extremes of; unused for a count. */
  field: string;
  /**
   * Which of the group's documents the column takes in, as trunkdb filter
   * text (its SPEC §126); empty: all of them. The groups and the other
   * columns still see every document.
   */
  condition: string;
  /** The field ordering the group's documents for first and last; empty: by ID. */
  by: string;
}

export interface GroupSort {
  /** A position in `GroupResult.columns`. */
  column: number;
  descending: boolean;
}

/** Documents counted by group (trunkdb SPEC §107). */
export interface GroupRequest {
  request_id: number;
  collection: string;
  /** The documents to group: the list's applied filter. */
  filter: FilterInput;
  /**
   * Arrays each document is made one per element of, in order, before
   * grouping (trunkdb SPEC §147); `items.sku` then names a field of one element.
   */
  unwind: string[];
  /** In order; empty: one group of every matching document. */
  group_by: string[];
  /** After the count. */
  columns: ColumnInput[];
  /** null: by the group values, ascending. */
  sort: GroupSort | null;
  /** Zero-based. */
  page: number;
  page_size: number;
}

export interface GroupColumn {
  /** The field path of a group field; `count`, `sum tries`, ... for the others. */
  label: string;
  /** Set for a group field, which holds the group's value. */
  group: boolean;
  /** null for a group field. */
  kind: ColumnKind | null;
}

export interface GroupRow {
  /** One per column, in column order. */
  cells: Cell[];
  /**
   * The filter's conditions and an `eq` per group field: exactly the
   * documents counted, as rows or as text like the request's filter.
   */
  documents: FilterInput | null;
  /** Why `documents` is null. */
  no_documents: string | null;
}

export interface GroupResult {
  request_id: number;
  /** Groups, before paging. */
  total: number;
  page: number;
  page_size: number;
  page_count: number;
  columns: GroupColumn[];
  rows: GroupRow[];
}

/** An object document for the editor: the ID apart, the rest as JSON text. */
export interface DocumentView {
  id: string;
  /** The object without its top-level `_id`, as pretty tagged JSON. */
  json: string;
}

export interface SaveRequest {
  collection: string;
  /** The document to replace; null inserts a new one. */
  id: string | null;
  /** The editor text, sent as it is. */
  json: string;
  /** The list's active filter, to learn whether the document still matches. */
  filter: FilterInput;
}

export interface SavedDocument {
  /** As stored now. */
  document: DocumentView;
  created: boolean;
  matches_filter: boolean;
}

export interface IndexRequest {
  collection: string;
  /** In index order. */
  fields: string[];
  unique: boolean;
  sparse: boolean;
}

/** The file's pages by what they hold; they add up to the file's pages. */
export interface PageUse {
  header: number;
  catalog: number;
  free: number;
  data: number;
  overflow: number;
  index: number;
  /** Claimed by nothing: a leak, which the consistency check names. */
  unaccounted: number;
}

export interface IndexStorage {
  /** `["_id"]` for the primary index. */
  fields: string[];
  entries: number;
  pages: number;
  depth: number;
  key_bytes: number;
}

export interface CollectionStorage {
  name: string;
  documents: number;
  data_pages: number;
  overflow_pages: number;
  /** The documents as stored (encoded). */
  document_bytes: number;
  /** Room left inside its data pages. */
  free_bytes: number;
  /** The primary index first. */
  indexes: IndexStorage[];
}

/** Where the file's space goes (trunkdb SPEC §93). */
export interface StorageReport {
  page_size: number;
  pages: number;
  page_use: PageUse;
  /** What a compaction would leave, worked out exactly by trunkdb. */
  compacted_pages: number;
  /** null when there is no write-ahead log file. */
  wal_bytes: number | null;
  /** Set when the open restored pages after an unclean shutdown. */
  /**
   * What the open restored from a WAL a crash left. `in_memory` for a
   * read-only open: shown from memory, the file unchanged.
   */
  recovered: { pages: number; in_memory: boolean } | null;
  /** Persisted collections, by name. */
  collections: CollectionStorage[];
}

/** The kind of plan trunkdb chose for a query. */
export type PlanKind = "scan" | "by_id" | "index" | "index_union" | "index_order" | "other";

export interface IndexReadReport {
  /** `_id` for the primary index, `(a, b)` for a compound one. */
  index: string;
  /** The conditions the read is bounded by, in trunkdb's filter text; empty: the whole index. */
  bounds: string[];
  backward: boolean;
  entries: number;
  /** Its entries decided which documents match (trunkdb SPEC §100). */
  covering: boolean;
}

/** How a page was read (trunkdb SPEC §94). */
/** A plan trunkdb passed over (its SPEC §133): what the query, hinted to it, would read. */
export interface AlternativeReport {
  plan: PlanKind;
  /** The indexes it reads; empty for a scan and a lookup by ID. */
  indexes: string[];
  /** Index entries it would read, every read together. */
  entries: number;
  /** `entries` is a lower bound: trunkdb stopped counting there. */
  more_than: boolean;
  /** It reads a document per entry to check it; false where the entries decide. */
  reads_documents: boolean;
  /** It would read fewer entries than the query did. */
  fewer: boolean;
  /** The hint that reads the page this way; null where none names it. */
  hint: HintInput | null;
}

export interface ExplainReport {
  request_id: number;
  plan: PlanKind;
  /** The plan is the one the request's hint asked for. */
  hinted: boolean;
  reads: IndexReadReport[];
  /** Sort keys from the index order and sorted in memory. */
  sort: { from_index: number; in_memory: number } | null;
  skip: number;
  limit: number;
  keys_examined: number;
  documents_examined: number;
  /** The skipped included. */
  documents_matched: number;
  documents_returned: number;
  /** Matches taken from their index entries, their documents not read (trunkdb SPEC §106.5, §107.5). */
  from_entries: number;
  /** The groups made, for groups (trunkdb SPEC §107.6); null for a page of documents. */
  groups: number | null;
  elapsed_micros: number;
  /** The plans passed over, for a page of documents; empty for groups. */
  alternatives: AlternativeReport[];
}

export interface CheckReport {
  collections: number;
  documents: number;
  pages: number;
  /** Empty means the check found nothing wrong. */
  problems: string[];
}

export interface ExportSummary {
  path: string;
  collections: number;
  documents: number;
  bytes: number;
}

/** What a compaction did; equal pages: nothing was written. */
export interface CompactReport {
  pages_before: number;
  pages_after: number;
  page_size: number;
}

/** An export imported into a new database. */
export interface ImportSummary {
  /** The new database. */
  path: string;
  collections: number;
  documents: number;
  bytes: number;
}

/** Asks for the field paths of a collection's documents. */
export interface FieldPathsRequest {
  request_id: number;
  collection: string;
}

export interface KindCount {
  kind: ValueKind;
  /** Documents with a value of this kind at the path. */
  documents: number;
}

export interface FieldPath {
  /** As the path inputs take it: `address.city`, `tags[*].k`. */
  path: string;
  /** As a filter's text writes it, names in backticks where they must be. */
  text: string;
  /** false: a name on the way has a `.` or `[*]`; never suggested. */
  nameable: boolean;
  /** Documents with a value here, null included; missing isn't. */
  documents: number;
  /** Most first. */
  kinds: KindCount[];
}

/** Every document read and counted, as `trunkdb fields` counts. */
export interface FieldPaths {
  request_id: number;
  documents: number;
  paths: FieldPath[];
  /** Paths were left out past 10,000. */
  truncated: boolean;
}
