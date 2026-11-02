import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Backend } from "../ipc/backend";
import { BackendProvider } from "../ipc/BackendContext";
import type { Opened } from "../ipc/types";
import { appError, deferred, fakeBackend, recentFile, sessionInfo } from "../test/fakeBackend";
import { App } from "./App";

function renderApp(backend: Backend) {
  render(
    <BackendProvider value={backend}>
      <App />
    </BackendProvider>,
  );
  return userEvent.setup();
}

const startHeading = () => screen.findByRole("heading", { level: 1, name: "TrunkDB Admin" });

describe("start screen", () => {
  it("opens nothing on startup and shows the bundled trunkdb version", async () => {
    const backend = fakeBackend({
      recentList: vi.fn(async () => [recentFile("/data/shop.trunkdb")]),
    });
    renderApp(backend);

    await startHeading();
    expect(await screen.findByText(/trunkdb 0\.19\.0 \(d422d3e\)/)).toBeInTheDocument();
    expect(await screen.findByText("shop.trunkdb")).toBeInTheDocument();
    expect(backend.databaseOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close database" })).not.toBeInTheDocument();
  });

  it("opens the chosen file and shows its metadata", async () => {
    const backend = fakeBackend({ pickDatabaseToOpen: vi.fn(async () => "/data/shop.trunkdb") });
    const user = renderApp(backend);

    await user.click(await screen.findByRole("button", { name: "Open database…" }));

    expect(await screen.findByRole("heading", { level: 1, name: "shop.trunkdb" })).toBeVisible();
    expect(backend.databaseOpen).toHaveBeenCalledWith("/data/shop.trunkdb", false);
    const file = screen.getByRole("region", { name: "File" });
    const fact = (name: string) =>
      within(file).getByText(name, { selector: "dt" }).nextElementSibling;
    expect(fact("File format")).toHaveTextContent(/^12$/);
    expect(fact("Last written by")).toHaveTextContent("trunkdb 0.24.0");
    expect(fact("Created by")).toHaveTextContent("trunkdb 0.24.0");
    expect(within(file).getByText("8,192 bytes")).toBeInTheDocument();
    expect(within(file).getByText("0.19.0 (d422d3e)")).toBeInTheDocument();
  });

  it("does nothing when the open dialog is cancelled", async () => {
    const backend = fakeBackend();
    const user = renderApp(backend);

    await user.click(await screen.findByRole("button", { name: "Open database…" }));

    expect(backend.databaseOpen).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open database…" })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("creates through its own action, never through open", async () => {
    const backend = fakeBackend({ pickDatabaseToCreate: vi.fn(async () => "/data/new.trunkdb") });
    const user = renderApp(backend);

    await user.click(await screen.findByRole("button", { name: "Create database…" }));

    expect(await screen.findByRole("heading", { level: 1, name: "new.trunkdb" })).toBeVisible();
    expect(backend.databaseCreate).toHaveBeenCalledWith("/data/new.trunkdb");
    expect(backend.databaseOpen).not.toHaveBeenCalled();
  });

  it("reports a refused create and stays on the start screen", async () => {
    const backend = fakeBackend({
      pickDatabaseToCreate: vi.fn(async () => "/data/taken.trunkdb"),
      databaseCreate: vi.fn(async () => {
        throw appError("already_exists", "A file with this name already exists.");
      }),
    });
    const user = renderApp(backend);

    await user.click(await screen.findByRole("button", { name: "Create database…" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A file with this name already exists.");
    expect(alert).toHaveTextContent("/data/taken.trunkdb");
    await startHeading();
  });

  it("starts only one open while one is in flight", async () => {
    const opening = deferred<Opened>();
    const backend = fakeBackend({
      recentList: vi.fn(async () => [recentFile("/a.trunkdb"), recentFile("/b.trunkdb")]),
      databaseOpen: vi.fn(() => opening.promise),
    });
    const user = renderApp(backend);

    await user.click(await screen.findByRole("button", { name: "Open /a.trunkdb" }));

    expect(screen.getByRole("button", { name: "Open /b.trunkdb" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open database…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create database…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open /b.trunkdb" }));
    expect(backend.databaseOpen).toHaveBeenCalledTimes(1);

    opening.resolve({ session: sessionInfo("/a.trunkdb"), recent: [] });
    expect(await screen.findByRole("heading", { level: 1, name: "a.trunkdb" })).toBeVisible();
  });
});

describe("recent databases", () => {
  it("reports a missing recent file, offers removal, and opens nothing", async () => {
    const gone = "/data/gone.trunkdb";
    const backend = fakeBackend({
      recentList: vi.fn(async () => [recentFile(gone, false)]),
      databaseOpen: vi.fn(async () => {
        throw appError("file_not_found", "The file cannot be opened.");
      }),
      recentRemove: vi.fn(async () => []),
    });
    const user = renderApp(backend);

    expect(await screen.findByText("File not found")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Open ${gone}` }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The file cannot be opened.");
    expect(backend.databaseCreate).not.toHaveBeenCalled();
    await startHeading();

    await user.click(within(alert).getByRole("button", { name: "Remove from recent" }));

    expect(backend.recentRemove).toHaveBeenCalledWith(gone);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("No database has been opened yet.")).toBeInTheDocument();
  });

  it("removes an entry without opening it", async () => {
    const backend = fakeBackend({
      recentList: vi.fn(async () => [recentFile("/a.trunkdb"), recentFile("/b.trunkdb")]),
      recentRemove: vi.fn(async () => [recentFile("/b.trunkdb")]),
    });
    const user = renderApp(backend);

    await user.click(
      await screen.findByRole("button", { name: "Remove /a.trunkdb from recent databases" }),
    );

    await waitFor(() => expect(screen.queryByText("a.trunkdb")).not.toBeInTheDocument());
    expect(screen.getByText("b.trunkdb")).toBeInTheDocument();
    expect(backend.databaseOpen).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  async function openShop(backend: Backend) {
    const user = renderApp(backend);
    await user.click(await screen.findByRole("button", { name: "Open /shop.trunkdb" }));
    await screen.findByRole("heading", { level: 1, name: "shop.trunkdb" });
    return user;
  }
  const recents = { recentList: vi.fn(async () => [recentFile("/shop.trunkdb")]) };

  it("returns to the start screen only after the backend has closed", async () => {
    const closing = deferred<undefined>();
    const backend = fakeBackend({ ...recents, sessionClose: vi.fn(() => closing.promise) });
    const user = await openShop(backend);

    await user.click(screen.getByRole("button", { name: "Close database" }));

    expect(backend.sessionClose).toHaveBeenCalledWith("s1");
    const button = screen.getByRole("button", { name: "Closing…" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(backend.sessionClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1, name: "shop.trunkdb" })).toBeVisible();

    closing.resolve(undefined);
    await startHeading();
  });

  it("stays in the workspace when closing fails", async () => {
    const backend = fakeBackend({
      ...recents,
      sessionClose: vi.fn(async () => {
        throw appError("io", "Reading or writing the file failed.");
      }),
    });
    const user = await openShop(backend);

    await user.click(screen.getByRole("button", { name: "Close database" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Reading or writing");
    expect(screen.getByRole("heading", { level: 1, name: "shop.trunkdb" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close database" })).toBeEnabled();
  });

  it("treats a session the backend already closed as closed", async () => {
    const backend = fakeBackend({
      ...recents,
      sessionClose: vi.fn(async () => {
        throw appError("session_closed", "This database is no longer open.");
      }),
    });
    const user = await openShop(backend);

    await user.click(screen.getByRole("button", { name: "Close database" }));

    await startHeading();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
