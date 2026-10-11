//! `response_cache`: an in-memory response cache, per node (spec §9.4).
//!
//! Bounded by `APG_CACHE_MEMORY_BYTES`. When full, entries not used since they
//! were last considered are dropped first (a clock, which approximates
//! least-recently-used without touching a shared list on every hit).

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use bytes::Bytes;
use parking_lot::Mutex;
use serde::Deserialize;

use crate::metrics;

fn d_ttl() -> u64 {
    60
}
fn d_true() -> bool {
    true
}
fn d_methods() -> Vec<String> {
    vec!["GET".into(), "HEAD".into()]
}
fn d_statuses() -> Vec<u16> {
    vec![200, 301, 404]
}
fn d_max_object() -> usize {
    1_048_576
}

#[derive(Debug, Clone, Deserialize)]
pub struct CacheConfig {
    #[serde(default = "d_ttl")]
    pub ttl_secs: u64,
    #[serde(default = "d_true")]
    pub respect_cache_control: bool,
    #[serde(default = "d_methods")]
    pub methods: Vec<String>,
    #[serde(default = "d_statuses")]
    pub statuses: Vec<u16>,
    #[serde(default)]
    pub vary_headers: Vec<String>,
    #[serde(default = "d_max_object")]
    pub max_object_bytes: usize,
    #[serde(default)]
    pub cache_authenticated: bool,
}

/// A stored response.
#[derive(Debug, Clone, PartialEq)]
pub struct Cached {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

struct Entry {
    response: Cached,
    expires: Instant,
    /// Set on every hit; cleared when eviction passes over the entry.
    used: bool,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    /// Keys in the order eviction considers them.
    clock: VecDeque<String>,
    bytes: usize,
}

pub struct ResponseCache {
    budget: std::sync::atomic::AtomicUsize,
    inner: Mutex<Inner>,
}

fn size_of(key: &str, response: &Cached) -> usize {
    key.len() + response.body.len() + response.headers.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() + 128
}

/// Headers that describe one connection or one exchange, not the response itself.
const NOT_STORED: &[&str] = &["connection", "keep-alive", "transfer-encoding", "content-length", "date", "set-cookie", "x-request-id", "x-apg-cache", "ratelimit-limit", "ratelimit-remaining", "x-quota-limit", "x-quota-remaining", "x-quota-reset"];

/// The response headers worth keeping with a cached response.
pub fn storable_headers(headers: &http::HeaderMap) -> Vec<(String, String)> {
    headers.iter().filter(|(name, _)| !NOT_STORED.contains(&name.as_str())).filter_map(|(name, value)| Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))).collect()
}

/// How long a response may be kept, given its `Cache-Control`, or `None` when
/// it must not be stored in a shared cache at all.
pub fn lifetime(config: &CacheConfig, cache_control: Option<&str>, has_set_cookie: bool) -> Option<Duration> {
    let default = Duration::from_secs(config.ttl_secs);
    if !config.respect_cache_control {
        return Some(default);
    }
    // A response that sets a cookie is for one client.
    if has_set_cookie {
        return None;
    }
    let directives: Vec<String> = cache_control.unwrap_or("").split(',').map(|d| d.trim().to_ascii_lowercase()).collect();
    if directives.iter().any(|d| matches!(d.as_str(), "no-store" | "private" | "no-cache")) {
        return None;
    }
    let seconds = |name: &str| directives.iter().find_map(|d| d.strip_prefix(name)?.parse::<u64>().ok());
    match seconds("s-maxage=").or_else(|| seconds("max-age=")) {
        Some(0) => None,
        Some(n) => Some(Duration::from_secs(n)),
        None => Some(default),
    }
}

/// The cache key (spec §9.4): what must be equal for two requests to share a response.
#[allow(clippy::too_many_arguments)]
pub fn key(instance_id: &str, route_tag: u64, workspace_id: &str, method: &str, host: &str, path: &str, query: &str, vary: &[(String, String)], consumer_id: Option<&str>) -> String {
    let mut params: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    params.sort_unstable();
    // HEAD is answered from the stored GET.
    let method = if method == "HEAD" { "GET" } else { method };
    let vary: String = vary.iter().map(|(name, value)| format!("{name}={value}\u{1}")).collect();
    format!("{instance_id}\u{0}{route_tag}\u{0}{workspace_id}\u{0}{method}\u{0}{host}\u{0}{path}\u{0}{}\u{0}{vary}\u{0}{}", params.join("&"), consumer_id.unwrap_or(""))
}

impl ResponseCache {
    pub fn new(budget_bytes: usize) -> Self {
        Self { budget: std::sync::atomic::AtomicUsize::new(budget_bytes), inner: Mutex::new(Inner::default()) }
    }

