//! Creating and dropping secondary indexes. The primary
//! `_id` index is trunkdb's own and is never managed through here.

use crate::error::{AppError, AppResult, ErrorCategory};
use crate::overview::Overview;
use crate::session::Session;
use serde::Deserialize;
use trunkdb::{Document, IndexOptions};

#[derive(Debug, Clone, Deserialize)]
pub struct IndexRequest {
    pub collection: String,
    /// Field paths in index order.
    pub fields: Vec<String>,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub sparse: bool,
}

impl IndexRequest {
    fn options(&self) -> IndexOptions {
        let mut options = IndexOptions::new();
        if self.unique {
            options = options.unique();
        }
        if self.sparse {
            options = options.sparse();
        }
        options
    }

    /// What this tool checks itself, with its own wording. Path syntax
    /// and limits are trunkdb's to enforce.
    fn check_fields(fields: &[String]) -> AppResult<()> {
        if fields.is_empty() {
            return Err(AppError::invalid_input(
                "An index needs at least one field.",
            ));
        }
        if fields.iter().any(String::is_empty) {
            return Err(AppError::invalid_input(
                "Enter a path for every index field.",
            ));
        }
        let on_primary = |field: &String| {
            field
                .split('.')
                .next()
                .map(|step| step.trim_end_matches("[*]"))
                == Some("_id")
        };
        if fields.iter().any(on_primary) {
            return Err(AppError::invalid_input(
                "The index on _id is the automatic primary index. It cannot be created, \
                 changed or dropped.",
            ));
        }
        Ok(())
    }

    fn name(fields: &[String]) -> String {
        index_name(fields)
    }
}

/// An index as trunkdb names it: `status`, or `(status, created)` for a
/// compound one.
pub(crate) fn index_name(fields: &[String]) -> String {
    match fields {
        [single] => single.clone(),
        several => format!("({})", several.join(", ")),
    }
}

impl Session {
    /// Builds a secondary index over the stored documents. Creates the
    /// collection if it was virtual. A unique conflict among existing
    /// documents creates nothing.
    pub fn create_index(&self, request: &IndexRequest) -> AppResult<Overview> {
        IndexRequest::check_fields(&request.fields)?;
        let options = request.options();
        self.write(|database| {
            let collection = database.collection::<Document>(&request.collection);
            let name = IndexRequest::name(&request.fields);
            // Never replaced silently: the same fields with other options
            // must be dropped by the user first.
            if let Some(existing) = collection
                .indexes()?
                .into_iter()
                .find(|index| index.fields() == request.fields.as_slice())
            {
                let message = if existing.options() == options {
                    format!("An index on {name} already exists.")
                } else {
                    format!(
                        "An index on {name} already exists with other options. \
                         Drop it first to create it differently."
                    )
                };
                return Err(AppError::new(ErrorCategory::AlreadyExists, message));
            }
            collection.ensure_index_with(request.fields.clone(), options)?;
            Ok(())
        })?;
        self.overview()
    }

    pub fn drop_index(&self, collection: &str, fields: &[String]) -> AppResult<Overview> {
        IndexRequest::check_fields(fields)?;
        self.write(|database| {
            if database
                .collection::<Document>(collection)
                .drop_index(fields.to_vec())?
            {
                Ok(())
            } else {
                Err(AppError::not_found(format!(
                    "There is no index on {}.",
                    IndexRequest::name(fields)
                )))
            }
        })?;
        self.overview()
    }
}
