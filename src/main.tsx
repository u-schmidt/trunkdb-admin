import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { tauriBackend } from "./ipc/backend";
import { BackendProvider } from "./ipc/BackendContext";
import "@fontsource-variable/plus-jakarta-sans";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}

// In a plain browser during development there is no shell to talk to, so
// the UI runs on sample data. Never part of a production build.
const backend =
  import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)
    ? (await import("./test/demoBackend")).demoBackend()
    : tauriBackend;

createRoot(root).render(
  <StrictMode>
    <BackendProvider value={backend}>
      <App />
    </BackendProvider>
  </StrictMode>,
);
