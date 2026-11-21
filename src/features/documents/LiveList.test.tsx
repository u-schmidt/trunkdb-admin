import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { ListChanged, QueryRequest, QueryResult } from "../../ipc/types";
import {
  collection,
  fakeBackend,
  objectRow,
  overviewOf,
  resultFor,
  sessionInfo,
} from "../../test/fakeBackend";
import { Workspace } from "../workspace/Workspace";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

/** A read-only or an editing session on tasks, with the list open. */
async function openTasks(backend: Backend, readOnly: boolean) {
  render(
    <BackendProvider value={backend}>
      <DraftGuardProvider>
        <Workspace
          session={sessionInfo("/data/tasks.trunkdb", "s1", readOnly)}
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
  const sidebar = screen.getByRole("navigation", { name: "Database" });
  await userEvent.setup().click(await within(sidebar).findByRole("button", { name: /^tasks/ }));
  await screen.findByRole("list", { name: "Documents as JSON" });
}

function tasksBackend(overrides: Partial<Backend> = {}) {
  return fakeBackend({
    sessionOverview: vi.fn(async () => overviewOf(collection("tasks", 2))),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, [objectRow("id-1")], 1),
    ),
    ...overrides,
  });
}

/** The change handler the list subscribed with. */
function listener(backend: Backend): (change: ListChanged) => void {
  const calls = vi.mocked(backend.onListChanged).mock.calls;
  const handler = calls.at(-1)?.[0];
  if (handler === undefined) throw new Error("the list did not subscribe");
  return handler;
}

const queries = (backend: Backend) => vi.mocked(backend.collectionQuery).mock.calls.length;

describe("a read-only list that other programs write beside", () => {
  it("watches the list's filter and reads again when its documents change", async () => {
    const backend = tasksBackend();
    await openTasks(backend, true);
    expect(backend.collectionWatch).toHaveBeenCalledWith("s1", "tasks", { rows: [] });
    const before = queries(backend);

    listener(backend)({ session_id: "s1", collection: "tasks" });

    await waitFor(() => expect(queries(backend)).toBe(before + 1));
  });

  it("ignores changes to another collection or session", async () => {
    const backend = tasksBackend();
    await openTasks(backend, true);
    const before = queries(backend);

    listener(backend)({ session_id: "s1", collection: "people" });
    listener(backend)({ session_id: "s2", collection: "tasks" });

    await new Promise((done) => setTimeout(done, 50));
    expect(queries(backend)).toBe(before);
  });

  it("is not watched while the session can change data", async () => {
    const backend = tasksBackend();
    await openTasks(backend, false);

    expect(backend.collectionWatch).not.toHaveBeenCalled();
    expect(backend.onListChanged).not.toHaveBeenCalled();
  });
});

describe("the list's live state in the status bar", () => {
  const statusBar = () => screen.getByRole("contentinfo");

  it("says Live, and when the list last changed", async () => {
    const backend = tasksBackend();
    await openTasks(backend, true);
    expect(within(statusBar()).getByText(/^Live$/)).toBeInTheDocument();

    listener(backend)({ session_id: "s1", collection: "tasks" });

    expect(await within(statusBar()).findByText(/^Live · updated \d/)).toBeInTheDocument();
  });

  it("turns the watch off and on with the toolbar button", async () => {
    const stop = vi.fn();
    const backend = tasksBackend({ onListChanged: vi.fn(() => stop) });
    await openTasks(backend, true);
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Live updates" });

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(within(statusBar()).getByText("Live off")).toBeInTheDocument();
    expect(backend.collectionUnwatch).toHaveBeenCalledWith("s1", "tasks");
    expect(stop).toHaveBeenCalled();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(backend.collectionWatch).toHaveBeenCalledTimes(2));
  });

  it("has no live state for an editing session, and no toggle", async () => {
    const backend = tasksBackend();
    await openTasks(backend, false);

    expect(screen.queryByRole("button", { name: "Live updates" })).toBeNull();
    expect(within(statusBar()).queryByText(/Live/)).toBeNull();
  });

  it("says Live for the groups too, with the same toolbar toggle", async () => {
    const backend = tasksBackend();
    await openTasks(backend, true);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Groups" }));

    expect(within(statusBar()).getByText("Live")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Live updates" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(within(statusBar()).getByText("Live off")).toBeInTheDocument();
    expect(backend.collectionUnwatch).toHaveBeenCalledWith("s1", "tasks");
  });

  it("watches the groups once they are run, and groups again when they change", async () => {
    const backend = tasksBackend();
    await openTasks(backend, true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Groups" }));
    expect(backend.collectionGroupsWatch).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));

    await waitFor(() =>
      expect(backend.collectionGroupsWatch).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ collection: "tasks", group_by: ["status"] }),
      ),
    );
    const groupsRead = () => vi.mocked(backend.collectionGroups).mock.calls.length;
    const before = groupsRead();
    listener(backend)({ session_id: "s1", collection: "tasks" });
    await waitFor(() => expect(groupsRead()).toBe(before + 1));
    expect(await within(statusBar()).findByText(/^Live · updated \d/)).toBeInTheDocument();
  });
});

describe("changes while the list is busy", () => {
  it("a change re-reads the page that was asked for, not the one shown", async () => {
    // Page 2 is answered only when the test says so: the request is in flight.
    const waiting: Array<() => void> = [];
    const backend = tasksBackend({
      collectionQuery: vi.fn(
        (_session: string, request: QueryRequest) =>
          new Promise<QueryResult>((answer) => {
            const result = resultFor(request, [objectRow("id-1")], 120);
            if (request.page === 0) answer(result);
            else waiting.push(() => answer(result));
          }),
      ),
    });
    await openTasks(backend, true);
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(backend.collectionQuery).toHaveBeenCalledTimes(2));

    listener(backend)({ session_id: "s1", collection: "tasks" });

    await waitFor(() => expect(backend.collectionQuery).toHaveBeenCalledTimes(3));
    expect(vi.mocked(backend.collectionQuery).mock.calls[2]?.[1].page).toBe(1);
    waiting.forEach((answer) => answer());
    expect(await screen.findByText(/page 2 of 3/)).toBeInTheDocument();
  });

  it("a collection switch stops the old watch before the new one starts", async () => {
    const backend = tasksBackend();
    const overview = overviewOf(collection("tasks", 2), collection("people", 3));
    backend.sessionOverview = vi.fn(async () => overview);
    await openTasks(backend, true);

    const user = userEvent.setup();
    await user.click(
      within(screen.getByRole("navigation", { name: "Database" })).getByRole("button", {
        name: /^people/,
      }),
    );
    await waitFor(() =>
      expect(backend.collectionWatch).toHaveBeenCalledWith("s1", "people", { rows: [] }),
    );

    const stop = vi.mocked(backend.collectionUnwatch).mock.invocationCallOrder[0] ?? Infinity;
    const start = vi.mocked(backend.collectionWatch).mock.invocationCallOrder.at(-1) ?? 0;
    expect(backend.collectionUnwatch).toHaveBeenCalledWith("s1", "tasks");
    expect(stop).toBeLessThan(start);
  });
});
