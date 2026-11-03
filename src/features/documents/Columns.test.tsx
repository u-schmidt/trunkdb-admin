import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { QueryRequest, ResultRow } from "../../ipc/types";
import {
  appError,
  collection,
  explainOf,
  fakeBackend,
  objectRow,
  overviewOf,
  resultFor,
  sessionInfo,
} from "../../test/fakeBackend";
import { Workspace } from "../workspace/Workspace";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

const WHOLE: ResultRow[] = [
  objectRow("id-1", {
    name: { kind: "string", preview: "Ann" },
    address: { kind: "object", preview: '{"city":"Bonn"}' },
    bio: { kind: "string", preview: "long" },
  }),
];

const CHOSEN: ResultRow[] = [
  objectRow("id-1", {
    "address.city": { kind: "string", preview: "Bonn" },
    name: { kind: "string", preview: "Ann" },
  }),
];

function backendWith(overrides: Partial<Backend> = {}) {
  return fakeBackend({
    sessionOverview: vi.fn(async () => overviewOf(collection("people", 120))),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, request.select === null ? WHOLE : CHOSEN, 120),
    ),
    ...overrides,
  });
}

async function openPeople(backend: Backend) {
  render(
    <BackendProvider value={backend}>
      <DraftGuardProvider>
        <Workspace
          session={sessionInfo("/data/people.trunkdb")}
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
  await user.click(await within(sidebar).findByRole("button", { name: /^people/ }));
  await screen.findByText(/120 documents/);
  return user;
}

const lastQuery = (backend: Backend) =>
  vi.mocked(backend.collectionQuery).mock.calls.at(-1)?.[1] as QueryRequest;

/** Chooses `paths` in the Table view's chooser, replacing what it offers. */
async function choose(user: ReturnType<typeof userEvent.setup>, paths: string[]) {
  await user.click(screen.getByRole("button", { name: "Table" }));
  await user.click(screen.getByRole("button", { name: "Columns…" }));
  const chooser = screen.getByRole("form", { name: "Columns" });
  while (within(chooser).queryByRole("button", { name: "Remove column 1" }) !== null) {
    await user.click(within(chooser).getByRole("button", { name: "Remove column 1" }));
  }
  for (const [n, path] of paths.entries()) {
    await user.click(within(chooser).getByRole("button", { name: "Add column" }));
    await user.type(within(chooser).getByLabelText(`Column ${n + 1} path`), path);
  }
  await user.click(within(chooser).getByRole("button", { name: "Show these columns" }));
}

describe("chosen columns", () => {
  it("offers the page's fields, sends the chosen paths on the same page, and shows them", async () => {
    const backend = backendWith();
    const user = await openPeople(backend);
    expect(screen.queryByRole("button", { name: "Columns…" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastQuery(backend).page).toBe(1));

    await user.click(screen.getByRole("button", { name: "Table" }));
    await user.click(screen.getByRole("button", { name: "Columns…" }));
    const chooser = screen.getByRole("form", { name: "Columns" });
    const offered = within(chooser)
      .getAllByRole("combobox")
      .map((input) => (input as HTMLInputElement).value);
    expect(offered).toEqual(["address", "bio", "name"]);
    // Ordered and edited: address.city first, bio gone.
    await user.click(within(chooser).getByRole("button", { name: "Remove column 2" }));
    await user.type(within(chooser).getByLabelText("Column 1 path"), ".city");
    await user.click(within(chooser).getByRole("button", { name: "Show these columns" }));

    expect(lastQuery(backend)).toMatchObject({ select: ["address.city", "name"], page: 1 });
    expect(screen.queryByRole("form", { name: "Columns" })).not.toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Documents as table" });
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((th) => th.textContent),
      ).toEqual(["_id ▲", "address.city", "name"]),
    );
    expect(screen.getByRole("button", { name: "Columns (2)…" })).toBeInTheDocument();

    // A chosen nested path sorts as a path.
    await user.click(within(table).getByRole("button", { name: "address.city" }));
    expect(lastQuery(backend)).toMatchObject({
      sort: { field: "address.city", descending: false },
      select: ["address.city", "name"],
    });
  });

  it("says so above the JSON view, and goes back to whole documents", async () => {
    const backend = backendWith();
    const user = await openPeople(backend);
    await choose(user, ["name", "address.city"]);
    await user.click(screen.getByRole("button", { name: "JSON" }));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Showing 2 chosen fields of each document.");
    await user.click(within(note).getByRole("button", { name: "All fields" }));
    expect(lastQuery(backend).select).toBeNull();
    await waitFor(() => expect(screen.queryByRole("note")).not.toBeInTheDocument());
  });

  it("hides fields from whole documents, says so, and switches back", async () => {
    const backend = backendWith();
    const user = await openPeople(backend);
    await user.click(screen.getByRole("button", { name: "Table" }));
    await user.click(screen.getByRole("button", { name: "Columns…" }));
    const chooser = screen.getByRole("form", { name: "Columns" });
    await user.click(within(chooser).getByRole("button", { name: "All but these" }));
    while (within(chooser).queryByRole("button", { name: "Remove column 1" }) !== null) {
      await user.click(within(chooser).getByRole("button", { name: "Remove column 1" }));
    }
    await user.click(within(chooser).getByRole("button", { name: "Add column" }));
    await user.type(within(chooser).getByLabelText("Column 1 path"), "bio");
    await user.click(within(chooser).getByRole("button", { name: "Hide these fields" }));

    expect(lastQuery(backend)).toMatchObject({ select: null, except: ["bio"] });
    expect(await screen.findByRole("button", { name: "Columns (1 hidden)…" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "JSON" }));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Each document without bio.");

    // The chooser opens as it was left; Only these sends a selection alone.
    await user.click(screen.getByRole("button", { name: "Table" }));
    await user.click(screen.getByRole("button", { name: "Columns (1 hidden)…" }));
    const again = screen.getByRole("form", { name: "Columns" });
    expect(within(again).getByRole("button", { name: "All but these" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(again).getByRole("button", { name: "Only these" }));
    await user.click(within(again).getByRole("button", { name: "Show these columns" }));
    expect(lastQuery(backend)).toMatchObject({ select: ["bio"], except: [] });
  });

  it("keeps the choice through a filter, and Explain reads what the list reads", async () => {
    const backend = backendWith({
      collectionExplain: vi.fn(async (_session: string, request: QueryRequest) =>
        explainOf(request, { documents_examined: 0, documents_returned: 50, from_entries: 50 }),
      ),
    });
    const user = await openPeople(backend);
    await choose(user, ["name"]);
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "name");
    await user.type(screen.getByLabelText("Condition 1 value"), "Ann");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(lastQuery(backend)).toMatchObject({ select: ["name"], page: 0 });

    await user.click(screen.getByRole("button", { name: "Explain" }));
    await screen.findByText(/All 50 shown were built from the index entries alone/);
    expect(vi.mocked(backend.collectionExplain).mock.calls.at(-1)?.[1].select).toEqual(["name"]);
  });

  it("shows a refused path, and opens a row as the whole document", async () => {
    const backend = backendWith({
      collectionQuery: vi.fn(async (_session: string, request: QueryRequest) => {
        if (request.select?.includes("tags[*]") === true) {
          throw appError("invalid_input", "Column 1: choose the array “tags” itself.");
        }
        return resultFor(request, request.select === null ? WHOLE : CHOSEN, 120);
      }),
    });
    const user = await openPeople(backend);
    // `[[` types one `[` in user-event.
    await choose(user, ["tags[[*]"]);
    expect(await screen.findByText(/choose the array “tags” itself/)).toBeInTheDocument();

    await choose(user, ["name"]);
    const table = await screen.findByRole("table", { name: "Documents as table" });
    await user.click(within(table).getAllByRole("row")[1] as HTMLElement);
    expect(backend.documentRead).toHaveBeenCalledWith(expect.anything(), "people", "id-1");
  });
});
