//! The `api_poll` config source (spec §5.3): poll an HTTP endpoint that serves
//! the config contract.
//!
//! The endpoint may be the bundled admin or anything else that answers
//! `GET /changes` and `GET /snapshot` the same way (spec CFG-12a). The node
//! holds no database connection in this mode.

use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;

use crate::applier::{Applier, parse_snapshot};
use crate::gateway::Gateway;
use crate::metrics;

/// Ceiling of the retry delay. The node keeps serving what it has throughout,
/// so backing off costs nothing; hammering a struggling control plane would.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct ApiSourceConfig {
    /// Base URL of the config API; `/changes` and `/snapshot` are appended.
    pub url: String,
    pub token: Option<String>,
    pub poll_interval: Duration,
    pub poll_limit: u32,
    /// Long-poll wait. Zero polls at `poll_interval` instead.
    pub wait: Duration,
    pub node_id: String,
    pub region: Option<String>,
    /// Client certificate, key and CA bundle for mutual TLS to the endpoint.
    pub client_identity: Option<(String, String)>,
    pub ca_file: Option<String>,
}

#[derive(Deserialize)]
struct ChangeRow {
    seq: u64,
    data: Value,
}

#[derive(Deserialize)]
struct ChangesResponse {
    changes: Vec<ChangeRow>,
    #[serde(default)]
    has_more: bool,
}

/// What one poll decided.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// Rows were applied and more are waiting: ask again at once.
    More,
    /// Caught up.
    Drained,
    /// The position is gone, or the control plane changed: take a snapshot.
    Resync(&'static str),
}

pub struct ApiSource {
    pub config: ApiSourceConfig,
    pub applier: Arc<Applier>,
    pub gateway: Arc<Gateway>,
    client: reqwest::Client,
}

fn build_client(config: &ApiSourceConfig) -> anyhow::Result<reqwest::Client> {
    // The request must outlive the long poll it carries.
    let mut builder = reqwest::Client::builder().timeout(config.wait + Duration::from_secs(15)).connect_timeout(Duration::from_secs(5));
    if let Some(ca) = &config.ca_file {
        let pem = std::fs::read(ca).map_err(|e| anyhow::anyhow!("APG_CONFIG_CLIENT_CA: cannot read '{ca}': {e}"))?;
        builder = builder.add_root_certificate(reqwest::Certificate::from_pem(&pem).map_err(|e| anyhow::anyhow!("APG_CONFIG_CLIENT_CA: {e}"))?);
    }
    if let Some((cert, key)) = &config.client_identity {
        let cert_pem = std::fs::read(cert).map_err(|e| anyhow::anyhow!("APG_CONFIG_CLIENT_CERT: cannot read '{cert}': {e}"))?;
        let key_pem = std::fs::read(key).map_err(|e| anyhow::anyhow!("APG_CONFIG_CLIENT_KEY: cannot read '{key}': {e}"))?;
        builder = builder.identity(reqwest::Identity::from_pkcs8_pem(&cert_pem, &key_pem).map_err(|e| anyhow::anyhow!("client certificate: {e}"))?);
    }
    Ok(builder.build()?)
}

impl ApiSource {
    pub fn new(config: ApiSourceConfig, applier: Arc<Applier>, gateway: Arc<Gateway>) -> anyhow::Result<Self> {
        let client = build_client(&config)?;
        Ok(Self { config, applier, gateway, client })
    }

    /// The HTTP client configured for this control plane (its CA and client certificate).
    pub fn client(&self) -> reqwest::Client {
        self.client.clone()
    }

    fn base(&self) -> &str {
        self.config.url.trim_end_matches('/')
    }

    fn get(&self, url: String) -> reqwest::RequestBuilder {
        let req = self.client.get(url);
        match &self.config.token {
            Some(t) => req.bearer_auth(t),
            None => req,
        }
    }

