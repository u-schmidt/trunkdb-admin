//! Reading, validating, saving and deleting object documents.
//!
//! The editor's payload is tagged JSON text. It is parsed and written
//! here, by trunkdb's own `Document` parser and formatter, so no value
//! ever passes through a JavaScript number or object on its way to or
//! from the file.

use crate::error::{AppError, AppResult, ErrorCategory};
use crate::overview::Overview;
use crate::query::FilterInput;
use crate::session::Session;
use serde::{Deserialize, Serialize};
use trunkdb::{DocId, Document};

/// An object document as the editor shows it: the ID apart, immutable,
/// and the rest of the object as pretty tagged JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DocumentView {
    pub id: String,
    /// The object without its top-level `_id`.
    pub json: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveRequest {
    pub collection: String,
    /// The document to replace; `None` inserts a new one.
    pub id: Option<String>,
    /// The editor text: an object without a top-level `_id`.
    pub json: String,
    /// The list's active filter, to report whether the saved document
    /// still belongs to it.
    #[serde(default)]
    pub filter: FilterInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedDocument {
    /// As stored now, read back after the write.
    pub document: DocumentView,
    pub created: bool,
    /// Whether the document satisfies the request's conditions. About the
    /// filter only: being on another page is not a mismatch.
    pub matches_filter: bool,
}

impl DocumentView {
    const ID_FIELD: &'static str = "_id";

    /// The stored object `document`, split into ID and editable body.
    fn of(id: &DocId, document: Document) -> AppResult<Self> {
        // trunkdb holds nothing else since SPEC §95.
        let Document::Object(mut fields) = document else {
            return Err(AppError::new(
                ErrorCategory::Internal,
                "trunkdb returned a document that is not an object.",
            ));
        };
        fields.remove(Self::ID_FIELD);
        Ok(Self {
            id: id.to_string(),
            json: format!("{:#}", Document::Object(fields)),
        })
    }

    /// Editor text as a document that may be stored: valid tagged JSON,
    /// an object, without a top-level `_id`, not nested too deeply.
    pub fn parse_body(json: &str) -> AppResult<Document> {
        let document: Document = json.parse().map_err(|error: trunkdb::ParseDocumentError| {
            AppError::new(ErrorCategory::InvalidJson, "The text is not valid JSON.")
                .with_detail(error.to_string())
        })?;
        let Document::Object(fields) = &document else {
            return Err(AppError::invalid_input(
                "A document must be a JSON object: { \u{2026} }. Other values cannot be \
                 created or edited here.",
            ));
        };
        // Rejected rather than ignored or adopted: accepting it would
        // look like the ID could be chosen or changed. A nested `_id` is
        // ordinary content.
        if fields.contains_key(Self::ID_FIELD) {
            return Err(AppError::invalid_input(
                "Remove the top-level \u{201c}_id\u{201d}. The ID is assigned by the database \
                 and cannot be set or changed.",
            ));
        }
        if nests_deeper_than(&document, Document::MAX_NESTING) {
            return Err(AppError::invalid_input(format!(
                "The document nests deeper than {} levels.",
                Document::MAX_NESTING
            )));
        }
        Ok(document)
    }

    /// The text as trunkdb writes it: for the editor's Format action and
    /// as a check before saving. Changes nothing in the database.
    pub fn format_body(json: &str) -> AppResult<String> {
        Ok(format!("{:#}", Self::parse_body(json)?))
    }

    fn parse_id(id: &str) -> AppResult<DocId> {
        id.parse()
            .map_err(|_| AppError::invalid_input("This is not a document ID."))
    }
}

impl Session {
    pub fn read_document(&self, collection: &str, id: &str) -> AppResult<DocumentView> {
        let id = DocumentView::parse_id(id)?;
        self.read(|database| {
            let document = database
                .collection::<Document>(collection)
                .get(&id)?
                .ok_or_else(|| AppError::not_found("This document no longer exists."))?;
            DocumentView::of(&id, document)
        })
    }

    /// Inserts or replaces a document. An update replaces the whole
    /// object, so a field removed from the text is removed from storage.
    pub fn save_document(&self, request: &SaveRequest) -> AppResult<SavedDocument> {
        // Everything that can be refused is checked before the write.
        let body = DocumentView::parse_body(&request.json)?;
        let existing = request
            .id
            .as_deref()
            .map(DocumentView::parse_id)
            .transpose()?;
        let filter = request.filter.filter()?;

        self.write(|database| {
            let collection = database.collection::<Document>(&request.collection);
            let id = match existing {
                None => collection.insert(body)?,
                Some(id) => {
                    // `false` is "no such document", not a quiet success.
                    if !collection.update(&id, body)? {
                        return Err(AppError::not_found(
                            "This document no longer exists, so it could not be saved. \
                             Your text is kept.",
                        ));
                    }
                    id
                }
            };

            // The write is committed. From here on a failure must not
            // read as "not saved".
            let committed = |error: trunkdb::Error| {
                AppError::new(
                    ErrorCategory::Internal,
                    "The document was saved, but could not be read back. Refresh the list.",
                )
                .with_detail(error.to_string())
            };
            let snapshot = database.snapshot().map_err(committed)?;
            let view = snapshot.collection::<Document>(&request.collection);
            let stored = view
                .get(&id)
                .map_err(committed)?
                .ok_or_else(|| AppError::not_found("The document was saved and then removed."))?;
            let matches_filter = view.count(filter.id(id)).map_err(committed)? > 0;
            Ok(SavedDocument {
                document: DocumentView::of(&id, stored)?,
                created: existing.is_none(),
                matches_filter,
            })
        })
    }

    pub fn delete_document(&self, collection: &str, id: &str) -> AppResult<()> {
        let id = DocumentView::parse_id(id)?;
        self.write(|database| {
            if database.collection::<Document>(collection).delete(&id)? {
                Ok(())
            } else {
                Err(AppError::not_found(
                    "This document no longer exists; nothing was deleted.",
                ))
            }
        })
    }

    /// Removes a persisted collection with its documents and indexes.
    pub fn drop_collection(&self, name: &str) -> AppResult<Overview> {
        self.write(|database| {
            if database.drop_collection(name)? {
                Ok(())
            } else {
                Err(AppError::not_found(format!(
                    "There is no stored collection named \u{201c}{name}\u{201d}."
                )))
            }
        })?;
        self.overview()
    }
}

/// Whether `document` nests arrays and objects more than `levels` deep,
/// for refusing it before a save. trunkdb's own check (private since its
/// SPEC §118) also counts an object holding only an export tag twice, so
/// right at the limit a save can still be refused by the write itself,
/// as `invalid_input` too. Stops at the limit, so no document is too deep
/// for the stack here.
fn nests_deeper_than(document: &Document, levels: usize) -> bool {
    let children: Box<dyn Iterator<Item = &Document>> = match document {
        Document::Array(items) => Box::new(items.iter()),
        Document::Object(fields) => Box::new(fields.values()),
        _ => return false,
    };
    levels == 0
        || children
            .into_iter()
            .any(|child| nests_deeper_than(child, levels - 1))
}
