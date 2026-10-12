//! Applies changes from a control plane: to memory, to the local cache, and
//! then to the live snapshot.
//!
//! Shared by the `api_poll` and `db_tail` sources. Both hand it the same rows,
//! so both resume from the same checkpoint and behave the same (spec ARC-1).

use std::sync::Arc;

use apg_core::model::ChangeEvent;
use apg_core::resources::{Applied, Resources};
use parking_lot::Mutex;
use serde_json::Value;

use crate::cache::Cache;
use crate::gateway::Gateway;
use crate::metrics;
use crate::tls::TlsStore;

struct State {
    resources: Resources,
    seq: u64,
    cluster_id: Option<String>,
}

pub struct Applier {
    gateway: Arc<Gateway>,
    tls: Arc<TlsStore>,
    cache: Cache,
    state: Mutex<State>,
}

/// A snapshot as a control plane serves it: a header line, then one event per line.
#[derive(Debug)]
pub struct ParsedSnapshot {
    pub cluster_id: String,
    pub seq: u64,
    pub events: Vec<Value>,
}

/// Parses newline-delimited JSON: `{ cluster_id, seq }` first, then events (spec CFG-7).
pub fn parse_snapshot(body: &str) -> Result<ParsedSnapshot, String> {
    let mut lines = body.lines().filter(|l| !l.trim().is_empty());
    let header: Value = serde_json::from_str(lines.next().ok_or("the snapshot is empty")?).map_err(|e| format!("the snapshot header is not JSON: {e}"))?;
    let cluster_id = header.get("cluster_id").and_then(Value::as_str).ok_or("the snapshot header has no cluster_id")?.to_string();
    let seq = header.get("seq").and_then(Value::as_u64).ok_or("the snapshot header has no seq")?;
    let mut events = Vec::new();
    for (i, line) in lines.enumerate() {
        // A truncated or corrupt body must not be half-applied.
        events.push(serde_json::from_str(line).map_err(|e| format!("snapshot line {} is not JSON: {e}", i + 2))?);
    }
    Ok(ParsedSnapshot { cluster_id, seq, events })
}

impl Applier {
    /// Opens the local cache. If it holds a configuration, that configuration
    /// is installed at once: a node that restarts while its control plane is
    /// down serves what it had (spec ARC-4).
    pub fn open(data_dir: &str, gateway: Arc<Gateway>, tls: Arc<TlsStore>) -> anyhow::Result<Self> {
        let (cache, loaded) = Cache::open(data_dir)?;
        let warm = loaded.cluster_id.is_some();
        if warm {
            tls.install(&loaded.resources, &|p| std::fs::read(p));
            gateway.install(&loaded.resources, loaded.applied_seq);
            gateway.health.mark_converged();
            tracing::info!(applied_seq = loaded.applied_seq, routes = gateway.snapshot().route_count(), "serving the cached configuration while the config source is contacted");
        }
        Ok(Self { gateway, tls, cache, state: Mutex::new(State { resources: loaded.resources, seq: loaded.applied_seq, cluster_id: loaded.cluster_id }) })
    }

    /// Position to resume from.
    pub fn seq(&self) -> u64 {
        self.state.lock().seq
    }

    /// The control plane this node's state came from, if it has any state.
    pub fn cluster_id(&self) -> Option<String> {
        self.state.lock().cluster_id.clone()
    }

