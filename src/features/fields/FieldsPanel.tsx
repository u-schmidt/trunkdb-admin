import { useEffect, useState } from "react";
import { ErrorNotice } from "../../components/ErrorNotice";
import type { FieldPath } from "../../ipc/types";
import { knownPaths, useFieldPaths } from "./FieldPathsContext";

const kindName = (kind: string) => kind.replace("_", "-");

/**
 * Every field path of the collection's documents with exact counts,
 * as `trunkdb fields` lists them. Read on opening, kept until
 * the documents change.
 */
export function FieldsPanel() {
  const fields = useFieldPaths();
  const { state, ensure } = fields;
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => ensure(), [ensure]);

  const known = knownPaths(state);
  const copy = (path: FieldPath) => {
    navigator.clipboard.writeText(path.text).then(
      () => setCopied(path.text),
      () => setCopied(null),
    );
  };

  return (
    <div className="fields">
      <div className="panel-heading">
        <p className="muted" role="status">
          {state.status === "loading"
            ? "Reading every document…"
            : known !== null
              ? `${known.paths.length.toLocaleString("en")} ${known.paths.length === 1 ? "path" : "paths"} in ${known.documents.toLocaleString("en")} ${known.documents === 1 ? "document" : "documents"}${copied !== null ? ` · copied ${copied}` : ""}`
              : ""}
        </p>
        <button type="button" onClick={fields.refresh} disabled={state.status === "loading"}>
          {state.status === "loading" ? "Reading…" : "Refresh"}
        </button>
      </div>
      {state.status === "failed" && <ErrorNotice error={state.error} onDismiss={ensure} />}
      {known?.truncated === true && (
        <p className="tool-result tool-warning" role="note">
          Only the first 10,000 paths found are counted: this collection&apos;s field names look
          like data.
        </p>
      )}
      {known !== null && known.paths.length === 0 && (
        <p className="muted">This collection has no documents.</p>
      )}
      {known !== null && known.paths.length > 0 && (
        <div className="table-scroll">
          <table className="plain-table" aria-label="Field paths">
            <thead>
              <tr>
                <th scope="col">Path</th>
                <th scope="col" className="numeric">
                  Documents
                </th>
                <th scope="col">Kinds</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {known.paths.map((path) => (
                <tr key={path.path}>
                  <td>
                    <code>{path.text}</code>
                    {!path.nameable && <span className="muted"> (no path can name it)</span>}
                  </td>
                  <td className="numeric">
                    {path.documents.toLocaleString("en")} of {known.documents.toLocaleString("en")}
                  </td>
                  <td>
                    {path.kinds
                      .map((k) => `${kindName(k.kind)} ${k.documents.toLocaleString("en")}`)
                      .join(" · ")}
                  </td>
                  <td className="numeric">
                    {path.nameable && (
                      <button
                        type="button"
                        className="quiet"
                        aria-label={`Copy ${path.text}`}
                        onClick={() => copy(path)}
                      >
                        Copy
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
