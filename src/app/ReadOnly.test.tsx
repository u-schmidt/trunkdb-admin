import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { Backend } from "../ipc/backend";
import { BackendProvider } from "../ipc/BackendContext";
import type { QueryRequest } from "../ipc/types";
import {
  appError,
  collection,
  fakeBackend,
  objectRow,
  overviewOf,
  recentFile,
  resultFor,
  storageOf,
} from "../test/fakeBackend";
import { App } from "./App";

vi.mock("../components/JsonEditor", async () => await import("../test/PlainJsonEditor"));

// Opening read-only.

const SHOP = "/data/shop.trunkdb";

function shopBackend(overrides: Partial<Backend> = {}) {
  const people = {
    ...collection("people", 2),
    indexes: [{ fields: ["name"], unique: false, sparse: false }],
  };
  return fakeBackend({
    pickDatabaseToOpen: vi.fn(async () => SHOP),
    sessionOverview: vi.fn(async () => overviewOf(people)),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, [objectRow("id-1"), objectRow("id-2")]),
    ),
    ...overrides,
  });
}

function renderApp(backend: Backend): UserEvent {
  render(
    <BackendProvider value={backend}>
      <App />
    </BackendProvider>,
  );
  return userEvent.setup();
}

const readOnlyHeading = () => screen.findByRole("heading", { level: 1, name: /Read-only/ });
const sidebar = () => screen.getByRole("navigation", { name: "Database" });

async function openReadOnly(backend: Backend) {
  const user = renderApp(backend);
  await user.click(await screen.findByRole("button", { name: "Open read-only…" }));
  await readOnlyHeading();
  return user;
}

describe("opening read-only", () => {
  it("opens the chosen file read-only and says so", async () => {
    const backend = shopBackend();
    await openReadOnly(backend);

    expect(backend.databaseOpen).toHaveBeenCalledWith(SHOP, true);
    expect(screen.getByRole("button", { name: "Open for editing" })).toBeEnabled();
    const file = screen.getByRole("region", { name: "File" });
    expect(file).toHaveTextContent("Nothing is written to the file or its write-ahead log");
  });

  it("opens a recent entry the way it was last opened, and labels it", async () => {
    const backend = shopBackend({
      recentList: vi.fn(async () => [recentFile(SHOP, true, true), recentFile("/data/b.trunkdb")]),
    });
    const user = renderApp(backend);

    const entry = await screen.findByRole("button", { name: `Open ${SHOP} read-only` });
    expect(within(entry.closest("li") as HTMLElement).getByText("Read-only")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open /data/b.trunkdb" })).toBeVisible();
    await user.click(entry);

    await readOnlyHeading();
    expect(backend.databaseOpen).toHaveBeenCalledWith(SHOP, true);
  });

  it("offers Open read-only when an open for editing is not permitted", async () => {
    const backend = shopBackend({
      databaseOpen: vi.fn(async (path: string, readOnly: boolean) => {
        if (!readOnly) throw appError("permission_denied", "Your permissions don't allow this.");
        return fakeBackend().databaseOpen(path, readOnly);
      }),
    });
    const user = renderApp(backend);
    await user.click(await screen.findByRole("button", { name: "Open database…" }));

    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Open read-only" }));

    await readOnlyHeading();
    expect(backend.databaseOpen).toHaveBeenLastCalledWith(SHOP, true);
  });

  it("offers nothing more when a read-only open is not permitted either", async () => {
    const backend = shopBackend({
      databaseOpen: vi.fn(async () => {
        throw appError("permission_denied", "Your permissions don't allow this.");
      }),
    });
    const user = renderApp(backend);
    await user.click(await screen.findByRole("button", { name: "Open read-only…" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Open read-only" })).toBeNull();
  });
});

describe("a read-only workspace", () => {
  it("has no action that writes, and keeps every one that reads", async () => {
    const user = await openReadOnly(shopBackend());

    // No new collection, but the tools.
    expect(within(sidebar()).queryByRole("textbox", { name: "New collection" })).toBeNull();
    await user.click(within(sidebar()).getByRole("button", { name: "Tools" }));
    expect(screen.getByRole("button", { name: "Run check" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export database…" })).toBeEnabled();

    await user.click(await within(sidebar()).findByRole("button", { name: /^people/ }));
    await screen.findByRole("list", { name: "Documents as JSON" });
    expect(screen.queryByRole("button", { name: "New document" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete collection…" })).toBeNull();
    for (const name of ["Table", "Groups", "Side pane", "Refresh"]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }

    await user.click(screen.getByRole("button", { name: /id-1/ }));
    const panel = await screen.findByRole("complementary", { name: "Document editor" });
    expect(await within(panel).findByRole("textbox")).toHaveAttribute("readonly");
    expect(within(panel).getByRole("status")).toHaveTextContent("Read-only");
    for (const name of ["Save", "Format", "Delete…"]) {
      expect(within(panel).queryByRole("button", { name })).toBeNull();
    }
    expect(within(panel).queryByRole("button", { name: "Close" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Hide side pane" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Indexes" }));
    expect(await screen.findByRole("table", { name: "Indexes" })).toHaveTextContent("name");
    expect(screen.queryByRole("button", { name: /Drop index/ })).toBeNull();
    expect(screen.queryByRole("form", { name: "Create index" })).toBeNull();
  });

  it("says a recovery after a crash is shown from memory", async () => {
    const user = await openReadOnly(
      shopBackend({
        databaseStorage: vi.fn(async () => storageOf({ recovered: { pages: 3, in_memory: true } })),
      }),
    );
    await user.click(within(sidebar()).getByRole("button", { name: "Storage" }));

    const storage = (await screen.findByRole("heading", { name: "Storage" })).closest(
      "section",
    ) as HTMLElement;
    expect(await within(storage).findByRole("status")).toHaveTextContent(
      "3 pages from its write-ahead log are shown from memory; the file is unchanged",
    );
  });
});

describe("switching", () => {
  it("reopens a read-only file for editing without asking", async () => {
    const backend = shopBackend();
    const user = await openReadOnly(backend);

    await user.click(screen.getByRole("button", { name: "Open for editing" }));

    expect(await screen.findByRole("button", { name: "Reopen read-only" })).toBeVisible();
    expect(backend.sessionClose).toHaveBeenCalledWith("s1");
    expect(backend.databaseOpen).toHaveBeenLastCalledWith(SHOP, false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "shop.trunkdb" })).toBeVisible();
  });

  it("ends on the start screen with the reason when the other open fails", async () => {
    const backend = shopBackend({
      databaseOpen: vi.fn(async (path: string, readOnly: boolean) => {
        if (!readOnly) throw appError("locked", "The database is in use by another program.");
        return fakeBackend().databaseOpen(path, readOnly);
      }),
    });
    const user = await openReadOnly(backend);

    await user.click(screen.getByRole("button", { name: "Open for editing" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("in use by another program");
    expect(screen.getByRole("heading", { level: 1, name: "TrunkDB Admin" })).toBeVisible();
    expect(backend.sessionClose).toHaveBeenCalledWith("s1");
  });
});
