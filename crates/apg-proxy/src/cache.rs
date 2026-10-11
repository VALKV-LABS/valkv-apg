//! The local config cache (spec §6.6): the last applied configuration on disk,
//! so a node restarts warm and serves even when its config source is down.
//!
//! The cache records which control plane it came from (`cluster_id`) and the
//! format it was written in. A mismatch of either means the contents cannot be
//! trusted, and the cache is discarded rather than guessed at (spec CFG-10, DP-7).
//!
//! Used by the `api_poll` and `db_tail` sources. File mode needs no cache: the
//! file is already local.

use std::path::Path;

use apg_core::model::ChangeEvent;
use apg_core::resources::Resources;
use fjall::{Config as FjallConfig, Keyspace, PartitionHandle};

/// Bump when the on-disk layout changes incompatibly.
pub const FORMAT_VERSION: u32 = 2;

const META_FORMAT: &str = "format";
const META_CLUSTER: &str = "cluster_id";
const META_SEQ: &str = "applied_seq";

pub struct Cache {
    keyspace: Keyspace,
    resources: PartitionHandle,
    meta: PartitionHandle,
}

/// What a cache held when it was opened.
#[derive(Debug, Default)]
pub struct Loaded {
    pub resources: Resources,
    pub applied_seq: u64,
    pub cluster_id: Option<String>,
}

fn key(kind: &str, id: &str) -> String {
    format!("{kind}/{id}")
}

impl Cache {
    /// Opens the cache under `data_dir`. A cache written in another format is
    /// emptied: the node will snapshot instead.
    pub fn open(data_dir: &str) -> anyhow::Result<(Self, Loaded)> {
        let path = Path::new(data_dir).join("config");
        std::fs::create_dir_all(&path)?;
        let keyspace = Keyspace::open(FjallConfig::new(&path))?;
        let resources = keyspace.open_partition("resources", Default::default())?;
        let meta = keyspace.open_partition("meta", Default::default())?;
        let cache = Self { keyspace, resources, meta };

        let format = cache.meta_get(META_FORMAT)?.and_then(|v| v.parse::<u32>().ok());
        if format != Some(FORMAT_VERSION) {
            if format.is_some() {
                tracing::warn!(found = ?format, expected = FORMAT_VERSION, "config cache is in another format; discarding it");
            }
            cache.clear()?;
            cache.meta.insert(META_FORMAT, FORMAT_VERSION.to_string())?;
            return Ok((cache, Loaded::default()));
        }

        let mut loaded = Loaded {
            applied_seq: cache.meta_get(META_SEQ)?.and_then(|v| v.parse().ok()).unwrap_or(0),
            cluster_id: cache.meta_get(META_CLUSTER)?,
            ..Default::default()
        };
        for item in cache.resources.iter() {
            let (_, value) = item?;
            // An entry that no longer decodes is skipped; the next resync replaces it.
            if let Ok(event) = serde_json::from_slice::<ChangeEvent>(&value) {
                loaded.resources.apply(&event);
            }
        }
        Ok((cache, loaded))
    }

    fn meta_get(&self, name: &str) -> anyhow::Result<Option<String>> {
        Ok(self.meta.get(name)?.map(|v| String::from_utf8_lossy(&v).into_owned()))
    }

    fn clear(&self) -> anyhow::Result<()> {
        for item in self.resources.iter() {
            let (k, _) = item?;
            self.resources.remove(k)?;
        }
        self.meta.remove(META_SEQ)?;
        self.meta.remove(META_CLUSTER)?;
        Ok(())
    }

    /// Records one applied event and the position it brings the node to, atomically.
    pub fn record(&self, seq: u64, event: &ChangeEvent) -> anyhow::Result<()> {
        let mut batch = self.keyspace.batch();
        let k = key(&event.kind, &event.id);
        match event.op.as_str() {
            "upsert" => batch.insert(&self.resources, k, serde_json::to_vec(event)?),
            "delete" => batch.remove(&self.resources, k),
            _ => {}
        }
        batch.insert(&self.meta, META_SEQ, seq.to_string());
        batch.commit()?;
        Ok(())
    }

    /// Moves the position without changing any resource (a skipped event).
    pub fn checkpoint(&self, seq: u64) -> anyhow::Result<()> {
        self.meta.insert(META_SEQ, seq.to_string())?;
        Ok(())
    }

