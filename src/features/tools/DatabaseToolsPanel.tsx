import { FileDown, Import, ShieldCheck } from "lucide-react";
import { shortenHome } from "../../components/shortenHome";
import type { AppError } from "../../ipc/types";
import type { DatabaseTools } from "./useDatabaseTools";

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

function Failure({ title, error }: { title: string; error: AppError }) {
  return (
    <div className="tool-result tool-failed" role="alert">
      <p>
        <strong>{title}</strong> {error.message}
      </p>
      {error.detail !== null && <p className="muted">{error.detail}</p>}
    </div>
  );
}

/**
 * Consistency check, whole-database export and import into a new
 * database, each on explicit request.
 */
export function DatabaseToolsPanel({
  tools,
  onOpenImported,
}: {
  tools: DatabaseTools;
  /** Leaves this database for the one an import made. */
  onOpenImported: (path: string) => void;
}) {
  const { check, exporting, importing, busy } = tools;
  return (
    <section aria-labelledby="tools-heading" className="panel">
      <h2 id="tools-heading">Tools</h2>

      <div className="tool">
        <div className="tool-head">
          <div>
            <h3>Consistency check</h3>
            <p className="muted">
              Reads the whole file and verifies pages, documents and indexes. Nothing is repaired.
            </p>
          </div>
          <button type="button" onClick={tools.runCheck} disabled={busy}>
            <ShieldCheck aria-hidden="true" />
            {check.status === "running" ? "Checking…" : "Run check"}
          </button>
        </div>
        {check.status === "running" && (
          <p className="tool-result" role="status">
            Checking the database…
          </p>
        )}
        {check.status === "failed" && (
          // Not a result: nothing is known about the database's state.
          <Failure title="The check could not be completed." error={check.error} />
        )}
        {check.status === "done" && (
          <div
            className={
              check.report.problems.length === 0 ? "tool-result tool-ok" : "tool-result tool-failed"
            }
            role="status"
            aria-label="Check report"
          >
            <p>
              <strong>
                {check.report.problems.length === 0
                  ? "No problems found."
                  : `${count(check.report.problems.length, "problem", "problems")} found.`}
              </strong>{" "}
              Checked {count(check.report.collections, "collection", "collections")},{" "}
              {count(check.report.documents, "document", "documents")} and{" "}
              {count(check.report.pages, "page", "pages")}.
            </p>
            {check.report.problems.length > 0 && (
              <ol className="tool-problems">
                {check.report.problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ol>
            )}
            <p className="muted">
              Completed at {check.finishedAt.toLocaleTimeString()}. Changes made since are not
              covered.
            </p>
          </div>
        )}
      </div>

      <div className="tool">
        <div className="tool-head">
          <div>
            <h3>Export</h3>
            <p className="muted">
              Writes the whole saved database as TrunkDB tagged JSON Lines (.jsonl): every
              collection with its index definitions and documents with their IDs. The filter, the
              page, unsaved edits and unsaved collections play no part.
            </p>
          </div>
          <button type="button" onClick={tools.startExport} disabled={busy}>
            <FileDown aria-hidden="true" />
            {exporting.status === "running" ? "Exporting…" : "Export database…"}
          </button>
        </div>
        {exporting.status === "running" && (
          <p className="tool-result" role="status">
            Exporting to {exporting.destination}…
          </p>
        )}
        {exporting.status === "failed" && (
          <Failure title="The export failed." error={exporting.error} />
        )}
        {exporting.status === "done" && (
          <div className="tool-result tool-ok" role="status" aria-label="Export result">
            <p>
              <strong>Export complete.</strong>{" "}
              {count(exporting.summary.collections, "collection", "collections")} and{" "}
              {count(exporting.summary.documents, "document", "documents")},{" "}
              {exporting.summary.bytes.toLocaleString("en")} bytes.
            </p>
            <p className="muted">{shortenHome(exporting.summary.path)}</p>
          </div>
        )}
      </div>

      <div className="tool">
        <div className="tool-head">
          <div>
            <h3>Import</h3>
            <p className="muted">
              Makes a new database from an export (.jsonl): its collections, index definitions and
              documents with their IDs. This database stays as it is; the new one is written only
              when the whole export has been read.
            </p>
          </div>
          <button type="button" onClick={tools.startImport} disabled={busy}>
            <Import aria-hidden="true" />
            {importing.status === "running" ? "Importing…" : "Import into a new database…"}
          </button>
        </div>
        {importing.status === "running" && (
          <p className="tool-result" role="status">
            Importing {importing.source}…
          </p>
        )}
        {importing.status === "failed" && (
          <Failure title="The import failed; nothing was created." error={importing.error} />
        )}
        {importing.status === "done" && (
          <div className="tool-result tool-ok" role="status" aria-label="Import result">
            <p>
              <strong>Import complete.</strong>{" "}
              {count(importing.summary.collections, "collection", "collections")} and{" "}
              {count(importing.summary.documents, "document", "documents")} in a new database.{" "}
              <button
                type="button"
                className="link"
                onClick={() => onOpenImported(importing.summary.path)}
              >
                Open it
              </button>
            </p>
            <p className="muted">{shortenHome(importing.summary.path)}</p>
          </div>
        )}
      </div>
    </section>
  );
}
