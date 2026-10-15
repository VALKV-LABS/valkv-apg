//! The plugin runtime (spec §9).
//!
//! Every plugin instance is built once, when configuration is applied: its
//! configuration parsed, its patterns compiled (spec PL-5). The request path
//! only looks the built instance up. An instance whose configuration cannot
//! be built is kept as [`Built::Broken`]: an authentication or restriction
//! plugin in that state refuses requests, every other type steps aside and is
//! counted (spec PL-4).

use std::collections::HashMap;
use std::sync::Arc;

use apg_core::model::CaCertificate;
use apg_core::plugins::Instance;
use apg_core::resources::Resources;
use apg_core::snapshot::Snapshot;
use arc_swap::ArcSwap;
use http::HeaderMap;
use serde::Deserialize;
use serde_json::Value;

use crate::auth::{BasicAuth, JwtAuth, KeyAuth, VerifiedCache};
use crate::callout::{ForwardAuth, HttpCallout};
use crate::mtls::MtlsAuth;
use crate::response_cache::{CacheConfig, ResponseCache};
use crate::limits::{BandwidthConfig, ConcurrencyConfig, RateLimitConfig};
use crate::net::Cidr;
use crate::secrets::SecretBox;
use crate::transform::{AccessLog, Compression, Quota, Quotas, Redirect, StaticResponse, Transformer};

/// What a plugin may read of a request.
pub struct Req<'a> {
    pub method: &'a str,
    pub host: &'a str,
    /// The normalised path.
    pub path: &'a str,
    pub query: &'a str,
    pub client_ip: &'a str,
    pub headers: &'a HeaderMap,
    /// The workspace the request is attributed to.
    pub workspace_id: &'a str,
    /// Whether the matched route belongs to the system workspace.
    pub system_route: bool,
    /// Seconds since the epoch.
    pub now: i64,
}

impl Req<'_> {
    /// The first value of a header, when it is valid text and not empty.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty())
    }

    /// The first value of a query parameter, as written (not percent-decoded).
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query.split('&').filter_map(|pair| pair.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v).filter(|v| !v.is_empty())
    }

    pub fn cookie(&self, name: &str) -> Option<&str> {
        self.header("cookie")?.split(';').filter_map(|pair| pair.trim().split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v).filter(|v| !v.is_empty())
    }
}

/// What a request-phase plugin decided.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Continue,
    /// Refuse with a gateway error (spec §6.7).
    Deny { status: u16, code: &'static str, message: &'static str },
    /// Answer the request here, without an upstream.
    Respond { status: u16, headers: Vec<(String, String)>, body: bytes::Bytes },
}

// ── ip_restriction ───────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct IpRestriction {
    allow: Vec<Cidr>,
    deny: Vec<Cidr>,
}

impl IpRestriction {
    fn build(config: &Value) -> Result<Self, String> {
        let list = |key: &str| -> Result<Vec<Cidr>, String> {
            config.get(key).and_then(Value::as_array).into_iter().flatten().map(|v| v.as_str().and_then(Cidr::parse).ok_or_else(|| format!("{key}: {v} is not a CIDR"))).collect()
        };
        Ok(Self { allow: list("allow")?, deny: list("deny")? })
    }

    /// `deny` wins. With a non-empty `allow`, anything outside it is denied.
    /// A request whose address is unknown matches no list.
    pub fn check(&self, client_ip: &str) -> Verdict {
        let ip = client_ip.parse::<std::net::IpAddr>().ok();
        let within = |list: &[Cidr]| ip.is_some_and(|ip| list.iter().any(|c| c.contains(ip)));
        if within(&self.deny) || (!self.allow.is_empty() && !within(&self.allow)) {
            Verdict::Deny { status: 403, code: "IP_FORBIDDEN", message: "this client address is not allowed" }
        } else {
            Verdict::Continue
        }
    }
}

// ── acl ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
pub struct Acl {
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
}

