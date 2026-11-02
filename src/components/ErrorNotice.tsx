import type { ReactNode } from "react";
import type { AppError } from "../ipc/types";
import { shortenHome } from "./shortenHome";

interface Props {
  error: AppError;
  /** What was being attempted, e.g. the file path. */
  subject?: string | undefined;
  onDismiss: () => void;
  /** Follow-up actions specific to this failure. */
  children?: ReactNode;
}

/** A failure that stays readable until dismissed; never only a color. */
export function ErrorNotice({ error, subject, onDismiss, children }: Props) {
  return (
    <div className="notice notice-error" role="alert">
      <div className="notice-body">
        <p className="notice-message">
          <span className="notice-label">Error</span> {shortenHome(error.message)}
        </p>
        {subject !== undefined && <p className="notice-subject">{shortenHome(subject)}</p>}
        {error.detail !== null && <p className="notice-detail">{shortenHome(error.detail)}</p>}
      </div>
      <div className="notice-actions">
        {children}
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
