//! What a database contains: its collections with counts and indexes, and
//! the session's not-yet-stored virtual collections.

use crate::error::{AppError, AppResult, ErrorCategory};
use crate::session::{FileInfo, Session};
use serde::Serialize;
use trunkdb::query::Filter;
use trunkdb::{Database, Document};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexSummary {
    /// In index order: it matters for a compound index.
    pub fields: Vec<String>,
    pub unique: bool,
    pub sparse: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionSummary {
    pub name: String,
    /// `false` for a virtual collection: prepared here, absent from the file.
    pub persisted: bool,
    /// `None` when the count could not be read, which is not zero;
    /// `count_error` then says why.
    pub count: Option<usize>,
    pub count_error: Option<String>,
    /// Secondary indexes only, as trunkdb lists them.
    pub indexes: Vec<IndexSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Overview {
    pub file: FileInfo,
    /// Persisted and virtual collections together, by name.
    pub collections: Vec<CollectionSummary>,
}

impl Session {
    /// File facts and every collection, read from one snapshot so counts
    /// and lists agree with each other.
    pub fn overview(&self) -> AppResult<Overview> {
        let (file, mut collections) = self.read(|database| {
            let snapshot = database.snapshot()?;
            let file = FileInfo::from(snapshot.file_info()?);
            let mut collections = Vec::new();
            for name in snapshot.collections()? {
                let view = snapshot.collection::<Document>(&name);
                let (count, count_error) = match view.count(Filter::new()) {
                    Ok(count) => (Some(count), None),
                    Err(error) => (None, Some(AppError::from(error).to_string())),
                };
                let indexes = view
                    .indexes()?
                    .iter()
                    .map(|index| IndexSummary {
                        fields: index.fields().to_vec(),
                        unique: index.is_unique(),
                        sparse: index.is_sparse(),
                    })
                    .collect();
                collections.push(CollectionSummary {
                    name,
                    persisted: true,
                    count,
                    count_error,
                    indexes,
                });
            }
            Ok((file, collections))
        })?;

        let mut virtuals = self.virtual_collections();
        // A first insert or index made it real: it is no longer virtual.
        virtuals.retain(|name| !collections.iter().any(|stored| stored.name == *name));
        collections.extend(virtuals.iter().map(|name| CollectionSummary {
            name: name.clone(),
            persisted: false,
            count: Some(0),
            count_error: None,
            indexes: Vec::new(),
        }));
        collections.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Overview { file, collections })
    }

    /// Adds a virtual collection: a name to work in, written nowhere
    /// until its first insert or index.
    pub fn prepare_collection(&self, name: &str) -> AppResult<Overview> {
        // It could never be stored.
        if !self.can_mutate() {
            return Err(AppError::read_only());
        }
        if name.is_empty() {
            return Err(AppError::invalid_input("Enter a collection name."));
        }
        // trunkdb's own limit; it would refuse the first insert otherwise.
        if name.len() > Database::MAX_COLLECTION_NAME_LEN {
            return Err(AppError::invalid_input(format!(
                "A collection name can be at most {} bytes long.",
                Database::MAX_COLLECTION_NAME_LEN
            )));
        }
        let persisted = self.read(|database| Ok(database.collections()?))?;
        {
            let mut virtuals = self.virtual_collections();
            if persisted.iter().any(|existing| existing == name)
                || virtuals.iter().any(|existing| existing == name)
            {
                return Err(AppError::new(
                    ErrorCategory::AlreadyExists,
                    format!("A collection named \u{201c}{name}\u{201d} already exists."),
                ));
            }
            virtuals.push(name.to_string());
        }
        self.overview()
    }

    /// Removes a virtual collection from view. Never touches the file: a
    /// persisted collection is refused here, and dropped only by its own,
    /// confirmed operation.
    pub fn discard_virtual_collection(&self, name: &str) -> AppResult<Overview> {
        {
            let mut virtuals = self.virtual_collections();
            let before = virtuals.len();
            virtuals.retain(|existing| existing != name);
            if virtuals.len() == before {
                return Err(AppError::new(
                    ErrorCategory::TargetNotFound,
                    format!("\u{201c}{name}\u{201d} is not an unsaved collection."),
                ));
            }
        }
        self.overview()
    }
}
