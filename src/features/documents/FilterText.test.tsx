import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { GroupRequest, QueryRequest, SaveRequest } from "../../ipc/types";
import {
  appError,
  collection,
  fakeBackend,
  groupRow,
  groupsFor,
  objectRow,
  overviewOf,
  resultFor,
  sessionInfo,
} from "../../test/fakeBackend";
import { Workspace } from "../workspace/Workspace";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

// Filters as text.

function tasksBackend(overrides: Partial<Backend> = {}) {
  return fakeBackend({
    sessionOverview: vi.fn(async () => overviewOf(collection("tasks", 3))),
    collectionQuery: vi.fn(async (_session: string, request: QueryRequest) =>
      resultFor(request, [objectRow("id-1"), objectRow("id-2")], 2),
    ),
    collectionGroups: vi.fn(async (_session: string, request: GroupRequest) =>
      groupsFor(request, [groupRow(request, ["failed"], 2)], 1),
    ),
    ...overrides,
  });
}

async function openTasks(backend: Backend): Promise<UserEvent> {
  render(
    <BackendProvider value={backend}>
      <DraftGuardProvider>
        <Workspace
          session={sessionInfo("/data/tasks.trunkdb")}
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
  await user.click(await within(sidebar).findByRole("button", { name: /^tasks/ }));
  await screen.findByRole("list", { name: "Documents as JSON" });
  return user;
}

const queries = (backend: Backend): QueryRequest[] =>
  vi.mocked(backend.collectionQuery).mock.calls.map(([, request]) => request);
const lastQuery = (backend: Backend) => queries(backend).at(-1) as QueryRequest;
const box = () => screen.getByRole("textbox", { name: "Filter text" });
const toText = (user: UserEvent) => user.click(screen.getByRole("button", { name: "Text" }));
const toRows = (user: UserEvent) => user.click(screen.getByRole("button", { name: "Rows" }));

/** Types `text` into the box, replacing what is there. */
const enter = (text: string) => fireEvent.change(box(), { target: { value: text } });

describe("switching between rows and text", () => {
  it("prints the rows as text, and runs nothing", async () => {
    const backend = tasksBackend({ filterToText: vi.fn(async () => 'status = "failed"') });
    const user = await openTasks(backend);
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "status");
    await user.type(screen.getByLabelText("Condition 1 value"), "failed");
    const asked = queries(backend).length;

    await toText(user);

    expect(box()).toHaveValue('status = "failed"');
    expect(backend.filterToText).toHaveBeenCalledWith([
      { field: "status", operator: "eq", value: { type: "string", text: "failed" } },
    ]);
    expect(screen.queryByRole("button", { name: "Add condition" })).toBeNull();
    expect(queries(backend)).toHaveLength(asked);
  });

  it("takes text back into rows where it has their shape", async () => {
    const backend = tasksBackend({
      filterToRows: vi.fn(async () => ({
        rows: [{ field: "n", operator: "gt" as const, value: { type: "int" as const, text: "3" } }],
      })),
    });
    const user = await openTasks(backend);
    await toText(user);
    enter("n > 3");

    await toRows(user);

    expect(await screen.findByLabelText("Condition 1 field path")).toHaveValue("n");
    expect(screen.getByLabelText("Condition 1 operator")).toHaveValue("gt");
    expect(screen.getByLabelText("Condition 1 value")).toHaveValue("3");
    expect(backend.filterToRows).toHaveBeenCalledWith("n > 3");
  });

  it("keeps the text and says why when rows can't show it", async () => {
    const backend = tasksBackend({
      filterToRows: vi.fn(async () => ({
        reason: "This filter has an `or` (or an `in`), which rows can't show.",
      })),
    });
    const user = await openTasks(backend);
    await toText(user);
    enter("a = 1 or b = 2");

    await toRows(user);

    expect(await screen.findByText(/which rows can't show/)).toBeVisible();
    expect(box()).toHaveValue("a = 1 or b = 2");
    expect(screen.getByRole("button", { name: "Text" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("running text", () => {
  it("sends the text as typed, with Run and with Cmd+Enter", async () => {
    const backend = tasksBackend();
    const user = await openTasks(backend);
    await toText(user);
    enter('status in ("failed", "stuck")  or  n <> 3');

    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(lastQuery(backend).filter).toEqual({
        text: 'status in ("failed", "stuck")  or  n <> 3',
      }),
    );
    expect(lastQuery(backend).page).toBe(0);
    expect(box()).toHaveValue('status in ("failed", "stuck")  or  n <> 3');

    enter("n > 1");
    const asked = queries(backend).length;
    box().focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(queries(backend)).toHaveLength(asked + 1));
    expect(lastQuery(backend).filter).toEqual({ text: "n > 1" });
  });

  it("puts an example from the syntax help where the cursor is", async () => {
    const backend = tasksBackend();
    const user = await openTasks(backend);
    await toText(user);
    enter("n > 1 and ");
    await user.click(screen.getByText("Syntax"));

    await user.click(
      screen.getByRole("button", { name: 'Insert items has (sku = "A1" and qty >= 10)' }),
    );
    expect(box()).toHaveValue('n > 1 and items has (sku = "A1" and qty >= 10)');
    expect(box()).toHaveFocus();

    (box() as HTMLTextAreaElement).setSelectionRange(0, 5);
    await user.click(screen.getByRole("button", { name: "Insert exists(note)" }));
    expect(box()).toHaveValue('exists(note) and items has (sku = "A1" and qty >= 10)');
    // Nothing runs until Run.
    expect(lastQuery(backend).filter).toEqual({ rows: [] });
  });

  it("shows a mistake under the box with its place, and keeps the list", async () => {
    const backend = tasksBackend({
      collectionQuery: vi.fn(async (_session: string, request: QueryRequest) => {
        if ("text" in request.filter) {
          throw {
            ...appError("invalid_input", "The filter text doesn't read."),
            detail: "expected a value, found `Ada` at line 2 column 10",
            at: { line: 2, column: 10, index: 19 },
          };
        }
        return resultFor(request, [objectRow("id-1")], 1);
      }),
    });
    const user = await openTasks(backend);
    await toText(user);
    enter("n > 1 and\n  name = Ada");

    await user.click(screen.getByRole("button", { name: "Run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("expected a value, found `Ada` at line 2 column 10");
    // The line, and a mark under column 10.
    expect(alert.querySelector("pre")?.textContent).toBe("  name = Ada\n         ^");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(box()).toHaveAttribute("aria-invalid", "true");
    expect((box() as HTMLTextAreaElement).selectionStart).toBe(19);
    // The list shown before stays.
    expect(screen.getByRole("button", { name: /id-1/ })).toBeVisible();
  });
});

describe("text everywhere the filter goes", () => {
  it("groups by the text, and a group's documents come back into the box", async () => {
    const backend = tasksBackend();
    const user = await openTasks(backend);
    await toText(user);
    enter("n > 1 or n < 0");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(lastQuery(backend).filter).toEqual({ text: "n > 1 or n < 0" }));

    await user.click(screen.getByRole("button", { name: "Groups" }));
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    await waitFor(() =>
      expect(vi.mocked(backend.collectionGroups).mock.calls.at(-1)?.[1].filter).toEqual({
        text: "n > 1 or n < 0",
      }),
    );

    await user.click(await screen.findByRole("button", { name: "Show documents of group 1" }));

    const drill = '(n > 1 or n < 0) and status = "failed"';
    await waitFor(() => expect(lastQuery(backend).filter).toEqual({ text: drill }));
    expect(box()).toHaveValue(drill);
  });

  it("checks a saved document against the text", async () => {
    const backend = tasksBackend();
    const user = await openTasks(backend);
    await toText(user);
    enter('status = "failed"');
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(lastQuery(backend).filter).toEqual({ text: 'status = "failed"' }));

    await user.click(screen.getByRole("button", { name: "New document" }));
    await screen.findByRole("textbox", { name: "New document JSON" });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(backend.documentSave).toHaveBeenCalled());
    const saved = vi.mocked(backend.documentSave).mock.calls[0]?.[1] as SaveRequest;
    expect(saved.filter).toEqual({ text: 'status = "failed"' });
  });
});

describe("copy as command", () => {
  it("puts the list's query on the clipboard", async () => {
    const backend = tasksBackend({
      collectionFindCommand: vi.fn(async () => "trunkdb find /data/tasks.trunkdb tasks 'n > 1'"),
    });
    const user = await openTasks(backend);

    await user.click(screen.getByRole("button", { name: "Copy as command" }));

    expect(await screen.findByText("Copied")).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe(
      "trunkdb find /data/tasks.trunkdb tasks 'n > 1'",
    );
    expect(vi.mocked(backend.collectionFindCommand).mock.calls[0]?.[1]).toMatchObject({
      collection: "tasks",
      filter: { rows: [] },
    });
  });

  it("shows the command to select by hand when the clipboard is refused", async () => {
    const backend = tasksBackend({
      collectionFindCommand: vi.fn(async () => "trunkdb find /data/tasks.trunkdb tasks"),
    });
    const user = await openTasks(backend);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));

    await user.click(screen.getByRole("button", { name: "Copy as command" }));

    const dialog = await screen.findByRole("dialog", { name: "Command" });
    expect(within(dialog).getByRole("textbox", { name: "Command" })).toHaveValue(
      "trunkdb find /data/tasks.trunkdb tasks",
    );
  });
});
