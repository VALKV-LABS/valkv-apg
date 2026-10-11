//! The apply path: the one place a changelog event becomes node state.
//!
//! Every config source (file, API poll, database tail) feeds [`Resources::apply`].
//! A routing behaviour that differs by source would have to be written
//! somewhere else, and there is nowhere else (spec ARC-1).

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use crate::model::{ChangeEvent, KINDS};

/// One stored resource: exactly what the last accepted event said.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored {
    pub workspace_id: Option<String>,
    pub revision: u64,
    pub data: Value,
}

/// What [`Resources::apply`] did with an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// State changed.
    Changed,
    /// The event was a repeat or older than what is held; nothing changed (spec CFG-4).
    Unchanged,
    /// The event could not be used. The reason is a metric label (spec CFG-5).
    Skipped(&'static str),
}

/// Every resource a node holds, by kind and id.
///
/// `BTreeMap` keeps iteration order stable, so two nodes with the same
/// resources build byte-identical snapshots.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resources {
    by_kind: HashMap<String, BTreeMap<String, Stored>>,
}

impl Resources {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies one event. Never panics and never returns an error: an event
    /// that cannot be used is reported as [`Applied::Skipped`] so the caller
    /// can count it and move its checkpoint past it.
    pub fn apply(&mut self, event: &ChangeEvent) -> Applied {
        if event.v != 2 {
            return Applied::Skipped("unknown_version");
        }
        if !KINDS.contains(&event.kind.as_str()) {
            return Applied::Skipped("unknown_kind");
        }
        match event.op.as_str() {
            "upsert" => {
                let Some(data) = &event.data else { return Applied::Skipped("decode_error") };
                if !data.is_object() {
                    return Applied::Skipped("decode_error");
                }
                let revision = event.revision.unwrap_or(0);
                let kind = self.by_kind.entry(event.kind.clone()).or_default();
                if let Some(held) = kind.get(&event.id)
                    && held.revision >= revision
                {
                    return Applied::Unchanged;
                }
                kind.insert(event.id.clone(), Stored { workspace_id: event.workspace_id.clone(), revision, data: data.clone() });
                Applied::Changed
            }
            "delete" => match self.by_kind.get_mut(&event.kind).and_then(|k| k.remove(&event.id)) {
                Some(_) => Applied::Changed,
                None => Applied::Unchanged,
            },
            _ => Applied::Skipped("unknown_op"),
        }
    }

    /// Parses a raw changelog row and applies it.
    pub fn apply_value(&mut self, raw: &Value) -> Applied {
        match serde_json::from_value::<ChangeEvent>(raw.clone()) {
            Ok(event) => self.apply(&event),
            Err(_) => Applied::Skipped("decode_error"),
        }
    }

    /// All resources of one kind, in id order.
    pub fn kind(&self, kind: &str) -> impl Iterator<Item = (&String, &Stored)> {
        self.by_kind.get(kind).into_iter().flat_map(|m| m.iter())
    }

    pub fn get(&self, kind: &str, id: &str) -> Option<&Stored> {
        self.by_kind.get(kind).and_then(|m| m.get(id))
    }

    /// Number of resources of one kind.
    pub fn count(&self, kind: &str) -> usize {
        self.by_kind.get(kind).map_or(0, |m| m.len())
    }

    /// Every resource as an `upsert` event, in an order that lists what is
    /// referenced before what refers to it. Used to persist and reload state.
    pub fn to_events(&self) -> Vec<ChangeEvent> {
        const ORDER: &[&str] = &[
            "setting", "flag", "workspace", "ca_certificate", "certificate", "domain", "service", "route",
            "consumer", "credential", "wasm_module", "plugin", "acme_challenge",
        ];
        let mut out = Vec::new();
        for kind in ORDER {
            for (id, s) in self.kind(kind) {
                out.push(ChangeEvent {
                    v: 2,
                    kind: (*kind).to_string(),
                    op: "upsert".into(),
                    id: id.clone(),
                    workspace_id: s.workspace_id.clone(),
                    revision: Some(s.revision),
                    data: Some(s.data.clone()),
                });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(kind: &str, op: &str, id: &str, revision: u64, data: Value) -> ChangeEvent {
        ChangeEvent {
            v: 2,
            kind: kind.into(),
            op: op.into(),
            id: id.into(),
            workspace_id: Some("w".into()),
            revision: (op == "upsert").then_some(revision),
            data: (op == "upsert").then_some(data),
        }
    }

    #[test]
    fn upsert_then_delete() {
        let mut r = Resources::new();
        assert_eq!(r.apply(&ev("route", "upsert", "a", 1, json!({"name": "a"}))), Applied::Changed);
        assert_eq!(r.count("route"), 1);
        assert_eq!(r.apply(&ev("route", "delete", "a", 0, json!({}))), Applied::Changed);
        assert_eq!(r.count("route"), 0);
    }

    // spec CFG-4: replaying the stream from an older checkpoint must be harmless.
    #[test]
    fn replays_and_older_revisions_change_nothing() {
        let mut r = Resources::new();
        r.apply(&ev("route", "upsert", "a", 3, json!({"name": "new"})));
        assert_eq!(r.apply(&ev("route", "upsert", "a", 3, json!({"name": "new"}))), Applied::Unchanged);
        assert_eq!(r.apply(&ev("route", "upsert", "a", 2, json!({"name": "old"}))), Applied::Unchanged);
        assert_eq!(r.get("route", "a").unwrap().data["name"], "new");
        assert_eq!(r.apply(&ev("route", "delete", "missing", 0, json!({}))), Applied::Unchanged);
    }

    // spec CFG-5: nothing a control plane sends may stall or crash a node.
    #[test]
    fn unusable_events_are_skipped_with_a_reason() {
        let mut r = Resources::new();
        let mut e = ev("route", "upsert", "a", 1, json!({}));
        e.v = 1;
        assert_eq!(r.apply(&e), Applied::Skipped("unknown_version"));
        assert_eq!(r.apply(&ev("tenant", "upsert", "a", 1, json!({}))), Applied::Skipped("unknown_kind"));
        assert_eq!(r.apply(&ev("route", "replace", "a", 1, json!({}))), Applied::Skipped("unknown_op"));
        let mut no_data = ev("route", "upsert", "a", 1, json!({}));
        no_data.data = None;
        assert_eq!(r.apply(&no_data), Applied::Skipped("decode_error"));
        assert_eq!(r.apply(&ev("route", "upsert", "a", 1, json!("not an object"))), Applied::Skipped("decode_error"));
        assert_eq!(r.apply_value(&json!({"hello": "world"})), Applied::Skipped("decode_error"));
        assert_eq!(r.apply_value(&json!(42)), Applied::Skipped("decode_error"));
        assert_eq!(r.count("route"), 0);
    }

    #[test]
    fn to_events_round_trips_and_orders_referenced_first() {
        let mut r = Resources::new();
        r.apply(&ev("plugin", "upsert", "p", 1, json!({"type": "rate_limit"})));
        r.apply(&ev("route", "upsert", "r", 2, json!({"name": "r"})));
        r.apply(&ev("service", "upsert", "s", 1, json!({"name": "s"})));
        let events = r.to_events();
        assert_eq!(events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["service", "route", "plugin"]);
        let mut again = Resources::new();
        for e in &events {
            again.apply(e);
        }
        assert_eq!(again, r);
    }
}
