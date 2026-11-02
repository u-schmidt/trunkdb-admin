import { useCallback, useEffect, useRef, useState } from "react";
import { useDraftGuard } from "../../app/DraftGuard";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import type { AppError, FilterInput } from "../../ipc/types";

/** A new document starts as an empty object. */
export const NEW_DOCUMENT_TEXT = "{}";

export interface Draft {
  /** null for a document that has not been inserted yet. */
  id: string | null;
  /** What is stored (or, for a new document, the untouched start). */
  savedText: string;
  /** What the editor holds. */
  text: string;
  /** Changes whenever the editor must load `text` afresh. */
  revision: number;
  /** After a save: the document no longer satisfies the list's filter. */
  outsideFilter: boolean;
}

export interface DocumentDraft {
  draft: Draft | null;
  dirty: boolean;
  /** Reading the document to edit. */
  opening: boolean;
  saving: boolean;
  /** The last failed open, save, format or delete. */
  error: AppError | null;
  dismissError: () => void;
  openNew: () => void;
  open: (id: string) => void;
  setText: (text: string) => void;
  /** Resolves true once stored. The draft is kept on failure. */
  save: () => Promise<boolean>;
  format: () => void;
  /** Back to the stored text; a new document's editor closes. */
  cancel: () => void;
  close: () => void;
  /** Resolves with the failure, or null once deleted. */
  remove: () => Promise<AppError | null>;
}

interface Options {
  sessionId: string;
  collection: string;
  /** The filter the list currently shows, for the membership notice. */
  filter: FilterInput;
  /** After any successful write: the list and the counts are stale. */
  onWritten: () => void;
}

/**
 * The one document being edited in a collection. Text only: it goes to
 * the backend as typed and comes back as stored.
 */
export function useDocumentDraft({
  sessionId,
  collection,
  filter,
  onWritten,
}: Options): DocumentDraft {
  const backend = useBackend();
  const guard = useDraftGuard();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const revisions = useRef(0);
  const savingNow = useRef(false);
  // Only the newest open may fill the editor.
  const newestOpen = useRef(0);

  const dirty = draft !== null && draft.text !== draft.savedText;

  const load = useCallback((id: string | null, text: string, outsideFilter = false) => {
    setDraft({ id, savedText: text, text, revision: ++revisions.current, outsideFilter });
  }, []);

  const close = useCallback(() => {
    newestOpen.current++;
    setOpening(false);
    setDraft(null);
    setError(null);
  }, []);

  const openNew = useCallback(() => {
    newestOpen.current++;
    setOpening(false);
    setError(null);
    load(null, NEW_DOCUMENT_TEXT);
  }, [load]);

  const open = useCallback(
    (id: string) => {
      const mine = ++newestOpen.current;
      setOpening(true);
      setError(null);
      backend.documentRead(sessionId, collection, id).then(
        (document) => {
          if (mine !== newestOpen.current) return;
          setOpening(false);
          load(document.id, document.json);
        },
        (thrown: unknown) => {
          if (mine !== newestOpen.current) return;
          setOpening(false);
          setDraft(null);
          setError(toAppError(thrown));
        },
      );
    },
    [backend, sessionId, collection, load],
  );

  const setText = useCallback((text: string) => {
    setDraft((current) => (current === null ? null : { ...current, text }));
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    // The ref, not the state: a second Cmd+S must not start a second write.
    if (draft === null || savingNow.current) return false;
    savingNow.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await backend.documentSave(sessionId, {
        collection,
        id: draft.id,
        json: draft.text,
        filter,
      });
      // The editor shows what is stored now, not what was typed.
      load(saved.document.id, saved.document.json, !saved.matches_filter);
      onWritten();
      return true;
    } catch (thrown) {
      setError(toAppError(thrown));
      return false;
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }, [backend, sessionId, collection, filter, draft, load, onWritten]);

  const format = useCallback(() => {
    if (draft === null) return;
    const formatting = draft;
    setError(null);
    backend.documentFormat(formatting.text).then(
      (formatted) =>
        setDraft((current) =>
          // Formatting what was typed meanwhile would lose it.
          current === formatting
            ? { ...current, text: formatted, revision: ++revisions.current }
            : current,
        ),
      (thrown: unknown) => setError(toAppError(thrown)),
    );
  }, [backend, draft]);

  const cancel = useCallback(() => {
    if (draft === null) return;
    if (draft.id === null) close();
    else {
      setError(null);
      load(draft.id, draft.savedText, draft.outsideFilter);
    }
  }, [draft, load, close]);

  const remove = useCallback(async (): Promise<AppError | null> => {
    if (draft === null || draft.id === null) return null;
    try {
      await backend.documentDelete(sessionId, collection, draft.id);
    } catch (thrown) {
      const failed = toAppError(thrown);
      if (failed.category !== "target_not_found") return failed;
      // Gone already: there is nothing left to edit, but say so.
      close();
      setError(failed);
      onWritten();
      return null;
    }
    close();
    onWritten();
    return null;
  }, [backend, sessionId, collection, draft, close, onWritten]);

  // A quit from outside the app asks first only while the shell knows of a
  // modified draft. Reported on each change, and cleared when it goes away.
  useEffect(() => {
    if (!dirty) return;
    const report = (unsaved: boolean) => void backend.setUnsavedDraft(unsaved).catch(() => {});
    report(true);
    return () => report(false);
  }, [backend, dirty]);

  // Whoever wants to leave asks the guard, and the guard asks this.
  const latest = useRef({ dirty, save, close });
  useEffect(() => {
    latest.current = { dirty, save, close };
  });
  useEffect(() => {
    guard.register({
      isDirty: () => latest.current.dirty,
      save: () => latest.current.save(),
      discard: () => latest.current.close(),
    });
    return () => guard.register(null);
  }, [guard]);

  return {
    draft,
    dirty,
    opening,
    saving,
    error,
    dismissError: useCallback(() => setError(null), []),
    openNew,
    open,
    setText,
    save,
    format,
    cancel,
    close,
    remove,
  };
}
