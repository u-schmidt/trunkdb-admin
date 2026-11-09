import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { Backend } from "../ipc/backend";
import { BackendProvider } from "../ipc/BackendContext";
import type { QueryRequest, SavedDocument, SaveRequest } from "../ipc/types";
import {
  appError,
  collection,
  deferred,
  fakeBackend,
  objectRow,
  overviewOf,
  recentFile,
  resultFor,
} from "../test/fakeBackend";
import { App } from "./App";

vi.mock("../components/JsonEditor", async () => await import("../test/PlainJsonEditor"));

const STORED = '{\n  "name": "Ann",\n  "big": 9007199254740993,\n  "ratio": 2.0\n}';
const EDITED = '{\n  "name": "Ann B.",\n  "big": 9007199254740993,\n  "ratio": 2.0\n}';

/** What the test backend was asked to do on quit. */
let requestQuit: () => void = () => undefined;

function shopBackend(overrides: Partial<Backend> = {}) {
  const people = {
    ...collection("people", 3),
    indexes: [{ fields: ["name"], unique: true, sparse: false }],
  };
  return fakeBackend({
    recentList: vi.fn(async () => [recentFile("/shop.trunkdb")]),
    sessionOverview: vi.fn(async () => overviewOf(collection("orders", 1), people)),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, [objectRow("id-1"), objectRow("id-2")]),
    ),
    documentRead: vi.fn(async (_s: string, _c: string, id: string) => ({ id, json: STORED })),
    pickExportToImport: vi.fn(async () => "/exports/copy.jsonl"),
    pickImportDestination: vi.fn(async (name: string) => `/data/${name}`),
    onQuitRequested: vi.fn((handler: () => void) => {
      requestQuit = handler;
      return () => undefined;
    }),
    ...overrides,
  });
}

