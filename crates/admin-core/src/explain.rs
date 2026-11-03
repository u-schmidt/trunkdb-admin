//! How the page of a collection the list shows is read (trunkdb SPEC §94):
//! the same query, run by `explain_run` instead of `find`.

use crate::error::AppResult;
use crate::indexes::index_name;
use crate::query::{HintInput, QueryRequest};
use crate::session::Session;
use serde::Serialize;
use trunkdb::Document;
use trunkdb::query::{EntryCount, Explained, QueryPlan};

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

/// A plan trunkdb passed over (its SPEC §133): what the same query,
/// hinted to one index, would have read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AlternativeReport {
    pub plan: PlanKind,
    /// The indexes it reads, named as `IndexReadReport::index`; empty
    /// for a scan and a lookup by ID.
    pub indexes: Vec<String>,
    /// The index entries it would read, every read together.
    pub entries: u64,
    /// `entries` is a lower bound: trunkdb stopped counting there.
    pub more_than: bool,
    /// It would read a document per entry to check it; false where the
    /// entries decide the filter.
    pub reads_documents: bool,
    /// It would read fewer entries than the query did.
    pub fewer: bool,
    /// The hint that makes the page read this way; None where no hint
    /// names it.
    pub hint: Option<HintInput>,
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
    /// The plan is the one the request's hint asked for.
    pub hinted: bool,
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
    /// The plans passed over, for a page of documents; empty for groups.
    pub alternatives: Vec<AlternativeReport>,
}

impl Session {
    /// Runs the page `request` asks for as `query` would, and says how
    /// trunkdb read it. The page is taken as given: `query` has already
    /// moved a page past the end to the last one.
    pub fn explain(&self, request: &QueryRequest) -> AppResult<ExplainReport> {
        let filter = request.page_filter(request.conditions()?, request.page)?;
        let (skip, limit) = (request.page * request.page_size, request.page_size);
        let (explained, indexes) = self.read(|database| {
            let collection = database.collection::<Document>(&request.collection);
            let indexes: Vec<Vec<String>> = (collection.indexes()?.iter())
                .map(|index| index.fields().to_vec())
                .collect();
            Ok((collection.explain_run(filter)?, indexes))
        })?;
        let hint_for = |name: &str| -> Option<HintInput> {
            if name == "_id" {
                return Some(HintInput::Index {
                    fields: vec!["_id".to_string()],
                });
            }
            (indexes.iter())
                .find(|fields| index_name(fields) == name)
                .map(|fields| HintInput::Index {
                    fields: fields.clone(),
                })
        };
        let WithPlans { mut report, plans } =
            ExplainReport::build(request.request_id, skip, limit, explained, false);
        for (alternative, plan) in report.alternatives.iter_mut().zip(&plans) {
            alternative.hint = match plan {
                QueryPlan::Scan => Some(HintInput::NoIndex),
                QueryPlan::ById => hint_for("_id"),
                _ => match alternative.indexes.as_slice() {
                    [first, rest @ ..] if rest.iter().all(|name| name == first) => hint_for(first),
                    _ => None,
                },
            };
        }
        Ok(report)
    }
}

impl ExplainReport {
    /// The report, and the plan of each alternative, in order, for the
    /// caller to name its hint.
    pub(crate) fn build(
        request_id: u64,
        skip: usize,
        limit: usize,
        explained: Explained,
        groups: bool,
    ) -> WithPlans {
        let plan = PlanKind::of(&explained.plan);
        let stats = explained.stats;
        let plans: Vec<QueryPlan> = (explained.alternatives.iter())
            .map(|alternative| alternative.plan.clone())
            .collect();
        let alternatives = (explained.alternatives.iter())
            .map(|alternative| AlternativeReport {
                plan: PlanKind::of(&alternative.plan),
                indexes: index_names(&alternative.plan),
                entries: alternative.entries.at_least(),
                more_than: matches!(alternative.entries, EntryCount::MoreThan(_)),
                reads_documents: alternative.reads_documents,
                fewer: alternative.fewer,
                hint: None,
            })
            .collect();
        let report = Self {
            request_id,
            plan,
            hinted: explained.hinted,
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
            alternatives,
        };
        WithPlans { report, plans }
    }
}

/// A report with the trunkdb plans of its alternatives.
pub(crate) struct WithPlans {
    pub(crate) report: ExplainReport,
    pub(crate) plans: Vec<QueryPlan>,
}

impl PlanKind {
    fn of(plan: &QueryPlan) -> Self {
        match plan {
            QueryPlan::Scan => PlanKind::Scan,
            QueryPlan::ById => PlanKind::ById,
            QueryPlan::Index { .. } => PlanKind::Index,
            QueryPlan::IndexUnion { .. } => PlanKind::IndexUnion,
            QueryPlan::IndexOrder { .. } => PlanKind::IndexOrder,
            // `QueryPlan` is non-exhaustive.
            _ => PlanKind::Other,
        }
    }
}

/// The indexes a plan reads.
fn index_names(plan: &QueryPlan) -> Vec<String> {
    match plan {
        QueryPlan::Index { field, .. } | QueryPlan::IndexOrder { field, .. } => vec![field.clone()],
        QueryPlan::IndexUnion { fields, .. } => fields.clone(),
        _ => Vec::new(),
    }
}
