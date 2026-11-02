import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import type { AppError, FieldPath, FieldPaths, ValueKind, ValueType } from "../../ipc/types";

export type FieldPathsState =
  | { status: "idle" }
  | { status: "loading"; previous: FieldPaths | null }
  | { status: "loaded"; result: FieldPaths }
  | { status: "failed"; error: AppError };

export interface FieldPathsSource {
  state: FieldPathsState;
  /** Reads them unless read already or reading (on first need). */
  ensure: () => void;
  /** The collection's documents changed: read again on next need. */
  invalidate: () => void;
  /** Reads them again now. */
  refresh: () => void;
  /** `<datalist>` ids: every nameable path, and those without `[*]`. */
  listAll: string;
  listPlain: string;
}

const NONE: FieldPathsSource = {
  state: { status: "idle" },
  ensure: () => undefined,
  invalidate: () => undefined,
  refresh: () => undefined,
  listAll: "",
  listPlain: "",
};

const Context = createContext<FieldPathsSource>(NONE);

/** The field paths of the collection around the caller, or none. */
export function useFieldPaths(): FieldPathsSource {
  return useContext(Context);
}

/** The paths known now: the newest result, or the one being replaced. */
export function knownPaths(state: FieldPathsState): FieldPaths | null {
  if (state.status === "loaded") return state.result;
  if (state.status === "loading") return state.previous;
  return null;
}

/** The row value type a path's most common kind suggests, if a row has it. */
export function rowTypeOf(path: FieldPath): ValueType | null {
  const kind = path.kinds.find((k) => k.kind !== "null")?.kind;
  const types: Partial<Record<ValueKind, ValueType>> = {
    string: "string",
    int: "int",
    float: "float",
    bool: "bool",
    date_time: "date_time",
    id: "id",
  };
  return kind === undefined ? null : (types[kind] ?? null);
}

/** "812 of 1,000, string": a suggestion's label. */
export function pathLabel(path: FieldPath, documents: number): string {
  const main = path.kinds[0]?.kind.replace("_", "-") ?? "";
  return `${path.documents.toLocaleString("en")} of ${documents.toLocaleString("en")}, ${main}`;
}

/**
 * Field paths of one collection, read on first need and kept
 * until its documents change: every path input inside asks the same.
 */
export function FieldPathsProvider({
  sessionId,
  collection,
  stored,
  children,
}: {
  sessionId: string;
  collection: string;
  /** false for a virtual collection: no documents, nothing to read. */
  stored: boolean;
  children: ReactNode;
}) {
  const backend = useBackend();
  const [state, setState] = useState<FieldPathsState>({ status: "idle" });
  const newest = useRef(0);
  const id = useId();

  const read = useCallback(() => {
    const request = ++newest.current;
    setState((before) => ({ status: "loading", previous: knownPaths(before) }));
    backend.collectionFieldPaths(sessionId, { request_id: request, collection }).then(
      (result) => {
        if (request === newest.current) setState({ status: "loaded", result });
      },
      (thrown: unknown) => {
        if (request === newest.current) setState({ status: "failed", error: toAppError(thrown) });
      },
    );
  }, [backend, sessionId, collection]);

  const status = state.status;
  const ensure = useCallback(() => {
    if (stored && (status === "idle" || status === "failed")) read();
  }, [stored, status, read]);

  const invalidate = useCallback(() => {
    // An answer still on its way describes the documents before.
    newest.current += 1;
    setState({ status: "idle" });
  }, []);

  const refresh = useCallback(() => {
    if (stored) read();
  }, [stored, read]);

  const known = knownPaths(state);
  const nameable = known?.paths.filter((p) => p.nameable) ?? [];
  const source: FieldPathsSource = {
    state,
    ensure,
    invalidate,
    refresh,
    listAll: `${id}-all`,
    listPlain: `${id}-plain`,
  };
  return (
    <Context.Provider value={source}>
      {children}
      <datalist id={source.listAll}>
        {nameable.map((p) => (
          <option key={p.path} value={p.path} label={pathLabel(p, known?.documents ?? 0)} />
        ))}
      </datalist>
      <datalist id={source.listPlain}>
        {nameable
          .filter((p) => !p.path.includes("[*]"))
          .map((p) => (
            <option key={p.path} value={p.path} label={pathLabel(p, known?.documents ?? 0)} />
          ))}
      </datalist>
    </Context.Provider>
  );
}
