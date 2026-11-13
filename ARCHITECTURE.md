# Architecture

How TrunkDB Admin is put together, and why. [`AGENTS.md`](AGENTS.md) has the
rules that follow from it, in short, for working on the code.

## Three layers

```
React frontend (src/)
  │  ipc/backend.ts — the only code that talks to Tauri
  ▼
Tauri shell (src-tauri/)
  │  commands.rs — translates arguments and results, runs work off the UI thread
  ▼
admin-core (crates/admin-core/)
  │  sessions, queries, documents, indexes, maintenance, app state
  ▼
trunkdb, through its public API
```

- **admin-core holds all behaviour** and knows nothing of Tauri or the UI. It
  is tested with `cargo test` against real temporary databases, with no window
  running. Anything that decides what happens to a database lives here.
- **The Tauri shell is thin.** Each command takes its arguments, calls one
  admin-core method on a blocking thread (`spawn_blocking`), and returns the
  result. The shell also owns the window, the menu and quitting.
- **The frontend shows and asks.** It never filters, sorts or reorders rows,
  never parses filter text, and never decides on its own whether a write is
  allowed: the backend refuses whatever it shouldn't do, even when a disabled
  button is bypassed.
- **trunkdb is used through its public API only.** The app never reads a
  database file itself; a missing capability is a change to trunkdb, not a
  workaround here.

## Sessions and the file locks

An open database is a `Session`, found by its id; every database command
carries a `session_id`, and nothing uses a "current database". The session is
the only owner of the `trunkdb::Database`: `Session::read` and
`Session::write` lend it to a closure and never hand it out. That is what
makes closing reliable: closing marks the session as closing, so new work is
refused instead of queued, waits for running work, and then drops the
database, which releases trunkdb's locks. Another process can open the file
for writing as soon as the app says it is closed.

trunkdb's locks (its SPEC §185–§189) let one process write and others read
beside it. An open for editing is that writer: other programs may read the
file, none may write. A read-only session holds the readers' lock only while
it reads, so another program may write between reads; the session reads what
it wrote, and a read under way when it writes is asked to let go and fails
with `SnapshotExpired`.

An open for editing never raises a file's format unasked: trunkdb's writer
stamps the bundled format as it opens, so `SessionManager::open_existing`
looks at the file read-only first and refuses an older one with
`FormatUpgrade`. The frontend asks `format_upgrade` before every open for
editing and passes the user's answer as `upgrade`, which opens through
`open_upgrading`. `BUNDLED_FORMAT` is the admin's own copy of the format
trunkdb writes; a test checks a new database has it.

Writes go one at a time per session. A session opened read-only refuses every
write in `Session::write` with its own error category, and the frontend shows
write actions only where `can_mutate` is true. Writes are never retried
automatically.

## Reading: one snapshot per request

A page of the list, its total, and the groups are each read in one trunkdb
snapshot, released before the command returns. So the count and the rows
shown always belong together, even while the app writes in between, and no
snapshot stays open because an editor is.

Every list request carries a `request_id`. The frontend keeps only the answer
to its newest request, so a slow answer that arrives after a newer one can't
overwrite what is shown.

## Values cross as text

JavaScript would lose some trunkdb values: integers beyond 2⁵³, the
difference between `2` and `2.0`, NaN, binary data. So nothing crosses the
IPC boundary as a parsed value. Documents travel as JSON text in trunkdb's
tagged form, which the frontend displays and edits but never parses; table
cells are previews made in the backend; typed filter values are sent as text
and read by the backend. The editor gives back exactly the text it was given:
highlighting and syntax hints never rewrite it.

## Filters: rows or text, read by trunkdb

A filter is either typed rows or a text in trunkdb's filter language. Both
become trunkdb conditions in one place, `FilterInput::conditions`. Text is
parsed and printed by trunkdb itself, so the app understands exactly the
language trunkdb does, and a mistake points to its line and column. Switching
from text to rows works where rows can show the filter, and otherwise says
what they can't.

The Statement panel shows the same request as Rust calls. For the groups, the
calls are written in the same pass that builds the aggregate, so the statement
can't differ from what runs.

## Errors

Every error that reaches the frontend is an `AppError` with a stable category
(`Locked`, `UnsupportedFormat`, `UniqueConflict`, `ReadOnly` and so on) and a
readable message. The frontend decides what to do by the category, never by the
wording. trunkdb's error types, not its messages, decide the category.

## Unsaved changes

Every way of leaving a changed document goes through one place, the draft
guard (`src/app/DraftGuard.tsx`). It asks Save / Discard / Cancel, and runs the
action only after a successful save or a discard. Quitting is included:

- Cmd+Q and the menu's Quit are a custom menu item that asks the frontend
  first; macOS's predefined Quit item would end the app without asking.
- A quit from outside the app (the Dock, AppleScript, logout) is answered in
  `src-tauri/src/terminate.rs`, from a flag the frontend keeps current while a
  draft is changed. With a changed draft it cancels the quit, which also
  cancels a logout, and asks like Cmd+Q.

## Files the app writes

- **Export** writes to a temporary file beside the destination, syncs it, and
  only then puts it in place. A failed export leaves the destination as it
  was, and the database file or its log can never be the destination.
- **Import** runs only into a new database: a temporary one beside the
  destination, linked into place when complete and closed. trunkdb's own
  import isn't atomic, so it never runs into a database that is open.
- **App state** (recent files, preferences) is small JSON files, written beside
  and renamed. A missing or unreadable file counts as empty, so damaged app
  state can't keep the app from starting.

## Testing

- **admin-core:** `cargo test` on real temporary databases. Filter and query
  results are compared with direct trunkdb calls.
- **Across processes:** `npm run test:cli` builds the `trunkdb` CLI at the
  pinned release and checks, as a second process, what the app wrote and
  that the locks let in readers and writers as they should.
- **Frontend:** Vitest in jsdom against a fake backend, with the CodeMirror
  editor replaced by a plain text area; CodeMirror itself has its own tests.
- **Not covered by tests:** the native dialogs, the menu, quitting and
  appearance run only in the built app, so changes there need trying in it.

`npm run dev` without Tauri runs the frontend on a demo backend with built-in
sample data, for looking at the layout in a browser.
