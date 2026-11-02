//! Shared fixtures: every test gets its own temporary database.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use trunkdb::{DocId, Document};
use trunkdb_admin_core::{Session, SessionManager};

pub struct Fixture {
    pub dir: TempDir,
    pub path: PathBuf,
    pub manager: SessionManager,
    pub session: Arc<Session>,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.trunkdb");
        let manager = SessionManager::new();
        let session = manager.create_new(&path).unwrap();
        Self {
            dir,
            path,
            manager,
            session,
        }
    }

    /// Inserts tagged-JSON documents and returns their IDs in order.
    pub fn insert(&self, collection: &str, documents: &[&str]) -> Vec<DocId> {
        self.session
            .write(|db| {
                let target = db.collection::<Document>(collection);
                let mut ids = Vec::new();
                for text in documents {
                    ids.push(target.insert(doc(text))?);
                }
                Ok(ids)
            })
            .unwrap()
    }

    /// Closes the session and opens the same file in a new one.
    pub fn reopen(&mut self) {
        self.manager.close(self.session.id()).unwrap();
        self.session = self.manager.open_existing(&self.path).unwrap();
    }
}

pub fn doc(text: &str) -> Document {
    text.parse()
        .unwrap_or_else(|error| panic!("bad fixture JSON {text}: {error}"))
}
