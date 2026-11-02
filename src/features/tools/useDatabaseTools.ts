import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import type {
  AppError,
  CheckReport,
  CompactReport,
  ExportSummary,
  ImportSummary,
} from "../../ipc/types";

export type CheckState =
  | { status: "idle" }
  | { status: "running" }
  /** Ran to its end; `report.problems` says whether it is clean. */
  | { status: "done"; report: CheckReport; finishedAt: Date }
  /** Could not finish: says nothing about the database being fine. */
  | { status: "failed"; error: AppError };

export type ExportState =
  | { status: "idle" }
  | { status: "choosing" }
  | { status: "running"; destination: string }
  | { status: "done"; summary: ExportSummary }
  | { status: "failed"; error: AppError };

export type CompactState =
  { status: "idle" } | { status: "running" } | { status: "done"; report: CompactReport };

export type ImportState =
  | { status: "idle" }
  | { status: "choosing" }
  | { status: "running"; source: string }
  | { status: "done"; summary: ImportSummary }
  | { status: "failed"; error: AppError };

export interface DatabaseTools {
  check: CheckState;
  exporting: ExportState;
  compacting: CompactState;
  importing: ImportState;
  /** One tool at a time: one is running or being set up. */
  busy: boolean;
  runCheck: () => void;
  startExport: () => void;
  /** Compacts the database; resolves with the failure, or null. */
  compact: () => Promise<AppError | null>;
  /** Imports an export into a new database, asking for both files. */
  startImport: () => void;
}

/** The name a new database from `source` is offered: `shop.jsonl` → `shop.trunkdb`. */
export function importedName(source: string): string {
  const name = source.split(/[\\/]/).pop() ?? "";
  return `${name.replace(/\.[^.]+$/, "") || "imported"}.trunkdb`;
}

/**
 * The check and export of one open database. Kept above the screens that
 * show it, so a report stays readable while the user looks elsewhere.
 */
export function useDatabaseTools(
  sessionId: string,
  fileName: string,
  /** After a compaction: what the overview shows has changed. */
  onCompacted: () => void = () => undefined,
): DatabaseTools {
  const backend = useBackend();
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [exporting, setExporting] = useState<ExportState>({ status: "idle" });
  const [compacting, setCompacting] = useState<CompactState>({ status: "idle" });
  const [importing, setImporting] = useState<ImportState>({ status: "idle" });
  // Reserved from the click until the tool is finished or given up,
  // including while the file dialog is open.
  const reserved = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const runCheck = useCallback(() => {
    if (reserved.current) return;
    reserved.current = true;
    // The old report goes first: it must not be read as this run's.
    setCheck({ status: "running" });
    backend
      .databaseCheck(sessionId)
      .then(
        (report): CheckState => ({ status: "done", report, finishedAt: new Date() }),
        (thrown: unknown): CheckState => ({ status: "failed", error: toAppError(thrown) }),
      )
      .then((next) => {
        reserved.current = false;
        if (alive.current) setCheck(next);
      });
  }, [backend, sessionId]);

  const startExport = useCallback(async () => {
    if (reserved.current) return;
    reserved.current = true;
    const show = (state: ExportState) => alive.current && setExporting(state);
    show({ status: "choosing" });
    try {
      const suggested = `${fileName.replace(/\.[^.]+$/, "") || "database"}.jsonl`;
      const destination = await backend.pickExportDestination(suggested);
      if (destination === null) {
        show({ status: "idle" });
        return;
      }
      show({ status: "running", destination });
      // The save dialog has already asked before an existing file is
      // chosen, so a second question here would only repeat it.
      const summary = await backend.databaseExport(sessionId, destination, true);
      show({ status: "done", summary });
    } catch (thrown) {
      show({ status: "failed", error: toAppError(thrown) });
    } finally {
      reserved.current = false;
    }
  }, [backend, sessionId, fileName]);

  const compact = useCallback(async (): Promise<AppError | null> => {
    if (reserved.current) {
      return { category: "busy", message: "Another tool is running.", detail: null };
    }
    reserved.current = true;
    const previous = compacting;
    setCompacting({ status: "running" });
    try {
      const report = await backend.databaseCompact(sessionId);
      if (alive.current) setCompacting({ status: "done", report });
      onCompacted();
      return null;
    } catch (thrown) {
      // The dialog shows why; the last result stays as it was.
      if (alive.current) setCompacting(previous);
      return toAppError(thrown);
    } finally {
      reserved.current = false;
    }
  }, [backend, sessionId, compacting, onCompacted]);

  const startImport = useCallback(async () => {
    if (reserved.current) return;
    reserved.current = true;
    const show = (state: ImportState) => alive.current && setImporting(state);
    show({ status: "choosing" });
    try {
      const source = await backend.pickExportToImport();
      if (source === null) {
        show({ status: "idle" });
        return;
      }
      const destination = await backend.pickImportDestination(importedName(source));
      if (destination === null) {
        show({ status: "idle" });
        return;
      }
      show({ status: "running", source });
      const summary = await backend.databaseImport(source, destination);
      show({ status: "done", summary });
    } catch (thrown) {
      show({ status: "failed", error: toAppError(thrown) });
    } finally {
      reserved.current = false;
    }
  }, [backend]);

  const busy =
    check.status === "running" ||
    exporting.status === "choosing" ||
    exporting.status === "running" ||
    compacting.status === "running" ||
    importing.status === "choosing" ||
    importing.status === "running";

  return {
    check,
    exporting,
    compacting,
    importing,
    busy,
    runCheck,
    startExport: () => void startExport(),
    compact,
    startImport: () => void startImport(),
  };
}