async function openPeople(backend: Backend): Promise<UserEvent> {
  render(
    <BackendProvider value={backend}>
      <App />
    </BackendProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Open /shop.trunkdb" }));
  await user.click(await inSidebar(/^people/));
  await screen.findByRole("list", { name: "Documents as JSON" });
  return user;
}

/** A sidebar entry; collection names also appear in the overview table. */
const inSidebar = (name: RegExp | string) =>
  within(screen.getByRole("navigation", { name: "Database" })).findByRole("button", { name });

const rowButton = (id: string) => screen.getByRole("button", { name: new RegExp(id) });
const editorPanel = () => screen.findByRole("complementary", { name: "Document editor" });
const textbox = (id: string) => screen.findByRole("textbox", { name: `JSON of document ${id}` });

async function openDocument(user: UserEvent, id: string) {
  await user.click(rowButton(id));
  return textbox(id);
}

/** Opens id-1 and changes its text, so there is something to lose. */
async function modify(user: UserEvent) {
  const box = await openDocument(user, "id-1");
  fireEvent.change(box, { target: { value: EDITED } });
  expect(await screen.findByText("Modified")).toBeVisible();
}

const saves = (backend: Backend): SaveRequest[] =>
  vi.mocked(backend.documentSave).mock.calls.map(([, request]) => request);

describe("editing a document", () => {
  it("shows the ID apart from the editable body", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);

    const box = await openDocument(user, "id-1");

    expect(box).toHaveValue(STORED);
    const panel = await editorPanel();
    expect(within(panel).getByText("id-1")).toBeVisible();
    expect(within(panel).getByRole("status")).toHaveTextContent("Saved");
    expect(within(panel).getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("saves the text exactly as typed and shows what was stored", async () => {
    const backend = shopBackend({
      documentSave: vi.fn(async (_s: string, request: SaveRequest) => ({
        document: { id: "id-1", json: request.json.replace("Ann B.", "Ann B. (stored)") },
        created: false,
        matches_filter: true,
      })),
    });
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "name{Enter}");
    await waitFor(() => expect(backend.collectionQuery).toHaveBeenCalledTimes(2));
    await modify(user);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saves(backend)).toHaveLength(1));
    expect(saves(backend)[0]).toEqual({
      collection: "people",
      id: "id-1",
      // The digits and the `2.0` are the user's text, never a JS number.
      json: EDITED,
      filter: { rows: [{ field: "name", operator: "eq", value: { type: "string", text: "" } }] },
    });
    expect(await textbox("id-1")).toHaveValue(EDITED.replace("Ann B.", "Ann B. (stored)"));
    const panel = await editorPanel();
    expect(within(panel).getByRole("status")).toHaveTextContent("Saved");
    expect(within(panel).queryByText(/no longer matches the filter/)).toBeNull();
    // The list and the sidebar counts are read again.
    await waitFor(() => expect(backend.collectionQuery).toHaveBeenCalledTimes(3));
    expect(backend.sessionOverview).toHaveBeenCalledTimes(2);
  });

  it("saves with Cmd+S and starts only one save at a time", async () => {
    const saving = deferred<SavedDocument>();
    const backend = shopBackend({ documentSave: vi.fn(() => saving.promise) });
    const user = await openPeople(backend);
    await modify(user);

    await user.keyboard("{Meta>}s{/Meta}");
    await user.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(backend.documentSave).toHaveBeenCalledTimes(1);
    expect(await textbox("id-1")).toHaveAttribute("readonly");
    saving.resolve({
      document: { id: "id-1", json: EDITED },
      created: false,
      matches_filter: true,
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("keeps the draft and explains when a save is refused", async () => {
    const backend = shopBackend({
      documentSave: vi.fn(async () => {
        throw {
          ...appError("unique_conflict", "A unique index does not allow this value twice."),
          detail: 'collection "people" has a unique index on "name"',
        };
      }),
    });
    const user = await openPeople(backend);
    await modify(user);

    await user.click(screen.getByRole("button", { name: "Save" }));

    const panel = await editorPanel();
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("A unique index does not allow this value twice.");
    expect(alert).toHaveTextContent('unique index on "name"');
    expect(await textbox("id-1")).toHaveValue(EDITED);
    expect(within(panel).getByRole("status")).toHaveTextContent("Modified");
    // Nothing was written, so nothing is re-read.
    expect(backend.collectionQuery).toHaveBeenCalledTimes(1);
  });

  it("says so when the saved document no longer matches the filter, and keeps it open", async () => {
    const backend = shopBackend({
      documentSave: vi.fn(async (_s: string, request: SaveRequest) => ({
        document: { id: "id-1", json: request.json },
        created: false,
        matches_filter: false,
      })),
    });
    const user = await openPeople(backend);
    await modify(user);

    await user.click(screen.getByRole("button", { name: "Save" }));

    const panel = await editorPanel();
    expect(await within(panel).findByText(/no longer matches the filter/)).toBeVisible();
    expect(await textbox("id-1")).toHaveValue(EDITED);
  });

  it("stays on a saved document that a refresh moved off the page", async () => {
    let calls = 0;
    const backend = shopBackend({
      collectionQuery: vi.fn(async (_s: string, request: QueryRequest) =>
        // After the save, id-1 is on some other page.
        resultFor(request, calls++ === 0 ? [objectRow("id-1")] : [objectRow("id-9")], 80),
      ),
    });
    const user = await openPeople(backend);
    await modify(user);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("button", { name: /id-9/ });
    const panel = await editorPanel();
    expect(await textbox("id-1")).toHaveValue(EDITED);
    // Another page is not a filter mismatch.
    expect(within(panel).queryByText(/no longer matches the filter/)).toBeNull();
  });

  it("starts a new document as {} and keeps the editor on it once it has an ID", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "New document" }));
    const box = await screen.findByRole("textbox", { name: "New document JSON" });
    expect(box).toHaveValue("{}");
    const panel = await editorPanel();
    expect(within(panel).getByRole("status")).toHaveTextContent("Not saved yet");
    expect(within(panel).queryByRole("button", { name: "Delete…" })).toBeNull();
    fireEvent.change(box, { target: { value: '{"name": "New"}' } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saves(backend)).toHaveLength(1));
    expect(saves(backend)[0]).toMatchObject({ id: null, json: '{"name": "New"}' });
    expect(await textbox("new-id")).toHaveValue('{"name": "New"}');
    expect(within(await editorPanel()).getByText("new-id")).toBeVisible();
  });

  it("does not drop modified text on Escape, and Discard changes restores the stored text", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);
    await modify(user);

    await user.keyboard("{Escape}");
    expect(await textbox("id-1")).toHaveValue(EDITED);

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await textbox("id-1")).toHaveValue(STORED);
    expect(backend.documentSave).not.toHaveBeenCalled();
  });

  it("formats through the backend and reports text that is not valid", async () => {
    const documentFormat = vi
      .fn<Backend["documentFormat"]>()
      .mockResolvedValueOnce('{\n  "formatted": true\n}')
      .mockRejectedValueOnce(appError("invalid_json", "The text is not valid JSON."));
    const backend = shopBackend({ documentFormat });
    const user = await openPeople(backend);
    await modify(user);

    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(await textbox("id-1")).toHaveValue('{\n  "formatted": true\n}');
    expect(documentFormat).toHaveBeenCalledWith(EDITED);

    fireEvent.change(await textbox("id-1"), { target: { value: "{oops" } });
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The text is not valid JSON.");
    expect(await textbox("id-1")).toHaveValue("{oops");
  });
});

