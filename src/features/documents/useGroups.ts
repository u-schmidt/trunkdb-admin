import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import type {
  AppError,
  ColumnInput,
  FilterInput,
  GroupRequest,
  GroupResult,
  GroupSort,
} from "../../ipc/types";

/** How documents are grouped, apart from which documents and the page. */
export interface GroupSettings {
  groupBy: string[];
  columns: ColumnInput[];
  sort: GroupSort | null;
  pageSize: number;
}

/** What one group request asks for. */
export interface GroupAsk {
  settings: GroupSettings;
  /** The list's applied filter: the documents to group. */
  filter: FilterInput;
}

export interface Groups {
  /** The last successful result; kept while a newer request runs or fails. */
  result: GroupResult | null;
  /** What `result` was made of; null before the first Run. */
  applied: GroupAsk | null;
  /** The newest ask sent, which may still be running or have failed. */
  requested: GroupAsk | null;
  loading: boolean;
  /** The newest request's failure. */
  error: AppError | null;
  /** Groups `ask`, from the first page. */
  run: (ask: GroupAsk) => void;
  goToPage: (page: number) => void;
  /** The request `ask` and `page` make, for Explain. */
  requestFor: (ask: GroupAsk, page: number, requestId: number) => GroupRequest;
}

/**
 * Runs a collection's group queries in the backend (trunkdb SPEC §107),
 * keeping only the answer to the newest request, as `useCollectionQuery`
 * does. Nothing runs until the first `run`.
 */
export function useGroups(sessionId: string, collection: string): Groups {
  const backend = useBackend();
  const [result, setResult] = useState<GroupResult | null>(null);
  const [applied, setApplied] = useState<GroupAsk | null>(null);
  const [requested, setRequested] = useState<GroupAsk | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const newest = useRef(0);
  const position = useRef<{ ask: GroupAsk; page: number } | null>(null);

  const requestFor = useCallback(
    (ask: GroupAsk, page: number, requestId: number): GroupRequest => ({
      request_id: requestId,
      collection,
      filter: ask.filter,
      group_by: ask.settings.groupBy,
      columns: ask.settings.columns,
      sort: ask.settings.sort,
      page,
      page_size: ask.settings.pageSize,
    }),
    [collection],
  );

  const send = useCallback(
    (ask: GroupAsk, page: number) => {
      const requestId = ++newest.current;
      setRequested(ask);
      setLoading(true);
      backend.collectionGroups(sessionId, requestFor(ask, page, requestId)).then(
        (answer) => {
          if (answer.request_id !== newest.current) return;
          // The backend may have moved to the last page that exists.
          position.current = { ask, page: answer.page };
          setResult(answer);
          setApplied(ask);
          setError(null);
          setLoading(false);
        },
        (thrown: unknown) => {
          if (requestId !== newest.current) return;
          setError(toAppError(thrown));
          setLoading(false);
        },
      );
    },
    [backend, sessionId, requestFor],
  );

  // Whatever is still in flight belongs to a view that is gone.
  useEffect(
    () => () => {
      newest.current = Number.MAX_SAFE_INTEGER;
    },
    [],
  );

  const run = useCallback((ask: GroupAsk) => send(ask, 0), [send]);
  const goToPage = useCallback(
    (page: number) => {
      if (position.current !== null) send(position.current.ask, page);
    },
    [send],
  );

  return { result, applied, requested, loading, error, run, goToPage, requestFor };
}
