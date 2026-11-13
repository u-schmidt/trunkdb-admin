# Test fixtures

- `written-by-0.24.0.trunkdb`: a database trunkdb 0.24.0 wrote, file format
  12, copied unchanged from trunkdb's own `tests/fixtures/0.24.0/trunkdb.db`
  (tag `v0.40.0`). The tests copy it into a temporary folder before opening
  it, never opening it in place: an open for editing would raise its format.
