import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { ListChanged, QueryRequest } from "../../ipc/types";
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

function tasksBackend() {
  return fakeBackend({
    sessionOverview: vi.fn(async () => overviewOf(collection("tasks", 2))),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, [objectRow("id-1")], 1),
    ),
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
