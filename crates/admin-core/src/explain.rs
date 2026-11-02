//! How the page of a collection the list shows is read (trunkdb SPEC §94):
//! the same query, run by `explain_run` instead of `find`.

use crate::error::AppResult;
use crate::query::QueryRequest;
use crate::session::Session;
use serde::Serialize;
use trunkdb::Document;
use trunkdb::query::{Explained, QueryPlan};

/// The kind of plan trunkdb chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanKind {
    /// Every document read and checked.
    Scan,
    /// Documents looked up by their IDs.
    ById,
    /// One index range read.
    Index,
    /// One range per branch of an OR.
    IndexUnion,
    /// An index walked in sort order until the page is full.
    IndexOrder,
    /// A plan from a later trunkdb.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexReadReport {
    /// `_id` for the primary index, `(a, b)` for a compound one.
    pub index: String,
    /// The conditions the read is bounded by, in trunkdb's filter text
    /// (its SPEC §111), as a filter would be typed; empty: the whole index.
    pub bounds: Vec<String>,
    pub backward: bool,
    pub entries: u64,
    /// Its entries decided which documents match (trunkdb SPEC §100):
    /// documents were read only where the page needed them.
    pub covering: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SortReport {
    /// Sort keys the index order gives.
    pub from_index: usize,
    /// Sort keys sorted in memory.
    pub in_memory: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExplainReport {
    pub request_id: u64,
    pub plan: PlanKind,
    pub reads: Vec<IndexReadReport>,
    pub sort: Option<SortReport>,
    /// What the page query passes over and asks for.
    pub skip: usize,
    pub limit: usize,
    pub keys_examined: u64,
    pub documents_examined: u64,
    /// The skipped included.
    pub documents_matched: u64,
    pub documents_returned: u64,
    /// Matches taken from their index entries, their documents not read
    /// (trunkdb SPEC §106.5, §107.5).
    pub from_entries: u64,
    /// The groups made, for groups (trunkdb SPEC §107.6); None for a
    /// page of documents.
    pub groups: Option<u64>,
    /// Wall-clock; a second run is usually faster, from the page cache.
    pub elapsed_micros: u64,
}

impl Session {
    /// Runs the page `request` asks for as `query` would, and says how
    /// trunkdb read it. The page is taken as given: `query` has already
    /// moved a page past the end to the last one.
    pub fn explain(&self, request: &QueryRequest) -> AppResult<ExplainReport> {
        let filter = request.page_filter(request.conditions()?, request.page)?;
        let (skip, limit) = (request.page * request.page_size, request.page_size);
        let explained = self.read(|database| {
            Ok(database
                .collection::<Document>(&request.collection)
                .explain_run(filter)?)
        })?;
        Ok(ExplainReport::new(
            request.request_id,
            skip,
            limit,
            explained,
            false,
        ))
    }
}

impl ExplainReport {
    pub(crate) fn new(
        request_id: u64,
        skip: usize,
        limit: usize,
        explained: Explained,
        groups: bool,
    ) -> Self {
        let plan = match explained.plan {
            QueryPlan::Scan => PlanKind::Scan,
            QueryPlan::ById => PlanKind::ById,
            QueryPlan::Index { .. } => PlanKind::Index,
            QueryPlan::IndexUnion { .. } => PlanKind::IndexUnion,
            QueryPlan::IndexOrder { .. } => PlanKind::IndexOrder,
            // `QueryPlan` is non-exhaustive.
            _ => PlanKind::Other,
        };
        let stats = explained.stats;
        Self {
            request_id,
            plan,
            reads: explained
                .reads
                .iter()
                .map(|read| IndexReadReport {
                    index: read.index.clone(),
                    bounds: read.bounds.iter().map(ToString::to_string).collect(),
                    backward: read.backward,
                    entries: read.entries,
                    covering: read.covering,
                })
                .collect(),
            sort: explained.sort.map(|sort| SortReport {
                from_index: sort.from_index,
                in_memory: sort.in_memory,
            }),
            skip,
            limit,
            keys_examined: stats.keys_examined,
            documents_examined: stats.documents_examined,
            documents_matched: stats.documents_matched,
            documents_returned: stats.documents_returned,
            from_entries: stats.from_entries,
            groups: groups.then_some(stats.groups),
            elapsed_micros: u64::try_from(stats.elapsed.as_micros()).unwrap_or(u64::MAX),
        }
    }
}
