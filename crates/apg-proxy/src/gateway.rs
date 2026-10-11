//! The node's live state: the current snapshot, and what the config source last said.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use apg_core::model::KINDS;
use apg_core::resources::Resources;
use apg_core::snapshot::Snapshot;
use arc_swap::ArcSwap;
use dashmap::DashMap;
use parking_lot::Mutex;

use crate::metrics;
use crate::upstream::{self, Upstreams};

/// Liveness of the config source, and whether the node has ever held a
/// complete configuration (spec §5.6).
pub struct SourceHealth {
    converged: AtomicBool,
    last_alive: Mutex<Instant>,
    /// Seconds of silence after which the source counts as stale.
    stale_after_secs: u64,
}

/// What `/readyz` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Readiness {
    pub ready: bool,
    pub stale: bool,
    pub source_age_seconds: u64,
}

impl SourceHealth {
    pub fn new(stale_after_secs: u64) -> Self {
        Self { converged: AtomicBool::new(false), last_alive: Mutex::new(Instant::now()), stale_after_secs }
    }

    /// The source answered (with or without changes).
    pub fn mark_alive(&self) {
        *self.last_alive.lock() = Instant::now();
    }

    /// The node holds everything the source has.
    pub fn mark_converged(&self) {
        self.converged.store(true, Ordering::Relaxed);
        metrics::CONFIG_CONVERGED.set(1);
    }

    /// Ready means "has converged at least once". It deliberately does not
    /// mean "the source is fresh": every node in a fleet shares one source, so
    /// failing readiness on staleness would eject them all at the same moment
    /// and turn a control-plane outage into a total outage. Staleness is
    /// reported and alarmed on instead (spec CFG-21).
    pub fn readiness(&self) -> Readiness {
        let age = self.last_alive.lock().elapsed().as_secs();
        metrics::CONFIG_SOURCE_AGE.set(age as i64);
        Readiness { ready: self.converged.load(Ordering::Relaxed), stale: age > self.stale_after_secs, source_age_seconds: age }
    }
}

/// Shared by the proxy pipeline, the config sources and the management server.
pub struct Gateway {
    snapshot: ArcSwap<Snapshot>,
    applied_seq: AtomicU64,
    pub health: SourceHealth,
    /// Backend health, circuits, resolved addresses and upstream trust material.
    pub upstreams: Arc<Upstreams>,
    /// ACME HTTP-01 answers every node of the fleet must give (spec TLS-10): token to key authorisation.
    challenges: ArcSwap<HashMap<String, String>>,
    /// Answers for challenges this node started itself, when nothing distributes them (file mode).
    local_challenges: DashMap<String, String>,
    /// Signalled whenever a configuration is installed.
    pub changed: tokio::sync::Notify,
    pub node_id: String,
    pub source: &'static str,
    started: Instant,
}

impl Gateway {
    pub fn new(node_id: String, source: &'static str, stale_after_secs: u64) -> Arc<Self> {
        Self::with_upstreams(node_id, source, stale_after_secs, upstream::Settings::default())
    }

    pub fn with_upstreams(node_id: String, source: &'static str, stale_after_secs: u64, upstreams: upstream::Settings) -> Arc<Self> {
        Arc::new(Self {
            snapshot: ArcSwap::from_pointee(Snapshot::default()),
            applied_seq: AtomicU64::new(0),
            health: SourceHealth::new(stale_after_secs),
            upstreams: Arc::new(Upstreams::new(upstreams)),
            challenges: ArcSwap::from_pointee(HashMap::new()),
            local_challenges: DashMap::new(),
            changed: tokio::sync::Notify::new(),
            node_id,
            source,
            started: Instant::now(),
        })
    }

