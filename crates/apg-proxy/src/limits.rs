//! Request-rate and bandwidth limiting (spec §9.4: `rate_limit`, `bandwidth_limit`).
//!
//! Both are token buckets held per node. A fleet of N nodes therefore allows
//! up to N times the configured rate; the plugin documentation says so.
//!
//! Bucket maps are bounded: idle buckets are evicted, so a limit scoped to
//! `ip` cannot grow memory without limit (spec NFR-8).

use std::time::{Duration, Instant};

use dashmap::DashMap;
use parking_lot::Mutex;
use serde_json::Value;

use crate::upstream::hash_parts;

/// What a limit is counted against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Workspace,
    Consumer,
    Ip,
    Route,
    Global,
    /// The request's host, so each host a route serves has its own budget.
    Host,
    /// The first n segments of the path.
    PathPrefix(usize),
    Header(String),
}

impl Scope {
    /// Parses a scope. Unknown text falls back to `workspace`; configuration
    /// is schema-validated before it gets here, so this only guards decoding.
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("consumer") => Scope::Consumer,
            Some("ip") => Scope::Ip,
            Some("route") => Scope::Route,
            Some("global") => Scope::Global,
            Some("host") => Scope::Host,
            Some(other) => {
                if let Some(name) = other.strip_prefix("header:") {
                    Scope::Header(name.to_ascii_lowercase())
                } else if let Some(n) = other.strip_prefix("path_prefix:").and_then(|n| n.parse().ok()) {
                    Scope::PathPrefix(n)
                } else {
                    Scope::Workspace
                }
            }
            None => Scope::Workspace,
        }
    }
}

/// The facts a limit key can be built from.
pub struct Subject<'a> {
    pub plugin_id: &'a str,
    pub route_id: &'a str,
    pub workspace_id: &'a str,
    pub consumer_id: Option<&'a str>,
    pub client_ip: &'a str,
    /// The request's host, without a port.
    pub host: &'a str,
    /// The normalised path.
    pub path: &'a str,
    pub header: &'a dyn Fn(&str) -> Option<String>,
}

/// The first `n` segments of `path`: `/v1/db1/tables` with 2 is `/v1/db1`.
pub fn path_prefix(path: &str, n: usize) -> String {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).take(n).collect();
    format!("/{}", segments.join("/"))
}

/// The bucket key for a scope. Every key starts with the plugin instance, so
/// two instances never share a bucket, and includes the workspace, so two
/// tenants never do either.
pub fn bucket_key(scope: &Scope, s: &Subject<'_>) -> String {
    let who = match scope {
        Scope::Workspace => "ws".to_string(),
        // An unauthenticated request shares one bucket per workspace rather than escaping the limit.
        Scope::Consumer => format!("consumer:{}", s.consumer_id.unwrap_or("-")),
        Scope::Ip => format!("ip:{}", s.client_ip),
        Scope::Route => format!("route:{}", s.route_id),
        Scope::Global => return format!("{}|global", s.plugin_id),
        Scope::Host => format!("host:{}", s.host),
        Scope::PathPrefix(n) => format!("path:{}", path_prefix(s.path, *n)),
        // A header often carries a credential; only a hash of it is kept in memory.
        Scope::Header(name) => match (s.header)(name) {
            Some(value) => format!("header:{:016x}", hash_parts(&[&value])),
            None => "header:-".to_string(),
        },
    };
    format!("{}|{}|{}", s.plugin_id, s.workspace_id, who)
}

/// Parsed `rate_limit` configuration. Defaults equal `schemas/plugins/rate_limit.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimitConfig {
    pub per_second: f64,
    pub burst: f64,
    pub scope: Scope,
    pub response_headers: bool,
}

impl RateLimitConfig {
    pub fn from_json(v: &Value) -> Self {
        Self {
            per_second: v.get("per_second").and_then(Value::as_f64).unwrap_or(100.0),
            burst: v.get("burst").and_then(Value::as_f64).unwrap_or(200.0),
            scope: Scope::parse(v.get("scope").and_then(Value::as_str)),
            response_headers: v.get("response_headers").and_then(Value::as_bool).unwrap_or(true),
        }
    }
}

/// Parsed `bandwidth_limit` configuration. Defaults equal `schemas/plugins/bandwidth_limit.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct BandwidthConfig {
    pub bytes_per_second: f64,
    pub burst_bytes: f64,
    pub scope: Scope,
}

impl BandwidthConfig {
    pub fn from_json(v: &Value) -> Self {
        Self {
            bytes_per_second: v.get("bytes_per_second").and_then(Value::as_f64).unwrap_or(5_000_000.0),
            burst_bytes: v.get("burst_bytes").and_then(Value::as_f64).unwrap_or(20_000_000.0),
            scope: Scope::parse(v.get("scope").and_then(Value::as_str)),
        }
    }
}

struct Bucket {
    level: f64,
    refilled: Instant,
}

/// The outcome of a rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Decision {
    pub allowed: bool,
    /// Whole requests still available.
    pub remaining: u64,
    /// Seconds until one request is available again.
    pub retry_after_secs: u64,
}

