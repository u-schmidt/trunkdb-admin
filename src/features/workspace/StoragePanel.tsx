import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { CollectionStorage, StorageReport } from "../../ipc/types";
import type { DatabaseTools } from "../tools/useDatabaseTools";
import { formatBytes } from "./bytes";
import type { StorageState } from "./useStorage";

interface Props {
  storage: StorageState;
  onRefresh: () => void;
  /** Compaction; absent in a read-only session. */
  tools?: DatabaseTools | undefined;
}

const pagesOf = (report: StorageReport, pages: number) => formatBytes(pages * report.page_size);

function indexPages(collection: CollectionStorage): number {
  return collection.indexes.reduce((sum, index) => sum + index.pages, 0);
}

/** Where the file's space goes: pages by kind, collections, compaction. */
export function StoragePanel({ storage, onRefresh, tools }: Props) {
  const [confirming, setConfirming] = useState(false);
  const report =
    storage.status === "loaded"
      ? storage.report
      : storage.status === "loading"
        ? storage.previous
        : null;
  // Only a current report decides: its estimate is exact (trunkdb §93.4).
  const current = storage.status === "loaded" ? storage.report : null;
  const gain = current === null ? 0 : current.pages - current.compacted_pages;
  const compacting = tools?.compacting.status === "running";
  const why =
    current === null
      ? "The sizes are being read."
      : gain <= 0
        ? "Already as small as a compaction makes it."
        : tools?.busy
          ? "Another tool is running."
          : undefined;
  return (
    <section aria-labelledby="storage-heading" className="panel">
      <div className="panel-heading">
        <h2 id="storage-heading">Storage</h2>
        <span className="panel-actions">
          {tools !== undefined && (
            // A disabled button shows no tooltip of its own everywhere.
            <span title={why}>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={why !== undefined}
                aria-description={why}
              >
                {compacting ? "Compacting…" : "Compact…"}
              </button>
            </span>
          )}
          <button type="button" onClick={onRefresh} disabled={storage.status === "loading"}>
            <RefreshCw aria-hidden="true" />
            {storage.status === "loading" ? "Reading…" : "Refresh"}
          </button>
        </span>
      </div>
      {tools?.compacting.status === "done" && (
        <p className="tool-result tool-ok" role="status" aria-label="Compaction result">
          {compactedLine(tools.compacting.report)}
        </p>
      )}
      {confirming && tools !== undefined && current !== null && (
        <ConfirmDialog
          title="Compact the database?"
          confirmLabel="Compact"
          tone="primary"
          onConfirm={tools.compact}
          onClose={() => setConfirming(false)}
        >
          <p>
            The file goes from {current.pages.toLocaleString("en")} pages (
            {pagesOf(current, current.pages)}) to {current.compacted_pages.toLocaleString("en")}{" "}
            pages ({pagesOf(current, current.compacted_pages)}), and frees {pagesOf(current, gain)}.
          </p>
          <p>
            While it runs the disk needs about {pagesOf(current, 2 * current.compacted_pages)} more,
            for the new file beside the database and in its log. Writes wait, and the list may pause
            at the end.
          </p>
          <p>Documents, their IDs and indexes stay as they are, and so does an open draft.</p>
        </ConfirmDialog>
      )}
      {storage.status === "failed" && (
        <div className="tool-result tool-failed" role="alert">
          <p>
            <strong>The sizes could not be read.</strong> {storage.error.message}
          </p>
          {storage.error.detail !== null && <p className="muted">{storage.error.detail}</p>}
          {storage.error.category === "damaged_data" && (
            <p>The consistency check below says what is damaged.</p>
          )}
        </div>
      )}
      {report === null ? (
        storage.status === "loading" && <p className="muted">Reading the file…</p>
      ) : (
        <StorageReportView report={report} />
      )}
    </section>
  );
}

