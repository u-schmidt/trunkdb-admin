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
}

/**
 * Runs a collection's queries in the backend and keeps only the answer to
 * the newest request: each one carries an ID, and a response with an older
 * ID is dropped instead of overwriting the view.
 */
export function useCollectionQuery(sessionId: string, collection: string): CollectionQuery {
  const backend = useBackend();
  const [result, setResult] = useState<QueryResult | null>(null);
  const [applied, setApplied] = useState<Criteria>(DEFAULT_CRITERIA);
  const [requested, setRequested] = useState<Criteria>(DEFAULT_CRITERIA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const newest = useRef(0);
  const position = useRef({ criteria: DEFAULT_CRITERIA, page: 0 });

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

  const apply = useCallback((criteria: Criteria) => run(criteria, 0), [run]);
  const goToPage = useCallback((page: number) => run(position.current.criteria, page), [run]);
  const refresh = useCallback(() => run(position.current.criteria, position.current.page), [run]);
  const choose = useCallback(
    (select: string[] | null, except: string[] = []) =>
      run({ ...position.current.criteria, select, except }, position.current.page),
    [run],
  );

  const setHint = useCallback(
    (hint: HintInput | null) => run({ ...position.current.criteria, hint }, position.current.page),
    [run],
  );

  return { result, applied, requested, loading, error, apply, goToPage, choose, setHint, refresh };
}
