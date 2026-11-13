import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { Backend } from "../ipc/backend";
import { BackendProvider } from "../ipc/BackendContext";
import type { FormatUpgrade } from "../ipc/types";
import { fakeBackend } from "../test/fakeBackend";
import { App } from "./App";

vi.mock("../components/JsonEditor", async () => await import("../test/PlainJsonEditor"));

// Asking before an open for editing raises a file's format.

const OLD = "/data/notes.trunkdb";
const UPGRADE: FormatUpgrade = {
  format_version: 12,
  written_by: "0.24.0",
  becomes: 17,
  bundled_release: "0.40.0",
};

function oldFileBackend(overrides: Partial<Backend> = {}) {
  return fakeBackend({
    pickDatabaseToOpen: vi.fn(async () => OLD),
    databaseFormatUpgrade: vi.fn(async () => UPGRADE),
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

const question = () => screen.findByRole("dialog", { name: "Upgrade the file format?" });
const startHeading = () => screen.getByRole("heading", { level: 1, name: "TrunkDB Admin" });

async function openForEditing(backend: Backend) {
  const user = renderApp(backend);
  await user.click(await screen.findByRole("button", { name: "Open database…" }));
  return { user, dialog: await question() };
}

describe("opening an older file for editing", () => {
  it("asks first, saying what changes and for whom", async () => {
    const backend = oldFileBackend();
    const { dialog } = await openForEditing(backend);

    expect(dialog).toHaveTextContent(
      "notes.trunkdb has file format 12, last written by trunkdb 0.24.0. " +
        "Opening it for editing changes it to format 17, the format of the bundled trunkdb 0.40.0.",
    );
    expect(dialog).toHaveTextContent("such as 0.24.0, can't open the file afterwards");
    expect(backend.databaseFormatUpgrade).toHaveBeenCalledWith(OLD);
    expect(backend.databaseOpen).not.toHaveBeenCalled();
  });

  it("opens nothing on Cancel", async () => {
    const backend = oldFileBackend();
    const { user, dialog } = await openForEditing(backend);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(startHeading()).toBeVisible();
    expect(backend.databaseOpen).not.toHaveBeenCalled();
  });

  it("opens with the upgrade on Upgrade and open", async () => {
    const backend = oldFileBackend();
    const { user, dialog } = await openForEditing(backend);

    await user.click(within(dialog).getByRole("button", { name: "Upgrade and open" }));

    expect(await screen.findByRole("heading", { level: 1, name: "notes.trunkdb" })).toBeVisible();
    expect(backend.databaseOpen).toHaveBeenCalledWith(OLD, false, true);
  });

  it("leaves the file as it is on Open read-only", async () => {
    const backend = oldFileBackend();
    const { user, dialog } = await openForEditing(backend);

    await user.click(within(dialog).getByRole("button", { name: "Open read-only" }));

    expect(await screen.findByRole("heading", { level: 1, name: /Read-only/ })).toBeVisible();
    expect(backend.databaseOpen).toHaveBeenCalledWith(OLD, true, false);
  });

  it("asks nothing about a file of the bundled format", async () => {
    const backend = oldFileBackend({ databaseFormatUpgrade: vi.fn(async () => null) });
    const user = renderApp(backend);
    await user.click(await screen.findByRole("button", { name: "Open database…" }));

    expect(await screen.findByRole("heading", { level: 1, name: "notes.trunkdb" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.databaseOpen).toHaveBeenCalledWith(OLD, false, false);
  });

  it("asks nothing for a read-only open", async () => {
    const backend = oldFileBackend();
    const user = renderApp(backend);
    await user.click(await screen.findByRole("button", { name: "Open read-only…" }));

    expect(await screen.findByRole("heading", { level: 1, name: /Read-only/ })).toBeVisible();
    expect(backend.databaseFormatUpgrade).not.toHaveBeenCalled();
  });
});

describe("switching an older file from read-only to editing", () => {
  async function readOnlyThenEditing(backend: Backend) {
    const user = renderApp(backend);
    await user.click(await screen.findByRole("button", { name: "Open read-only…" }));
    await screen.findByRole("heading", { level: 1, name: /Read-only/ });
    await user.click(screen.getByRole("button", { name: "Open for editing" }));
    return { user, dialog: await question() };
  }

  it("asks while still open read-only, and stays there on Cancel", async () => {
    const backend = oldFileBackend();
    const { user, dialog } = await readOnlyThenEditing(backend);

    expect(within(dialog).queryByRole("button", { name: "Open read-only" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("heading", { level: 1, name: /Read-only/ })).toBeVisible();
    expect(backend.sessionClose).not.toHaveBeenCalled();
  });

  it("reopens with the upgrade on Upgrade and open", async () => {
    const backend = oldFileBackend();
    const { user, dialog } = await readOnlyThenEditing(backend);

    await user.click(within(dialog).getByRole("button", { name: "Upgrade and open" }));

    await waitFor(() => expect(backend.databaseOpen).toHaveBeenLastCalledWith(OLD, false, true));
    expect(backend.sessionClose).toHaveBeenCalledWith("s1");
    expect(await screen.findByRole("heading", { level: 1, name: "notes.trunkdb" })).toBeVisible();
  });
});
