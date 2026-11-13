# TrunkDB Admin

A desktop app for looking into and managing
[trunkdb](https://github.com/u-schmidt/trunkdb) databases without writing
Rust. Built with Tauri 2, React and TypeScript; macOS is the platform it is
made and tested on.

![A recipes collection filtered on ingredients[*].name equals Tomatoes, two documents found, the first shown as JSON](assets/screenshot.webp)

## What it does

- **Open or create** a database file, read-only if you like; recent files on
  the start screen.
- **Overview:** collections with their document counts and indexes, the file's
  format and the trunkdb releases that created and last wrote it, and storage
  statistics: pages by kind, sizes per collection, the write-ahead log, and
  what compacting would free.
- **Browse** a collection as JSON or as a table, sorted and paged by trunkdb,
  with the columns you choose, or every field but the ones you hide.
- **Filter** with typed rows (comparisons, contains, starts with, one of a list
  of values, a kind of value) or with trunkdb's filter language as text
  (`status = "open" and due < date("2026-12-01T00:00:00Z")`); copy the list as a
  `trunkdb find` command.
- **Groups:** documents counted per value of up to three fields, with sums,
  averages, minimums, maximums, distinct counts and first or last values;
  arrays unwound to count their elements; each group's documents one click
  away.
- **Explain** how trunkdb ran what is shown: the plan, each index read, how
  many entries and documents it read for how many shown, and what the plans it
  passed over would have read, each one click away as an index hint.
  **Statement** shows the same as the Rust calls that make it.
- **Edit** documents in a JSON editor that never rewrites your text; insert,
  delete, and a question before any unsaved change is lost, quitting included.
- **Indexes:** create single, compound, unique and sparse indexes; drop them.
- **Field paths** counted over every document, as suggestions in every path
  input.
- **Maintenance:** consistency check, export to JSON Lines, compaction, and
  importing an export into a new database.

All filtering, sorting, counting and paging happen in trunkdb, through its
public API; the app never reads database files itself.

## Building and running

Needs Node.js 22 or later, Rust 1.90 or later, and Tauri's
[prerequisites](https://tauri.app/start/prerequisites/) (on macOS: Xcode's
command line tools).

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # target/release/bundle/macos/TrunkDB Admin.app
```

The app isn't signed or notarized, so build it yourself rather than passing a
bundle around.

To have something to look at, make a sample database:

```bash
cargo run -p trunkdb-admin-core --example make_sample -- ~/Documents/sample.trunkdb
```

`npm run dev` alone serves the interface in a browser on built-in sample data,
without a database: enough to look at the layout.

## Bundled trunkdb

trunkdb is built into the app, pinned to the release tag `v0.40.0` in
`Cargo.toml`; the start screen and the overview show the version and commit.
The app opens what that trunkdb opens: every file an earlier trunkdb wrote, in
the current format 17. A file the app opens for editing is in that format
afterwards, and trunkdb 0.39.0 or older, or TrunkDB Admin 0.1.0, can't open it
then; a read-only open leaves the format as it is.

## Sharing a file with other programs

While the app has a database open for editing, other programs using trunkdb
0.40.0 or newer can read it at the same time, but not write to it. Opened
read-only here, the file stays open to another program that writes: the app
reads what it wrote, and a read that is under way when it writes stops with
"The data changed while it was being read"; reading again shows the new state.
trunkdb keeps four lock files beside each database it opens (`.writer`,
`.readers`, `.gate`, `.letgo`) and leaves them there.

## Where it keeps things

The bundle identifier is `io.github.u-schmidt.trunkdb-admin`. Recent files and
preferences live in `~/Library/Application Support/` under that name; nothing
else is stored outside your database files.

## Known limits

- A file another program has open for writing can be opened here read-only,
  not for editing.
- The groups are made anew for every page shown, and trunkdb holds them all in
  memory, so grouping by a field with a different value in every document
  makes as many groups as documents each time.
- Quitting from the Dock, by AppleScript or at logout asks about unsaved
  changes like Cmd+Q does. This hooks into the app delegate at startup
  (`src-tauri/src/terminate.rs`); should a later Tauri answer that itself, the
  app says so on stderr and such a quit no longer asks.
- Windows and Linux may build, but aren't tried.

## Changes

What changed in each release is in [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

How the app is built and why is in [`ARCHITECTURE.md`](ARCHITECTURE.md); the
commands and the rules that keep it working are in [`AGENTS.md`](AGENTS.md).
`npm run check` runs everything a change must pass.

## License

MIT, see [`LICENSE`](LICENSE).
