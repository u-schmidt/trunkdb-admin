import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type {
  ExplainReport,
  QueryRequest,
  QueryResult,
  ResultRow,
  StorageReport,
} from "../../ipc/types";
import {
  appError,
  collection,
  deferred,
  explainOf,
  fakeBackend,
  objectRow,
  overviewOf,
  resultFor,
  sessionInfo,
  storageOf,
} from "../../test/fakeBackend";
import { Workspace } from "./Workspace";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

function renderWorkspace(backend: Backend, readOnly = false) {
  render(
    <BackendProvider value={backend}>
      <DraftGuardProvider>
        <Workspace
          session={sessionInfo("/data/shop.trunkdb", "s1", readOnly)}
          appInfo={null}
          closing={false}
          switching={false}
          onClose={() => undefined}
          onSwitchMode={() => undefined}
          onOpenOther={() => undefined}
        />
      </DraftGuardProvider>
    </BackendProvider>,
  );
  return userEvent.setup();
}

const sidebar = () => screen.getByRole("navigation", { name: "Database" });
const openCollection = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(await within(sidebar()).findByRole("button", { name: new RegExp(`^${name}`) }));

/** The requests the UI sent, in order. */
const requests = (backend: Backend): QueryRequest[] =>
  vi.mocked(backend.collectionQuery).mock.calls.map(([, request]) => request);
const lastRequest = (backend: Backend) => requests(backend).at(-1) as QueryRequest;

const ROWS: ResultRow[] = [
  objectRow("id-1", {
    name: { kind: "string", preview: "Ann" },
    note: { kind: "null", preview: "null" },
    nested: { kind: "object", preview: '{"deep":[1,2]}' },
  }),
  objectRow("id-2", { name: { kind: "string", preview: "true" } }),
  objectRow("id-3", { tags: { kind: "array", preview: "[1,2]" } }),
];

/** A backend with one stored collection answering every query with ROWS. */
function peopleBackend(overrides: Partial<Backend> = {}) {
  return fakeBackend({
    sessionOverview: vi.fn(async () => overviewOf(collection("people", 120))),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, ROWS, 120),
    ),
    ...overrides,
  });
}

