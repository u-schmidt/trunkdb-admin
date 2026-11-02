import { createContext, useContext } from "react";
import type { Backend } from "./backend";

const BackendContext = createContext<Backend | null>(null);

export const BackendProvider = BackendContext.Provider;

export function useBackend(): Backend {
  const backend = useContext(BackendContext);
  if (backend === null) {
    throw new Error("useBackend needs a BackendProvider above it");
  }
  return backend;
}
