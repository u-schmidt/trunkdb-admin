//! The field paths a collection's documents have: every
//! document read, in one snapshot, counted as trunkdb's `trunkdb fields`
//! counts them (its SPEC §121), for suggestions in the path inputs and
//! the Fields section. trunkdb keeps this out of its library (§121.5);
//! a cursor and `Document` are all it takes.

use crate::error::AppResult;
use crate::query::ValueKind;
use crate::session::Session;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use trunkdb::Document;
use trunkdb::query::{Condition, Filter};

#[derive(Debug, Clone, Deserialize)]
pub struct FieldPathsRequest {
    /// Chosen by the caller and echoed in the result.
    pub request_id: u64,
    pub collection: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KindCount {
    pub kind: ValueKind,
    /// Documents with a value of this kind at the path.
    pub documents: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldPath {
    /// As the path inputs take it: `address.city`, `tags[*].k`.
    pub path: String,
    /// As a filter's text writes it (trunkdb SPEC §111.3): names in
    /// backticks where they must be.
    pub text: String,
    /// Whether a path can name it: no name on the way has a `.` or a
    /// `[*]` in it (trunkdb SPEC §31.2). Never suggested if not.
    pub nameable: bool,
    /// Documents with a value here, null included; missing isn't.
    pub documents: u64,
    /// Most first; a tie in `ValueKind`'s order.
    pub kinds: Vec<KindCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldPaths {
    pub request_id: u64,
    /// The documents read: all of the collection's.
    pub documents: u64,
    /// `_id` first, then by name, each field before what is below it, an
    /// object's fields before its array's elements.
    pub paths: Vec<FieldPath>,
    /// Paths were left out at `MAX_PATHS`.
    pub truncated: bool,
}

/// As `trunkdb fields` (its SPEC §121.4): past this, names are data.
pub const MAX_PATHS: usize = 10_000;

impl Session {
    /// Every document of the collection, read through one cursor (one
    /// snapshot): its paths, counted per document. A collection that isn't
    /// stored, virtual or gone, has none.
    pub fn field_paths(&self, request: &FieldPathsRequest) -> AppResult<FieldPaths> {
        self.read(|database| {
            let mut summary = Summary::default();
            if database.collections()?.contains(&request.collection) {
                let collection = database.collection::<Document>(&request.collection);
                for doc in collection.cursor(Filter::new())? {
                    summary.add(&doc?);
                }
            }
            Ok(FieldPaths {
                request_id: request.request_id,
                documents: summary.documents,
                paths: summary.paths(),
                truncated: summary.full,
            })
        })
    }
}

/// One path, and the paths below it: the fields of the objects found
/// there, and the elements of its arrays. A document counts once per
/// path and once per kind, however many values it has there.
#[derive(Default)]
struct Shape {
    documents: u64,
    kinds: BTreeMap<ValueKind, u64>,
    /// The number, from 1, of the last document counted, overall and per
    /// kind: a document reaches a path under an array once per element.
    last: u64,
    last_kind: BTreeMap<ValueKind, u64>,
    fields: BTreeMap<String, Shape>,
    elements: Option<Box<Shape>>,
}

#[derive(Default)]
struct Summary {
    root: Shape,
    documents: u64,
    paths: usize,
    full: bool,
}

impl Summary {
    fn add(&mut self, doc: &Document) {
        self.documents += 1;
        let number = self.documents;
        if let Document::Object(map) = doc {
            for (name, value) in map.iter() {
                Self::field(
                    &mut self.root,
                    name,
                    value,
                    number,
                    &mut self.paths,
                    &mut self.full,
                );
            }
        }
    }

    fn field(
        parent: &mut Shape,
        name: &str,
        value: &Document,
        number: u64,
        paths: &mut usize,
        full: &mut bool,
    ) {
        if !parent.fields.contains_key(name) {
            if *paths == MAX_PATHS {
                *full = true;
                return;
            }
            *paths += 1;
            parent.fields.insert(name.to_string(), Shape::default());
        }
        let shape = parent.fields.get_mut(name).expect("just found or made");
        Self::value(shape, value, number, paths, full);
    }

    fn value(shape: &mut Shape, value: &Document, number: u64, paths: &mut usize, full: &mut bool) {
        if shape.last != number {
            shape.last = number;
            shape.documents += 1;
        }
        let kind = ValueKind::of(value);
        let last = shape.last_kind.entry(kind).or_insert(0);
        if *last != number {
            *last = number;
            *shape.kinds.entry(kind).or_insert(0) += 1;
        }
        match value {
            Document::Object(map) => {
                for (name, value) in map.iter() {
                    Self::field(shape, name, value, number, paths, full);
                }
            }
            Document::Array(items) => {
                for item in items {
                    if shape.elements.is_none() {
                        if *paths == MAX_PATHS {
                            *full = true;
                            return;
                        }
                        *paths += 1;
                        shape.elements = Some(Box::default());
                    }
                    let elements = shape.elements.as_mut().expect("just made");
                    Self::value(elements, item, number, paths, full);
                }
            }
            _ => {}
        }
    }

    fn paths(&self) -> Vec<FieldPath> {
        let mut out = Vec::new();
        let mut names: Vec<&String> = self.root.fields.keys().collect();
        names.sort_by_key(|name| name.as_str() != "_id");
        for name in names {
            walk(
                name.clone(),
                name_text(name),
                nameable(name),
                &self.root.fields[name],
                &mut out,
            );
        }
        out
    }
}

/// Whether a path can reach a field of this name (trunkdb SPEC §31.2).
fn nameable(name: &str) -> bool {
    !name.contains('.') && !name.contains("[*]")
}

/// `name` as a filter writes it, written by trunkdb's filter language
/// itself so the two can't disagree; one no path can name in backticks
/// too, as `trunkdb fields` writes it.
fn name_text(name: &str) -> String {
    match nameable(name) {
        true => {
            let text = Condition::exists(name).to_string();
            text["exists(".len()..text.len() - 1].to_string()
        }
        false => format!("`{}`", name.replace('`', "``")),
    }
}

fn walk(path: String, text: String, can_name: bool, shape: &Shape, out: &mut Vec<FieldPath>) {
    let mut kinds: Vec<KindCount> = (shape.kinds.iter())
        .map(|(&kind, &documents)| KindCount { kind, documents })
        .collect();
    kinds.sort_by_key(|k| std::cmp::Reverse(k.documents));
    out.push(FieldPath {
        path: path.clone(),
        text: text.clone(),
        nameable: can_name,
        documents: shape.documents,
        kinds,
    });
    for (name, field) in &shape.fields {
        walk(
            format!("{path}.{name}"),
            format!("{text}.{}", name_text(name)),
            can_name && nameable(name),
            field,
            out,
        );
    }
    if let Some(ref elements) = shape.elements {
        walk(
            format!("{path}[*]"),
            format!("{text}[*]"),
            can_name,
            elements,
            out,
        );
    }
}
