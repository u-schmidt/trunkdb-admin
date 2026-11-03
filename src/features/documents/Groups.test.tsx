import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { GroupRequest, GroupResult, QueryRequest } from "../../ipc/types";
import {
  collection,
  appError,
  deferred,
  fakeBackend,
  groupRow,
  groupsExplainOf,
  groupsFor,
  overviewOf,
  sessionInfo,
} from "../../test/fakeBackend";
import { Workspace } from "../workspace/Workspace";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

const STATUSES: [string, number][] = [
  ["done", 100],
  ["queued", 120],
  ["running", 80],
];

/** Answers by status, whatever was asked; `total` groups in all. */
const byStatus = (request: GroupRequest, total = STATUSES.length): GroupResult =>
  groupsFor(
    request,
    STATUSES.map(([status, n]) => groupRow(request, [status], n)),
    total,
  );

function backendWith(overrides: Partial<Backend> = {}) {
  return fakeBackend({
    sessionOverview: vi.fn(async () => overviewOf(collection("tasks", 300))),
    collectionGroups: vi.fn(async (_session: string, request: GroupRequest) => byStatus(request)),
    ...overrides,
  });
}

async function openGroups(backend: Backend) {
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
  await user.click(await screen.findByRole("button", { name: "Groups" }));
  return user;
}

const groupRequests = (backend: Backend): GroupRequest[] =>
  vi.mocked(backend.collectionGroups).mock.calls.map(([, request]) => request);
const lastGroups = (backend: Backend) => groupRequests(backend).at(-1) as GroupRequest;
const lastQuery = (backend: Backend) =>
  vi.mocked(backend.collectionQuery).mock.calls.at(-1)?.[1] as QueryRequest;

const groupTable = () => screen.findByRole("table", { name: "Groups" });
const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

