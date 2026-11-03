import { SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { toAppError } from "../../ipc/backend";
import type { AppError } from "../../ipc/types";

interface Props {
  /** The command, made by the backend from what the list runs. */
  makeCommand: () => Promise<string>;
  /** A failure making it: a filter that doesn't read, a closed session. */
  onError: (error: AppError) => void;
}

const HELP =
  "Copies a trunkdb find command for a terminal: the filter, the sort and the chosen " +
  "columns, not the page. It runs while the database is closed here or open read-only.";

/**
 * Copy as command: what the list shows, as a `trunkdb find`
 * command, on the clipboard; shown to select by hand where the clipboard
 * is refused.
 */
export function CopyCommand({ makeCommand, onError }: Props) {
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    let command: string;
    try {
      command = await makeCommand();
    } catch (thrown) {
      onError(toAppError(thrown));
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setRefused(command);
    }
  };

  return (
    <>
      <button type="button" title={HELP} onClick={() => void copy()}>
        <SquareTerminal aria-hidden="true" />
        Copy as command
      </button>
      {copied && (
        <span className="muted" role="status">
          Copied
        </span>
      )}
      {refused !== null && (
        <Modal title="Command" onCancel={() => setRefused(null)}>
          <div className="modal-body">
            <p>The clipboard is not available. Select the command and copy it:</p>
            <textarea
              className="command-text"
              aria-label="Command"
              readOnly
              rows={4}
              value={refused}
              onFocus={(event) => event.target.select()}
              autoFocus
            />
            <p className="muted">{HELP}</p>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setRefused(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