    /// The configuration requests are served from right now. Cheap: one atomic load.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.load_full()
    }

    pub fn applied_seq(&self) -> u64 {
        self.applied_seq.load(Ordering::Relaxed)
    }

    /// Builds a snapshot from `resources` and makes it current. Requests in
    /// flight keep the snapshot they started with; new ones see the new one.
    /// Building happens before the swap, so no request ever waits on it.
    pub fn install(&self, resources: &Resources, seq: u64) {
        let snapshot = Snapshot::build(resources);
        for kind in KINDS {
            metrics::CONFIG_RESOURCES.with_label_values(&[kind]).set(resources.count(kind) as i64);
        }
        metrics::CONFIG_DANGLING.set(snapshot.report.dangling as i64);
        if snapshot.report.undecodable > 0 {
            metrics::CHANGELOG_ERRORS.with_label_values(&["undecodable_resource"]).inc_by(snapshot.report.undecodable as u64);
        }
        // Before the swap, so no request meets a service whose state is not there yet.
        self.upstreams.sync(resources, &snapshot);
        let challenges: HashMap<String, String> = resources
            .kind("acme_challenge")
            .filter_map(|(token, stored)| Some((token.clone(), stored.data.get("key_authorization")?.as_str()?.to_string())))
            .collect();
        self.challenges.store(Arc::new(challenges));
        self.snapshot.store(Arc::new(snapshot));
        self.applied_seq.store(seq, Ordering::Relaxed);
        metrics::CONFIG_APPLIED_SEQ.set(seq as i64);
        self.changed.notify_waiters();
    }

    /// The answer to an ACME HTTP-01 challenge, if this node knows the token.
    pub fn challenge(&self, token: &str) -> Option<String> {
        self.challenges.load().get(token).cloned().or_else(|| self.local_challenges.get(token).map(|v| v.clone()))
    }

    /// Remembers (or with `None` forgets) the answer to a challenge this node started.
    pub fn set_local_challenge(&self, token: &str, key_authorization: Option<&str>) {
        match key_authorization {
            Some(value) => {
                self.local_challenges.insert(token.to_string(), value.to_string());
            }
            None => {
                self.local_challenges.remove(token);
            }
        }
    }

    /// The document `/status` returns: the node's own view of itself (spec OBS-5).
    pub fn status(&self) -> serde_json::Value {
        let snap = self.snapshot();
        let r = self.health.readiness();
        serde_json::json!({
            "node_id": self.node_id,
            "version": env!("CARGO_PKG_VERSION"),
            "source": self.source,
            "applied_seq": self.applied_seq(),
            "converged": r.ready,
            "stale": r.stale,
            "source_age_seconds": r.source_age_seconds,
            "uptime_seconds": self.started.elapsed().as_secs(),
            "counts": {
                "workspaces": snap.workspace_count(),
                "services": snap.service_count(),
                "routes": snap.route_count(),
                "dangling_routes": snap.report.dangling,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use serde_json::json;

    // spec CFG-21: the rule that keeps a control-plane outage from becoming a data-plane outage.
    #[test]
    fn readiness_is_about_having_converged_never_about_freshness() {
        let h = SourceHealth::new(0);
        assert!(!h.readiness().ready, "a node that has never held a configuration is not ready");
        h.mark_converged();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let r = h.readiness();
        assert!(r.stale, "the source has been silent past the threshold");
        assert!(r.ready, "and the node is still ready: it serves what it has");
        h.mark_alive();
        assert!(!SourceHealth::new(30).readiness().stale);
    }

    #[test]
    fn install_swaps_the_snapshot_and_requests_keep_the_one_they_started_with() {
        let g = Gateway::new("n1".into(), "file", 30);
        let before = g.snapshot();
        assert_eq!(before.route_count(), 0);

        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "s", "backends": [{ "target": "a:1" }] })));
        r.apply(&ChangeEvent::upsert("route", "r", Some("w".into()), json!({ "name": "r", "service": "s" })));
        g.install(&r, 42);

        assert_eq!(g.snapshot().route_count(), 1);
        assert_eq!(g.applied_seq(), 42);
        assert_eq!(before.route_count(), 0, "the old snapshot is unchanged for whoever still holds it");
        let status = g.status();
        assert_eq!(status["counts"]["routes"], 1);
        assert_eq!(status["node_id"], "n1");
        assert_eq!(status["converged"], false);
    }

    // spec TLS-10
    #[test]
    fn challenge_answers_come_from_configuration_and_from_this_node() {
        let g = Gateway::new("n1".into(), "api_poll", 30);
        assert_eq!(g.challenge("tok"), None);
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("acme_challenge", "tok", None, json!({ "token": "tok", "key_authorization": "tok.thumb" })));
        g.install(&r, 7);
        assert_eq!(g.challenge("tok").as_deref(), Some("tok.thumb"));
        // Withdrawn by the control plane: no longer answered.
        g.install(&Resources::new(), 8);
        assert_eq!(g.challenge("tok"), None);

        g.set_local_challenge("mine", Some("mine.thumb"));
        assert_eq!(g.challenge("mine").as_deref(), Some("mine.thumb"));
        g.set_local_challenge("mine", None);
        assert_eq!(g.challenge("mine"), None);
    }
}
