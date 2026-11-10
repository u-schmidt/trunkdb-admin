# Working in this repository

TrunkDB Admin is a Tauri 2 desktop app (React + TypeScript frontend, Rust
backend) for inspecting and managing local [trunkdb](https://github.com/u-schmidt/trunkdb)
databases. What the app does is in `README.md`, how it is built and why in
`ARCHITECTURE.md`. This file is about how to work here.

## Layout

- `crates/admin-core/` — all behavior: sessions, overview, queries, documents,
  indexes, check/export, errors, recent files, preferences. No Tauri
  dependency; tested with `cargo test` against temporary databases.
- `src-tauri/` — the shell: thin command adapters (`commands.rs`), app state,
  window and bundle configuration. Commands translate and move work off the UI
  thread; they do not contain logic.
- `src/` — frontend. `ipc/` is the only code that talks to Tauri (`Backend`
  interface + DTO types mirroring admin-core); `features/` holds screens;
  `app/` holds top-level state; `test/` holds the fake backend for tests and the
  sample-data backend used when the UI runs in a plain browser.
- `ui-tests/` — UI tests as sentences, run with GroundworkTH against the
  `wdio-test` build (`ui-tests/README.md`).

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Run in development | `npm run tauri dev` (dev server on port 1430) |
| UI only, sample data | `npm run dev`, then open http://127.0.0.1:1430 |
| Everything below, in order | `npm run check` |
| Format (write) | `npm run format` and `cargo fmt --all` |
| Lint | `npm run lint` and `cargo clippy --workspace --all-targets -- -D warnings` |
| Type-check | `npm run typecheck` |
| Frontend tests | `npm test` |
| Backend tests | `cargo test --workspace` |
| Cross-process tests with the pinned trunkdb CLI | `npm run test:cli` (builds the CLI into `target/pinned-cli`; needs network once) |
| macOS app | `npm run tauri build` → `target/release/bundle/macos/TrunkDB Admin.app` |
| UI test build through WebDriver, never shipped | `npm run build:wdio-test` → `target/wdio-test/release/trunkdb-admin` |
| A UI test run's database and recent files | `scripts/wdio-fixture.sh <empty folder>` → prints `TRUNKDB_ADMIN_STATE_DIR=…` |
| UI tests (macOS, needs GroundworkTH and a model) | `ui-tests/run.sh [test …] [--suite admin-smoke]` |

## Rules

- trunkdb is pinned by release tag (`tag = "v…"`) in the root `Cargo.toml`.
  Use its public API only. A missing capability is a separate decision, never a reason to edit
  trunkdb or to read database files directly.
- Never hand a `trunkdb::Database` (or a clone) out of `Session::read`/`write`:
  closing relies on the session being the only owner to release the file lock.
- Every database command carries a `session_id`; nothing uses a global
  "current database".
- Whether a session may write is `Session::can_mutate`, false for a read-only
  open. Every write goes through `Session::write`, which refuses
  then with the `read_only` category; a new write action is shown only when
  `session.can_mutate` is true.
- Errors crossing IPC are `AppError` with a stable `ErrorCategory`. The frontend
  branches on the category, never on message text.
- The npm `@tauri-apps/*` packages and the Rust `tauri*` crates must stay on the
  same minor version, or `tauri build` refuses.
- Filtering, sorting, counting and paging happen in trunkdb, in one snapshot per
  request. The frontend never reorders or filters rows.
- Values cross IPC as text where JavaScript would lose them: condition values
  are typed text, documents are JSON text that is displayed but never parsed.
- A filter is a `FilterInput`: typed rows or trunkdb filter text.
  Every reader of a filter goes through `FilterInput::conditions`; the
  frontend never parses filter text, trunkdb reads and prints it.
- Every way out of a modified document draft goes through
  `useDraftGuard().requestLeave(action)` (`src/app/DraftGuard.tsx`). A new
  navigation, close or delete action must use it too.
- Quit is a custom menu item (`src-tauri/src/menu.rs`) that asks the frontend,
  which calls `app_quit`. Do not restore the predefined Quit item: it would
  terminate without asking about a draft.
- A quit from outside the app (Dock, AppleScript, logout) is answered in
  `src-tauri/src/terminate.rs` from the unsaved-draft flag the frontend keeps
  current with `setUnsavedDraft`. Code that holds a draft must report it there.
- Appearance (View → Appearance) is set natively with `AppHandle::set_theme`;
  the styles follow through `prefers-color-scheme`. Colors are tokens in
  `styles.css` with a light and a dark set; add new colors to both. They
  come from the logo: navy `#0F2747` and petrol `#0E8FB8`. Petrol is 3.7:1 on
  white, so text and filled buttons use the deeper `--accent`, and
  `--accent-bright` marks, focuses and draws only. The navy column and the
  status bar (`--shell-*`, `--status-*`) are navy in both appearances.
- An export writes to a temporary file beside its destination and publishes it
  only when complete and synced (`maintenance.rs`). Keep the database and WAL
  alias checks on both sides of the write.
- An import runs only into a new database: a temporary one beside the
  destination, hard-linked into place when complete and closed, never over a
  file (`import.rs`). trunkdb's import isn't atomic; never run it
  into an open session's database.
- The WebDriver plugin for UI tests (`tauri-plugin-wdio-webdriver`) is linked
  only by the `wdio-test` Cargo feature, off by default, and built only by
  `scripts/build-wdio-test.sh`: its server takes full control of the window
  on every launch. Its permission is given there through `TAURI_CONFIG`, never
  by a file in `src-tauri/capabilities/`. Code for UI tests, like reading
  `TRUNKDB_ADMIN_STATE_DIR`, sits behind `#[cfg(feature = "wdio-test")]`.
- Component tests replace the CodeMirror editor with `test/PlainJsonEditor`;
  CodeMirror itself is covered by `components/JsonEditor.test.tsx`.
- Tests create their own temporary databases. Never point one at a personal file.
- Dependencies are exact-pinned in `package.json`; both lockfiles are committed.

## Dependency choices

- **`tauri-plugin-dialog`** for native open and save dialogs; the frontend has
  no other filesystem capability.
- **`tauri-plugin-wdio-webdriver`**, pinned exactly, in the UI test build
  only: macOS offers no WebDriver for WKWebView from outside the app, so UI
  tests drive it through a server inside it.
- **CodeMirror 6 with `@codemirror/lang-json`** for the document editor. It is
  given a string and reports a string; highlighting and diagnostics never
  rewrite the text. `JsonEditor.test.tsx` checks that text JavaScript's JSON
  would damage comes back unchanged.
- **Native `<dialog>`** for modal dialogs: the WebView provides the focus trap,
  inert background and focus return.
- **`lucide-react`** for icons (ISC licence), exact-pinned. An icon stands
  beside a button's text, never instead of it, and is `aria-hidden`; only a
  small inline control like a value's × is icon-only, with an `aria-label`.
- **`@fontsource-variable/plus-jakarta-sans`** (OFL-1.1), exact-pinned: the
  trunkdb design system's typeface, bundled so the app never loads a font
  from the network.
- **No state-management, form, table or UI component library:** React state
  and one context (the draft guard) are enough, and the result table is plain
  markup because sorting and paging happen in trunkdb.
- **Native `<select>`** through `components/Select.tsx`, which draws it flat
  with its own arrow. The list that opens stays the system's.

## The app icon

The icon is the small trunkdb mark (white elephant, petrol stack, on navy
`#0F2747`) on a macOS rounded square: `src-tauri/icons/app-icon.svg`. The
bundle's icon files are made from it. `tauri icon` also writes mobile and
Windows Store sizes this app doesn't use, so write them elsewhere:

```bash
npx tauri icon src-tauri/icons/app-icon.svg --output /tmp/trunkdb-admin-icons
```

Then copy `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`,
`icon.png`, `icon.icns` and `icon.ico` into `src-tauri/icons/`.