impl Acl {
    /// `groups` is `None` when no consumer was authenticated.
    pub fn check(&self, groups: Option<&[String]>) -> Verdict {
        let Some(groups) = groups else { return Verdict::Deny { status: 401, code: "UNAUTHENTICATED", message: "authentication is required" } };
        let member = |list: &[String]| groups.iter().any(|g| list.contains(g));
        if member(&self.deny) || (!self.allow.is_empty() && !member(&self.allow)) {
            Verdict::Deny { status: 403, code: "FORBIDDEN", message: "this consumer is not allowed here" }
        } else {
            Verdict::Continue
        }
    }
}

// ── cors ─────────────────────────────────────────────────────────────────────

fn d_cors_methods() -> Vec<String> {
    ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].iter().map(|m| m.to_string()).collect()
}
fn d_max_age() -> u64 {
    86_400
}

#[derive(Debug, Deserialize)]
pub struct Cors {
    origins: Vec<String>,
    #[serde(default = "d_cors_methods")]
    methods: Vec<String>,
    #[serde(default)]
    headers: Vec<String>,
    #[serde(default)]
    expose_headers: Vec<String>,
    #[serde(default = "d_max_age")]
    max_age: u64,
    #[serde(default)]
    credentials: bool,
}

/// What `cors` contributes to a request.
#[derive(Debug, Default, PartialEq)]
pub struct CorsResult {
    /// Headers for whatever response the request gets, an error included.
    pub response_headers: Vec<(String, String)>,
    /// Set for a preflight request: the gateway answers it with these headers.
    pub preflight: Option<Vec<(String, String)>>,
}

impl Cors {
    /// The `Access-Control-Allow-Origin` value for an origin, if it is allowed.
    fn allow_origin(&self, origin: &str) -> Option<String> {
        for pattern in &self.origins {
            if pattern == "*" {
                return Some(if self.credentials { origin.to_string() } else { "*".to_string() });
            }
            let matches = match pattern.split_once("*.") {
                // `https://*.example.com`: the scheme, then exactly one more label.
                Some((scheme, suffix)) => origin
                    .strip_prefix(scheme)
                    .and_then(|rest| rest.strip_suffix(suffix))
                    .and_then(|label| label.strip_suffix('.'))
                    .is_some_and(|label| !label.is_empty() && !label.contains('.') && !label.contains('/')),
                None => pattern.eq_ignore_ascii_case(origin),
            };
            if matches {
                return Some(origin.to_string());
            }
        }
        None
    }

    pub fn check(&self, req: &Req<'_>) -> CorsResult {
        // The answer depends on the Origin header, so caches must key on it.
        let mut out = CorsResult { response_headers: vec![("vary".into(), "Origin".into())], preflight: None };
        let Some(origin) = req.header("origin") else { return out };
        let allowed = self.allow_origin(origin);
        if let Some(value) = &allowed {
            out.response_headers.push(("access-control-allow-origin".into(), value.clone()));
            if self.credentials {
                out.response_headers.push(("access-control-allow-credentials".into(), "true".into()));
            }
            if !self.expose_headers.is_empty() {
                out.response_headers.push(("access-control-expose-headers".into(), self.expose_headers.join(", ")));
            }
        }
        if req.method == "OPTIONS" && req.header("access-control-request-method").is_some() {
            let mut headers = Vec::new();
            if allowed.is_some() {
                headers.push(("access-control-allow-methods".to_string(), self.methods.join(", ")));
                // An empty list means: whatever the browser asks to send.
                let requested = if self.headers.is_empty() { req.header("access-control-request-headers").map(str::to_string) } else { Some(self.headers.join(", ")) };
                if let Some(list) = requested {
                    headers.push(("access-control-allow-headers".to_string(), list));
                }
                headers.push(("access-control-max-age".to_string(), self.max_age.to_string()));
            }
            out.preflight = Some(headers);
        }
        out
    }
}

// ── The registry ─────────────────────────────────────────────────────────────

