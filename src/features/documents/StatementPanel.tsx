import { useEffect, useState } from "react";
import { toAppError } from "../../ipc/backend";
import type { AppError } from "../../ipc/types";

interface Props {
  /** Set when the groups' aggregate is shown rather than the list's query. */
  grouped: boolean;
  /** What is shown now; a new one is written again. */
  subject: object;
  /** The statement, written by the backend from what was run. */
  make: () => Promise<string>;
  onClose: () => void;
}

type State =
  | { status: "loading"; subject: object }
  | { status: "loaded"; subject: object; text: string }
  | { status: "failed"; subject: object; error: AppError };

/**
 * What the app hands trunkdb for what is shown, as the Rust
 * calls that make it: the list's count and page, or the groups'
 * aggregate. Written again for every new page or groups while open.
 */
export function StatementPanel({ grouped, subject, make, onClose }: Props) {
  const [state, setState] = useState<State>({ status: "loading", subject });
  const [copied, setCopied] = useState<boolean | null>(null);

  useEffect(() => {
    let current = true;
    make().then(
      (text) => current && setState({ status: "loaded", subject, text }),
      (thrown: unknown) =>
        current && setState({ status: "failed", subject, error: toAppError(thrown) }),
    );
    return () => {
      current = false;
    };
    // `make` is made anew every render; what it writes changes with `subject`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const loading = state.subject !== subject || state.status === "loading";
  const text = state.status === "loaded" ? state.text : null;
  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="explain" aria-labelledby="statement-heading" aria-busy={loading}>
      <div className="panel-heading">
        <h2 id="statement-heading">
          {grouped ? "The statement for these groups" : "The statement for this page"}
        </h2>
        {copied === true && (
          <span className="muted" role="status">
            Copied
          </span>
        )}
        {copied === false && (
          <span className="muted" role="status">
            The clipboard is not available: select the text and copy it.
          </span>
        )}
        <button type="button" onClick={() => void copy()} disabled={text === null}>
          Copy
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">
        {grouped
          ? "What trunkdb is asked for, as its Rust API: the filter and the aggregate. Every group is made in one run; the app shows a page of them."
          : "What trunkdb is asked for, as its Rust API: the count of what the filter finds, and the page shown."}
      </p>
      {state.status === "failed" ? (
        <div className="tool-result tool-failed" role="alert">
          <p>
            <strong>There is no statement for this.</strong> {state.error.message}
          </p>
          {state.error.detail !== null && <p className="muted">{state.error.detail}</p>}
        </div>
      ) : text === null ? (
        <p className="muted">Writing the statement…</p>
      ) : (
        <pre
          className={loading ? "statement-code explain-stale" : "statement-code"}
          aria-label="Statement"
          tabIndex={0}
        >
          {text}
        </pre>
      )}
    </section>
  );
}
