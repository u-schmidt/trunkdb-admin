//! Where a database's space goes (trunkdb SPEC §93), for the overview.
//! Read on request, not with every overview: it reads every page in use.

use crate::error::AppResult;
use crate::session::Session;
use serde::Serialize;

/// The file's pages by what they hold; they add up to the file's pages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageUse {
    pub header: u64,
    pub catalog: u64,
    pub free: u64,
    pub data: u64,
    pub overflow: u64,
    pub index: u64,
    /// Claimed by nothing: a leak, which a consistency check names.
    pub unaccounted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexStorage {
    /// `["_id"]` for the primary index.
    pub fields: Vec<String>,
    pub entries: u64,
    pub pages: u64,
    pub depth: u32,
    pub key_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionStorage {
    pub name: String,
    pub documents: u64,
    pub data_pages: u64,
    pub overflow_pages: u64,
    /// The documents as stored (encoded).
    pub document_bytes: u64,
    /// Room left inside its data pages.
    pub free_bytes: u64,
    /// The primary index first, then the secondary ones.
    pub indexes: Vec<IndexStorage>,
}

/// What the open restored from the write-ahead log after an unclean
/// shutdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Recovery {
    pub pages: u64,
    /// A read-only open (trunkdb SPEC §88): the pages are kept in memory,
    /// the file and its WAL unchanged; the next open for editing writes
    /// them back.
    pub in_memory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StorageReport {
    pub page_size: u64,
    pub pages: u64,
    pub page_use: PageUse,
    /// What a compaction would leave, worked out exactly by trunkdb.
    pub compacted_pages: u64,
    /// `None` when there is no write-ahead log file.
    pub wal_bytes: Option<u64>,
    pub recovered: Option<Recovery>,
    /// Persisted collections, by name.
    pub collections: Vec<CollectionStorage>,
}

impl Session {
    /// trunkdb's storage statistics, on one snapshot.
    pub fn storage(&self) -> AppResult<StorageReport> {
        let stats = self.read(|database| Ok(database.stats()?))?;
        let index = |index: &trunkdb::IndexStats| IndexStorage {
            fields: index.fields.clone(),
            entries: index.entries,
            pages: index.pages,
            depth: index.depth,
            key_bytes: index.key_bytes,
        };
        Ok(StorageReport {
            page_size: stats.file.page_size as u64,
            pages: stats.file.pages,
            page_use: PageUse {
                header: stats.pages.header,
                catalog: stats.pages.catalog,
                free: stats.pages.free,
                data: stats.pages.data,
                overflow: stats.pages.overflow,
                index: stats.pages.index,
                unaccounted: stats.pages.unaccounted,
            },
            compacted_pages: stats.compacted_pages_estimate(),
            wal_bytes: stats.wal_bytes,
            recovered: stats.recovered.map(|recovered| Recovery {
                pages: recovered.pages,
                in_memory: recovered.in_memory,
            }),
            collections: stats
                .collections
                .iter()
                .map(|collection| CollectionStorage {
                    name: collection.name.clone(),
                    documents: collection.documents,
                    data_pages: collection.data_pages,
                    overflow_pages: collection.overflow_pages,
                    document_bytes: collection.document_bytes,
                    free_bytes: collection.free_bytes,
                    indexes: std::iter::once(&collection.primary)
                        .chain(&collection.indexes)
                        .map(index)
                        .collect(),
                })
                .collect(),
        })
    }
}
