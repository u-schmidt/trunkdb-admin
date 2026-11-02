import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "../components/Modal";

/** What the open document editor offers to whoever wants to leave it. */
export interface DraftHandle {
  isDirty: () => boolean;
  /** Resolves true once saved; false leaves the draft as it is. */
  save: () => Promise<boolean>;
  discard: () => void;
}

interface DraftGuard {
  /** The editor announces itself, and null when it is gone. */
  register: (handle: DraftHandle | null) => void;
  /**
   * Runs `action` now if nothing unsaved would be lost. Otherwise asks
   * Save / Discard / Cancel first, and runs it only after a successful
   * save or a discard.
   */
  requestLeave: (action: () => void) => void;
}

const Context = createContext<DraftGuard | null>(null);

export function useDraftGuard(): DraftGuard {
  const guard = useContext(Context);
  if (guard === null) throw new Error("useDraftGuard needs a DraftGuardProvider above it");
  return guard;
}

/**
 * The single gate for every way out of a modified document draft:
 * another document, another collection, closing the database, quitting.
 */
export function DraftGuardProvider({ children }: { children: ReactNode }) {
  const handle = useRef<DraftHandle | null>(null);
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  const [saving, setSaving] = useState(false);

  const register = useCallback((next: DraftHandle | null) => {
    handle.current = next;
  }, []);

  const requestLeave = useCallback((action: () => void) => {
    if (handle.current === null || !handle.current.isDirty()) {
      action();
      return;
    }
    // A question already on screen is answered first.
    setPending((current) => current ?? { action });
  }, []);

  const guard = useMemo(() => ({ register, requestLeave }), [register, requestLeave]);

  const save = async () => {
    if (pending === null || saving) return;
    setSaving(true);
    const saved = (await handle.current?.save()) ?? true;
    setSaving(false);
    setPending(null);
    // A failed save leaves the user in the editor, with its error and the
    // draft; whatever they were about to do does not happen.
    if (saved) pending.action();
  };

  const discard = () => {
    if (pending === null) return;
    handle.current?.discard();
    setPending(null);
    pending.action();
  };

  return (
    <Context.Provider value={guard}>
      {children}
      {pending !== null && (
        <Modal title="Unsaved changes" onCancel={() => setPending(null)} busy={saving}>
          <div className="modal-body">
            <p>The document you are editing has changes that are not saved.</p>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setPending(null)} disabled={saving}>
              Cancel
            </button>
            <button type="button" onClick={discard} disabled={saving}>
              Discard changes
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={saving}
              autoFocus
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </Modal>
      )}
    </Context.Provider>
  );
}
