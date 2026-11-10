import { Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorNotice } from "../../components/ErrorNotice";
import { JsonEditor } from "../../components/JsonEditor";
import type { DocumentDraft } from "./useDocumentDraft";

interface Props {
  collection: string;
  editor: DocumentDraft;
  /** The database is open read-only: the document is shown, not edited. */
  readOnly: boolean;
  /** Another page of the side pane is in front; the draft stays as typed. */
  hidden?: boolean;
}

/** The document being edited, beside the list it was opened from. */
export function DocumentEditor({ collection, editor, readOnly, hidden = false }: Props) {
  const { draft, dirty, saving, error } = editor;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const save = editor.save;

  // Cmd+S saves wherever the focus is while an editor is open. Escape is
  // deliberately not bound: it must never drop modified text.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, readOnly]);

  if (draft === null) return null;
  const isNew = draft.id === null;
  const status = readOnly
    ? "Read-only"
    : saving
      ? "Saving…"
      : dirty
        ? "Modified"
        : isNew
          ? "Not saved yet"
          : "Saved";

  return (
    <aside className="side-page" aria-label="Document editor" hidden={hidden}>
      <header className="detail-header">
        <div className="detail-title">
          <h3>{isNew ? "New document" : "Document"}</h3>
          {isNew ? (
            <p className="muted">The ID is assigned when the document is saved.</p>
          ) : (
            <code className="detail-id" title="The ID cannot be changed">
              {draft.id}
            </code>
          )}
        </div>
        <span className={dirty ? "detail-status modified" : "detail-status"} role="status">
          {status}
        </span>
      </header>

      {!readOnly && (
        <div className="editor-actions">
          <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
            <Save aria-hidden="true" />
            Save
          </button>
          <button type="button" onClick={editor.format} disabled={saving}>
            Format
          </button>
          {(dirty || isNew) && (
            <button type="button" onClick={editor.cancel} disabled={saving}>
              {isNew ? "Discard" : "Discard changes"}
            </button>
          )}
          <span className="spacer" />
          {!isNew && (
            <button
              type="button"
              className="danger-quiet"
              onClick={() => setConfirmingDelete(true)}
              disabled={saving}
            >
              <Trash2 aria-hidden="true" />
              Delete…
            </button>
          )}
        </div>
      )}

      {error !== null && <ErrorNotice error={error} onDismiss={editor.dismissError} />}
      {draft.outsideFilter && !dirty && (
        <div className="notice notice-info" role="status">
          <p className="notice-message">
            <span className="notice-label">Note</span> Saved. This document no longer matches the
            filter, so it is not in the list. It stays open here.
          </p>
        </div>
      )}

      <div className="editor-body">
        <JsonEditor
          key={draft.revision}
          initialText={draft.text}
          onChange={editor.setText}
          readOnly={readOnly || saving}
          label={isNew ? "New document JSON" : `JSON of document ${draft.id}`}
        />
      </div>

      {confirmingDelete && draft.id !== null && (
        <ConfirmDialog
          title="Delete document?"
          confirmLabel="Delete document"
          onConfirm={editor.remove}
          onClose={() => setConfirmingDelete(false)}
        >
          <p>
            Document <code>{draft.id}</code> will be removed from “{collection}”. This cannot be
            undone.
          </p>
          {dirty && <p>Its unsaved changes are lost as well.</p>}
        </ConfirmDialog>
      )}
    </aside>
  );
}
