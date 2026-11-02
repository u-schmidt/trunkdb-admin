import { useCallback, useRef, useState } from "react";
import { toAppError } from "../../ipc/backend";
import type { AppError, ExplainReport } from "../../ipc/types";

export type ExplainState =
  | { status: "closed" }
  | { status: "loading"; previous: ExplainReport | null }
  | { status: "loaded"; report: ExplainReport }
  | { status: "failed"; error: AppError };

export interface Explain {
  state: ExplainState;
  /**
   * Asks the backend through `ask`, with a request ID it must echo, and
   * replaces any earlier answer.
   */
  run: (ask: (requestId: number) => Promise<ExplainReport>) => void;
  /** Hides the explanation; an answer still running is dropped. */
  close: () => void;
}

/**
 * Asks how trunkdb reads a page of the list (trunkdb SPEC §94) or makes
 * its groups (§107.6). Only on demand: it runs the query once more. Only
 * the newest answer is kept, as in `useCollectionQuery`.
 */
export function useExplain(): Explain {
  const [state, setState] = useState<ExplainState>({ status: "closed" });
  const newest = useRef(0);

  const run = useCallback((ask: (requestId: number) => Promise<ExplainReport>) => {
    const requestId = ++newest.current;
    setState((previous) => ({
      status: "loading",
      previous:
        previous.status === "loaded"
          ? previous.report
          : previous.status === "loading"
            ? previous.previous
            : null,
    }));
    ask(requestId).then(
      (report) => {
        if (report.request_id !== newest.current) return;
        setState({ status: "loaded", report });
      },
      (thrown: unknown) => {
        if (requestId !== newest.current) return;
        setState({ status: "failed", error: toAppError(thrown) });
      },
    );
  }, []);

  const close = useCallback(() => {
    newest.current += 1;
    setState({ status: "closed" });
  }, []);

  return { state, run, close };
}
