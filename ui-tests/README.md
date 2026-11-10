# TrunkDB Admin UI tests

A GroundworkTH test project:
tests written as sentences, which a model turns into actions on the
running app. They cover what the Rust and frontend tests can't reach: the
app as a whole, its native panels, menus, quitting and restarting.

- `groundwork.config.json` — the project: the app's test build, how to
  build it, and the fresh start before every test (`prepare.sh`:
  `../scripts/wdio-fixture.sh`, a new sample database and
  recent-files list, plus a recent entry `gone.trunkdb` whose file is
  missing).
- `testcases/` — one test per file; `"expectedResult": "fail"` marks a
  negative control, a claim that is false on purpose.
- `stepgroups/` — steps several tests share, used as `@name`.
- `suites/` — named selections of tests. `admin-edge` is what no other
  test of the app reaches: the native panels, the quit paths and the Dock,
  the lock seen from another process, real keystrokes in the editor, dark
  mode as drawn, and a restart; for after a Tauri, plugin, trunkdb or
  macOS upgrade. `admin-smoke` is a quick pass over the page.
- `run.sh` — `groundwork run` on this project.

## Running

GroundworkTH checked out beside this repository, as `groundwork-th-public`
(or `GROUNDWORK_TH` pointing to it), with `npm install` done there and a
model chosen once with `groundwork init`; macOS, since the app's test build
and the helper below are macOS only.
Many tests reach beyond the page — the open and save panels, the menu bar,
⌘Q, the Dock's Quit, a restart — through groundwork's macOS helper
(`npm run build:native` there, then allow Groundwork macOS Helper under
Accessibility and Screen Recording); the tests about how something looks
need a vision model as well (`groundwork init --vision-model …`).
Some tests check the database afterwards with the app's pinned trunkdb CLI
(`npm run test:cli` in the repository builds it): `trunkdb info` says it is in use while
the app has it open, `trunkdb count` sees what a save or quit left. A run brings the app to the
front and types into it, and the copy/paste test writes the clipboard.

```bash
cd ui-tests
../../groundwork-th-public/bin/groundwork.mjs dashboard   # opens this project
../../groundwork-th-public/bin/groundwork.mjs build       # the admin's test build
./run.sh                                           # all tests, as one run
./run.sh admin-overview                            # just these
./run.sh --suite admin-smoke
./run.sh --suite admin-edge                        # after an upgrade
```

The run history is kept outside this repository, in groundwork's data
folder (`groundwork list` names it).

## The sample, as the cases rely on it

`people`: 137 documents; `address.city` Berlin, Bonn and Bremen in turn
(46 in Berlin); `name` repeats five names, with a plain index on it;
`score` repeats, with no index; `note` is a stored null in 35 documents
and missing in the other 102. trunkdb's `note = null` finds both (its
§32), so a stored null is `note` exists and is null. `mixed`: 9 documents of every kind of
value. `empty`: no documents, an index on `anything`. A unique index on
`name` is refused because the plain one exists ("already exists with other
options"); the duplicate-value refusal is shown on `score`.

The export save panel adds `.jsonl` to any name, so the database file
can't be chosen as the destination: `sample.trunkdb` becomes
`sample.trunkdb.jsonl`. The refusal itself is covered by the Rust tests.

## Results

Traces and reports go to groundwork's data folder. Each test's fixture
is removed when the test is done; the runner's logs are kept, in a
temporary folder `run.sh` prints, only when a test went wrong. No result
is kept in this repository.