function StorageReportView({ report }: { report: StorageReport }) {
  const use = report.page_use;
  const saved = report.pages - report.compacted_pages;
  return (
    <>
      {report.recovered !== null && (
        <p className="tool-result tool-warning" role="status">
          {report.recovered.in_memory ? (
            <>
              The last session didn&apos;t close cleanly.{" "}
              {report.recovered.pages.toLocaleString("en")}{" "}
              {report.recovered.pages === 1 ? "page" : "pages"} from its write-ahead log{" "}
              {report.recovered.pages === 1 ? "is" : "are"} shown from memory; the file is
              unchanged, and the next open for editing writes them back.
            </>
          ) : (
            <>
              This database was opened after an unclean shutdown:{" "}
              {report.recovered.pages.toLocaleString("en")}{" "}
              {report.recovered.pages === 1 ? "page was" : "pages were"} restored from the
              write-ahead log.
            </>
          )}
        </p>
      )}
      <dl className="facts">
        <dt>File size</dt>
        <dd>
          {pagesOf(report, report.pages)} ({report.pages.toLocaleString("en")} pages)
        </dd>
        <dt>Documents</dt>
        <dd>
          {pagesOf(report, use.data)} in data pages
          {use.overflow > 0 && `, ${pagesOf(report, use.overflow)} in overflow pages`}
        </dd>
        <dt>Indexes</dt>
        <dd>{pagesOf(report, use.index)}</dd>
        <dt>Free pages</dt>
        <dd>{pagesOf(report, use.free)}</dd>
        <dt>Header and catalog</dt>
        <dd>{pagesOf(report, use.header + use.catalog)}</dd>
        {use.unaccounted > 0 && (
          <>
            <dt>Unaccounted</dt>
            <dd>
              {use.unaccounted.toLocaleString("en")} pages belong to nothing. Run the consistency
              check for details.
            </dd>
          </>
        )}
        <dt>Write-ahead log</dt>
        <dd>{report.wal_bytes === null ? "none" : formatBytes(report.wal_bytes)}</dd>
        <dt>Compacting</dt>
        <dd>
          {saved > 0
            ? `would free ${pagesOf(report, saved)} (${saved.toLocaleString("en")} of ${report.pages.toLocaleString("en")} pages)`
            : "would not make the file smaller"}
        </dd>
      </dl>
      {report.collections.length > 0 && (
        <table className="plain-table" aria-label="Storage by collection">
          <thead>
            <tr>
              <th scope="col">Collection</th>
              <th scope="col" className="numeric">
                Documents
              </th>
              <th scope="col" className="numeric">
                Stored data
              </th>
              <th scope="col" className="numeric">
                Pages
              </th>
              <th scope="col" className="numeric">
                Free in pages
              </th>
              <th scope="col" className="numeric">
                Indexes
              </th>
            </tr>
          </thead>
          <tbody>
            {report.collections.map((collection) => (
              <tr key={collection.name}>
                <td>{collection.name}</td>
                <td className="numeric">{collection.documents.toLocaleString("en")}</td>
                <td className="numeric">{formatBytes(collection.document_bytes)}</td>
                <td className="numeric">
                  {pagesOf(report, collection.data_pages + collection.overflow_pages)}
                </td>
                <td className="numeric">{formatBytes(collection.free_bytes)}</td>
                <td className="numeric">
                  {pagesOf(report, indexPages(collection))} ·{" "}
                  {collection.indexes.length === 1
                    ? "1 index"
                    : `${collection.indexes.length} indexes`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function compactedLine(report: { pages_before: number; pages_after: number; page_size: number }) {
  if (report.pages_after >= report.pages_before) {
    return "Already as small as a compaction makes it; nothing was written.";
  }
  const freed = formatBytes((report.pages_before - report.pages_after) * report.page_size);
  return `Compacted: ${report.pages_before.toLocaleString("en")} → ${report.pages_after.toLocaleString("en")} pages, ${freed} freed.`;
}