/// A plugin instance, ready for the request path.
#[derive(Debug)]
pub enum Built {
    IpRestriction(IpRestriction),
    Cors(Cors),
    RequestSize { max_bytes: u64 },
    KeyAuth(KeyAuth),
    BasicAuth(BasicAuth),
    JwtAuth(JwtAuth),
    Acl(Acl),
    RateLimit(RateLimitConfig),
    Bandwidth(BandwidthConfig),
    Concurrency(ConcurrencyConfig),
    Quota(Quota),
    Redirect(Redirect),
    StaticResponse(StaticResponse),
    RequestTransformer(Transformer),
    ResponseTransformer(Transformer),
    Compression(Compression),
    AccessLog(AccessLog),
    MtlsAuth(MtlsAuth),
    ForwardAuth(ForwardAuth),
    HttpCallout(HttpCallout),
    /// The configuration, and a tag that changes with it (cached responses carry it).
    ResponseCache(CacheConfig, u64),
    /// The configuration could not be turned into a working plugin.
    Broken(String),
}

/// Types that decide who may pass. A broken instance of one of these refuses
/// requests; a broken instance of any other type is skipped (spec PL-4).
pub const FAIL_CLOSED: &[&str] = &["ip_restriction", "mtls_auth", "jwt_auth", "key_auth", "basic_auth", "forward_auth", "acl"];

/// Authentication schemes combined under spec PL-10.
pub const AUTH_TYPES: &[&str] = &["mtls_auth", "jwt_auth", "key_auth", "basic_auth"];

type BuiltMap = HashMap<String, (Value, Arc<Built>)>;

pub struct Runtime {
    built: ArcSwap<BuiltMap>,
    secrets: Option<Arc<SecretBox>>,
    pub verified_passwords: VerifiedCache,
    pub quotas: Quotas,
    pub cache: ResponseCache,
    /// For the plugins that call other services.
    pub http: reqwest::Client,
    /// Environment variable names templates may read (`APG_TEMPLATE_ENV_ALLOW`).
    env_allow: std::sync::OnceLock<Vec<String>>,
}

