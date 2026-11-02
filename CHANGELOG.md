# Changelog

What changed in each release of TrunkDB Admin, newest first. Each release is
tagged `vX.Y.Z` and names the trunkdb release it bundles.

## 0.1.0 — unreleased

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