describe("deleting", () => {
  it("deletes a document only after a confirmation that names it", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);
    await openDocument(user, "id-1");

    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete document?" });
    expect(dialog).toHaveTextContent("id-1");
    expect(dialog).toHaveTextContent("people");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(backend.documentDelete).not.toHaveBeenCalled();
    expect(await textbox("id-1")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete document" }),
    );

    await waitFor(() =>
      expect(backend.documentDelete).toHaveBeenCalledWith("s1", "people", "id-1"),
    );
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(backend.collectionQuery).toHaveBeenCalledTimes(2));
  });

  it("reports a document that was already gone instead of claiming success", async () => {
    const backend = shopBackend({
      documentDelete: vi.fn(async () => {
        throw appError("target_not_found", "This document no longer exists; nothing was deleted.");
      }),
    });
    const user = await openPeople(backend);
    await openDocument(user, "id-1");

    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete document" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("nothing was deleted");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("deletes a collection after a confirmation naming it and what goes with it", async () => {
    const backend = shopBackend({
      collectionDrop: vi.fn(async () => overviewOf(collection("orders", 1))),
    });
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Delete collection…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete collection?" });
    expect(dialog).toHaveTextContent("“people”");
    expect(dialog).toHaveTextContent("its 3 documents and all its indexes");
    await user.click(within(dialog).getByRole("button", { name: "Delete collection" }));

    await waitFor(() => expect(backend.collectionDrop).toHaveBeenCalledWith("s1", "people"));
    // Its views are gone with it.
    expect(await screen.findByRole("heading", { name: "File" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "people" })).toBeNull();
    expect(
      within(screen.getByRole("navigation", { name: "Database" })).queryByRole("button", {
        name: /^people/,
      }),
    ).toBeNull();
  });

  it("keeps the collection and shows the reason when deleting it fails", async () => {
    const backend = shopBackend({
      collectionDrop: vi.fn(async () => {
        throw appError("io", "Reading or writing the file failed.");
      }),
    });
    const user = await openPeople(backend);

    await user.click(screen.getByRole("button", { name: "Delete collection…" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete collection" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Reading or writing");
    expect(screen.getByRole("heading", { name: "people" })).toBeVisible();
  });
});

/** Every way out of a modified draft, and how to tell that it happened. */
const LEAVES: Record<
  string,
  { leave: (user: UserEvent) => Promise<void>; left: () => Promise<unknown> }