    /// Applies rows in order. Each row moves the checkpoint, usable or not:
    /// a row that cannot be used is a property of its content, so retrying it
    /// would fail the same way forever (spec CFG-5).
    pub fn apply_batch(&self, rows: &[(u64, Value)]) -> anyhow::Result<()> {
        let Some(&(last, _)) = rows.last() else { return Ok(()) };
        let mut state = self.state.lock();
        let mut changed = false;
        for (seq, raw) in rows {
            let event = serde_json::from_value::<ChangeEvent>(raw.clone()).ok();
            let outcome = match &event {
                Some(e) => state.resources.apply(e),
                None => Applied::Skipped("decode_error"),
            };
            match (outcome, &event) {
                (Applied::Changed, Some(e)) => {
                    changed = true;
                    self.cache.record(*seq, e)?;
                }
                (Applied::Skipped(reason), _) => {
                    metrics::CHANGELOG_ERRORS.with_label_values(&[reason]).inc();
                    tracing::warn!(seq, reason, "change skipped");
                    self.cache.checkpoint(*seq)?;
                }
                _ => self.cache.checkpoint(*seq)?,
            }
        }
        state.seq = last;
        if changed {
            self.tls.install(&state.resources, &|p| std::fs::read(p));
        }
        // Install even when nothing changed, so the applied position is visible.
        self.gateway.install(&state.resources, last);
        Ok(())
    }