    async fn snapshot(&self, reason: &'static str) -> anyhow::Result<()> {
        let res = self.get(format!("{}/snapshot", self.base())).send().await?;
        if !res.status().is_success() {
            anyhow::bail!("snapshot request returned {}", res.status());
        }
        let parsed = parse_snapshot(&res.text().await?).map_err(|e| anyhow::anyhow!(e))?;
        self.applier.replace(parsed, reason)
    }

    /// One poll.
    pub async fn poll_once(&self) -> anyhow::Result<Step> {
        let since = self.applier.seq();
        let url = format!("{}/changes?since={since}&limit={}&wait_ms={}", self.base(), self.config.poll_limit, self.config.wait.as_millis());
        let res = self.get(url).send().await?;

        // A node pointed at a different control plane must not trust its position (spec CFG-10).
        if let (Some(theirs), Some(ours)) = (res.headers().get("x-apg-cluster-id").and_then(|v| v.to_str().ok()), self.applier.cluster_id())
            && theirs != ours
        {
            tracing::warn!(ours, theirs, "the config source is a different control plane; resyncing");
            return Ok(Step::Resync("cluster_changed"));
        }

        match res.status() {
            // Alive, nothing new.
            StatusCode::NO_CONTENT => Ok(Step::Drained),
            StatusCode::GONE => Ok(Step::Resync("position_gone")),
            StatusCode::OK => {
                let body: ChangesResponse = res.json().await?;
                let rows: Vec<(u64, Value)> = body.changes.into_iter().map(|c| (c.seq, c.data)).collect();
                self.applier.apply_batch(&rows)?;
                Ok(if body.has_more { Step::More } else { Step::Drained })
            }
            other => anyhow::bail!("changes request returned {other}"),
        }
    }