> = {
  "another document": {
    leave: (user) => user.click(rowButton("id-2")),
    left: () => textbox("id-2"),
  },
  "a new document": {
    leave: (user) => user.click(screen.getByRole("button", { name: "New document" })),
    left: () => screen.findByRole("textbox", { name: "New document JSON" }),
  },
  "another collection": {
    leave: async (user) => user.click(await inSidebar(/^orders/)),
    left: () => screen.findByRole("heading", { name: "orders" }),
  },
  "closing the database": {
    leave: (user) => user.click(screen.getByRole("button", { name: "Close database" })),
    left: () => screen.findByRole("heading", { level: 1, name: "TrunkDB Admin" }),
  },
  "deleting the collection": {
    leave: (user) => user.click(screen.getByRole("button", { name: "Delete collection…" })),
    left: () => screen.findByRole("dialog", { name: "Delete collection?" }),
  },
  "reopening read-only": {
    leave: (user) => user.click(screen.getByRole("button", { name: "Reopen read-only" })),
    left: () => screen.findByRole("heading", { level: 1, name: /Read-only/ }),
  },
  quitting: {
    leave: async () => requestQuit(),
    left: () => waitFor(() => expect(quitCalled()).toBe(true)),
  },
};

let currentBackend: Backend;
const quitCalled = () => vi.mocked(currentBackend.quit).mock.calls.length > 0;

describe.each(Object.keys(LEAVES))("leaving a modified draft for %s", (name) => {
  const { leave, left } = LEAVES[name] as (typeof LEAVES)[string];
  const unsaved = () => screen.findByRole("dialog", { name: "Unsaved changes" });

  async function modified(overrides: Partial<Backend> = {}) {
    currentBackend = shopBackend(overrides);
    const user = await openPeople(currentBackend);
    await modify(user);
    await leave(user);
    return { user, dialog: await unsaved() };
  }

  /** Still in the editor, text intact, nowhere else. */
  async function expectStayed() {
    expect(await textbox("id-1")).toHaveValue(EDITED);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(quitCalled()).toBe(false);
    expect(currentBackend.sessionClose).not.toHaveBeenCalled();
  }

  it("Cancel stays with the draft", async () => {
    const { user, dialog } = await modified();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await expectStayed();
    expect(currentBackend.documentSave).not.toHaveBeenCalled();
  });

  it("Discard leaves without saving", async () => {
    const { user, dialog } = await modified();

    await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));

    await left();
    expect(currentBackend.documentSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull();
  });

  it("Save stores the draft and then leaves", async () => {
    const { user, dialog } = await modified();

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await left();
    expect(saves(currentBackend)).toHaveLength(1);
    expect(saves(currentBackend)[0]).toMatchObject({ id: "id-1", json: EDITED });
  });

  it("a failed Save stays with the draft and its error", async () => {
    const { user, dialog } = await modified({
      documentSave: vi.fn(async () => {
        throw appError("invalid_json", "The text is not valid JSON.");
      }),
    });

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The text is not valid JSON.");
    await expectStayed();
  });
});

describe("opening a database an import made", () => {
  async function importAndOpen(user: UserEvent) {
    await user.click(await inSidebar("Tools"));
    await user.click(screen.getByRole("button", { name: "Import into a new database…" }));
    const result = await screen.findByRole("status", { name: "Import result" });
    await user.click(within(result).getByRole("button", { name: "Open it" }));
    return screen.findByRole("dialog", { name: "Unsaved changes" });
  }

  it("asks about a modified draft first; Cancel keeps it and the database", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);
    await modify(user);

    const dialog = await importAndOpen(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(backend.sessionClose).not.toHaveBeenCalled();
    await user.click(await inSidebar(/^people/));
    expect(await textbox("id-1")).toHaveValue(EDITED);
  });

  it("Discard closes this database and opens the new one", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);
    await modify(user);

    const dialog = await importAndOpen(user);
    await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));

    expect(await screen.findByRole("heading", { level: 1, name: "copy.trunkdb" })).toBeVisible();
    expect(backend.sessionClose).toHaveBeenCalled();
    expect(backend.databaseOpen).toHaveBeenLastCalledWith("/data/copy.trunkdb", false);
    expect(backend.documentSave).not.toHaveBeenCalled();
  });
});