    /// Replaces everything with a snapshot. The new state is built beside the
    /// old one and swapped in; requests keep being served throughout (spec CFG-8).
    pub fn replace(&self, snapshot: ParsedSnapshot, reason: &'static str) -> anyhow::Result<()> {
        let mut fresh = Resources::new();
        let mut skipped = 0usize;
        for raw in &snapshot.events {
            if let Applied::Skipped(why) = fresh.apply_value(raw) {
                skipped += 1;
                metrics::CHANGELOG_ERRORS.with_label_values(&[why]).inc();
            }
        }
        self.cache.replace(&snapshot.cluster_id, snapshot.seq, &fresh)?;
        self.tls.install(&fresh, &|p| std::fs::read(p));
        self.gateway.install(&fresh, snapshot.seq);
        metrics::SNAPSHOTS.with_label_values(&[reason]).inc();
        tracing::info!(reason, seq = snapshot.seq, resources = snapshot.events.len(), skipped, cluster_id = %snapshot.cluster_id, "snapshot applied");
        let mut state = self.state.lock();
        state.resources = fresh;
        state.seq = snapshot.seq;
        state.cluster_id = Some(snapshot.cluster_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn applier(dir: &TempDir) -> (Applier, Arc<Gateway>) {
        let gateway = Gateway::new("n".into(), "api_poll", 30);
        (Applier::open(dir.path().to_str().unwrap(), gateway.clone(), Arc::new(TlsStore::new(None).unwrap())).unwrap(), gateway)
    }

    fn snapshot_body(seq: u64, cluster: &str) -> String {
        [
            json!({ "cluster_id": cluster, "seq": seq }),
            json!({ "v": 2, "kind": "workspace", "op": "upsert", "id": "w", "revision": 1, "data": { "name": "default", "slug": "default", "system": true } }),
            json!({ "v": 2, "kind": "service", "op": "upsert", "id": "s", "workspace_id": "w", "revision": 1, "data": { "name": "s", "backends": [{ "target": "a:1" }] } }),
            json!({ "v": 2, "kind": "route", "op": "upsert", "id": "r1", "workspace_id": "w", "revision": 1, "data": { "name": "r1", "service": "s" } }),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
    }

    fn route(id: &str, revision: u64) -> Value {
        json!({ "v": 2, "kind": "route", "op": "upsert", "id": id, "workspace_id": "w", "revision": revision, "data": { "name": id, "service": "s", "paths": [format!("/{id}")] } })
    }

    #[test]
    fn a_new_node_has_nothing_and_is_not_converged() {
        let dir = TempDir::new().unwrap();
        let (a, g) = applier(&dir);
        assert_eq!((a.seq(), a.cluster_id()), (0, None));
        assert!(!g.health.readiness().ready);
    }

    #[test]
    fn snapshot_then_changes() {
        let dir = TempDir::new().unwrap();
        let (a, g) = applier(&dir);
        a.replace(parse_snapshot(&snapshot_body(10, "c1")).unwrap(), "empty_cache").unwrap();
        assert_eq!((a.seq(), a.cluster_id().as_deref(), g.snapshot().route_count()), (10, Some("c1"), 1));

        a.apply_batch(&[(11, route("r2", 1)), (12, route("r3", 1))]).unwrap();
        assert_eq!((a.seq(), g.snapshot().route_count(), g.applied_seq()), (12, 3, 12));

        a.apply_batch(&[(13, json!({ "v": 2, "kind": "route", "op": "delete", "id": "r2", "workspace_id": "w" }))]).unwrap();
        assert_eq!(g.snapshot().route_count(), 2);
        a.apply_batch(&[]).unwrap();
        assert_eq!(a.seq(), 13);
    }

    // spec CFG-5: one bad row must never stall the stream, and must not be retried forever.
    #[test]
    fn unusable_rows_are_skipped_and_the_checkpoint_still_moves_past_them() {
        let dir = TempDir::new().unwrap();
        let (a, g) = applier(&dir);
        a.replace(parse_snapshot(&snapshot_body(1, "c1")).unwrap(), "empty_cache").unwrap();
        a.apply_batch(&[
            (2, json!("not an event")),
            (3, json!({ "v": 9, "kind": "route", "op": "upsert", "id": "x", "revision": 1, "data": {} })),
            (4, json!({ "v": 2, "kind": "hologram", "op": "upsert", "id": "x", "revision": 1, "data": {} })),
            (5, route("r2", 1)),
            (6, json!({ "nonsense": true })),
        ])
        .unwrap();
        assert_eq!(a.seq(), 6, "the position is past the trailing bad row");
        assert_eq!(g.snapshot().route_count(), 2, "and the good row between them was applied");
    }

    // spec ARC-4: the property that keeps a control-plane outage from becoming a data-plane outage.
    #[test]
    fn a_restart_serves_the_cached_configuration_before_any_contact_with_the_source() {
        let dir = TempDir::new().unwrap();
        {
            let (a, _) = applier(&dir);
            a.replace(parse_snapshot(&snapshot_body(10, "c1")).unwrap(), "empty_cache").unwrap();
            a.apply_batch(&[(11, route("r2", 1))]).unwrap();
        }
        let (a, g) = applier(&dir);
        assert_eq!((a.seq(), a.cluster_id().as_deref()), (11, Some("c1")));
        assert_eq!(g.snapshot().route_count(), 2);
        assert!(g.health.readiness().ready, "ready from the cache alone");
    }

    #[test]
    fn a_snapshot_replaces_everything_including_things_the_new_one_lacks() {
        let dir = TempDir::new().unwrap();
        let (a, g) = applier(&dir);
        a.replace(parse_snapshot(&snapshot_body(10, "c1")).unwrap(), "empty_cache").unwrap();
        a.apply_batch(&[(11, route("extra", 1))]).unwrap();
        assert_eq!(g.snapshot().route_count(), 2);
        // a different control plane, with a lower position
        a.replace(parse_snapshot(&snapshot_body(3, "c2")).unwrap(), "cluster_changed").unwrap();
        assert_eq!((a.seq(), a.cluster_id().as_deref(), g.snapshot().route_count()), (3, Some("c2"), 1));
        drop(a);
        let (again, _) = applier(&dir);
        assert_eq!((again.seq(), again.cluster_id().as_deref()), (3, Some("c2")));
    }

    #[test]
    fn a_malformed_snapshot_is_refused_whole() {
        assert!(parse_snapshot("").is_err());
        assert!(parse_snapshot("not json").is_err());
        assert!(parse_snapshot("{\"seq\": 1}").unwrap_err().contains("cluster_id"));
        assert!(parse_snapshot("{\"cluster_id\": \"c\"}").unwrap_err().contains("seq"));
        let truncated = format!("{}\n{{\"v\": 2, \"kind\": \"rou", json!({ "cluster_id": "c", "seq": 1 }));
        assert!(parse_snapshot(&truncated).unwrap_err().contains("line 2"));
        let ok = parse_snapshot(&format!("{}\n\n", json!({ "cluster_id": "c", "seq": 0 }))).unwrap();
        assert_eq!((ok.seq, ok.events.len()), (0, 0));
    }
}