describe("groups", () => {
  it("groups nothing until Run, then sends the filter's conditions, fields and columns", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    expect(screen.getByText("Choose how to group and press Run groups.")).toBeInTheDocument();
    expect(backend.collectionGroups).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.selectOptions(screen.getByLabelText("Column 1 kind"), "avg");
    await user.type(screen.getByLabelText("Column 1 field"), "tries");
    await user.click(screen.getByRole("button", { name: "Run groups" }));

    expect(lastGroups(backend)).toEqual({
      request_id: expect.any(Number) as number,
      collection: "tasks",
      filter: { rows: [] },
      unwind: [],
      group_by: ["status"],
      columns: [{ kind: "avg", field: "tries", condition: "", by: "" }],
      sort: null,
      page: 0,
      page_size: 50,
    });
    const table = await groupTable();
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["status", "count", "average tries", "Documents"]);
    expect(bodyRows(table).map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      '"done"',
      '"queued"',
      '"running"',
    ]);
    expect(screen.getByRole("navigation", { name: "Pages of groups" })).toHaveTextContent(
      "3 groups · page 1 of 1",
    );
  });

  it("sends a column's condition, and a count needs no field", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.selectOptions(screen.getByLabelText("Column 1 kind"), "count");
    expect(screen.queryByLabelText("Column 1 field")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Column 1 condition"), "tries > 3");
    await user.click(screen.getByRole("button", { name: "Run groups" }));

    expect(lastGroups(backend).columns).toEqual([
      { kind: "count", field: "", condition: "tries > 3", by: "" },
    ]);
    const table = await groupTable();
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["status", "count", "count where tries > 3", "Documents"]);
  });

  it("sends unwound arrays, and an order for first and last only", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    await user.click(screen.getByRole("button", { name: "Add unwind" }));
    await user.type(screen.getByLabelText("Unwind 1"), "items");
    await user.type(screen.getByLabelText("Group field 1"), "items.sku");
    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.selectOptions(screen.getByLabelText("Column 1 kind"), "last");
    await user.type(screen.getByLabelText("Column 1 field"), "status");
    await user.type(screen.getByLabelText("Column 1 order"), "created");
    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.selectOptions(screen.getByLabelText("Column 2 kind"), "first");
    await user.type(screen.getByLabelText("Column 2 field"), "tries");
    await user.type(screen.getByLabelText("Column 2 order"), "created");
    // No longer first or last: the order is hidden and not sent.
    await user.selectOptions(screen.getByLabelText("Column 2 kind"), "count_distinct");
    expect(screen.queryByLabelText("Column 2 order")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run groups" }));

    expect(lastGroups(backend)).toMatchObject({
      unwind: ["items"],
      group_by: ["items.sku"],
      columns: [
        { kind: "last", field: "status", condition: "", by: "created" },
        { kind: "count_distinct", field: "tries", condition: "", by: "" },
      ],
    });
    const table = await groupTable();
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual([
      "items.sku",
      "count",
      "last status by created",
      "distinct tries",
      "Documents",
    ]);
  });

  it("hides the list's sort, and says what to do before groups are explained", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    expect(screen.queryByLabelText("Sort by")).not.toBeVisible();
    const explain = screen.getByRole("button", { name: "Explain" });
    expect(explain).toBeDisabled();
    expect(explain).toHaveAttribute("title", "Run groups first");

    await user.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByLabelText("Sort by")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Explain" }));
    await screen.findByText(/read the primary index in sort order/);
    await user.click(screen.getByRole("button", { name: "Groups" }));
    expect(await screen.findByText("Run groups to see how they are made.")).toBeInTheDocument();
  });

  it("sorts by a header in the backend: the biggest groups first, then reversed", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    const table = await groupTable();

    await user.click(within(table).getByRole("button", { name: "count" }));
    expect(lastGroups(backend).sort).toEqual({ column: 1, descending: true });
    await waitFor(() =>
      expect(within(table).getByRole("columnheader", { name: /count/ })).toHaveAttribute(
        "aria-sort",
        "descending",
      ),
    );
    await user.click(within(table).getByRole("button", { name: /count/ }));
    expect(lastGroups(backend).sort).toEqual({ column: 1, descending: false });
    // A group field starts ascending.
    await user.click(within(table).getByRole("button", { name: "status" }));
    expect(lastGroups(backend).sort).toEqual({ column: 0, descending: false });
    // Each sort starts at the first page, of what was run, not of the form.
    await user.type(screen.getByLabelText("Group field 1"), "x");
    await user.click(within(table).getByRole("button", { name: /status/ }));
    expect(lastGroups(backend)).toMatchObject({ group_by: ["status"], page: 0 });
  });

  it("pages groups, and sizes the page", async () => {
    const backend = backendWith({
      collectionGroups: vi.fn(async (_session: string, request: GroupRequest) =>
        byStatus(request, 312),
      ),
    });
    const user = await openGroups(backend);
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    const pager = await screen.findByRole("navigation", { name: "Pages of groups" });
    expect(pager).toHaveTextContent("312 groups · page 1 of 7");
    await user.click(within(pager).getByRole("button", { name: "Next" }));
    expect(lastGroups(backend).page).toBe(1);
    await user.selectOptions(within(pager).getByLabelText("Per page"), "100");
    expect(lastGroups(backend)).toMatchObject({ page: 0, page_size: 100 });
  });

  it("shows a group's documents in the table, with its conditions in the filter", async () => {
    const backend = backendWith({
      collectionGroups: vi.fn(async (_session: string, request: GroupRequest) => {
        const result = byStatus(request);
        const last = result.rows[2];
        if (last !== undefined) {
          last.documents = null;
          last.no_documents =
            "“status” is an array here, which rows can't hold. Switch the filter to Text to show these documents.";
        }
        return result;
      }),
    });
    const user = await openGroups(backend);
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    await groupTable();

    const refused = screen.getByRole("button", { name: "Show documents of group 3" });
    expect(refused).toBeDisabled();
    expect(refused).toHaveAttribute("title", expect.stringContaining("an array") as string);

    await user.click(screen.getByRole("button", { name: "Show documents of group 2" }));
    expect(lastQuery(backend)).toMatchObject({
      filter: {
        rows: [{ field: "status", operator: "eq", value: { type: "string", text: "queued" } }],
      },
      page: 0,
    });
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Condition 1 field path")).toHaveValue("status");
    expect(screen.getByLabelText("Condition 1 value")).toHaveValue("queued");
    // Applied as shown: nothing waits for Run.
    expect(screen.queryByText("Not applied yet")).not.toBeInTheDocument();
  });

  it("is made again from the filter when it changes, and keeps its settings across views", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    await groupTable();
    const before = groupRequests(backend).length;

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "tenant");
    await user.type(screen.getByLabelText("Condition 1 value"), "t1");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(groupRequests(backend).length).toBe(before + 1));
    expect(lastGroups(backend)).toMatchObject({
      group_by: ["status"],
      filter: {
        rows: [{ field: "tenant", operator: "eq", value: { type: "string", text: "t1" } }],
      },
    });

    await user.click(screen.getByRole("button", { name: "JSON" }));
    await user.click(screen.getByRole("button", { name: "Groups" }));
    expect(screen.getByLabelText("Group field 1")).toHaveValue("status");
    expect(await groupTable()).toBeInTheDocument();
    // Nothing changed meanwhile: not made again.
    expect(groupRequests(backend).length).toBe(before + 1);
  });

  it("takes the filter as typed on Run groups, and groups on Run, once each", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    const tenant = {
      rows: [{ field: "tenant", operator: "eq", value: { type: "string", text: "t1" } }],
    };

    // The filter edited but not run: Run groups applies it to both.
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByLabelText("Condition 1 field path"), "tenant");
    await user.type(screen.getByLabelText("Condition 1 value"), "t1");
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    await groupTable();
    expect(lastGroups(backend)).toMatchObject({ group_by: ["status"], filter: tenant });
    expect(lastQuery(backend).filter).toEqual(tenant);
    await waitFor(() => expect(groupRequests(backend)).toHaveLength(1));

    // Settings changed but not run: the filter's Run groups with them.
    await user.click(screen.getByRole("button", { name: "Add group field" }));
    await user.type(screen.getByLabelText("Group field 2"), "tenant");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(groupRequests(backend)).toHaveLength(2));
    expect(lastGroups(backend)).toMatchObject({ group_by: ["status", "tenant"], filter: tenant });
  });

  it("shows the statement for the groups, and for the list after a switch", async () => {
    const backend = backendWith();
    const user = await openGroups(backend);
    const statement = screen.getByRole("button", { name: "Statement" });
    expect(statement).toBeDisabled();

    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    await groupTable();
    await user.click(statement);
    expect(await screen.findByLabelText("Statement")).toHaveTextContent(
      'let aggregate = Aggregate::new().group_by("status");',
    );
    expect(backend.groupsStatement).toHaveBeenLastCalledWith(
      expect.objectContaining({ collection: "tasks", group_by: ["status"] }),
    );
    expect(
      screen.getByRole("heading", { name: "The statement for these groups" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "JSON" }));
    expect(
      await screen.findByRole("heading", { name: "The statement for this page" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Statement")).toHaveTextContent(
        'let collection = db.collection::<Document>("tasks");',
      ),
    );
    expect(backend.queryStatement).toHaveBeenLastCalledWith(
      expect.objectContaining({ collection: "tasks", page: 0 }),
    );

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Statement")).not.toBeInTheDocument();
  });

  it("keeps the newest answer only, and the last groups when the backend refuses", async () => {
    const slow = deferred<GroupResult>();
    let calls = 0;
    const backend = backendWith({
      collectionGroups: vi.fn(async (_session: string, request: GroupRequest) => {
        calls += 1;
        if (calls === 1) return slow.promise;
        if (request.group_by.includes("")) {
          throw appError("invalid_input", "Group field 2: enter a field path.");
        }
        return groupsFor(request, [groupRow(request, ["t1"], 7)]);
      }),
    });
    const user = await openGroups(backend);
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    await user.clear(screen.getByLabelText("Group field 1"));
    await user.type(screen.getByLabelText("Group field 1"), "tenant");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    const table = await groupTable();
    slow.resolve(byStatus(groupRequests(backend)[0] as GroupRequest));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(1));
    expect(within(table).getByText('"t1"')).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add group field" }));
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    expect(await screen.findByText("Group field 2: enter a field path.")).toBeInTheDocument();
    expect(within(table).getByText('"t1"')).toBeInTheDocument();
    expect(screen.getByLabelText("Group field 1")).toHaveValue("tenant");
  });

  it("explains how the groups are made, and follows them while open", async () => {
    const backend = backendWith({
      collectionGroupsExplain: vi.fn(async (_session: string, request: GroupRequest) =>
        request.sort === null
          ? groupsExplainOf(request)
          : groupsExplainOf(request, {
              plan: "scan",
              reads: [],
              keys_examined: 0,
              documents_examined: 300,
              from_entries: 0,
            }),
      ),
    });
    const user = await openGroups(backend);
    expect(screen.getByRole("button", { name: "Explain" })).toBeDisabled();
    await user.type(screen.getByLabelText("Group field 1"), "status");
    await user.click(screen.getByRole("button", { name: "Run groups" }));
    await groupTable();
    await user.click(screen.getByRole("button", { name: "Explain" }));

    const panel = await screen.findByRole("region", { name: "How these groups are made" });
    expect(lastExplained(backend)).toMatchObject({ group_by: ["status"], filter: { rows: [] } });
    await within(panel).findByText("Counted from the index entries: no document was read.");
    expect(panel).toHaveTextContent(
      "trunkdb walked the index on (status, created) from end to end.",
    );
    expect(panel).toHaveTextContent("Groups3");

    // Sorted, the fake answers with a scan, and names the index that would help.
    await user.click(within(await groupTable()).getByRole("button", { name: "count" }));
    await within(panel).findByText(/An index on “status” could let trunkdb count/);
    expect(panel).toHaveTextContent("No index was used");
    expect(backend.collectionExplain).not.toHaveBeenCalled();
  });
});

const lastExplained = (backend: Backend) =>
  vi.mocked(backend.collectionGroupsExplain).mock.calls.at(-1)?.[1] as GroupRequest;