describe("overview", () => {
  it("lists collections and tells an unavailable count from zero", async () => {
    const backend = fakeBackend({
      sessionOverview: vi.fn(async () =>
        overviewOf(
          collection("empty", 0),
          { ...collection("broken"), count: null, count_error: "page 7 is damaged" },
          collection("people", 1234),
          collection("draft", 0, false),
        ),
      ),
    });
    renderWorkspace(backend);

    const nav = sidebar();
    expect(await within(nav).findByRole("button", { name: /^empty\s*0$/ })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^people\s*1,234$/ })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^broken\s*count unavailable$/ })).toBeVisible();
    expect(within(nav).getByRole("button", { name: /^draft\s*Not saved$/ })).toBeInTheDocument();
    expect(backend.sessionOverview).toHaveBeenCalledWith("s1");
    expect(backend.collectionQuery).not.toHaveBeenCalled();
  });

  it("names the releases that wrote and created the file, or says why not", async () => {
    const backend = fakeBackend({
      sessionOverview: vi.fn(async () => {
        const overview = overviewOf(collection("people", 2));
        return { ...overview, file: { ...overview.file, created_by: null, written_by: "0.24.0" } };
      }),
    });
    renderWorkspace(backend);

    const facts = await screen.findByRole("region", { name: "File" });
    const fact = (name: string) =>
      within(facts).getByText(name, { selector: "dt" }).nextElementSibling;
    await waitFor(() => expect(fact("Last written by")).toHaveTextContent("trunkdb 0.24.0"));
    expect(fact("Created by")).toHaveTextContent(
      "Unknown: the file is from before trunkdb 0.24.0, or an older trunkdb wrote it since",
    );
  });

  it("reports a failed overview and loads it again on request", async () => {
    const sessionOverview = vi
      .fn<Backend["sessionOverview"]>()
      .mockRejectedValueOnce(appError("damaged_data", "The database file is damaged."))
      .mockResolvedValue(overviewOf(collection("people", 2)));
    const user = renderWorkspace(fakeBackend({ sessionOverview }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The database file is damaged.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await within(sidebar()).findByRole("button", { name: /^people\s*2$/ })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("storage", () => {
  const storagePanel = async () =>
    (await screen.findByRole("heading", { name: "Storage" })).closest("section") as HTMLElement;

  it("shows where the space goes, by kind and by collection, and what compacting frees", async () => {
    const backend = fakeBackend({
      sessionOverview: vi.fn(async () => overviewOf(collection("people", 10))),
      databaseStorage: vi.fn(async () =>
        storageOf({ pages: 40, compacted_pages: 30, wal_bytes: 2048 }, "people"),
      ),
    });
    renderWorkspace(backend);

    const panel = await storagePanel();
    await within(panel).findByText("320.0 KiB (40 pages)");
    expect(panel).toHaveTextContent("would free 80.0 KiB (10 of 40 pages)");
    expect(panel).toHaveTextContent("Write-ahead log2.0 KiB");
    const table = within(panel).getByRole("table", { name: "Storage by collection" });
    const [, row] = within(table).getAllByRole("row");
    expect(row).toHaveTextContent(
      /people\s*10\s*2\.0 KiB\s*8\.0 KiB\s*5\.9 KiB\s*8\.0 KiB · 1 index/,
    );
    expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
    expect(backend.databaseStorage).toHaveBeenCalledWith("s1");
  });

  it("says so when the open recovered after an unclean shutdown, and when compacting gains nothing", async () => {
    renderWorkspace(
      fakeBackend({
        databaseStorage: vi.fn(async () =>
          storageOf({
            recovered: { pages: 3, in_memory: false },
            compacted_pages: 12,
            wal_bytes: null,
          }),
        ),
      }),
    );

    const panel = await storagePanel();
    expect(await within(panel).findByRole("status")).toHaveTextContent(
      "opened after an unclean shutdown: 3 pages were restored from the write-ahead log",
    );
    expect(panel).toHaveTextContent("would not make the file smaller");
    expect(panel).toHaveTextContent("Write-ahead lognone");
  });

  it("refreshes on request and shows only the newest answer", async () => {
    const late = deferred<StorageReport>();
    const databaseStorage = vi
      .fn<Backend["databaseStorage"]>()
      .mockResolvedValueOnce(storageOf({ pages: 12 }))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(storageOf({ pages: 99, compacted_pages: 99 }));
    const user = renderWorkspace(fakeBackend({ databaseStorage }));
    const panel = await storagePanel();
    await within(panel).findByText("96.0 KiB (12 pages)");

    await user.click(within(panel).getByRole("button", { name: "Refresh" }));
    // While it reads, the last report stays, and Refresh waits.
    expect(within(panel).getByRole("button", { name: "Reading…" })).toBeDisabled();
    expect(panel).toHaveTextContent("96.0 KiB (12 pages)");
    late.resolve(storageOf({ pages: 50 }));
    await within(panel).findByText("400.0 KiB (50 pages)");
    expect(databaseStorage).toHaveBeenCalledTimes(2);
  });

  it("reports a report it could not read, and where to look for damage", async () => {
    renderWorkspace(
      fakeBackend({
        databaseStorage: vi.fn(async () => {
          throw appError("damaged_data", "The database file is damaged or incomplete.");
        }),
      }),
    );

    const panel = await storagePanel();
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("The sizes could not be read.");
    expect(alert).toHaveTextContent("The consistency check below says what is damaged.");
  });

  it("is read when the database page is shown, not with each overview refresh", async () => {
    const backend = fakeBackend({
      sessionOverview: vi.fn(async () => overviewOf(collection("people", 2))),
    });
    const user = renderWorkspace(backend);
    await storagePanel();
    await waitFor(() => expect(backend.databaseStorage).toHaveBeenCalledTimes(1));

    await openCollection(user, "people");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(backend.sessionOverview).toHaveBeenCalledTimes(2));
    expect(backend.databaseStorage).toHaveBeenCalledTimes(1);

    await user.click(within(sidebar()).getByRole("button", { name: "Database" }));
    await storagePanel();
    await waitFor(() => expect(backend.databaseStorage).toHaveBeenCalledTimes(2));
  });
});

describe("virtual collections", () => {
  it("adds one, opens it, and says it is not saved", async () => {
    const backend = fakeBackend();
    const user = renderWorkspace(backend);

    await user.type(await screen.findByLabelText("New collection"), "drafts");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(backend.collectionPrepare).toHaveBeenCalledWith("s1", "drafts");
    expect(await screen.findByRole("heading", { name: "drafts" })).toBeVisible();
    expect(await screen.findByText(/not saved yet/)).toBeVisible();
    expect(screen.getByLabelText("New collection")).toHaveValue("");
  });

  it("keeps a refused name in the field with the reason", async () => {
    const backend = fakeBackend({
      collectionPrepare: vi.fn(async () => {
        throw appError("already_exists", "A collection named “people” already exists.");
      }),
    });
    const user = renderWorkspace(backend);

    await user.type(await screen.findByLabelText("New collection"), "people");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByLabelText("New collection")).toHaveValue("people");
    expect(screen.getByLabelText("New collection")).toBeInvalid();
  });

  it("removes one from view and returns to the database overview", async () => {
    const backend = fakeBackend({
      sessionOverview: vi.fn(async () => overviewOf(collection("drafts", 0, false))),
    });
    const user = renderWorkspace(backend);
    await openCollection(user, "drafts");
    await screen.findByRole("heading", { name: "drafts" });

    await user.click(screen.getByRole("button", { name: "Remove unsaved collection drafts" }));

    expect(backend.collectionDiscardVirtual).toHaveBeenCalledWith("s1", "drafts");
    expect(await screen.findByRole("heading", { name: "File" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "drafts" })).not.toBeInTheDocument();
  });
});

describe("results", () => {
  it("asks the backend for the first page in _id order and shows JSON by default", async () => {
    const backend = peopleBackend();
    const user = renderWorkspace(backend);

    await openCollection(user, "people");

    const list = await screen.findByRole("list", { name: "Documents as JSON" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(lastRequest(backend)).toMatchObject({
      collection: "people",
      filter: { rows: [] },
      sort: { field: "_id", descending: false },
      page: 0,
      page_size: 50,
    });
    expect(screen.getByRole("status")).toHaveTextContent("120 documents · page 1 of 3");
  });

  it("shows the same page as a table without asking again", async () => {
    const backend = peopleBackend();
    const user = renderWorkspace(backend);
    await openCollection(user, "people");
    await screen.findByRole("list", { name: "Documents as JSON" });

    await user.click(screen.getByRole("button", { name: "Table" }));

    const table = screen.getByRole("table", { name: "Documents as table" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    // Sorted by _id, the default.
    expect(headers).toEqual(["_id ▲", "name", "nested", "note", "tags"]);
    const [, first, second, third] = within(table).getAllByRole("row");
    // A stored null and a field that is not there look different.
    expect(within(first as HTMLElement).getByText("null")).toBeVisible();
    expect(within(second as HTMLElement).getAllByText("missing")).toHaveLength(3);
    // The string "true" is quoted, so it cannot pass for the Bool.
    expect(within(second as HTMLElement).getByText('"true"')).toBeVisible();
    expect(within(first as HTMLElement).getByText('{"deep":[1,2]}')).toBeVisible();
    expect(within(third as HTMLElement).getByText("[1,2]")).toBeVisible();
    expect(requests(backend)).toHaveLength(1);
  });

  it("opens a row for editing, by keyboard too", async () => {
    const backend = peopleBackend();
    const user = renderWorkspace(backend);
    await openCollection(user, "people");
    await screen.findByRole("list", { name: "Documents as JSON" });
    await user.click(screen.getByRole("button", { name: "Table" }));
    const [, first, , third] = screen.getAllByRole("row");

    await user.click(first as HTMLElement);
    const editor = await screen.findByRole("complementary", { name: "Document editor" });
    expect(within(editor).getByText("id-1")).toBeVisible();
    expect(backend.documentRead).toHaveBeenCalledWith("s1", "people", "id-1");
    expect(within(editor).getByRole("button", { name: "Delete…" })).toBeEnabled();

    // Every document is an object with its ID (trunkdb SPEC §95).
    (third as HTMLElement).focus();
    await user.keyboard("{Enter}");
    expect(await within(editor).findByText("id-3")).toBeVisible();
    expect(backend.documentRead).toHaveBeenCalledWith("s1", "people", "id-3");
  });

  it("tells an empty collection from a filter without matches", async () => {
    const backend = peopleBackend({
      collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
        resultFor(request, []),
      ),
    });
    const user = renderWorkspace(backend);
    await openCollection(user, "people");

    expect(await screen.findByText("This collection has no documents.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "name");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("No documents match the filter.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Documents as JSON" })).not.toBeInTheDocument();
  });
});

describe("filter, sort and paging", () => {
  async function openPeople(backend: Backend) {
    const user = renderWorkspace(backend);
    await openCollection(user, "people");
    await screen.findByRole("list", { name: "Documents as JSON" });
    return user;
  }

  it("sends typed values as text and only on Run", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "address.zip");
    await user.selectOptions(screen.getByLabelText("Condition 1 operator"), "gte");
    await user.selectOptions(screen.getByLabelText("Condition 1 value type"), "int");
    await user.type(screen.getByLabelText("Condition 1 value"), "9007199254740993");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 2 field path"), "note");
    await user.selectOptions(screen.getByLabelText("Condition 2 operator"), "missing");

    expect(requests(backend)).toHaveLength(1);
    expect(screen.getByText("Not applied yet")).toBeVisible();
    expect(screen.queryByLabelText("Condition 2 value")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(requests(backend)).toHaveLength(2));
    expect(lastRequest(backend).filter).toEqual({
      rows: [
        // Beyond what a JavaScript number holds exactly: it must stay text.
        { field: "address.zip", operator: "gte", value: { type: "int", text: "9007199254740993" } },
        { field: "note", operator: "missing", value: null },
      ],
    });
    await waitFor(() => expect(screen.queryByText("Not applied yet")).not.toBeInTheDocument());
  });

  it("makes contains a String search and null a value without text", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "name");
    await user.selectOptions(screen.getByLabelText("Condition 1 value type"), "int");
    await user.selectOptions(screen.getByLabelText("Condition 1 operator"), "contains");
    expect(screen.getByLabelText("Condition 1 value type")).toBeDisabled();
    await user.type(screen.getByLabelText("Condition 1 value"), "ann");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 2 field path"), "note");
    await user.selectOptions(screen.getByLabelText("Condition 2 value type"), "null");
    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(requests(backend)).toHaveLength(2));
    expect(lastRequest(backend).filter).toEqual({
      rows: [
        { field: "name", operator: "contains", value: { type: "string", text: "ann" } },
        { field: "note", operator: "eq", value: { type: "null", text: "" } },
      ],
    });
  });

  it("sends a Bool value as its menu shows it, true before any choice", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "active");
    await user.type(screen.getByLabelText("Condition 1 value"), "yes");
    await user.selectOptions(screen.getByLabelText("Condition 1 value type"), "bool");
    expect(screen.getByLabelText("Condition 1 value")).toHaveValue("true");
    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(requests(backend)).toHaveLength(2));
    expect(lastRequest(backend).filter).toEqual({
      rows: [{ field: "active", operator: "eq", value: { type: "bool", text: "true" } }],
    });
  });

  it("pages in the backend and returns to the first page on filter, sort and size changes", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));
    const page = () => lastRequest(backend).page;

    await next();
    await waitFor(() => expect(page()).toBe(1));
    expect(await screen.findByText(/page 2 of 3/)).toBeVisible();

    // The direction applies at once, without Run.
    await user.selectOptions(screen.getByLabelText("Sort direction"), "desc");
    await waitFor(() =>
      expect(lastRequest(backend)).toMatchObject({
        sort: { field: "_id", descending: true },
        page: 0,
      }),
    );
    await user.clear(screen.getByLabelText("Sort by"));
    await user.type(screen.getByLabelText("Sort by"), "name{Enter}");
    await waitFor(() =>
      expect(lastRequest(backend)).toMatchObject({
        sort: { field: "name", descending: true },
        page: 0,
      }),
    );

    await screen.findByText(/page 1 of 3/);
    await next();
    await waitFor(() => expect(page()).toBe(1));
    await screen.findByText(/page 2 of 3/);
    await user.selectOptions(screen.getByLabelText("Per page"), "100");
    await waitFor(() =>
      expect(lastRequest(backend)).toMatchObject({
        page: 0,
        page_size: 100,
        sort: { field: "name", descending: true },
      }),
    );

    await screen.findByText(/page 1 of 2/);
    await next();
    await waitFor(() => expect(page()).toBe(1));
    await screen.findByText(/page 2 of 2/);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(requests(backend)).toHaveLength(8));
    // Refresh reads the same page again, and the counts with it.
    expect(lastRequest(backend)).toMatchObject({ page: 1, page_size: 100 });
    expect(backend.sessionOverview).toHaveBeenCalledTimes(2);
  });

  it("applies a sort field on leaving it, without conditions that were not run", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "age");
    const before = requests(backend).length;

    await user.clear(screen.getByLabelText("Sort by"));
    await user.type(screen.getByLabelText("Sort by"), "name");
    // Typing alone asks nothing.
    expect(requests(backend)).toHaveLength(before);
    await user.tab();

    await waitFor(() =>
      expect(lastRequest(backend)).toMatchObject({
        sort: { field: "name", descending: false },
        filter: { rows: [] },
        page: 0,
      }),
    );
    expect(requests(backend)).toHaveLength(before + 1);
    expect(screen.getByText("Not applied yet")).toBeVisible();
  });

  it("an emptied sort field means _id", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);
    await user.clear(screen.getByLabelText("Sort by"));
    await user.selectOptions(screen.getByLabelText("Sort direction"), "desc");

    await waitFor(() =>
      expect(lastRequest(backend)).toMatchObject({ sort: { field: "_id", descending: true } }),
    );
    expect(screen.getByLabelText("Sort by")).toHaveValue("_id");
  });

  it("keeps a sort field being typed when an earlier sort's answer arrives", async () => {
    const slow = deferred<QueryResult>();
    const collectionQuery = vi.fn(async (_session: string, request: QueryRequest) =>
      request.sort.descending ? slow.promise : resultFor(request, ROWS, 120),
    );
    const user = await openPeople(peopleBackend({ collectionQuery }));
    await user.selectOptions(screen.getByLabelText("Sort direction"), "desc");
    await user.clear(screen.getByLabelText("Sort by"));
    await user.type(screen.getByLabelText("Sort by"), "na");

    const [, request] = collectionQuery.mock.calls.at(-1) as [string, QueryRequest];
    slow.resolve(resultFor(request, ROWS, 120));

    await waitFor(() => expect(screen.getByLabelText("Sort direction")).toHaveValue("desc"));
    expect(screen.getByLabelText("Sort by")).toHaveValue("na");
  });

  it("sorts by a table column on click, and reverses on a second click", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Table" }));
    const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });

    await user.click(within(header("name")).getByRole("button"));
    await waitFor(() =>
      expect(lastRequest(backend)).toMatchObject({
        sort: { field: "name", descending: false },
        page: 0,
      }),
    );
    await waitFor(() => expect(header("name")).toHaveAttribute("aria-sort", "ascending"));
    expect(header("_id")).not.toHaveAttribute("aria-sort");
    // The sort field follows.
    expect(screen.getByLabelText("Sort by")).toHaveValue("name");

    await user.click(within(header("name")).getByRole("button"));
    await waitFor(() =>
      expect(lastRequest(backend)).toMatchObject({ sort: { field: "name", descending: true } }),
    );
    await waitFor(() => expect(header("name")).toHaveAttribute("aria-sort", "descending"));
    expect(screen.getByLabelText("Sort direction")).toHaveValue("desc");
  });

  it("follows the backend to the last page when the requested one is gone", async () => {
    // Documents were removed meanwhile: page 3 of 3 became page 2 of 2.
    const collectionQuery = vi.fn(async (_session: string, request: QueryRequest) =>
      request.page >= 2
        ? { ...resultFor(request, ROWS, 80), page: 1 }
        : resultFor(request, ROWS, 120),
    );
    const backend = peopleBackend({ collectionQuery });
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/page 2 of 3/);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText(/80 documents · page 2 of 2/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    // A refresh asks for the page that is shown, not the one that was gone.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(lastRequest(backend).page).toBe(1));
  });

  it("keeps the listed result when the backend refuses the input", async () => {
    const collectionQuery = vi.fn(async (_session: string, request: QueryRequest) => {
      if ("rows" in request.filter && request.filter.rows.length > 0) {
        throw appError("invalid_input", "Condition 1: “abc” is not a whole number.");
      }
      return resultFor(request, ROWS, 120);
    });
    const backend = peopleBackend({ collectionQuery });
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "age");
    await user.selectOptions(screen.getByLabelText("Condition 1 value type"), "int");
    await user.type(screen.getByLabelText("Condition 1 value"), "abc");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("is not a whole number");
    // The entered condition stays to be corrected; the old list stays too,
    // still marked as not being the answer to what is entered.
    expect(screen.getByLabelText("Condition 1 value")).toHaveValue("abc");
    expect(screen.getByRole("list", { name: "Documents as JSON" })).toBeVisible();
    expect(screen.getByText("Not applied yet")).toBeVisible();
  });

  it("ignores an answer that arrives after a newer request", async () => {
    const slow = deferred<QueryResult>();
    let first: QueryRequest | undefined;
    const collectionQuery = vi.fn((_session: string, request: QueryRequest) => {
      if (first === undefined) {
        first = request;
        return slow.promise;
      }
      return Promise.resolve(resultFor(request, [objectRow("newer")], 1));
    });
    const backend = peopleBackend({ collectionQuery });
    const user = renderWorkspace(backend);
    await openCollection(user, "people");
    await waitFor(() => expect(first).toBeDefined());

    // Run again while the first request is still out.
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "name{Enter}");
    expect(await screen.findByText("newer")).toBeVisible();

    slow.resolve(resultFor(first as QueryRequest, [objectRow("stale")], 99));
    await waitFor(() => expect(collectionQuery).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(screen.queryByText("stale")).not.toBeInTheDocument();
    expect(screen.getByText("newer")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("1 document");
  });

  it("starts another collection with its own filter and first page", async () => {
    const backend = peopleBackend({
      sessionOverview: vi.fn(async () =>
        overviewOf(collection("orders", 5), collection("people", 120)),
      ),
    });
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "name{Enter}");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastRequest(backend).page).toBe(1));

    await openCollection(user, "orders");

    await waitFor(() => expect(lastRequest(backend).collection).toBe("orders"));
    expect(lastRequest(backend)).toMatchObject({ filter: { rows: [] }, page: 0 });
    expect(screen.queryByLabelText("Condition 1 field path")).not.toBeInTheDocument();
  });

  it("keeps filter and page while the indexes are shown", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/page 2 of 3/);

    await user.click(screen.getByRole("button", { name: "Indexes" }));
    expect(screen.getByRole("table", { name: "Indexes" })).toHaveTextContent("Primary");
    await user.click(screen.getByRole("button", { name: "Documents" }));

    expect(screen.getByText(/page 2 of 3/)).toBeVisible();
    expect(requests(backend)).toHaveLength(2);
  });
});

