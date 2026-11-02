import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { FieldPathsRequest, QueryRequest } from "../../ipc/types";
import {
  collection,
  fakeBackend,
  fieldPath,
  fieldPathsOf,
  objectRow,
  overviewOf,
  resultFor,
  sessionInfo,
} from "../../test/fakeBackend";
import { Workspace } from "../workspace/Workspace";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

// Field paths. The fake backend's paths: _id, name, age (int 2,
// null 1), tags (array) and tags[*], in 3 documents.

function peopleBackend(overrides: Partial<Backend> = {}) {
  return fakeBackend({
    sessionOverview: vi.fn(async () =>
      overviewOf(collection("people", 3), collection("draft", 0, false)),
    ),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, [objectRow("id-1")], 1),
    ),
    ...overrides,
  });
}

async function openCollection(backend: Backend, name = /^people/) {
  render(
    <BackendProvider value={backend}>
      <DraftGuardProvider>
        <Workspace
          session={sessionInfo("/data/shop.trunkdb")}
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
  const user = userEvent.setup();
  const sidebar = screen.getByRole("navigation", { name: "Database" });
  await user.click(await within(sidebar).findByRole("button", { name }));
  return user;
}

const reads = (backend: Backend) => vi.mocked(backend.collectionFieldPaths).mock.calls.length;

/** The values a path input's suggestion list offers. */
function offered(input: HTMLElement): string[] {
  const list = document.getElementById(input.getAttribute("list") ?? "");
  return [...(list?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value") ?? "");
}

describe("field path suggestions", () => {
  it("reads every document on first need only, and offers the paths", async () => {
    const backend = peopleBackend();
    const user = await openCollection(backend);
    await screen.findByRole("list", { name: "Documents as JSON" });
    expect(reads(backend)).toBe(0);

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    const field = screen.getByLabelText("Condition 1 field path");
    await user.click(field);

    await waitFor(() => expect(offered(field)).toEqual(["_id", "name", "age", "tags", "tags[*]"]));
    expect(backend.collectionFieldPaths).toHaveBeenCalledWith("s1", {
      request_id: expect.any(Number) as number,
      collection: "people",
    });
    // Columns and the sort take no `[*]` paths.
    const sort = screen.getByLabelText("Sort by");
    expect(offered(sort)).toEqual(["_id", "name", "age", "tags"]);
    await user.click(sort);
    await user.click(screen.getByRole("button", { name: "Groups" }));
    await user.click(screen.getByLabelText("Group field 1"));
    expect(offered(screen.getByLabelText("Group field 1"))).not.toContain("tags[*]");
    expect(reads(backend)).toBe(1);
  });

  it("labels each path with its documents and main kind", async () => {
    const backend = peopleBackend();
    const user = await openCollection(backend);
    await user.click(await screen.findByRole("button", { name: "Add condition" }));
    const field = screen.getByLabelText("Condition 1 field path");
    await user.click(field);

    await waitFor(() => expect(offered(field)).toContain("age"));
    const list = document.getElementById(field.getAttribute("list") ?? "");
    const age = list?.querySelector('option[value="age"]');
    expect(age?.getAttribute("label")).toBe("2 of 3, int");
  });

  it("sets an empty row's type from the path, and never retypes a value", async () => {
    const backend = peopleBackend();
    const user = await openCollection(backend);
    await user.click(await screen.findByRole("button", { name: "Add condition" }));
    const field = screen.getByLabelText("Condition 1 field path");
    await user.click(field);
    await waitFor(() => expect(offered(field)).toContain("age"));

    fireEvent.change(field, { target: { value: "age" } });
    expect(screen.getByLabelText("Condition 1 value type")).toHaveValue("int");

    fireEvent.change(field, { target: { value: "" } });
    await user.type(screen.getByLabelText("Condition 1 value"), "Ann");
    await user.selectOptions(screen.getByLabelText("Condition 1 value type"), "string");
    await user.type(screen.getByLabelText("Condition 1 value"), "x");
    fireEvent.change(field, { target: { value: "age" } });
    expect(screen.getByLabelText("Condition 1 value type")).toHaveValue("string");
  });

  it("reads again after a write, not after an index change", async () => {
    const backend = peopleBackend({
      indexCreate: vi.fn(async () =>
        overviewOf({
          ...collection("people", 3),
          indexes: [{ fields: ["name"], unique: false, sparse: false }],
        }),
      ),
    });
    const user = await openCollection(backend);
    await user.click(await screen.findByRole("button", { name: "Add condition" }));
    await user.click(screen.getByLabelText("Condition 1 field path"));
    await waitFor(() => expect(reads(backend)).toBe(1));

    // A new document saved: the documents changed.
    await user.click(screen.getByRole("button", { name: "New document" }));
    await screen.findByRole("textbox", { name: "New document JSON" });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.documentSave).toHaveBeenCalled());
    await user.click(screen.getByLabelText("Sort by"));
    await waitFor(() => expect(reads(backend)).toBe(2));

    // An index: no document changed.
    await user.click(screen.getByRole("button", { name: "Indexes" }));
    await user.type(await screen.findByLabelText("Index field 1"), "name");
    await user.click(screen.getByRole("button", { name: "Create index" }));
    await waitFor(() => expect(backend.indexCreate).toHaveBeenCalled());
    await user.click(screen.getByLabelText("Index field 1"));
    expect(reads(backend)).toBe(2);
  });

  it("never offers a path no input can name", async () => {
    const backend = peopleBackend({
      collectionFieldPaths: vi.fn(async (_session: string, request: FieldPathsRequest) =>
        fieldPathsOf(request, 1, fieldPath("name", 1), {
          ...fieldPath("a.b", 1, [["int", 1]], "`a.b`"),
          nameable: false,
        }),
      ),
    });
    const user = await openCollection(backend);
    await user.click(await screen.findByRole("button", { name: "Add condition" }));
    const field = screen.getByLabelText("Condition 1 field path");
    await user.click(field);

    await waitFor(() => expect(offered(field)).toEqual(["name"]));
  });

  it("reads nothing for a collection that isn't stored", async () => {
    const backend = peopleBackend();
    const user = await openCollection(backend, /^draft/);
    await user.click(await screen.findByRole("button", { name: "Add condition" }));
    await user.click(screen.getByLabelText("Condition 1 field path"));
    expect(reads(backend)).toBe(0);
  });
});

describe("the Fields section", () => {
  it("lists every path with exact counts and copies a path's text", async () => {
    const backend = peopleBackend();
    const user = await openCollection(backend);

    await user.click(await screen.findByRole("button", { name: "Fields" }));

    const table = await screen.findByRole("table", { name: "Field paths" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "_id3 of 3id 3Copy",
      "name3 of 3string 3Copy",
      "age2 of 3int 2 · null 1Copy",
      "tags2 of 3array 2Copy",
      "tags[*]1 of 3string 1Copy",
    ]);
    expect(screen.getByText("5 paths in 3 documents")).toBeVisible();

    await user.click(within(table).getByRole("button", { name: "Copy age" }));
    expect(await navigator.clipboard.readText()).toBe("age");
    expect(await screen.findByText(/copied age/)).toBeVisible();
  });
});