describe("the database pages", () => {
  it("are shown without leaving the draft, and the collection comes back as it was", async () => {
    currentBackend = shopBackend();
    const user = await openPeople(currentBackend);
    await modify(user);

    await user.click(await inSidebar("Overview"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("heading", { name: "File" })).toBeVisible();
    await user.click(await inSidebar(/^people/));
    expect(await textbox("id-1")).toHaveValue(EDITED);
    expect(screen.getByText("Modified")).toBeVisible();
    // Nothing was read again on the way.
    expect(currentBackend.collectionQuery).toHaveBeenCalledTimes(1);
    expect(currentBackend.documentRead).toHaveBeenCalledTimes(1);
  });

  it("runs a check and an export while a modified draft waits", async () => {
    currentBackend = shopBackend({
      pickExportDestination: vi.fn(async () => "/out/shop.jsonl"),
    });
    const user = await openPeople(currentBackend);
    await modify(user);
    await user.click(await inSidebar("Tools"));

    await user.click(screen.getByRole("button", { name: "Run check" }));
    expect(await screen.findByRole("status", { name: "Check report" })).toHaveTextContent(
      "No problems found.",
    );
    await user.click(screen.getByRole("button", { name: "Export database…" }));
    expect(await screen.findByRole("status", { name: "Export result" })).toHaveTextContent(
      "Export complete.",
    );

    // The export took nothing from the editor and nothing was saved for it.
    expect(currentBackend.documentSave).not.toHaveBeenCalled();
    expect(currentBackend.databaseExport).toHaveBeenCalledWith("s1", "/out/shop.jsonl", true);
    await user.click(await inSidebar(/^people/));
    expect(await textbox("id-1")).toHaveValue(EDITED);
  });
});

describe("leaving without changes", () => {
  it("asks nothing for an unmodified document or an untouched new one", async () => {
    currentBackend = shopBackend();
    const user = await openPeople(currentBackend);

    await openDocument(user, "id-1");
    await user.click(rowButton("id-2"));
    await textbox("id-2");
    await user.click(screen.getByRole("button", { name: "New document" }));
    await screen.findByRole("textbox", { name: "New document JSON" });
    await user.click(await inSidebar(/^orders/));
    await screen.findByRole("heading", { name: "orders" });
    requestQuit();

    await waitFor(() => expect(quitCalled()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("quits at once from the start screen", async () => {
    currentBackend = shopBackend();
    render(
      <BackendProvider value={currentBackend}>
        <App />
      </BackendProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: "TrunkDB Admin" });

    requestQuit();

    await waitFor(() => expect(quitCalled()).toBe(true));
  });
});

describe("quit from outside the app", () => {
  const reported = (backend: Backend) =>
    vi.mocked(backend.setUnsavedDraft).mock.calls.map(([unsaved]) => unsaved);

  it("tells the shell about a modified draft until it is discarded", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);
    await openDocument(user, "id-1");
    expect(reported(backend)).toEqual([]);

    await modify(user);
    await waitFor(() => expect(reported(backend)).toEqual([true]));
    // Further typing is no news.
    fireEvent.change(await textbox("id-1"), { target: { value: STORED + " " } });
    expect(reported(backend)).toEqual([true]);

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(reported(backend)).toEqual([true, false]));
  });

  it("clears the report once the draft is saved", async () => {
    const backend = shopBackend();
    const user = await openPeople(backend);
    await modify(user);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reported(backend)).toEqual([true, false]));
  });
});

