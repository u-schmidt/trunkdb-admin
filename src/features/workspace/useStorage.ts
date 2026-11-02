import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import type { AppError, StorageReport } from "../../ipc/types";

export type StorageState =
  | { status: "loading"; previous: StorageReport | null }
  | { status: "loaded"; report: StorageReport }
  | { status: "failed"; error: AppError };

/**
 * The storage report of an open database. It reads every page in use, so
 * it is asked for when the overview is shown and on Refresh, not with
 * every overview refresh after a write. Only the newest answer is shown.
 */
export function useStorage(sessionId: string): {
  storage: StorageState;
  refresh: () => void;
} {
  const backend = useBackend();
  const [storage, setStorage] = useState<StorageState>({ status: "loading", previous: null });
  const newest = useRef(0);

  const send = useCallback(() => {
    const request = ++newest.current;
    return backend.databaseStorage(sessionId).then(
      (report) => {
        if (request === newest.current) setStorage({ status: "loaded", report });
      },
      (thrown: unknown) => {
        if (request === newest.current) {
          setStorage({ status: "failed", error: toAppError(thrown) });
        }
      },
    );
  }, [backend, sessionId]);

  // The first report; the state already starts as loading.
  useEffect(() => {
    void send();
    return () => {
      // Whatever is in flight belongs to a view that is gone.
      newest.current = Number.MAX_SAFE_INTEGER;
    };
  }, [send]);

  const refresh = useCallback(() => {
    setStorage((current) => ({
      status: "loading",
      previous: current.status === "loaded" ? current.report : null,
    }));
    void send();
  }, [send]);

  return { storage, refresh };
}
