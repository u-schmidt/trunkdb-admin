import { useRef, useState, type ReactNode } from "react";
import type { AppError } from "../ipc/types";
import { Modal } from "./Modal";

interface Props {
  title: string;
  /** Names the target and says what will be removed. */
  children: ReactNode;
  confirmLabel: string;
  /** Resolves with the failure, or null when done. */
  onConfirm: () => Promise<AppError | null>;
  /** Called on cancel. */
  onClose: () => void;
  /** Called after a successful confirm; defaults to `onClose`. */
  onDone?: () => void;
  /** `primary` for an action that removes nothing, such as a compaction. */
  tone?: "danger" | "primary";
}

/** Confirmation of a destructive action. Cancel has the initial focus. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  onDone = onClose,
  tone = "danger",
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const inFlight = useRef(false);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const failed = await onConfirm();
    inFlight.current = false;
    setBusy(false);
    if (failed === null) onDone();
    else setError(failed);
  };

  return (
    <Modal title={title} onCancel={onClose} busy={busy}>
      <div className="modal-body">{children}</div>
      {error !== null && (
        <p className="field-problem" role="alert">
          {error.message}
          {error.detail !== null && ` (${error.detail})`}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onClose} disabled={busy} autoFocus>
          Cancel
        </button>
        <button type="button" className={tone} onClick={() => void confirm()} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