    /// Runs until the process exits. On any failure the node keeps serving what
    /// it has: clearing routes because the control plane is unreachable would
    /// turn a control-plane outage into a total one.
    pub async fn run(self: Arc<Self>) {
        tracing::info!(url = %self.base(), wait_ms = self.config.wait.as_millis() as u64, "config source: api_poll");
        let mut backoff = self.config.poll_interval;
        let mut resync: Option<&'static str> = self.applier.cluster_id().is_none().then_some("empty_cache");
        loop {
            let outcome = match resync {
                Some(reason) => self.snapshot(reason).await.map(|()| Step::More),
                None => self.poll_once().await,
            };
            match outcome {
                Ok(step) => {
                    self.gateway.health.mark_alive();
                    backoff = self.config.poll_interval;
                    match step {
                        Step::More => resync = None,
                        Step::Drained => {
                            resync = None;
                            self.gateway.health.mark_converged();
                            // With long polling the wait happened on the server.
                            if self.config.wait.is_zero() {
                                tokio::time::sleep(self.config.poll_interval).await;
                            }
                        }
                        Step::Resync(reason) => resync = Some(reason),
                    }
                }
                Err(e) => {
                    metrics::CHANGELOG_ERRORS.with_label_values(&["poll_error"]).inc();
                    tracing::warn!(error = %e, retry_in_ms = backoff.as_millis() as u64, "config source unreachable; still serving the last configuration");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    }

    /// Reports this node to the control plane every ten seconds (spec OBS-4).
    /// Optional in the contract: an endpoint that answers 404 is not asked again.
    pub async fn heartbeat(self: Arc<Self>, admin_url: String) {
        let started = chrono_now();
        let url = format!("{}/heartbeat", admin_url.trim_end_matches('/'));
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tick.tick().await;
            let r = self.gateway.health.readiness();
            let snap = self.gateway.snapshot();
            let body = serde_json::json!({
                "node_id": self.config.node_id,
                "version": env!("CARGO_PKG_VERSION"),
                "source": self.gateway.source,
                "applied_seq": self.gateway.applied_seq(),
                "stale": r.stale,
                "region": self.config.region,
                "started_at": started,
                "counts": { "routes": snap.route_count(), "services": snap.service_count(), "workspaces": snap.workspace_count() },
            });
            let req = self.client.post(&url).timeout(Duration::from_secs(5)).json(&body);
            let req = match &self.config.token {
                Some(t) => req.bearer_auth(t),
                None => req,
            };
            match req.send().await {
                Ok(res) if res.status() == StatusCode::NOT_FOUND => {
                    tracing::info!("the config source offers no heartbeat endpoint; not reporting");
                    return;
                }
                Ok(_) => {}
                Err(e) => tracing::debug!(error = %e, "heartbeat failed"),
            }
        }
    }
}

/// RFC 3339 timestamp of now, without pulling in a date library.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tls::TlsStore;
    use std::sync::Mutex;
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A scripted control plane: answers each request with the next canned response
    /// and records the request line it saw.
    type Canned = (u16, Vec<(&'static str, String)>, String);

    async fn fake(responses: Vec<Canned>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            for (status, headers, body) in responses {
                let Ok((mut s, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                log.lock().unwrap().push(text.lines().next().unwrap_or("").to_string() + " | " + text.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization")).unwrap_or(""));
                let extra: String = headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
                let reason = match status { 200 => "OK", 204 => "No Content", 410 => "Gone", _ => "Error" };
                let head = format!("HTTP/1.1 {status} {reason}\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n", body.len());
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(body.as_bytes()).await;
            }
        });
        (format!("http://{addr}/dp"), seen)
    }

    fn source(dir: &TempDir, url: String) -> (Arc<ApiSource>, Arc<Gateway>) {
        let gateway = Gateway::new("n1".into(), "api_poll", 30);
        let applier = Arc::new(Applier::open(dir.path().to_str().unwrap(), gateway.clone(), Arc::new(TlsStore::new(None).unwrap())).unwrap());
        let config = ApiSourceConfig { url, token: Some("node-token".into()), poll_interval: Duration::from_millis(10), poll_limit: 500, wait: Duration::ZERO, node_id: "n1".into(), region: None, client_identity: None, ca_file: None };
        (Arc::new(ApiSource::new(config, applier, gateway.clone()).unwrap()), gateway)
    }

    fn snapshot(seq: u64, cluster: &str) -> String {
        format!(
            "{}\n{}\n{}\n",
            serde_json::json!({ "cluster_id": cluster, "seq": seq }),
            serde_json::json!({ "v": 2, "kind": "workspace", "op": "upsert", "id": "w", "revision": 1, "data": { "name": "default", "slug": "default", "system": true } }),
            serde_json::json!({ "v": 2, "kind": "service", "op": "upsert", "id": "s", "workspace_id": "w", "revision": 1, "data": { "name": "s", "backends": [{ "target": "a:1" }] } }),
        )
    }

    fn changes(rows: &[(u64, &str)], has_more: bool) -> String {
        let changes: Vec<Value> = rows.iter().map(|(seq, id)| serde_json::json!({ "seq": seq, "data": { "v": 2, "kind": "route", "op": "upsert", "id": id, "workspace_id": "w", "revision": 1, "data": { "name": id, "service": "s" } } })).collect();
        serde_json::json!({ "changes": changes, "last_seq": rows.last().map_or(0, |r| r.0), "has_more": has_more }).to_string()
    }

    #[tokio::test]
    async fn snapshot_then_polls_from_the_snapshot_position_with_the_token() {
        let dir = TempDir::new().unwrap();
        let (url, seen) = fake(vec![
            (200, vec![], snapshot(7, "c1")),
            (200, vec![("x-apg-cluster-id", "c1".into())], changes(&[(8, "r1"), (9, "r2")], true)),
            (204, vec![("x-apg-cluster-id", "c1".into())], String::new()),
        ])
        .await;
        let (src, gateway) = source(&dir, url);
        src.snapshot("empty_cache").await.unwrap();
        assert_eq!(src.applier.seq(), 7);
        assert_eq!(src.poll_once().await.unwrap(), Step::More);
        assert_eq!((src.applier.seq(), gateway.snapshot().route_count()), (9, 2));
        assert_eq!(src.poll_once().await.unwrap(), Step::Drained);

        let seen = seen.lock().unwrap();
        assert!(seen[0].starts_with("GET /dp/snapshot "), "{}", seen[0]);
        assert!(seen[1].starts_with("GET /dp/changes?since=7&limit=500&wait_ms=0 "), "{}", seen[1]);
        assert!(seen[2].starts_with("GET /dp/changes?since=9&"), "{}", seen[2]);
        assert!(seen.iter().all(|l| l.to_ascii_lowercase().contains("authorization: bearer node-token")), "{seen:?}");
    }

    #[tokio::test]
    async fn a_gone_position_and_a_different_control_plane_both_mean_resync() {
        let dir = TempDir::new().unwrap();
        let (url, _) = fake(vec![
            (200, vec![], snapshot(7, "c1")),
            (410, vec![("x-apg-cluster-id", "c1".into())], "{}".into()),
            (204, vec![("x-apg-cluster-id", "c2".into())], String::new()),
        ])
        .await;
        let (src, _) = source(&dir, url);
        src.snapshot("empty_cache").await.unwrap();
        assert_eq!(src.poll_once().await.unwrap(), Step::Resync("position_gone"));
        // "nothing new" from another control plane is not "caught up"
        assert_eq!(src.poll_once().await.unwrap(), Step::Resync("cluster_changed"));
    }

    // spec CFG-12: a failed poll must leave routing exactly as it was.
    #[tokio::test]
    async fn an_unreachable_or_failing_source_changes_nothing() {
        let dir = TempDir::new().unwrap();
        let (url, _) = fake(vec![
            (200, vec![], snapshot(7, "c1")),
            (200, vec![("x-apg-cluster-id", "c1".into())], changes(&[(8, "r1")], false)),
            (500, vec![], "boom".into()),
            (200, vec![("x-apg-cluster-id", "c1".into())], "this is not json".into()),
        ])
        .await;
        let (src, gateway) = source(&dir, url);
        src.snapshot("empty_cache").await.unwrap();
        src.poll_once().await.unwrap();
        assert_eq!(gateway.snapshot().route_count(), 1);
        assert!(src.poll_once().await.is_err(), "a 500 is an error");
        assert!(src.poll_once().await.is_err(), "a body that is not the contract is an error");
        assert!(src.poll_once().await.is_err(), "and so is a refused connection");
        assert_eq!((src.applier.seq(), gateway.snapshot().route_count()), (8, 1));
    }

    #[tokio::test]
    async fn a_bad_snapshot_is_not_half_applied() {
        let dir = TempDir::new().unwrap();
        let truncated = format!("{}\n{{\"v\": 2, \"kind\": \"wor", serde_json::json!({ "cluster_id": "c1", "seq": 3 }));
        let (url, _) = fake(vec![(200, vec![], truncated), (401, vec![], "{}".into())]).await;
        let (src, gateway) = source(&dir, url);
        assert!(src.snapshot("empty_cache").await.is_err());
        assert!(src.snapshot("empty_cache").await.is_err(), "an unauthorised snapshot is an error too");
        assert_eq!((src.applier.seq(), src.applier.cluster_id(), gateway.snapshot().service_count()), (0, None, 0));
        assert!(!gateway.health.readiness().ready);
    }

    #[test]
    fn timestamps_are_rfc3339() {
        let t = chrono_now();
        assert_eq!(t.len(), 20);
        assert!(t.ends_with('Z') && &t[4..5] == "-" && &t[10..11] == "T", "{t}");
        assert!(t[0..4].parse::<u32>().unwrap() >= 2025);
    }
}