    /// Changes the memory budget (`APG_CACHE_MEMORY_BYTES`).
    pub fn set_budget(&self, bytes: usize) {
        self.budget.store(bytes, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn get(&self, key: &str) -> Option<Cached> {
        let mut inner = self.inner.lock();
        let entry = inner.entries.get_mut(key)?;
        if entry.expires <= Instant::now() {
            return None;
        }
        entry.used = true;
        Some(entry.response.clone())
    }

    /// Stores a response. One larger than the whole budget is not stored.
    pub fn put(&self, key: String, response: Cached, ttl: Duration) {
        let budget = self.budget.load(std::sync::atomic::Ordering::Relaxed);
        let size = size_of(&key, &response);
        if size > budget {
            return;
        }
        let mut inner = self.inner.lock();
        if let Some(old) = inner.entries.remove(&key) {
            inner.bytes -= size_of(&key, &old.response);
        } else {
            inner.clock.push_back(key.clone());
        }
        inner.bytes += size;
        inner.entries.insert(key, Entry { response, expires: Instant::now() + ttl, used: false });

        // Make room: expired entries and those not used since last considered go first.
        let now = Instant::now();
        let mut passes = inner.clock.len() * 2;
        while inner.bytes > budget && passes > 0 {
            passes -= 1;
            let Some(candidate) = inner.clock.pop_front() else { break };
            let keep = match inner.entries.get_mut(&candidate) {
                None => continue,
                Some(entry) if entry.used && entry.expires > now => {
                    entry.used = false;
                    true
                }
                Some(_) => false,
            };
            if keep {
                inner.clock.push_back(candidate);
            } else if let Some(gone) = inner.entries.remove(&candidate) {
                inner.bytes -= size_of(&candidate, &gone.response);
            }
        }
        metrics::CACHE_BYTES.set(inner.bytes as i64);
    }

    pub fn len(&self) -> usize {
        self.inner.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn bytes(&self) -> usize {
        self.inner.lock().bytes
    }
}

/// Status, headers and lifetime of a response that may be stored.
pub type Storable = (u16, Vec<(String, String)>, Duration);

/// A response being collected for the cache.
pub struct Pending {
    pub key: String,
    pub config: CacheConfig,
    /// Set once the response headers allow storing.
    pub store: Option<Storable>,
    body: Vec<u8>,
    too_large: bool,
}

impl Pending {
    pub fn new(key: String, config: CacheConfig) -> Self {
        Self { key, config, store: None, body: Vec::new(), too_large: false }
    }

    /// Notes one body chunk as it is sent to the client. At the end, returns
    /// the response to store, if it stayed within the size limit.
    pub fn feed(&mut self, chunk: Option<&Bytes>, end: bool) -> Option<(Cached, Duration)> {
        let (status, headers, ttl) = self.store.as_ref()?;
        if let Some(c) = chunk {
            if self.body.len() + c.len() > self.config.max_object_bytes {
                self.too_large = true;
                self.body = Vec::new();
            } else if !self.too_large {
                self.body.extend_from_slice(c);
            }
        }
        (end && !self.too_large).then(|| (Cached { status: *status, headers: headers.clone(), body: Bytes::from(std::mem::take(&mut self.body)) }, *ttl))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(extra: serde_json::Value) -> CacheConfig {
        serde_json::from_value(extra).unwrap()
    }

    fn response(body: &str) -> Cached {
        Cached { status: 200, headers: vec![("content-type".into(), "text/plain".into())], body: Bytes::from(body.to_string()) }
    }

    #[test]
    fn stores_serves_and_expires() {
        let cache = ResponseCache::new(1 << 20);
        assert!(cache.get("k").is_none());
        cache.put("k".into(), response("hello"), Duration::from_secs(60));
        assert_eq!(cache.get("k").unwrap().body, "hello");
        cache.put("gone".into(), response("old"), Duration::ZERO);
        assert!(cache.get("gone").is_none(), "an expired entry is never served");
        // Storing again replaces, and the size is accounted once.
        let before = cache.bytes();
        cache.put("k".into(), response("hello"), Duration::from_secs(60));
        assert_eq!(cache.bytes(), before);
    }

    #[test]
    fn stays_within_its_budget_and_keeps_what_is_in_use() {
        let one = size_of("key-00", &response(&"x".repeat(1000)));
        let cache = ResponseCache::new(one * 5);
        for i in 0..5 {
            cache.put(format!("key-{i:02}"), response(&"x".repeat(1000)), Duration::from_secs(60));
        }
        assert_eq!(cache.len(), 5);
        // Two entries are read; then five more arrive.
        assert!(cache.get("key-01").is_some() && cache.get("key-03").is_some());
        for i in 5..8 {
            cache.put(format!("key-{i:02}"), response(&"x".repeat(1000)), Duration::from_secs(60));
        }
        assert!(cache.bytes() <= one * 5);
        assert!(cache.get("key-01").is_some() && cache.get("key-03").is_some(), "entries in use survive");
        assert!(cache.get("key-00").is_none() && cache.get("key-02").is_none(), "unused ones made room");
        // Larger than the whole cache: not stored, nothing evicted for it.
        let len = cache.len();
        cache.put("huge".into(), response(&"x".repeat(one * 6)), Duration::from_secs(60));
        assert!(cache.get("huge").is_none());
        assert_eq!(cache.len(), len);
    }

    #[test]
    fn cache_control_is_respected_unless_told_otherwise() {
        let c = config(json!({ "ttl_secs": 30 }));
        assert_eq!(lifetime(&c, None, false), Some(Duration::from_secs(30)));
        assert_eq!(lifetime(&c, Some("public, max-age=120"), false), Some(Duration::from_secs(120)));
        assert_eq!(lifetime(&c, Some("max-age=120, s-maxage=10"), false), Some(Duration::from_secs(10)));
        for forbidden in ["no-store", "private, max-age=60", "no-cache", "max-age=0", "Private"] {
            assert_eq!(lifetime(&c, Some(forbidden), false), None, "{forbidden}");
        }
        assert_eq!(lifetime(&c, None, true), None, "a response that sets a cookie is for one client");
        let blunt = config(json!({ "ttl_secs": 30, "respect_cache_control": false }));
        assert_eq!(lifetime(&blunt, Some("no-store"), true), Some(Duration::from_secs(30)));
    }

    #[test]
    fn the_key_separates_what_must_not_be_shared() {
        let base = |query: &str, vary: &[(String, String)], consumer: Option<&str>| key("p1", 7, "w1", "GET", "api.example.com", "/items", query, vary, consumer);
        assert_eq!(base("a=1&b=2", &[], None), base("b=2&a=1", &[], None), "parameter order does not matter");
        assert_eq!(key("p1", 7, "w1", "HEAD", "api.example.com", "/items", "", &[], None), base("", &[], None), "HEAD shares the GET entry");
        let all = [
            base("a=1", &[], None),
            base("a=2", &[], None),
            base("a=1", &[("accept-language".into(), "de".into())], None),
            base("a=1", &[], Some("c1")),
            key("p1", 8, "w1", "GET", "api.example.com", "/items", "a=1", &[], None),
            key("p2", 7, "w1", "GET", "api.example.com", "/items", "a=1", &[], None),
            key("p1", 7, "w2", "GET", "api.example.com", "/items", "a=1", &[], None),
            key("p1", 7, "w1", "GET", "other.example.com", "/items", "a=1", &[], None),
            key("p1", 7, "w1", "GET", "api.example.com", "/items/", "a=1", &[], None),
        ];
        let unique: std::collections::HashSet<&String> = all.iter().collect();
        assert_eq!(unique.len(), all.len());
    }

    #[test]
    fn a_response_is_collected_up_to_the_size_limit() {
        let mut pending = Pending::new("k".into(), config(json!({ "max_object_bytes": 10 })));
        assert!(pending.feed(Some(&Bytes::from_static(b"abc")), true).is_none(), "nothing is stored until the headers allow it");
        pending.store = Some((200, vec![], Duration::from_secs(5)));
        assert!(pending.feed(Some(&Bytes::from_static(b"hello ")), false).is_none());
        let (stored, ttl) = pending.feed(Some(&Bytes::from_static(b"you")), true).unwrap();
        assert_eq!((stored.body.as_ref(), ttl), (&b"hello you"[..], Duration::from_secs(5)));

        let mut large = Pending::new("k".into(), config(json!({ "max_object_bytes": 10 })));
        large.store = Some((200, vec![], Duration::from_secs(5)));
        assert!(large.feed(Some(&Bytes::from_static(b"0123456789AB")), false).is_none());
        assert!(large.feed(Some(&Bytes::from_static(b"x")), true).is_none(), "too large: not stored, not truncated");

        let mut headers = http::HeaderMap::new();
        for (k, v) in [("content-type", "text/plain"), ("set-cookie", "a=b"), ("content-length", "5"), ("etag", "\"v1\""), ("x-request-id", "r")] {
            headers.insert(k, v.parse().unwrap());
        }
        let mut kept = storable_headers(&headers);
        kept.sort();
        assert_eq!(kept, [("content-type".to_string(), "text/plain".to_string()), ("etag".to_string(), "\"v1\"".to_string())]);
    }
}
