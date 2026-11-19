//! Change signals for a list: a live query on the list's filter, whose
//! reports say the documents it shows changed. Nothing is rendered from
//! the reports; the caller runs the list's query again.
//!
//! A query holds no database handle, only the receiving end of a channel,
//! so it doesn't keep a session's file open. It ends when the database is
//! dropped, and says so through `Wait::Ended`.

use crate::error::{AppError, AppResult, ErrorCategory};
use crate::query::FilterInput;
use crate::session::Session;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use trunkdb::{Document, LiveQuery};

/// How long one wait lasts before the thread looks whether to stop.
const STOP_CHECK: Duration = Duration::from_millis(250);
/// Reports closer together than this are one burst.
const SETTLE: Duration = Duration::from_millis(150);
/// A burst that never settles still signals after this long.
const MOST_WAIT: Duration = Duration::from_secs(1);

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
                .map_err(AppError::from)?;
            Ok(ListWatch { query })
        })
    }
}

/// Calls `on_change` once for each burst of changes to a list, on its own
/// thread, until it is dropped or its database is.
pub struct ListWatcher {
    stop: Arc<AtomicBool>,
}

impl ListWatcher {
    /// Starts watching the list `collection` and `filter` show. The first
    /// reports are the documents already there, so `on_change` may come
    /// once soon after, for a list the caller has just loaded.
    pub fn start(
        session: &Session,
        collection: &str,
        filter: &FilterInput,
        on_change: impl Fn() + Send + 'static,
    ) -> AppResult<Self> {
        let watch = session.watch_list(collection, filter)?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("list-watch".into())
            .spawn(move || run(watch, &flag, on_change))
            .map_err(|error| {
                AppError::new(
                    ErrorCategory::Internal,
                    "The list could not start watching.",
                )
                .with_detail(error.to_string())
            })?;
        Ok(Self { stop })
    }
}

impl Drop for ListWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn run(watch: ListWatch, stop: &AtomicBool, on_change: impl Fn()) {
    while !stop.load(Ordering::Relaxed) {
        match watch.wait(STOP_CHECK) {
            Wait::Quiet => {}
            Wait::Ended => return,
            Wait::Changed => {
                // Let the burst settle, then signal once.
                let started = Instant::now();
                let mut ended = false;
                while started.elapsed() < MOST_WAIT {
                    match watch.wait(SETTLE) {
                        Wait::Changed => {}
                        Wait::Quiet => break,
                        Wait::Ended => {
                            ended = true;
                            break;
                        }
                    }
                }
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                on_change();
                if ended {
                    return;
                }
            }
        }
    }
}
