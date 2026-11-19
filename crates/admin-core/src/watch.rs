//! Change signals for a list (spike): a live query on the list's filter,
//! whose reports say the documents it shows changed. Nothing is
//! rendered from the reports; the caller runs the list's query again.
//!
//! A query holds no database handle, only the receiving end of a channel,
//! so it doesn't keep a session's file open. It ends when the database is
//! dropped, and says so through `Wait::Ended`.

use crate::error::AppResult;
use crate::query::FilterInput;
use crate::session::Session;
use std::time::Duration;
use trunkdb::{Document, LiveQuery};

/// What a wait for the list's changes found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// A document the list shows came, went or changed.
    Changed,
    /// Nothing came within the time asked.
    Quiet,
    /// The watch has ended: its database was dropped.
    Ended,
}

/// A live query on a collection's documents matching a list's filter.
pub struct ListWatch {
    query: LiveQuery<Document>,
}

impl ListWatch {
    /// Waits at most `timeout` for a report.
    pub fn wait(&self, timeout: Duration) -> Wait {
        match self.query.recv_timeout(timeout) {
            Some(Ok(_)) => Wait::Changed,
            // An error ends the watch the same way a dropped database does.
            Some(Err(_)) => Wait::Ended,
            None if self.query.has_ended() => Wait::Ended,
            None => Wait::Quiet,
        }
    }
}

impl Session {
    /// Watches the documents of `collection` that `filter` finds, from now
    /// on. The first reports are the documents already there; a caller
    /// that runs the list first sees them as a change it already shows.
    pub fn watch_list(&self, collection: &str, filter: &FilterInput) -> AppResult<ListWatch> {
        let filter = filter.filter()?;
        self.read(|database| {
            let query = database
                .collection::<Document>(collection)
                .watch(filter)
                .map_err(crate::error::AppError::from)?;
            Ok(ListWatch { query })
        })
    }
}