impl Runtime {
    pub fn new(secrets: Option<Arc<SecretBox>>) -> Self {
        Self { built: ArcSwap::from_pointee(HashMap::new()), secrets, verified_passwords: VerifiedCache::default(), quotas: Quotas::default(),
            cache: ResponseCache::new(268_435_456),
            http: reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(3)).build().unwrap_or_default(),
            env_allow: std::sync::OnceLock::new(),
        }
    }

    /// Sets, once, which environment variables templates may read.
    pub fn allow_env(&self, names: Vec<String>) {
        let _ = self.env_allow.set(names);
    }

    pub fn env_allow(&self) -> &[String] {
        self.env_allow.get().map_or(&[], Vec::as_slice)
    }

    fn build(&self, instance: &Instance, resources: &Resources) -> Built {
        let config = &instance.plugin.config;
        let parse = |what: Result<Built, String>| what.unwrap_or_else(Built::Broken);
        let typed = |e: serde_json::Error| e.to_string();
        match instance.plugin.kind.as_str() {
            "ip_restriction" => parse(IpRestriction::build(config).map(Built::IpRestriction)),
            "cors" => parse(serde_json::from_value(config.clone()).map(Built::Cors).map_err(typed)),
            "request_size_limit" => Built::RequestSize { max_bytes: config.get("max_bytes").and_then(Value::as_u64).unwrap_or(10_485_760) },
            "key_auth" => parse(serde_json::from_value(config.clone()).map(Built::KeyAuth).map_err(typed)),
            "basic_auth" => parse(serde_json::from_value(config.clone()).map(Built::BasicAuth).map_err(typed)),
            "jwt_auth" => {
                let aad = format!("plugin:{}", instance.id);
                parse(JwtAuth::build(config, &|value| crate::secrets::resolve(value, &aad, self.secrets.as_deref())).map(Built::JwtAuth))
            }
            "acl" => parse(serde_json::from_value(config.clone()).map(Built::Acl).map_err(typed)),
            "rate_limit" => Built::RateLimit(RateLimitConfig::from_json(config)),
            "bandwidth_limit" => Built::Bandwidth(BandwidthConfig::from_json(config)),
            "concurrency_limit" => Built::Concurrency(ConcurrencyConfig::from_json(config)),
            "quota" => parse(Quota::build(config).map(Built::Quota)),
            "redirect" => parse(Redirect::build(config).map(Built::Redirect)),
            "static_response" => parse(StaticResponse::build(config).map(Built::StaticResponse)),
            "request_transformer" => parse(Transformer::build(config).map(Built::RequestTransformer)),
            "response_transformer" => parse(Transformer::build(config).map(Built::ResponseTransformer)),
            "compression" => parse(serde_json::from_value(config.clone()).map(Built::Compression).map_err(typed)),
            "access_log" => parse(AccessLog::build(config).map(Built::AccessLog)),
            "mtls_auth" => {
                let ca_pem = |id: &str| -> Result<Vec<u8>, String> {
                    let stored = resources.get("ca_certificate", id).ok_or_else(|| format!("CA certificate '{id}' is not in the configuration"))?;
                    let ca: CaCertificate = serde_json::from_value(stored.data.clone()).map_err(|e| e.to_string())?;
                    match (ca.cert_pem, ca.cert_file) {
                        (Some(pem), _) => Ok(pem.into_bytes()),
                        (None, Some(path)) => std::fs::read(&path).map_err(|e| format!("cannot read '{path}': {e}")),
                        (None, None) => Err(format!("CA certificate '{id}' has no certificate")),
                    }
                };
                parse(MtlsAuth::build(config, &ca_pem).map(Built::MtlsAuth))
            }
            "forward_auth" => parse(ForwardAuth::build(config).map(Built::ForwardAuth)),
            "http_callout" => {
                let aad = format!("plugin:{}", instance.id);
                parse(HttpCallout::build(config, &|value| crate::secrets::resolve(value, &aad, self.secrets.as_deref())).map(Built::HttpCallout))
            }
            "response_cache" => parse(serde_json::from_value(config.clone()).map(|c| Built::ResponseCache(c, crate::upstream::hash_parts(&[&config.to_string()]))).map_err(typed)),
            other => Built::Broken(format!("plugin type '{other}' is not available in this build")),
        }
    }

    /// Builds every instance of a new configuration. An instance whose
    /// configuration did not change keeps its built form, and with it any
    /// state it holds (fetched signing keys, for example).
    pub fn sync(&self, resources: &Resources, snapshot: &Snapshot) {
        let previous = self.built.load();
        let mut next: BuiltMap = HashMap::new();
        for instance in snapshot.plugins.instances() {
            // What the built form depends on: the configuration, and for
            // mtls_auth the CA certificates it names.
            let mut basis = instance.plugin.config.clone();
            if instance.plugin.kind == "mtls_auth" {
                let revisions: Vec<u64> = basis.get("ca_certificates").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(|id| resources.get("ca_certificate", id).map_or(0, |s| s.revision)).collect();
                basis = serde_json::json!({ "config": basis, "ca_revisions": revisions });
            }
            let built = match previous.get(&instance.id) {
                Some((kept, built)) if *kept == basis => built.clone(),
                _ => {
                    let built = self.build(instance, resources);
                    if let Built::Broken(reason) = &built {
                        tracing::error!(plugin = %instance.id, kind = %instance.plugin.kind, %reason, "plugin instance could not be built");
                    }
                    Arc::new(built)
                }
            };
            next.insert(instance.id.clone(), (basis, built));
        }
        self.built.store(Arc::new(next));
    }

    pub fn get(&self, instance_id: &str) -> Option<Arc<Built>> {
        self.built.load().get(instance_id).map(|(_, built)| built.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use apg_core::resources::Resources;
    use serde_json::json;

    fn req<'a>(method: &'a str, headers: &'a HeaderMap) -> Req<'a> {
        Req { method, host: "api.example.com", path: "/", query: "a=1&token=abc&empty=", client_ip: "203.0.113.9", headers, workspace_id: "w", system_route: true, now: 0 }
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        h
    }

    #[test]
    fn request_accessors() {
        let h = headers(&[("x-a", "1"), ("cookie", "theme=dark; session=abc"), ("x-empty", "")]);
        let r = req("GET", &h);
        assert_eq!((r.header("X-A"), r.header("x-empty"), r.header("x-none")), (Some("1"), None, None));
        assert_eq!((r.query_param("token"), r.query_param("empty"), r.query_param("none")), (Some("abc"), None, None));
        assert_eq!((r.cookie("session"), r.cookie("theme"), r.cookie("none")), (Some("abc"), Some("dark"), None));
    }

    #[test]
    fn ip_restriction_deny_wins_and_allow_is_exclusive() {
        let denied = Verdict::Deny { status: 403, code: "IP_FORBIDDEN", message: "this client address is not allowed" };
        let only_office = IpRestriction::build(&json!({ "allow": ["203.0.113.0/24", "2001:db8::/32"] })).unwrap();
        assert_eq!(only_office.check("203.0.113.9"), Verdict::Continue);
        assert_eq!(only_office.check("2001:db8::1"), Verdict::Continue);
        assert_eq!(only_office.check("198.51.100.1"), denied);
        assert_eq!(only_office.check(""), denied, "an unknown address is outside every allow list");

        let both = IpRestriction::build(&json!({ "allow": ["203.0.113.0/24"], "deny": ["203.0.113.9"] })).unwrap();
        assert_eq!(both.check("203.0.113.9"), denied);
        assert_eq!(both.check("203.0.113.10"), Verdict::Continue);

        let block_one = IpRestriction::build(&json!({ "deny": ["198.51.100.0/24"] })).unwrap();
        assert_eq!(block_one.check("198.51.100.7"), denied);
        assert_eq!(block_one.check("203.0.113.9"), Verdict::Continue);
        assert_eq!(IpRestriction::build(&json!({})).unwrap().check("1.2.3.4"), Verdict::Continue);
        assert!(IpRestriction::build(&json!({ "allow": ["not-a-cidr"] })).is_err());
    }

    #[test]
    fn acl_needs_a_consumer_and_deny_wins() {
        let acl: Acl = serde_json::from_value(json!({ "allow": ["partners", "staff"], "deny": ["suspended"] })).unwrap();
        let groups = |g: &[&str]| g.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(acl.check(Some(&groups(&["partners"]))), Verdict::Continue);
        assert!(matches!(acl.check(Some(&groups(&["partners", "suspended"]))), Verdict::Deny { status: 403, code: "FORBIDDEN", .. }));
        assert!(matches!(acl.check(Some(&groups(&["public"]))), Verdict::Deny { status: 403, .. }));
        assert!(matches!(acl.check(Some(&[])), Verdict::Deny { status: 403, .. }));
        assert!(matches!(acl.check(None), Verdict::Deny { status: 401, code: "UNAUTHENTICATED", .. }));
        // Only a deny list: everyone else passes.
        let deny_only: Acl = serde_json::from_value(json!({ "deny": ["suspended"] })).unwrap();
        assert_eq!(deny_only.check(Some(&groups(&["anything"]))), Verdict::Continue);
        assert_eq!(deny_only.check(Some(&[])), Verdict::Continue);
    }

    #[test]
    fn cors_allows_listed_origins_and_answers_preflight() {
        let cors: Cors = serde_json::from_value(json!({ "origins": ["https://app.example.com", "https://*.example.org"], "expose_headers": ["X-Total"], "credentials": true, "max_age": 600 })).unwrap();
        let get = |origin: &str| cors.check(&req("GET", &headers(&[("origin", origin)])));
        let acao = |r: &CorsResult| r.response_headers.iter().find(|(k, _)| k == "access-control-allow-origin").map(|(_, v)| v.clone());

        let ok = get("https://app.example.com");
        assert_eq!(acao(&ok).as_deref(), Some("https://app.example.com"));
        assert!(ok.response_headers.contains(&("access-control-allow-credentials".into(), "true".into())));
        assert!(ok.response_headers.contains(&("access-control-expose-headers".into(), "X-Total".into())));
        assert!(ok.response_headers.contains(&("vary".into(), "Origin".into())));
        assert!(ok.preflight.is_none());

        assert_eq!(acao(&get("https://shop.example.org")).as_deref(), Some("https://shop.example.org"));
        for refused in ["https://evil.example", "https://a.b.example.org", "https://example.org", "http://shop.example.org", "https://shop.example.org.evil.test"] {
            let r = get(refused);
            assert_eq!(acao(&r), None, "{refused}");
            assert!(r.response_headers.contains(&("vary".into(), "Origin".into())));
        }
        // No Origin header: not a cross-origin request.
        assert_eq!(cors.check(&req("GET", &HeaderMap::new())).response_headers.len(), 1);

        // Preflight: answered here, reflecting the headers the browser asks for.
        let pre = cors.check(&req("OPTIONS", &headers(&[("origin", "https://app.example.com"), ("access-control-request-method", "PUT"), ("access-control-request-headers", "x-custom, content-type")])));
        let answer = pre.preflight.unwrap();
        assert!(answer.contains(&("access-control-allow-headers".into(), "x-custom, content-type".into())));
        assert!(answer.contains(&("access-control-max-age".into(), "600".into())));
        assert!(answer.iter().any(|(k, v)| k == "access-control-allow-methods" && v.contains("PUT")));
        // A preflight from an origin that is not allowed is answered with no permission at all.
        let pre = cors.check(&req("OPTIONS", &headers(&[("origin", "https://evil.example"), ("access-control-request-method", "PUT")])));
        assert_eq!(pre.preflight, Some(vec![]));
        // A plain OPTIONS request is not a preflight.
        assert!(cors.check(&req("OPTIONS", &headers(&[("origin", "https://app.example.com")]))).preflight.is_none());

        // Any origin, no credentials: the literal star. A fixed header list is sent as configured.
        let open: Cors = serde_json::from_value(json!({ "origins": ["*"], "headers": ["Authorization"] })).unwrap();
        assert_eq!(acao(&open.check(&req("GET", &headers(&[("origin", "https://anything.test")])))).as_deref(), Some("*"));
        let pre = open.check(&req("OPTIONS", &headers(&[("origin", "https://x.test"), ("access-control-request-method", "GET"), ("access-control-request-headers", "x-other")])));
        assert!(pre.preflight.unwrap().contains(&("access-control-allow-headers".into(), "Authorization".into())));
    }

    // spec PL-5, PL-4
    #[test]
    fn instances_are_built_once_and_kept_while_their_configuration_is_unchanged() {
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        let plugin = |id: &str, kind: &str, config: Value, revision: u64| {
            let mut e = ChangeEvent::upsert("plugin", id, Some("w".into()), json!({ "type": kind, "scope": "global", "config": config }));
            e.revision = Some(revision);
            e
        };
        r.apply(&plugin("p-ip", "ip_restriction", json!({ "deny": ["10.0.0.0/8"] }), 1));
        r.apply(&plugin("p-acl", "acl", json!({ "allow": ["staff"] }), 1));
        r.apply(&plugin("p-bad", "ip_restriction", json!({ "deny": ["nonsense"] }), 1));
        let runtime = Runtime::new(None);
        runtime.sync(&r, &Snapshot::build(&r));
        let ip_before = runtime.get("p-ip").unwrap();
        assert!(matches!(*ip_before, Built::IpRestriction(_)));
        assert!(matches!(*runtime.get("p-bad").unwrap(), Built::Broken(_)));
        assert!(runtime.get("p-none").is_none());

        // Another instance changes: this one is not rebuilt.
        r.apply(&plugin("p-acl", "acl", json!({ "allow": ["partners"] }), 2));
        runtime.sync(&r, &Snapshot::build(&r));
        assert!(Arc::ptr_eq(&ip_before, &runtime.get("p-ip").unwrap()));
        // Its own configuration changes: it is.
        r.apply(&plugin("p-ip", "ip_restriction", json!({ "deny": ["192.168.0.0/16"] }), 2));
        runtime.sync(&r, &Snapshot::build(&r));
        assert!(!Arc::ptr_eq(&ip_before, &runtime.get("p-ip").unwrap()));
        // Removed instances are forgotten.
        let mut gone = ChangeEvent::upsert("plugin", "p-acl", Some("w".into()), json!({}));
        gone.op = "delete".into();
        gone.revision = Some(3);
        gone.data = None;
        r.apply(&gone);
        runtime.sync(&r, &Snapshot::build(&r));
        assert!(runtime.get("p-acl").is_none());
    }
}