describe("indexes", () => {
  async function openIndexes(backend: Backend) {
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Indexes" }));
    return user;
  }

  it("lists the primary index without actions and secondary ones with Drop", async () => {
    const user = await openIndexes(shopBackend());

    const table = screen.getByRole("table", { name: "Indexes" });
    const [, primary, secondary] = within(table).getAllByRole("row");
    expect(primary).toHaveTextContent("_id");
    expect(primary).toHaveTextContent("Primary · automatic, cannot be changed");
    expect(within(primary as HTMLElement).queryByRole("button")).toBeNull();
    expect(secondary).toHaveTextContent("name");
    expect(secondary).toHaveTextContent("unique");
    expect(
      within(secondary as HTMLElement).getByRole("button", { name: "Drop index name" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Documents" }));
  });

  it("creates a compound index with the fields in the chosen order", async () => {
    const backend = shopBackend({
      indexCreate: vi.fn(async () =>
        overviewOf({
          ...collection("people", 3),
          indexes: [{ fields: ["city", "age"], unique: true, sparse: true }],
        }),
      ),
    });
    const user = await openIndexes(backend);

    await user.type(screen.getByLabelText("Index field 1"), "age");
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.type(screen.getByLabelText("Index field 2"), "city");
    await user.click(screen.getByRole("button", { name: "Move field 2 up" }));
    await user.click(screen.getByLabelText("Unique"));
    await user.click(screen.getByLabelText("Sparse"));
    await user.click(screen.getByRole("button", { name: "Create index" }));

    await waitFor(() =>
      expect(backend.indexCreate).toHaveBeenCalledWith("s1", {
        collection: "people",
        fields: ["city", "age"],
        unique: true,
        sparse: true,
      }),
    );
    expect(await screen.findByRole("button", { name: "Drop index (city, age)" })).toBeVisible();
    // The form is ready for the next index.
    expect(screen.getByLabelText("Index field 1")).toHaveValue("");
    expect(screen.queryByLabelText("Index field 2")).toBeNull();
    expect(screen.getByLabelText("Unique")).not.toBeChecked();
  });

  it("keeps the entered definition when creation fails", async () => {
    const backend = shopBackend({
      indexCreate: vi.fn(async () => {
        throw {
          ...appError("unique_conflict", "A unique index does not allow this value twice."),
          detail: "documents a and b would have the same value there",
        };
      }),
    });
    const user = await openIndexes(backend);

    await user.type(screen.getByLabelText("Index field 1"), "email");
    await user.click(screen.getByLabelText("Unique"));
    await user.click(screen.getByRole("button", { name: "Create index" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("does not allow this value twice");
    expect(alert).toHaveTextContent("documents a and b");
    expect(screen.getByLabelText("Index field 1")).toHaveValue("email");
    expect(screen.getByLabelText("Unique")).toBeChecked();
    expect(screen.getByRole("button", { name: "Create index" })).toBeEnabled();
  });

  it("drops an index only after a confirmation naming it", async () => {
    const backend = shopBackend({
      indexDrop: vi.fn(async () => overviewOf(collection("people", 3))),
    });
    const user = await openIndexes(backend);

    await user.click(screen.getByRole("button", { name: "Drop index name" }));
    const dialog = screen.getByRole("dialog", { name: "Drop index?" });
    expect(dialog).toHaveTextContent("name");
    expect(dialog).toHaveTextContent("unique");
    expect(dialog).toHaveTextContent("The documents stay.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(backend.indexDrop).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Drop index name" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Drop index" }),
    );

    await waitFor(() => expect(backend.indexDrop).toHaveBeenCalledWith("s1", "people", ["name"]));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Drop index name" })).toBeNull(),
    );
  });

  it("leaves an open document draft and the result page alone", async () => {
    const backend = shopBackend({
      indexCreate: vi.fn(async () => overviewOf(collection("orders", 1), collection("people", 3))),
    });
    const user = await openPeople(backend);
    await modify(user);

    await user.click(screen.getByRole("button", { name: "Indexes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.type(screen.getByLabelText("Index field 1"), "age");
    await user.click(screen.getByRole("button", { name: "Create index" }));
    await waitFor(() => expect(backend.indexCreate).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Documents" }));

    expect(await textbox("id-1")).toHaveValue(EDITED);
    expect(screen.getByText("Modified")).toBeVisible();
    expect(backend.collectionQuery).toHaveBeenCalledTimes(1);
  });
});
