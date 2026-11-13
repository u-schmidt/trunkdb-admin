# Changelog

What changed in each release of TrunkDB Admin, newest first. Each release is
tagged `vX.Y.Z` and names the trunkdb release it bundles.

## Unreleased

Catching up with what trunkdb 0.30.0 offers, then bundling trunkdb 0.40.0.

- **New look:** the logo's navy and petrol, and Plus Jakarta Sans, bundled
  with the app. An open database is laid out as an app window: a navy column
  with the file, its mode, the collections and Close database; a collection's
  sections as tabs under its name; the filter in a tinted band; a status bar
  with the mode, file format and trunkdb release. The database has three
  pages in that column, Overview, Storage and Tools, each with its cards side
  by side where the window is wide enough.
- **A side pane beside the list:** the document, Explain and Statement are
  its tabs; Side pane in the toolbar shows or hides it, and its left edge
  makes it wider or narrower, both kept for the next start. Explain reads
  only while its tab is in front. Hidden, the pane keeps an unsaved document;
  the editor has no Close, and a new document is dropped with Discard. With
  much open above the list, the documents column scrolls on its own and the
  window stays put.
- **trunkdb 0.40.0** instead of 0.30.0: file format 17, which the app's
  0.1.0 can't open once this version has opened a file for editing. Among
  what comes with it: other programs read a file while it is open here for
  editing, and write to one open here read-only, which reads what they wrote;
  a read under way when they write says the data changed, and a refused open
  for editing offers Open read-only. trunkdb keeps four lock files beside each
  database (`.writer`, `.readers`, `.gate`, `.letgo`); an import removes those
  of its temporary database, and an export never writes over them. A
  write-ahead log that belongs to another copy of the file is refused with
  its own message, nothing replayed. Also: a sorted page that isn't full
  reads each document once, where it read the collection a second time,
  after a compaction counts what each index leaves out; and a compaction that
  frees no space still writes those counts. Exports end with a line counting
  what they hold, which an import checks.
- **Asking before a format upgrade:** opening a file of an older format for
  editing first says which format it has, which trunkdb last wrote it, and
  that older trunkdb releases can't open it once it is upgraded, offering
  Open read-only instead. Nothing upgrades a file without that answer.
- **Filter rows:** `starts with`, `is one of` / `is none of` (trunkdb's `in`
  and `not in`), and `is of kind` / `is not of kind`; text with these turns
  into rows and back.
- **Index hints:** Explain lists the plans trunkdb passed over and how many
  index entries each would read; Use reads the page that way, and the hint is
  shown above the list until trunkdb is let choose again. The copied command
  and the statement carry it.
- **Groups:** distinct counts, the first or last value of a group (by ID or
  ordered by a field), and unwinding arrays to count their elements; a group's
  documents are those with such an element.
- **Columns:** hide fields from whole documents instead of choosing the rest.
- The browser preview's sample data names trunkdb 0.40.0 and file format 17.
- **Layout:** the table shows IDs by their start and end, the whole ID in the
  tooltip; the Groups view hides the list's sort, and says to run groups
  before Explain; the collection header no longer moves while field paths are
  read.
- **Look:** buttons carry icons beside their text (Lucide); selects are flat
  like the text fields, with the same height, border and arrow in both
  appearances.
- **For UI tests:** a separate test build with a WebDriver server inside
  (`npm run build:wdio-test`, never shipped), and `scripts/wdio-fixture.sh` to
  start it on a fresh sample database without the file dialog.

## 0.1.0 — 2026-11-02

The first public release, with trunkdb 0.30.0 (tag `v0.30.0`).

- **Databases:** open, create, or open read-only; recent files on the start
  screen, with files that are gone marked as such.
- **Overview:** collections with document counts and indexes, the file format
  and the trunkdb releases that created and last wrote the file, and storage
  statistics with what compacting would free.
- **Browsing:** a collection as JSON or as a table, sorted and paged by
  trunkdb, with chosen columns; nested fields included.
- **Filters:** typed rows, or trunkdb's filter language as text, switching
  between the two where rows can show the filter; the list copied as a
  `trunkdb find` command.
- **Groups:** documents counted per value of up to three fields, with sums,
  averages, minimums and maximums and a condition per column; each group's
  documents one click away.
- **Explain and Statement:** how trunkdb ran what is shown, and the Rust calls
  that make it.
- **Editing:** a JSON editor that keeps the text as typed; insert, edit and
  delete documents; Save / Discard / Cancel before any unsaved change is lost,
  including a quit from the Dock or at logout.
- **Indexes:** single, compound, unique and sparse; created and dropped.
- **Field paths:** counted over every document, suggested in every path input.
- **Maintenance:** consistency check, export to JSON Lines, compaction, and
  importing an export into a new database.
- **Appearance:** light, dark, or following the system.