/// Token buckets shared by both limiters.
pub struct Buckets {
    map: DashMap<String, Mutex<Bucket>>,
    max_entries: usize,
    idle: Duration,
    last_sweep: Mutex<Instant>,
}

impl Default for Buckets {
    fn default() -> Self {
        Self::new(200_000, Duration::from_secs(600))
    }
}

impl Buckets {
    pub fn new(max_entries: usize, idle: Duration) -> Self {
        Self { map: DashMap::new(), max_entries, idle, last_sweep: Mutex::new(Instant::now()) }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    fn with<T>(&self, key: &str, capacity: f64, rate: f64, f: impl FnOnce(&mut Bucket) -> T) -> T {
        self.sweep_if_due();
        let entry = self.map.entry(key.to_string()).or_insert_with(|| Mutex::new(Bucket { level: capacity, refilled: Instant::now() }));
        let mut b = entry.lock();
        let now = Instant::now();
        b.level = (b.level + now.duration_since(b.refilled).as_secs_f64() * rate).min(capacity);
        b.refilled = now;
        f(&mut b)
    }

    /// Drops buckets nobody has touched for a while. Runs at most once every
    /// ten seconds, or immediately when the map is over its cap. A dropped
    /// bucket restarts full, which is what an idle bucket would have refilled to anyway.
    fn sweep_if_due(&self) {
        let over = self.map.len() >= self.max_entries;
        {
            let mut last = self.last_sweep.lock();
            if !over && last.elapsed() < Duration::from_secs(10) {
                return;
            }
            *last = Instant::now();
        }
        let idle = self.idle;
        self.map.retain(|_, b| b.lock().refilled.elapsed() < idle);
        if self.map.len() >= self.max_entries {
            // Still full of active buckets: shed the least recently used half rather than grow.
            let mut ages: Vec<Duration> = self.map.iter().map(|e| e.value().lock().refilled.elapsed()).collect();
            ages.sort_unstable();
            let cut = ages[ages.len() / 2];
            self.map.retain(|_, b| b.lock().refilled.elapsed() < cut);
        }
    }

    /// Takes one request token.
    pub fn take_request(&self, key: &str, cfg: &RateLimitConfig) -> Decision {
        self.with(key, cfg.burst, cfg.per_second, |b| {
            let allowed = b.level >= 1.0;
            if allowed {
                b.level -= 1.0;
            }
            let retry_after_secs = if allowed || cfg.per_second <= 0.0 { 0 } else { ((1.0 - b.level) / cfg.per_second).ceil().max(1.0) as u64 };
            Decision { allowed, remaining: b.level.max(0.0).floor() as u64, retry_after_secs }
        })
    }

    /// Bandwidth admission: allowed while the byte budget is above zero. The
    /// cost of this request is not known yet, so nothing is taken here.
    pub fn admit_bytes(&self, key: &str, cfg: &BandwidthConfig) -> bool {
        self.with(key, cfg.burst_bytes, cfg.bytes_per_second, |b| b.level > 0.0)
    }

    /// Charges the bytes a finished request actually transferred. The budget
    /// may go negative; it refills over time.
    pub fn debit_bytes(&self, key: &str, cfg: &BandwidthConfig, bytes: u64) {
        self.with(key, cfg.burst_bytes, cfg.bytes_per_second, |b| b.level -= bytes as f64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rl(per_second: f64, burst: f64) -> RateLimitConfig {
        RateLimitConfig { per_second, burst, scope: Scope::Workspace, response_headers: true }
    }

    fn bw(bps: f64, burst: f64) -> BandwidthConfig {
        BandwidthConfig { bytes_per_second: bps, burst_bytes: burst, scope: Scope::Workspace }
    }

    #[test]
    fn config_defaults_equal_the_schema_defaults() {
        let schema: Value = serde_json::from_str(include_str!("../../../schemas/plugins/rate_limit.json")).unwrap();
        let d = RateLimitConfig::from_json(&json!({}));
        assert_eq!(d.per_second, schema["properties"]["per_second"]["default"].as_f64().unwrap());
        assert_eq!(d.burst, schema["properties"]["burst"]["default"].as_f64().unwrap());
        assert_eq!(d.response_headers, schema["properties"]["response_headers"]["default"].as_bool().unwrap());
        assert_eq!(d.scope, Scope::parse(schema["properties"]["scope"]["default"].as_str()));

        let schema: Value = serde_json::from_str(include_str!("../../../schemas/plugins/bandwidth_limit.json")).unwrap();
        let d = BandwidthConfig::from_json(&json!({}));
        assert_eq!(d.bytes_per_second, schema["properties"]["bytes_per_second"]["default"].as_f64().unwrap());
        assert_eq!(d.burst_bytes, schema["properties"]["burst_bytes"]["default"].as_f64().unwrap());
    }

    #[test]
    fn scopes_parse() {
        assert_eq!(Scope::parse(Some("ip")), Scope::Ip);
        assert_eq!(Scope::parse(Some("header:X-Team")), Scope::Header("x-team".into()));
        assert_eq!(Scope::parse(Some("consumer")), Scope::Consumer);
        assert_eq!(Scope::parse(Some("host")), Scope::Host);
        assert_eq!(Scope::parse(Some("path_prefix:2")), Scope::PathPrefix(2));
        assert_eq!(Scope::parse(None), Scope::Workspace);
    }

    #[test]
    fn keys_never_collide_across_plugins_or_workspaces() {
        let h = |n: &str| (n == "x-team").then(|| "blue".to_string());
        let s = |plugin: &'static str, ws: &'static str| Subject { plugin_id: plugin, route_id: "r", workspace_id: ws, consumer_id: Some("c1"), client_ip: "1.2.3.4", host: "db1.example.com", path: "/v1/db1/tables/t", header: &h };
        for scope in [Scope::Workspace, Scope::Consumer, Scope::Ip, Scope::Route, Scope::Host, Scope::PathPrefix(2), Scope::Header("x-team".into())] {
            assert_ne!(bucket_key(&scope, &s("p1", "a")), bucket_key(&scope, &s("p1", "b")), "{scope:?} must separate workspaces");
            assert_ne!(bucket_key(&scope, &s("p1", "a")), bucket_key(&scope, &s("p2", "a")), "{scope:?} must separate plugin instances");
        }
        assert_eq!(bucket_key(&Scope::Global, &s("p1", "a")), bucket_key(&Scope::Global, &s("p1", "b")));
        assert!(bucket_key(&Scope::Ip, &s("p1", "a")).ends_with("ip:1.2.3.4"));
        assert!(bucket_key(&Scope::Host, &s("p1", "a")).ends_with("host:db1.example.com"));
        assert!(bucket_key(&Scope::PathPrefix(2), &s("p1", "a")).ends_with("path:/v1/db1"));
        // A header value is kept only as a hash, never as itself.
        let header_key = bucket_key(&Scope::Header("x-team".into()), &s("p1", "a"));
        assert!(!header_key.contains("blue") && header_key.contains("header:"), "{header_key}");
        assert_ne!(header_key, bucket_key(&Scope::Header("x-other".into()), &s("p1", "a")), "no value is not the same as a value");
    }

    #[test]
    fn path_prefixes_take_whole_segments() {
        assert_eq!(path_prefix("/v1/db1/tables/t", 2), "/v1/db1");
        assert_eq!(path_prefix("/v1/db1/tables/t", 9), "/v1/db1/tables/t");
        assert_eq!(path_prefix("/", 1), "/");
        assert_eq!(path_prefix("/a//b", 2), "/a/b");
    }

    #[test]
    fn allows_a_burst_then_refuses_and_reports_what_is_left() {
        let b = Buckets::default();
        let c = rl(0.0, 3.0);
        assert_eq!(b.take_request("k", &c), Decision { allowed: true, remaining: 2, retry_after_secs: 0 });
        assert!(b.take_request("k", &c).allowed);
        assert_eq!(b.take_request("k", &c).remaining, 0);
        assert!(!b.take_request("k", &c).allowed);
        assert!(b.take_request("other", &c).allowed, "keys are independent");
    }

    #[test]
    fn refills_over_time_and_says_when_to_retry() {
        let b = Buckets::default();
        let c = rl(50.0, 1.0);
        assert!(b.take_request("k", &c).allowed);
        let refused = b.take_request("k", &c);
        assert!(!refused.allowed);
        assert_eq!(refused.retry_after_secs, 1);
        std::thread::sleep(Duration::from_millis(60));
        assert!(b.take_request("k", &c).allowed);
    }

    #[test]
    fn bandwidth_admits_until_the_budget_is_spent_then_recovers() {
        let b = Buckets::default();
        let c = bw(100_000.0, 1_000.0);
        assert!(b.admit_bytes("k", &c));
        b.debit_bytes("k", &c, 3_000);
        assert!(!b.admit_bytes("k", &c), "a budget driven negative refuses admission");
        assert!(b.admit_bytes("other", &c));
        std::thread::sleep(Duration::from_millis(60));
        assert!(b.admit_bytes("k", &c), "2000 bytes of debt refill in 20 ms at 100 kB/s");
    }

    // spec NFR-8: a limit keyed by client address must not grow memory without bound.
    #[test]
    fn the_bucket_map_stays_bounded() {
        let b = Buckets::new(1_000, Duration::from_secs(600));
        let c = rl(1.0, 1.0);
        for i in 0..10_000 {
            b.take_request(&format!("ip:{i}"), &c);
        }
        assert!(b.len() <= 1_000, "{} buckets", b.len());
    }

    #[test]
    fn idle_buckets_are_evicted() {
        let b = Buckets::new(10, Duration::from_millis(20));
        let c = rl(1.0, 1.0);
        for i in 0..9 {
            b.take_request(&format!("k{i}"), &c);
        }
        std::thread::sleep(Duration::from_millis(40));
        // the next insert finds the map at its cap and sweeps the idle ones
        b.take_request("k9", &c);
        b.take_request("fresh", &c);
        assert!(b.len() <= 2, "{} buckets", b.len());
    }
}
