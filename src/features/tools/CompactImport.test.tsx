import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../app/App";
import { DraftGuardProvider } from "../../app/DraftGuard";
import type { Backend } from "../../ipc/backend";
import { BackendProvider } from "../../ipc/BackendContext";
import type { CompactReport } from "../../ipc/types";
import {
  appError,
  deferred,
  fakeBackend,
  recentFile,
  sessionInfo,
  storageOf,
} from "../../test/fakeBackend";
import { Workspace } from "../workspace/Workspace";
import { importedName } from "./useDatabaseTools";

vi.mock("../../components/JsonEditor", async () => await import("../../test/PlainJsonEditor"));

// Compact and import.

function renderWorkspace(backend: Backend, readOnly = false, onOpenOther = vi.fn()) {
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
          onOpenOther={onOpenOther}
        />
      </DraftGuardProvider>
    </BackendProvider>,
  );
  return { user: userEvent.setup(), onOpenOther };
}

const storagePanel = async () =>
  (await screen.findByRole("heading", { name: "Storage" })).closest("section") as HTMLElement;
const compactButton = async () =>
  within(await storagePanel()).findByRole("button", { name: /Compact…|Compacting…/ });

describe("compact", () => {
  it("is offered only when it frees something, and says why not", async () => {
    renderWorkspace(
      fakeBackend({
        databaseStorage: vi.fn(async () => storageOf({ pages: 12, compacted_pages: 12 })),
      }),
    );

    const button = await compactButton();
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAccessibleDescription("Already as small as a compaction makes it.");
  });

  it("confirms with the numbers, compacts, and reads the sizes again", async () => {
    const running = deferred<CompactReport>();
    const backend = fakeBackend({
      databaseStorage: vi.fn(async () => storageOf({ pages: 214, compacted_pages: 171 })),
      databaseCompact: vi.fn(() => running.promise),
    });
    const { user } = renderWorkspace(backend);
    const button = await compactButton();
    await waitFor(() => expect(button).toBeEnabled());
    const storageReads = vi.mocked(backend.databaseStorage).mock.calls.length;
    const overviewReads = vi.mocked(backend.sessionOverview).mock.calls.length;

    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Compact the database?" });
    expect(dialog).toHaveTextContent("214 pages (1.7 MiB) to 171 pages (1.3 MiB)");
    expect(dialog).toHaveTextContent("frees 344.0 KiB");
    expect(dialog).toHaveTextContent("an open draft");
    expect(backend.databaseCompact).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Compact" }));

    expect(backend.databaseCompact).toHaveBeenCalledWith("s1");
    expect(await compactButton()).toHaveTextContent("Compacting…");
    expect(screen.getByRole("button", { name: "Run check" })).toBeDisabled();
    running.resolve({ pages_before: 214, pages_after: 171, page_size: 8192 });

    expect(await screen.findByRole("status", { name: "Compaction result" })).toHaveTextContent(
      "Compacted: 214 → 171 pages, 344.0 KiB freed.",
    );
    await waitFor(() =>
      expect(vi.mocked(backend.databaseStorage).mock.calls.length).toBeGreaterThan(storageReads),
    );
    expect(vi.mocked(backend.sessionOverview).mock.calls.length).toBeGreaterThan(overviewReads);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the dialog with the reason when a read is in the way, to try again", async () => {
    const databaseCompact = vi
      .fn<Backend["databaseCompact"]>()
      .mockRejectedValueOnce(
        appError("busy", "Another read is still running. Try again in a moment."),
      )
      .mockResolvedValue({ pages_before: 12, pages_after: 10, page_size: 8192 });
    const { user } = renderWorkspace(fakeBackend({ databaseCompact }));
    const button = await compactButton();
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Compact the database?" });

    await user.click(within(dialog).getByRole("button", { name: "Compact" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Try again in a moment");
    await user.click(within(dialog).getByRole("button", { name: "Compact" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(databaseCompact).toHaveBeenCalledTimes(2);
  });

  it("is not there in a read-only session", async () => {
    renderWorkspace(fakeBackend(), true);
    await storagePanel();
    expect(screen.queryByRole("button", { name: /Compact/ })).toBeNull();
  });
});

describe("import", () => {
  it("offers a database name from the export's", () => {
    expect(importedName("/x/shop.jsonl")).toBe("shop.trunkdb");
    expect(importedName("/x/backup.2026-10-01.jsonl")).toBe("backup.2026-10-01.trunkdb");
    expect(importedName("/x/.jsonl")).toBe("imported.trunkdb");
  });

  it("from the start screen, makes the new database and opens it", async () => {
    const backend = fakeBackend({
      pickExportToImport: vi.fn(async () => "/exports/shop.jsonl"),
      pickImportDestination: vi.fn(async (name: string) => `/data/${name}`),
    });
    render(
      <BackendProvider value={backend}>
        <App />
      </BackendProvider>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Import…" }));

    expect(await screen.findByRole("heading", { level: 1, name: "shop.trunkdb" })).toBeVisible();
    expect(backend.pickImportDestination).toHaveBeenCalledWith("shop.trunkdb");
    expect(backend.databaseImport).toHaveBeenCalledWith(
      "/exports/shop.jsonl",
      "/data/shop.trunkdb",
    );
    expect(backend.databaseOpen).toHaveBeenCalledWith("/data/shop.trunkdb", false);
    expect(screen.getByText(/into this new database/)).toHaveTextContent(
      "2 collections and 4 documents",
    );
  });

  it("from the start screen, does nothing when a dialog is cancelled, and shows a failure", async () => {
    const backend = fakeBackend({
      recentList: vi.fn(async () => [recentFile("/data/a.trunkdb")]),
      pickExportToImport: vi.fn(async () => "/exports/broken.jsonl"),
      databaseImport: vi.fn(async () => {
        throw {
          ...appError("invalid_input", "The export can't be read. Nothing was created."),
          detail: "line 12: expected a document",
        };
      }),
    });
    render(
      <BackendProvider value={backend}>
        <App />
      </BackendProvider>,
    );
    const user = userEvent.setup();

    // The destination dialog cancelled (the fake returns null).
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import…" })).toBeEnabled());
    expect(backend.databaseImport).not.toHaveBeenCalled();

    vi.mocked(backend.pickImportDestination).mockResolvedValue("/data/broken.trunkdb");
    await user.click(screen.getByRole("button", { name: "Import…" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The export can't be read. Nothing was created.");
    expect(backend.databaseOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "TrunkDB Admin" })).toBeVisible();
  });

  it("from the tools, leaves the open database as it is and offers to open the new one", async () => {
    const backend = fakeBackend({
      pickExportToImport: vi.fn(async () => "/exports/shop.jsonl"),
      pickImportDestination: vi.fn(async (name: string) => `/data/copy-${name}`),
    });
    const { user, onOpenOther } = renderWorkspace(backend);

    await user.click(await screen.findByRole("button", { name: "Import into a new database…" }));

    const result = await screen.findByRole("status", { name: "Import result" });
    expect(result).toHaveTextContent("2 collections and 4 documents in a new database");
    expect(backend.sessionClose).not.toHaveBeenCalled();
    await user.click(within(result).getByRole("button", { name: "Open it" }));
    expect(onOpenOther).toHaveBeenCalledWith("/data/copy-shop.trunkdb");
  });

  it("from the tools, shows a failed import", async () => {
    const backend = fakeBackend({
      pickExportToImport: vi.fn(async () => "/exports/shop.jsonl"),
      pickImportDestination: vi.fn(async () => "/data/taken.trunkdb"),
      databaseImport: vi.fn(async () => {
        throw appError("already_exists", "A file with this name already exists.");
      }),
    });
    const { user } = renderWorkspace(backend);

    await user.click(await screen.findByRole("button", { name: "Import into a new database…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The import failed; nothing was created. A file with this name already exists.",
    );
  });
});
