import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { CheckReport, ExportSummary } from "../../ipc/types";
import {
  appError,
  collection,
  deferred,
  fakeBackend,
  overviewOf,
  sessionInfo,
} from "../../test/fakeBackend";
import { Workspace } from "../workspace/Workspace";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

function renderWorkspace(backend: Backend, closing = false) {
  const view = (isClosing: boolean) => (
    <BackendProvider value={backend}>
      <DraftGuardProvider>
        <Workspace
          session={sessionInfo("/data/shop.trunkdb")}
          appInfo={null}
          closing={isClosing}
          switching={false}
          onClose={() => undefined}
          onSwitchMode={() => undefined}
          onOpenOther={() => undefined}
        />
      </DraftGuardProvider>
    </BackendProvider>
  );
  const { rerender } = render(view(closing));
  return { user: userEvent.setup(), setClosing: (next: boolean) => rerender(view(next)) };
}

const checkButton = () => screen.findByRole("button", { name: /Run check|Checking…/ });
const exportButton = () => screen.getByRole("button", { name: /Export database…|Exporting…/ });
const CLEAN: CheckReport = { collections: 4, documents: 66, pages: 12, problems: [] };

describe("consistency check", () => {
  it("runs only on request and shows a clean report with its counts", async () => {
    const running = deferred<CheckReport>();
    const backend = fakeBackend({ databaseCheck: vi.fn(() => running.promise) });
    const { user } = renderWorkspace(backend);
    await checkButton();
    expect(backend.databaseCheck).not.toHaveBeenCalled();

    await user.click(await checkButton());

    expect(await screen.findByText("Checking the database…")).toBeVisible();
    expect(await checkButton()).toBeDisabled();
    expect(exportButton()).toBeDisabled();
    await user.click(await checkButton());
    expect(backend.databaseCheck).toHaveBeenCalledTimes(1);

    running.resolve(CLEAN);
    const report = await screen.findByRole("status", { name: "Check report" });
    expect(report).toHaveTextContent("No problems found.");
    expect(report).toHaveTextContent("Checked 4 collections, 66 documents and 12 pages.");
    expect(await checkButton()).toBeEnabled();
  });

  it("lists every reported problem and does not call the database clean", async () => {
    const problems = [
      "page 9 is damaged: its checksum doesn't match",
      '"items": 32 documents can\'t be read, on damaged page 9',
      "leaks not checked: not everything could be read",
    ];
    const backend = fakeBackend({
      databaseCheck: vi.fn(async () => ({ ...CLEAN, problems })),
    });
    const { user } = renderWorkspace(backend);

    await user.click(await checkButton());

    const report = await screen.findByRole("status", { name: "Check report" });
    expect(report).toHaveTextContent("3 problems found.");
    expect(
      within(report)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(problems);
    expect(report).not.toHaveTextContent("No problems found");
  });

  it("shows a check that could not finish as a failure, not as an earlier clean report", async () => {
    const databaseCheck = vi
      .fn<Backend["databaseCheck"]>()
      .mockResolvedValueOnce(CLEAN)
      .mockRejectedValueOnce(appError("damaged_data", "The database file is damaged."));
    const { user } = renderWorkspace(fakeBackend({ databaseCheck }));
    await user.click(await checkButton());
    await screen.findByRole("status", { name: "Check report" });

    await user.click(await checkButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The check could not be completed.");
    expect(alert).toHaveTextContent("The database file is damaged.");
    expect(screen.queryByRole("status", { name: "Check report" })).toBeNull();
    expect(screen.queryByText("No problems found.")).toBeNull();
  });

  it("keeps the report readable after a look at a collection", async () => {
    const backend = fakeBackend({
      sessionOverview: vi.fn(async () => overviewOf(collection("people", 2))),
      databaseCheck: vi.fn(async () => CLEAN),
    });
    const { user } = renderWorkspace(backend);
    await user.click(await checkButton());
    await screen.findByRole("status", { name: "Check report" });
    const nav = within(screen.getByRole("navigation", { name: "Database" }));

    await user.click(await nav.findByRole("button", { name: /^people/ }));
    await screen.findByRole("heading", { name: "people" });
    await user.click(nav.getByRole("button", { name: "Database" }));

    expect(screen.getByRole("status", { name: "Check report" })).toHaveTextContent(
      "No problems found.",
    );
    expect(backend.databaseCheck).toHaveBeenCalledTimes(1);
  });

  it("explains a close that waits for the running check", async () => {
    const running = deferred<CheckReport>();
    const backend = fakeBackend({ databaseCheck: vi.fn(() => running.promise) });
    const { user, setClosing } = renderWorkspace(backend);
    await user.click(await checkButton());

    setClosing(true);

    expect(await screen.findByText("Waiting for the running tool to finish…")).toBeVisible();
    running.resolve(CLEAN);
    await waitFor(() => expect(screen.queryByText(/Waiting for the running/)).toBeNull());
  });
});

describe("export", () => {
  it("suggests a .jsonl name and reports what was written", async () => {
    const backend = fakeBackend({
      pickExportDestination: vi.fn(async () => "/out/shop.jsonl"),
      databaseExport: vi.fn(async (): Promise<ExportSummary> => ({
        path: "/private/out/shop.jsonl",
        collections: 4,
        documents: 66,
        bytes: 12345,
      })),
    });
    const { user } = renderWorkspace(backend);
    await checkButton();
    expect(screen.getByText(/TrunkDB tagged JSON Lines \(\.jsonl\)/)).toBeVisible();

    await user.click(exportButton());

    const result = await screen.findByRole("status", { name: "Export result" });
    expect(backend.pickExportDestination).toHaveBeenCalledWith("shop.jsonl");
    expect(backend.databaseExport).toHaveBeenCalledWith("s1", "/out/shop.jsonl", true);
    expect(result).toHaveTextContent("4 collections and 66 documents, 12,345 bytes.");
    expect(result).toHaveTextContent("/private/out/shop.jsonl");
  });

  it("does nothing when the save dialog is cancelled, and frees the tools", async () => {
    const choosing = deferred<string | null>();
    const backend = fakeBackend({ pickExportDestination: vi.fn(() => choosing.promise) });
    const { user } = renderWorkspace(backend);
    await checkButton();

    await user.click(exportButton());
    // While the dialog is open nothing else starts.
    expect(await checkButton()).toBeDisabled();
    choosing.resolve(null);

    await waitFor(() => expect(exportButton()).toBeEnabled());
    expect(await checkButton()).toBeEnabled();
    expect(backend.databaseExport).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("replaces a file chosen in the save dialog without asking again", async () => {
    // The native dialog has asked about the existing file already.
    const backend = fakeBackend({ pickExportDestination: vi.fn(async () => "/out/old.jsonl") });
    const { user } = renderWorkspace(backend);
    await checkButton();

    await user.click(exportButton());

    expect(await screen.findByRole("status", { name: "Export result" })).toHaveTextContent(
      "Export complete.",
    );
    expect(backend.databaseExport).toHaveBeenCalledTimes(1);
    expect(backend.databaseExport).toHaveBeenCalledWith("s1", "/out/old.jsonl", true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await checkButton()).toBeEnabled();
  });

  it("reports a refused destination and a failed export", async () => {
    const backend = fakeBackend({
      pickExportDestination: vi.fn(async () => "/data/shop.trunkdb"),
      databaseExport: vi.fn(async () => {
        throw appError(
          "invalid_input",
          "The export cannot be written to the open database or its write-ahead log.",
        );
      }),
    });
    const { user } = renderWorkspace(backend);
    await checkButton();

    await user.click(exportButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The export failed.");
    expect(alert).toHaveTextContent("cannot be written to the open database");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(exportButton()).toBeEnabled();
  });
});
