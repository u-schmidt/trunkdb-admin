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
import { queueWatch } from "./watchQueue";

/** How documents are grouped, apart from which documents and the page. */
export interface GroupSettings {
  /** Arrays made one document per element before grouping. */
  unwind: string[];
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
  /** When the groups last read again because their documents changed; null before. */
  changedAt: Date | null;
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
 *
 * With `live`, the groups are read again whenever the backend reports that
 * the documents they count changed: a read-only session beside another
 * program's writes. The watch follows the applied groups, not their page.
 */
export function useGroups(sessionId: string, collection: string, live = false): Groups {
  const backend = useBackend();
  const [result, setResult] = useState<GroupResult | null>(null);
  const [applied, setApplied] = useState<GroupAsk | null>(null);
  const [requested, setRequested] = useState<GroupAsk | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [changedAt, setChangedAt] = useState<Date | null>(null);
  const newest = useRef(0);
  const position = useRef<{ ask: GroupAsk; page: number } | null>(null);
  // The newest request's ask and page: what a change or a refresh reads
  // again, even while that request is still running.
  const wanted = useRef<{ ask: GroupAsk; page: number } | null>(null);

  const requestFor = useCallback(
    (ask: GroupAsk, page: number, requestId: number): GroupRequest => ({
      request_id: requestId,
      collection,
      filter: ask.filter,
      unwind: ask.settings.unwind,
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
          wanted.current = { ask, page: answer.page };
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

  const run = useCallback(
    (ask: GroupAsk) => {
      wanted.current = { ask, page: 0 };
      send(ask, 0);
    },
    [send],
  );
  const goToPage = useCallback(
    (page: number) => {
      if (position.current === null) return;
      wanted.current = { ask: position.current.ask, page };
      send(position.current.ask, page);
    },
    [send],
  );
  // Same groups and page, read again.
  const refresh = useCallback(() => {
    if (wanted.current !== null) send(wanted.current.ask, wanted.current.page);
  }, [send]);

  // The watch is replaced whenever the applied groups change. Keyed on their
  // text, so a page change alone doesn't start a new watch.
  const appliedKey = applied === null ? null : JSON.stringify(applied);
  useEffect(() => {
    if (!live || appliedKey === null) return;
    const ask = JSON.parse(appliedKey) as GroupAsk;
    queueWatch(sessionId, () => backend.collectionGroupsWatch(sessionId, requestFor(ask, 0, 0)));
  }, [backend, sessionId, live, appliedKey, requestFor]);

  // The refresh a change asks for, read through a ref as the list's is.
  const refreshRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (!live) return;
    const stop = backend.onListChanged((change) => {
      if (change.session_id === sessionId && change.collection === collection) {
        setChangedAt(new Date());
        refreshRef.current();
      }
    });
    return () => {
      stop();
      // Queued behind any watch call made earlier, and it names the
      // collection, so it cannot stop a watch that replaced this one.
      queueWatch(sessionId, () => backend.collectionUnwatch(sessionId, collection));
    };
  }, [backend, sessionId, collection, live]);

  return { result, applied, requested, loading, error, changedAt, run, goToPage, requestFor };
}