    /// Replaces everything with a snapshot taken at `seq` from control plane `cluster_id`.
    pub fn replace(&self, cluster_id: &str, seq: u64, resources: &Resources) -> anyhow::Result<()> {
        self.clear()?;
        let mut batch = self.keyspace.batch();
        for event in resources.to_events() {
            batch.insert(&self.resources, key(&event.kind, &event.id), serde_json::to_vec(&event)?);
        }
        batch.insert(&self.meta, META_CLUSTER, cluster_id);
        batch.insert(&self.meta, META_SEQ, seq.to_string());
        batch.insert(&self.meta, META_FORMAT, FORMAT_VERSION.to_string());
        batch.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn ev(kind: &str, id: &str, revision: u64) -> ChangeEvent {
        ChangeEvent { revision: Some(revision), ..ChangeEvent::upsert(kind, id, Some("ws".into()), json!({ "name": id })) }
    }

    fn dir(t: &TempDir) -> &str {
        t.path().to_str().unwrap()
    }

    #[test]
    fn a_new_cache_is_empty() {
        let t = TempDir::new().unwrap();
        let (_c, loaded) = Cache::open(dir(&t)).unwrap();
        assert_eq!((loaded.applied_seq, loaded.cluster_id.clone(), loaded.resources.count("route")), (0, None, 0));
    }

    #[test]
    fn what_is_recorded_survives_a_restart() {
        let t = TempDir::new().unwrap();
        {
            let (c, _) = Cache::open(dir(&t)).unwrap();
            let mut snapshot = Resources::new();
            snapshot.apply(&ev("service", "s1", 1));
            c.replace("cluster-a", 10, &snapshot).unwrap();
            c.record(11, &ev("route", "r1", 1)).unwrap();
            c.record(12, &ev("route", "r2", 1)).unwrap();
            c.record(13, &ChangeEvent { v: 2, kind: "route".into(), op: "delete".into(), id: "r1".into(), workspace_id: Some("ws".into()), revision: None, data: None }).unwrap();
            c.checkpoint(14).unwrap();
        }
        let (_c, loaded) = Cache::open(dir(&t)).unwrap();
        assert_eq!(loaded.applied_seq, 14);
        assert_eq!(loaded.cluster_id.as_deref(), Some("cluster-a"));
        assert_eq!(loaded.resources.count("service"), 1);
        assert!(loaded.resources.get("route", "r2").is_some());
        assert!(loaded.resources.get("route", "r1").is_none());
    }

    #[test]
    fn replace_discards_what_was_there() {
        let t = TempDir::new().unwrap();
        let (c, _) = Cache::open(dir(&t)).unwrap();
        c.record(5, &ev("route", "old", 1)).unwrap();
        let mut fresh = Resources::new();
        fresh.apply(&ev("route", "new", 1));
        c.replace("cluster-b", 2, &fresh).unwrap();
        drop(c);
        let (_c, loaded) = Cache::open(dir(&t)).unwrap();
        assert!(loaded.resources.get("route", "old").is_none());
        assert!(loaded.resources.get("route", "new").is_some());
        // the position may go backwards across a resync; it is the snapshot's
        assert_eq!((loaded.applied_seq, loaded.cluster_id.as_deref()), (2, Some("cluster-b")));
    }

    // spec DP-7: an older or newer binary must not guess at a layout it does not know.
    #[test]
    fn a_cache_in_another_format_is_discarded() {
        let t = TempDir::new().unwrap();
        {
            let (c, _) = Cache::open(dir(&t)).unwrap();
            c.record(7, &ev("route", "r1", 1)).unwrap();
            c.meta.insert(META_FORMAT, "999").unwrap();
        }
        let (_c, loaded) = Cache::open(dir(&t)).unwrap();
        assert_eq!((loaded.applied_seq, loaded.resources.count("route")), (0, 0));
        drop(_c);
        // and it is usable again afterwards
        let (c, _) = Cache::open(dir(&t)).unwrap();
        c.record(1, &ev("route", "r2", 1)).unwrap();
        drop(c);
        assert_eq!(Cache::open(dir(&t)).unwrap().1.resources.count("route"), 1);
    }
}
