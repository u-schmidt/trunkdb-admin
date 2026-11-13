import { shortenHome } from "../../components/shortenHome";
import type { AppInfo, CollectionSummary, FileInfo } from "../../ipc/types";
import { DatabasePage } from "./DatabasePage";

interface Props {
  path: string;
  file: FileInfo;
  appInfo: AppInfo | null;
  /** null while the first overview is loading. */
  collections: CollectionSummary[] | null;
  /** false: opened read-only. */
  canMutate: boolean;
  onSelect: (collection: string) => void;
}

/** A release the file names, or why it names none (trunkdb SPEC §125.3). */
function release(name: string | null): string {
  return name === null
    ? "Unknown: the file is from before trunkdb 0.24.0, or an older trunkdb wrote it since"
    : `trunkdb ${name}`;
}

function indexNames(collection: CollectionSummary): string {
  if (!collection.persisted) return "none";
  const secondary = collection.indexes.map((index) =>
    index.fields.length > 1 ? `(${index.fields.join(", ")})` : (index.fields[0] ?? ""),
  );
  return ["_id", ...secondary].join(" · ");
}

export function DatabaseOverview({ path, file, appInfo, collections, canMutate, onSelect }: Props) {
  return (
    <DatabasePage id="overview-heading" title="Overview">
      <section aria-labelledby="file-heading" className="panel">
        <h3 id="file-heading">File</h3>
        <dl className="facts">
          <dt>Path</dt>
          <dd>{shortenHome(path)}</dd>
          <dt>Opened</dt>
          <dd>
            {canMutate ? (
              "For editing"
            ) : (
              <>
                Read-only. Nothing is written to the file or its write-ahead log. Other programs can
                read and write the file meanwhile; what they write shows here the next time it is
                read. To change it, use Open for editing.
              </>
            )}
          </dd>
          <dt>trunkdb</dt>
          <dd>
            {appInfo === null
              ? "…"
              : `${appInfo.trunkdb.version} (${appInfo.trunkdb.revision.slice(0, 7)})`}
          </dd>
          <dt>File format</dt>
          <dd>{file.format_version}</dd>
          <dt>Last written by</dt>
          <dd>{release(file.written_by)}</dd>
          <dt>Created by</dt>
          <dd>{release(file.created_by)}</dd>
          <dt>Page size</dt>
          <dd>{file.page_size.toLocaleString("en")} bytes</dd>
          <dt>Pages</dt>
          <dd>{file.pages.toLocaleString("en")}</dd>
          <dt>Free pages</dt>
          <dd>{file.free_pages.toLocaleString("en")}</dd>
        </dl>
      </section>

      <section aria-labelledby="collections-heading" className="panel">
        <h3 id="collections-heading">Collections</h3>
        {collections === null ? (
          <p className="muted">Loading…</p>
        ) : collections.length === 0 ? (
          <p className="muted">
            {canMutate
              ? "This database has no collections. Add one in the sidebar; it is saved with its first document or index."
              : "This database has no collections."}
          </p>
        ) : (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="numeric">
                  Documents
                </th>
                <th scope="col">Indexes</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((collection) => (
                <tr key={collection.name}>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => onSelect(collection.name)}
                    >
                      {collection.name}
                    </button>
                  </td>
                  <td className="numeric">
                    {!collection.persisted ? (
                      <span className="badge badge-warning">Not saved</span>
                    ) : collection.count === null ? (
                      <span title={collection.count_error ?? undefined}>unavailable</span>
                    ) : (
                      collection.count.toLocaleString("en")
                    )}
                  </td>
                  <td>{indexNames(collection)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </DatabasePage>
  );
}
