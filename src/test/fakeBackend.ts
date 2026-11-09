import type { Backend } from "../ipc/backend";
import type {
  ConditionInput,
  FieldPathsRequest,
  FilterRows,
  GroupRequest,
  Opened,
  QueryRequest,
  SaveRequest,
} from "../ipc/types";
import {
  collection,
  explainOf,
  fieldPath,
  fieldPathsOf,
  groupsExplainOf,
  groupsFor,
  overviewOf,
  recentFile,
  resultFor,
  sessionInfo,
  storageOf,
} from "./fakeBackend.data";

export * from "./fakeBackend.data";

/** A backend that answers plausibly; tests override what they examine. */
export function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  const opened = (path: string, readOnly = false): Opened => ({
    session: sessionInfo(path, "s1", readOnly),
    recent: [recentFile(path, true, readOnly)],
  });
  return {
    appInfo: vi.fn(async () => ({
      app_version: "0.1.0",
      trunkdb: { version: "0.37.0", revision: "b3be82bd39fd603bd4665ee206588ab39e3a6ce0" },
    })),
    recentList: vi.fn(async () => []),
    recentRemove: vi.fn(async () => []),
    pickDatabaseToOpen: vi.fn(async () => null),
    pickDatabaseToCreate: vi.fn(async () => null),
    databaseOpen: vi.fn(async (path: string, readOnly: boolean) => opened(path, readOnly)),
    databaseCreate: vi.fn(async (path: string) => opened(path)),
    sessionClose: vi.fn(async () => undefined),
    sessionOverview: vi.fn(async () => overviewOf()),
    collectionPrepare: vi.fn(async (_session: string, name: string) =>
      overviewOf(collection(name, 0, false)),
    ),
    collectionDiscardVirtual: vi.fn(async () => overviewOf()),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, []),
    ),
    collectionExplain: vi.fn(async (_session: string, request: QueryRequest) => explainOf(request)),
    collectionFieldPaths: vi.fn(async (_session: string, request: FieldPathsRequest) =>
      fieldPathsOf(
        request,
        3,
        fieldPath("_id", 3, [["id", 3]]),
        fieldPath("name", 3),
        fieldPath("age", 2, [
          ["int", 2],
          ["null", 1],
        ]),
        fieldPath("tags", 2, [["array", 2]]),
        fieldPath("tags[*]", 1),
      ),
    ),
    collectionFindCommand: vi.fn(
      async (_session: string, request: QueryRequest) => `trunkdb find /data ${request.collection}`,
    ),
    queryStatement: vi.fn(
      async (request: QueryRequest) =>
        `let collection = db.collection::<Document>("${request.collection}");`,
    ),
    groupsStatement: vi.fn(
      async (request: GroupRequest) =>
        `let aggregate = Aggregate::new()${request.group_by.map((f) => `.group_by("${f}")`).join("")};`,
    ),
    filterToText: vi.fn(async (rows: ConditionInput[]) =>
      rows.map((row) => `${row.field} = ${JSON.stringify(row.value?.text ?? null)}`).join(" and "),
    ),
    filterToRows: vi.fn(async (): Promise<FilterRows> => ({ rows: [] })),
    collectionGroups: vi.fn(async (_session: string, request: GroupRequest) =>
      groupsFor(request, []),
    ),
    collectionGroupsExplain: vi.fn(async (_session: string, request: GroupRequest) =>
      groupsExplainOf(request),
    ),
    collectionDrop: vi.fn(async () => overviewOf()),
    documentRead: vi.fn(async (_session: string, _collection: string, id: string) => ({
      id,
      json: '{\n  "name": "Ann"\n}',
    })),
    documentFormat: vi.fn(async (json: string) => json),
    documentSave: vi.fn(async (_session: string, request: SaveRequest) => ({
      document: { id: request.id ?? "new-id", json: request.json },
      created: request.id === null,
      matches_filter: true,
    })),
    documentDelete: vi.fn(async () => undefined),
    indexCreate: vi.fn(async () => overviewOf()),
    indexDrop: vi.fn(async () => overviewOf()),
    databaseStorage: vi.fn(async () => storageOf()),
    databaseCheck: vi.fn(async () => ({ collections: 2, documents: 4, pages: 12, problems: [] })),
    pickExportDestination: vi.fn(async () => null),
    databaseCompact: vi.fn(async () => ({ pages_before: 12, pages_after: 9, page_size: 8192 })),
    pickExportToImport: vi.fn(async () => null),
    pickImportDestination: vi.fn(async () => null),
    databaseImport: vi.fn(async (_source: string, destination: string) => ({
      path: destination,
      collections: 2,
      documents: 4,
      bytes: 32768,
    })),
    databaseExport: vi.fn(async (_session: string, destination: string) => ({
      path: destination,
      collections: 2,
      documents: 4,
      bytes: 512,
    })),
    onQuitRequested: vi.fn(() => () => undefined),
    setUnsavedDraft: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    ...overrides,
  };
}
