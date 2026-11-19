import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import type { AppError, FilterInput, HintInput, QueryResult, SortInput } from "../../ipc/types";
import { NO_FILTER } from "./filter";

/** What decides which documents are listed, apart from the page. */
export interface Criteria {
  /** Rows or text. */
  filter: FilterInput;
  sort: SortInput;
  pageSize: number;
  /** Chosen fields (trunkdb SPEC §106); null: whole documents. */
  select: string[] | null;
  /** Fields left out of whole documents (trunkdb SPEC §143); empty: none. */
  except: string[];
  /** The index the page is read by; null: trunkdb's choice. */
  hint: HintInput | null;
}

export const PAGE_SIZES = [25, 50, 100] as const;

/**
 * Watch calls per session, each after the one before, so a stop and a start
 * made in order reach the backend in order, whatever the timing of the
 * requests.
 */
const watchQueues = new Map<string, Promise<unknown>>();

function queueWatch(sessionId: string, call: () => Promise<unknown>): void {
  const previous = watchQueues.get(sessionId) ?? Promise.resolve();
  // A call that fails leaves the queue going: a refused watch shows nothing.
  watchQueues.set(
    sessionId,
    previous.then(call).catch(() => undefined),
  );
}

export const DEFAULT_CRITERIA: Criteria = {
  filter: NO_FILTER,
  sort: { field: "_id", descending: false },
  pageSize: 50,
  select: null,
  except: [],
  hint: null,
};

export interface CollectionQuery {
  /** The last successful result; kept while a newer request runs or fails. */
  result: QueryResult | null;
  /** The criteria `result` was produced with. */
  applied: Criteria;
  /**
   * The criteria of the newest request: what the list shows once it has
   * loaded. Changes go from here, so a request still running is not undone.
   */
  requested: Criteria;
  loading: boolean;
  /** The newest request's failure; `result` is then older than the request. */
  error: AppError | null;
  /** New criteria always start at the first page. */
  apply: (criteria: Criteria) => void;
  goToPage: (page: number) => void;
  /** Other fields, fields left out, or whole documents, on the same page. */
  choose: (select: string[] | null, except?: string[]) => void;
  /** Another index, or trunkdb's choice, for the same page. */
  setHint: (hint: HintInput | null) => void;
  /** Same criteria and page, read again. */
  refresh: () => void;
  /** When the list last read again because its documents changed; null before. */
  changedAt: Date | null;
}

/**
 * Runs a collection's queries in the backend and keeps only the answer to
 * the newest request: each one carries an ID, and a response with an older
 * ID is dropped instead of overwriting the view.
 *
 * With `live`, the list is read again whenever the backend reports that
 * the documents it shows changed: a read-only session beside another
 * program's writes. The watch follows the applied filter.
 */
export function useCollectionQuery(
  sessionId: string,
  collection: string,
  live = false,
): CollectionQuery {
  const backend = useBackend();
  const [result, setResult] = useState<QueryResult | null>(null);
  const [applied, setApplied] = useState<Criteria>(DEFAULT_CRITERIA);
  const [requested, setRequested] = useState<Criteria>(DEFAULT_CRITERIA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [changedAt, setChangedAt] = useState<Date | null>(null);
  const newest = useRef(0);
  const position = useRef({ criteria: DEFAULT_CRITERIA, page: 0 });

  // The newest request's criteria and page: what the user asked for, which
  // a change or a refresh reads again, even while that request is running.
  const wanted = useRef({ criteria: DEFAULT_CRITERIA, page: 0 });

  /** Sends a request; the returned handlers ignore all but the newest. */
  const send = useCallback(
    (criteria: Criteria, page: number) => {
      const requestId = ++newest.current;
      return backend
        .collectionQuery(sessionId, {
          request_id: requestId,
          collection,
          filter: criteria.filter,
          sort: criteria.sort,
          page,
          page_size: criteria.pageSize,
          select: criteria.select,
          except: criteria.except,
          hint: criteria.hint,
        })
        .then(
          (answer) => {
            if (answer.request_id !== newest.current) return;
            // The backend may have moved to the last page that exists.
            position.current = { criteria, page: answer.page };
            // What the list shows is what a refresh asks for, the page the
            // backend moved to included.
            wanted.current = { criteria, page: answer.page };
            setResult(answer);
            setApplied(criteria);
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
    [backend, sessionId, collection],
  );

  const run = useCallback(
    (criteria: Criteria, page: number) => {
      wanted.current = { criteria, page };
      setLoading(true);
      setRequested(criteria);
      void send(criteria, page);
    },
    [send],
  );

  // The first page of everything; `loading` already starts out true.
  useEffect(() => {
    void send(DEFAULT_CRITERIA, 0);
    return () => {
      // Whatever is still in flight belongs to a view that is gone.
      newest.current = Number.MAX_SAFE_INTEGER;
    };
  }, [send]);

  // The watch is replaced whenever the applied filter changes. Calls go
  // out one after another, so an older filter's watch can't land last.
  const watched = JSON.stringify(applied.filter);
  useEffect(() => {
    if (!live) return;
    const filter = JSON.parse(watched) as FilterInput;
    queueWatch(sessionId, () => backend.collectionWatch(sessionId, collection, filter));
  }, [backend, sessionId, collection, live, watched]);

  const apply = useCallback((criteria: Criteria) => run(criteria, 0), [run]);
  const goToPage = useCallback((page: number) => run(position.current.criteria, page), [run]);
  const refresh = useCallback(() => run(wanted.current.criteria, wanted.current.page), [run]);
  const choose = useCallback(
    (select: string[] | null, except: string[] = []) =>
      run({ ...position.current.criteria, select, except }, position.current.page),
    [run],
  );

  const setHint = useCallback(
    (hint: HintInput | null) => run({ ...position.current.criteria, hint }, position.current.page),
    [run],
  );

  // The refresh a change asks for. Read through a ref, so subscribing once
  // doesn't depend on when `refresh` is made again.
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
      // This collection's watch goes with the view. Queued behind any watch
      // call made earlier, and it names the collection, so it cannot stop
      // the watch of a list that replaced this one.
      queueWatch(sessionId, () => backend.collectionUnwatch(sessionId, collection));
    };
  }, [backend, sessionId, collection, live]);

  return {
    result,
    applied,
    requested,
    loading,
    error,
    apply,
    goToPage,
    choose,
    setHint,
    refresh,
    changedAt,
  };
}