describe("explain", () => {
  async function openPeople(backend: Backend) {
    const user = renderWorkspace(backend);
    await openCollection(user, "people");
    await screen.findByRole("list", { name: "Documents as JSON" });
    return user;
  }
  const panel = () => screen.getByRole("region", { name: "How this page is read" });
  const explainRequests = (backend: Backend): QueryRequest[] =>
    vi.mocked(backend.collectionExplain).mock.calls.map(([, request]) => request);

  it("explains the page shown: plan, reads, counts and sort", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/page 2 of 3/);

    await user.click(screen.getByRole("button", { name: "Explain" }));

    await within(panel()).findByText(/read the primary index in sort order and stopped/);
    expect(explainRequests(backend)).toEqual([
      expect.objectContaining({
        collection: "people",
        filter: { rows: [] },
        sort: { field: "_id", descending: false },
        page: 1,
        page_size: 50,
      }),
    ]);
    expect(panel()).toHaveTextContent("The order came from the index.");
    // Its entries decided (trunkdb §100): only the page read.
    expect(panel()).toHaveTextContent(
      "The index entries decided which documents match, so trunkdb read only the documents shown.",
    );
    expect(panel()).toHaveTextContent("Documents read50");
    expect(panel()).toHaveTextContent("those on earlier pages included");
    expect(panel()).toHaveTextContent("1.5 ms");
    const reads = within(panel()).getByRole("table", { name: "Index reads" });
    expect(within(reads).getAllByRole("row")[1]).toHaveTextContent("_idthe whole indexforward100");
  });

  it("shows bounds and an index walked in order, and names an index the sort lacks", async () => {
    const answers: Partial<ExplainReport>[] = [
      { sort: { from_index: 0, in_memory: 1 } },
      {
        plan: "index_order",
        reads: [
          { index: "name", bounds: ['name >= "B"'], backward: true, entries: 51, covering: false },
        ],
        sort: { from_index: 1, in_memory: 0 },
      },
    ];
    const backend = peopleBackend({
      collectionExplain: vi.fn(async (_session: string, request: QueryRequest) =>
        explainOf(request, answers.shift()),
      ),
    });
    const user = await openPeople(backend);
    await user.clear(screen.getByLabelText("Sort by"));
    await user.type(screen.getByLabelText("Sort by"), "name{Enter}");
    await waitFor(() => expect(lastRequest(backend).sort.field).toBe("name"));

    await user.click(screen.getByRole("button", { name: "Explain" }));
    await within(panel()).findByText(/An index on “name” could let trunkdb stop/);

    // A new list result is explained again without asking.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await within(panel()).findByText(/read the index on name in sort order, backward,/);
    expect(panel()).toHaveTextContent("The order came from the index.");
    expect(panel()).toHaveTextContent('name >= "B"backward51');
  });

  it("says how many documents an index range read in vain, and none when every one matched", async () => {
    const answers: Partial<ExplainReport>[] = [
      {
        plan: "index",
        reads: [
          { index: "age", bounds: ["age < 40"], backward: false, entries: 82, covering: false },
        ],
        sort: { from_index: 0, in_memory: 1 },
        keys_examined: 82,
        documents_examined: 82,
        documents_matched: 80,
      },
      {
        plan: "index",
        reads: [
          { index: "age", bounds: ["age > 2.0"], backward: false, entries: 2, covering: false },
        ],
        keys_examined: 2,
        documents_examined: 2,
        documents_matched: 2,
      },
      {
        // Entries decided, but the sort needed documents beyond the page.
        plan: "index",
        reads: [
          { index: "age", bounds: ["age < 9"], backward: false, entries: 90, covering: true },
        ],
        keys_examined: 90,
        documents_examined: 80,
        documents_matched: 80,
      },
    ];
    const backend = peopleBackend({
      collectionExplain: vi.fn(async (_session: string, request: QueryRequest) =>
        explainOf(request, answers.shift()),
      ),
    });
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Explain" }));
    await within(panel()).findByText(
      "trunkdb used the index on age and looked only at the range below.",
    );
    expect(panel()).not.toHaveTextContent("The index entries decided");
    expect(panel()).toHaveTextContent("2 documents were read but did not match");
    // Sorted by _id, found through another index: sorted in memory.
    expect(panel()).toHaveTextContent("found its documents by ID or through another index");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await within(panel()).findByText("age > 2.0");
    expect(panel()).not.toHaveTextContent("did not match");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await within(panel()).findByText("age < 9");
    expect(panel()).toHaveTextContent(
      "The index entries decided which documents match; documents were read only where the page needed them.",
    );
    expect(panel()).not.toHaveTextContent("did not match");
  });

  it("follows the list while open, and stops when closed", async () => {
    const backend = peopleBackend();
    const user = await openPeople(backend);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Explain" }));
    await within(panel()).findByText(/read the primary index in sort order/);
    expect(explainRequests(backend).map((request) => request.page)).toEqual([0]);

    await next();
    await screen.findByText(/page 2 of 3/);
    await waitFor(() => expect(explainRequests(backend).map((r) => r.page)).toEqual([0, 1]));
    await user.selectOptions(screen.getByLabelText("Sort direction"), "desc");
    await waitFor(() =>
      expect(explainRequests(backend).at(-1)).toMatchObject({
        sort: { field: "_id", descending: true },
        page: 0,
      }),
    );
    // One explanation per list result, however often the panel renders.
    expect(explainRequests(backend)).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Explain" }));
    expect(screen.queryByRole("region", { name: "How this page is read" })).not.toBeInTheDocument();
    await next();
    await screen.findByText(/page 2 of 3/);
    expect(explainRequests(backend)).toHaveLength(3);
  });

  it("reports a failure, and drops an answer that arrives after Close", async () => {
    const late = deferred<ExplainReport>();
    const explain = vi
      .fn()
      .mockRejectedValueOnce(appError("damaged_data", "A page is damaged."))
      .mockReturnValueOnce(late.promise);
    const backend = peopleBackend({ collectionExplain: explain });
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Explain" }));
    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      "The query could not be explained. A page is damaged.",
    );

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(panel()).toHaveAttribute("aria-busy", "true"));
    expect(panel()).toHaveTextContent("Reading…");
    await user.click(within(panel()).getByRole("button", { name: "Close" }));
    late.resolve(explainOf(lastRequest(backend), { request_id: 2 }));
    await late.promise;

    expect(screen.queryByRole("region", { name: "How this page is read" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
