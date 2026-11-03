//! Cross-checks against the `trunkdb` command built from the pinned
//! revision, run as a separate process: what the
//! tool wrote is what trunkdb's own program reads, and the file lock holds
//! between processes exactly while a session is open.
//!
//! Ignored by default because they need that binary:
//!
//!     scripts/install-pinned-cli.sh
//!     cargo test -p trunkdb-admin-core --test cli -- --ignored
//!
//! or `npm run test:cli`, which does both.

mod common;

use common::Fixture;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, mpsc};
use trunkdb_admin_core::{FilterInput, IndexRequest, SaveRequest};

fn cli_path() -> PathBuf {
    std::env::var_os("TRUNKDB_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/pinned-cli/bin/trunkdb")
        })
}

fn cli(args: &[&str]) -> Output {
    let path = cli_path();
    assert!(
        path.is_file(),
        "no trunkdb CLI at {}: run scripts/install-pinned-cli.sh",
        path.display()
    );
    Command::new(path).args(args).output().unwrap()
}

fn stdout(output: &Output) -> String {
    assert!(
        output.status.success(),
        "trunkdb failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn assert_locked(path: &str) {
    for command in ["info", "check", "export", "compact"] {
        let output = cli(&[command, path]);
        assert!(
            !output.status.success(),
            "`trunkdb {command}` got in while the tool holds the file"
        );
        let message = String::from_utf8_lossy(&output.stderr);
        assert!(
            message.contains("in use by another program"),
            "{command}: {message}"
        );
    }
}

fn save(id: Option<&str>, json: &str) -> SaveRequest {
    SaveRequest {
        collection: "people".to_string(),
        id: id.map(str::to_string),
        json: json.to_string(),
        filter: FilterInput::default(),
    }
}

#[test]
#[ignore = "needs the pinned trunkdb CLI: run scripts/install-pinned-cli.sh"]
fn the_cli_reads_what_the_tool_inserted_edited_and_deleted() {
    let mut fx = Fixture::new();
    let path = fx.path.to_str().unwrap().to_string();

    // Insert, without an ID.
    let id = fx
        .session
        .save_document(&save(
            None,
            r#"{"name": "Ann", "big": 9223372036854775807, "ratio": 2.0}"#,
        ))
        .unwrap()
        .document
        .id;
    assert_locked(&path);
    fx.manager.close(fx.session.id()).unwrap();

    let exported = stdout(&cli(&["export", &path]));
    assert!(
        exported.contains(&format!(r#""_id":{{"$id":"{id}"}}"#)),
        "{exported}"
    );
    assert!(
        exported.contains(r#""name":"Ann","big":9223372036854775807,"ratio":2.0"#),
        "{exported}"
    );
    assert!(stdout(&cli(&["info", &path])).contains("people"));
    stdout(&cli(&["check", &path]));

    // Edit, through a new session.
    fx.session = fx.manager.open_existing(&fx.path).unwrap();
    fx.session
        .save_document(&save(Some(&id), r#"{"name": "Ann B.", "tags": ["x"]}"#))
        .unwrap();
    fx.reopen();
    assert_locked(&path);
    fx.manager.close(fx.session.id()).unwrap();

    let exported = stdout(&cli(&["export", &path]));
    assert!(
        exported.contains(&format!(
            r#"{{"_id":{{"$id":"{id}"}},"name":"Ann B.","tags":["x"]}}"#
        )),
        "{exported}"
    );
    assert!(
        !exported.contains("ratio"),
        "a field removed in the editor is gone"
    );

    // Delete.
    fx.session = fx.manager.open_existing(&fx.path).unwrap();
    fx.session.delete_document("people", &id).unwrap();
    fx.manager.close(fx.session.id()).unwrap();

    let exported = stdout(&cli(&["export", &path]));
    assert!(!exported.contains(&id), "{exported}");
    stdout(&cli(&["check", &path]));
}

#[test]
#[ignore = "needs the pinned trunkdb CLI: run scripts/install-pinned-cli.sh"]
fn another_process_gets_in_only_after_close_even_with_work_still_running() {
    let fx = Fixture::new();
    let path = fx.path.to_str().unwrap().to_string();
    fx.insert("people", &[r#"{"name": "Ann"}"#]);
    assert_locked(&path);

    // A command still working when the close is requested.
    let (started_tx, started_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel::<()>();
    let worker = std::thread::spawn({
        let session = Arc::clone(&fx.session);
        move || {
            session.read(|db| {
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(db.collections()?)
            })
        }
    });
    started_rx.recv().unwrap();
    let manager = Arc::new(fx.manager);
    let closer = std::thread::spawn({
        let manager = Arc::clone(&manager);
        let id = fx.session.id().to_string();
        move || manager.close(&id).unwrap()
    });
    std::thread::sleep(std::time::Duration::from_millis(150));

    assert_locked(&path);

    finish_tx.send(()).unwrap();
    closer.join().unwrap();
    worker.join().unwrap().unwrap();
    assert!(stdout(&cli(&["info", &path])).contains("people"));

    // And after "quit": every session closed at once.
    let reopened = manager.open_existing(Path::new(&path)).unwrap();
    assert_locked(&path);
    drop(reopened);
    manager.close_all();
    stdout(&cli(&["check", &path]));
}

#[test]
#[ignore = "needs the pinned trunkdb CLI: run scripts/install-pinned-cli.sh"]
fn the_cli_imports_the_tools_export_into_an_identical_database() {
    let fx = Fixture::new();
    fx.insert(
        "people",
        &[
            r#"{"name": "Ann", "n": 9223372036854775807, "f": 2.0, "at": {"$date": "2026-03-01T12:00:00Z"}}"#,
            r#"{"name": "Bo", "bytes": {"$binary": "AAEC"}, "nan": {"$float": "NaN"}, "tag_like": {"$object": {"$id": "x"}}}"#,
        ],
    );
    fx.insert(
        "mixed",
        &[
            r#"{"v": [1, 2]}"#,
            r#"{"v": "text"}"#,
            r#"{"v": 2.0}"#,
            r#"{"v": null}"#,
        ],
    );
    fx.session
        .create_index(&index("people", &["name"], true, false))
        .unwrap();
    fx.session
        .create_index(&index("people", &["name", "n"], false, true))
        .unwrap();
    let out = fx.dir.path().join("tool-export.jsonl");
    fx.session.export(&out, false).unwrap();
    fx.manager.close(fx.session.id()).unwrap();
    let path = fx.path.to_str().unwrap();

    let copy = fx.dir.path().join("copy.trunkdb");
    let copy = copy.to_str().unwrap();
    stdout(&cli(&["import", copy, out.to_str().unwrap()]));

    // The CLI's own export of both files, and the tool's, are the same bytes.
    let original = stdout(&cli(&["export", path]));
    assert_eq!(stdout(&cli(&["export", copy])), original);
    assert_eq!(std::fs::read_to_string(&out).unwrap(), original);
    assert!(original.contains(r#""unique":true"#) && original.contains(r#""sparse":true"#));
    stdout(&cli(&["check", copy]));
}

fn index(collection: &str, fields: &[&str], unique: bool, sparse: bool) -> IndexRequest {
    IndexRequest {
        collection: collection.to_string(),
        fields: fields.iter().map(|field| field.to_string()).collect(),
        unique,
        sparse,
    }
}

#[test]
#[ignore = "needs the pinned trunkdb CLI: run scripts/install-pinned-cli.sh"]
fn a_read_only_session_shares_the_file_with_reading_commands_only() {
    let mut fx = Fixture::new();
    let path = fx.path.to_str().unwrap().to_string();
    fx.insert("people", &[r#"{"name": "Ann"}"#]);
    fx.manager.close(fx.session.id()).unwrap();
    fx.session = fx.manager.open_read_only(&fx.path).unwrap();

    // trunkdb's reading commands open read-only too, so they get in.
    assert!(stdout(&cli(&["info", &path])).contains("people"));
    stdout(&cli(&["check", &path]));
    assert!(stdout(&cli(&["export", &path])).contains("Ann"));
    // A command that writes does not.
    let compact = cli(&["compact", &path]);
    assert!(!compact.status.success(), "`trunkdb compact` got in");
    let message = String::from_utf8_lossy(&compact.stderr);
    assert!(message.contains("in use by another program"), "{message}");

    fx.manager.close(fx.session.id()).unwrap();
    stdout(&cli(&["compact", &path]));
}

#[test]
#[ignore = "needs the pinned trunkdb CLI: run scripts/install-pinned-cli.sh"]
fn the_copied_command_finds_what_the_list_shows() {
    use trunkdb_admin_core::{QueryRequest, SortInput};

    let mut fx = Fixture::new();
    let mut names: Vec<String> = Vec::new();
    for n in 0..40 {
        names.push(format!(
            r#"{{"name": "n{n:02}", "n": {n}, "tag": "{}"}}"#,
            ["a", "b", "it's"][n % 3]
        ));
    }
    fx.insert(
        "people",
        &names.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    fx.manager.close(fx.session.id()).unwrap();
    // `trunkdb find` opens read-only, so it runs beside a read-only session.
    fx.session = fx.manager.open_read_only(&fx.path).unwrap();

    let request = QueryRequest {
        request_id: 1,
        collection: "people".into(),
        filter: FilterInput::Text(r#"tag = "it's" or n >= 35"#.into()),
        sort: SortInput {
            field: "name".into(),
            descending: true,
        },
        page: 0,
        page_size: 1000,
        select: Some(vec!["name".into()]),
        except: Vec::new(),
        hint: None,
    };
    let listed: Vec<String> = fx
        .session
        .query(&request)
        .unwrap()
        .rows
        .iter()
        .map(|row| row.id.clone())
        .collect();
    assert!(listed.len() > 10);

    let command = fx.session.find_command(&request).unwrap();
    let cli = cli_path().display().to_string();
    let shell = command.replacen("trunkdb", &format!("'{cli}'"), 1);
    let output = Command::new("sh").arg("-c").arg(&shell).output().unwrap();
    let found: Vec<String> = stdout(&output)
        .lines()
        .map(|line| {
            let document: trunkdb::Document = line.parse().unwrap();
            let trunkdb::Document::Object(fields) = document else {
                panic!("{line}")
            };
            assert_eq!(fields.len(), 2, "only _id and the chosen name: {line}");
            match fields.get("_id") {
                Some(trunkdb::Document::Id(id)) => id.to_string(),
                _ => panic!("{line}"),
            }
        })
        .collect();
    assert_eq!(found, listed, "{command}");
}

#[test]
#[ignore = "needs the pinned trunkdb CLI: run scripts/install-pinned-cli.sh"]
fn the_admin_imports_what_the_cli_exported_into_an_equal_database() {
    let fx = Fixture::new();
    fx.insert(
        "people",
        &[
            r#"{"name": "Ann", "n": 9223372036854775807, "f": 2.0, "meta": {"k": [1, 2.5]}}"#,
            r#"{"name": "Bo", "bytes": {"$binary": "AAEC"}, "at": {"$date": "2026-03-01T12:00:00Z"}}"#,
        ],
    );
    fx.session
        .create_index(&index("people", &["name"], true, false))
        .unwrap();
    let path = fx.path.to_str().unwrap().to_string();
    fx.manager.close(fx.session.id()).unwrap();

    let exported = stdout(&cli(&["export", &path]));
    let export = fx.dir.path().join("cli.jsonl");
    std::fs::write(&export, &exported).unwrap();
    let copy = fx.dir.path().join("copy.trunkdb");
    let summary = fx.manager.import_into_new(&export, &copy).unwrap();
    assert_eq!((summary.collections, summary.documents), (1, 2));

    // The copy, exported again by the CLI, is what was exported.
    let again = stdout(&cli(&["export", copy.to_str().unwrap()]));
    assert_eq!(again, exported);
}

#[test]
#[ignore = "needs the pinned trunkdb CLI: run scripts/install-pinned-cli.sh"]
fn field_paths_are_what_trunkdb_fields_lists() {
    use trunkdb_admin_core::FieldPathsRequest;

    let fx = Fixture::new();
    fx.insert(
        "things",
        &[
            r#"{"name": "a", "tags": ["x", 3], "a.b": {"c": 1}, "first name": "z", "items": [{"sku": "A1", "at": {"$date": "2026-03-01T12:00:00Z"}}], "grid": [[1.5, 2]]}"#,
            r#"{"name": null, "tags": [], "items": [{"sku": null}], "bytes": {"$binary": "AAE="}}"#,
            r#"{"other": {"$id": "01890000-0000-7000-8000-000000000001"}}"#,
        ],
    );
    let ours = fx
        .session
        .field_paths(&FieldPathsRequest {
            request_id: 1,
            collection: "things".into(),
        })
        .unwrap();
    let path = fx.path.to_str().unwrap().to_string();
    fx.manager.close(fx.session.id()).unwrap();

    let words = |line: &str| line.split_whitespace().collect::<Vec<_>>().join(" ");
    let theirs: Vec<String> = stdout(&cli(&["fields", &path, "things"]))
        .lines()
        .map(words)
        .collect();
    let ours: Vec<String> = ours
        .paths
        .iter()
        .map(|p| {
            let text = match p.nameable {
                true => p.text.clone(),
                false => format!("{} (no path can name it)", p.text),
            };
            let kinds: Vec<String> = (p.kinds.iter())
                .map(|k| {
                    let name = match format!("{:?}", k.kind).to_lowercase().as_str() {
                        "datetime" => "date".to_string(),
                        other => other.to_string(),
                    };
                    format!("{name} {}", k.documents)
                })
                .collect();
            words(&format!("{text} {} {}", p.documents, kinds.join(", ")))
        })
        .collect();
    assert_eq!(ours, theirs);
}
