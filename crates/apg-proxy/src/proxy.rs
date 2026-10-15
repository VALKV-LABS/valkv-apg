//! The request pipeline (spec §6.2).
//!
//! 1. assign a request id, resolve the client address
//! 2. match a route, attribute a workspace
//! 3. run request-phase plugins
//! 4. pick a backend (spec §7.1); on a retry, pick another
//! 5. build the upstream request (path, Host, forwarded and identity headers)
//! 6. forward, within the service's timeouts and the route's deadline
//! 7. response headers, body accounting
//! 8. log phase: metrics, circuit accounting, bandwidth debit, access log

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use apg_core::consumers::Consumer;
use apg_core::path;
use apg_core::plugins::Site;
use apg_core::snapshot::{CompiledRewrite, CompiledRoute, Matched, Request as MatchRequest, ServiceEntry, Snapshot};
use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use pingora_core::modules::http::compression::ResponseCompression;
use pingora_core::protocols::Digest;
use pingora_core::protocols::http::compression::Algorithm;
use pingora_core::upstreams::peer::HttpPeer;
use pingora_core::{Error, ErrorSource, ErrorType};
use pingora_http::{RequestHeader, ResponseHeader};
use pingora_proxy::{FailToProxy, ProxyHttp, Session};

use crate::accesslog::{Sink, TraceContext, rfc3339_millis};
use crate::auth::{AuthEffects, AuthOutcome};
use crate::callout::{Answer, Forwarded};
use crate::config::HttpMode;
use crate::gateway::Gateway;
use crate::limits::{BandwidthConfig, Buckets, InFlight, Permit, RateLimitConfig, Subject, bucket_key};
use crate::plugins::{AUTH_TYPES, Built, FAIL_CLOSED, Req, Verdict};
use crate::metrics;
use crate::mtls::ClientCert;
use crate::net::{Cidr, client_ip, normalize_host};
use crate::response_cache::{self, Pending, lifetime, storable_headers};
use crate::transform::{BodyRewrite, Compression, Rendered, Vars, is_json};
use crate::upstream::{Picked, failure_reason, hash_parts, weighted_pick};

/// Settings the pipeline needs that do not change while the node runs.
pub struct ProxySettings {
    pub http_mode: HttpMode,
    pub traffic_health_path: Option<String>,
    pub trusted_proxies: Vec<Cidr>,
    pub stub_upstream: bool,
    /// Port clients reach HTTPS on, for redirects. `None` means the default port.
    pub https_port: Option<u16>,
}

pub struct ApgProxy {
    pub gateway: Arc<Gateway>,
    pub settings: ProxySettings,
    pub buckets: Arc<Buckets>,
    /// Requests in progress, for `concurrency_limit`.
    pub in_flight: Arc<InFlight>,
    /// Rotation of each split route, by route id.
    split_rotation: DashMap<String, AtomicUsize>,
}

/// Per-request state.
#[derive(Default)]
pub struct Ctx {
    request_id: String,
    started: Option<Instant>,
    client_ip: String,
    is_tls: bool,
    host: String,
    method: String,
    /// The normalised request path.
    path: String,
    snapshot: Option<Arc<Snapshot>>,
    matched: Option<Matched>,
    service: Option<Arc<ServiceEntry>>,
    /// The backend of the attempt in progress.
    picked: Option<Picked>,
    /// Target of the last backend chosen, for the access log.
    backend_target: String,
    /// Targets that failed for this request; a retry avoids them.
    tried: Vec<String>,
    /// Attempts started.
    tries: u32,
    /// Whether the circuit breaker has heard how the current attempt ended.
    recorded: bool,
    /// The route's `timeout_ms`, as a point in time.
    deadline: Option<Instant>,
    /// Value of the service's `hash_key` for this request.
    hash_key: Option<String>,
    /// Status the upstream answered with, when it answered.
    upstream_status: Option<u16>,
    /// The response to give when no attempt can be made: status, code, message.
    refusal: Option<(u16, &'static str, &'static str)>,
    /// Set when the gateway itself produced the response.
    error_code: Option<&'static str>,
    bytes_in: u64,
    bytes_out: u64,
    rate: Option<(RateLimitConfig, u64)>,
    bandwidth: Option<(String, BandwidthConfig)>,
    /// Slots this request holds under `concurrency_limit`; given back when the context is dropped.
    permits: Vec<Permit>,
    /// The client asked to upgrade the connection (WebSocket and the like).
    upgrade: bool,
    /// A second descriptor of the upstream socket, kept while an upgrade may follow.
    upstream_socket: Option<std::net::TcpStream>,
    /// Set once the upstream agreed to the upgrade: the connection is watched for draining.
    upgraded: Option<crate::long_lived::Registration>,
    /// The socket peer's address, and whether it is a trusted proxy.
    peer_ip: String,
    peer_trusted: bool,
    /// Port the client connected to.
    server_port: Option<u16>,
    /// Seconds a refused client should wait; sent as `Retry-After`.
    retry_after: Option<u64>,
    /// Who the caller is, once authentication has said.
    consumer: Option<Arc<Consumer>>,
    /// The claims of a verified token.
    jwt_claims: Option<serde_json::Value>,
    /// The challenge to send with a 401.
    www_authenticate: Option<String>,
    /// Headers plugins add to whatever response the request gets (spec PL-8).
    response_headers: Vec<(String, String)>,
    /// Changes plugins ask for on the forwarded request.
    strip_headers: Vec<String>,
    strip_query: Vec<String>,
    set_headers: Vec<(String, String)>,
    /// Largest request body a plugin allows.
    max_body: Option<u64>,
    /// What `request_transformer` and `response_transformer` asked for, values filled in.
    request_transform: Option<Rendered>,
    response_transform: Option<Rendered>,
    /// Bodies being collected for a rewrite.
    request_rewrite: Option<BodyRewrite>,
    response_rewrite: Option<BodyRewrite>,
    compression: Option<Compression>,
    /// Set by an `access_log` plugin: do not write this request's line.
    log_suppressed: bool,
    /// Custom access-log fields, as a JSON object.
    log_fields: Option<String>,
    /// An `http_callout` instance to ask again when the response arrives, and what it was told about the request.
    callout: Option<Arc<Built>>,
    callout_payload: Option<serde_json::Value>,
    /// A body that replaces the upstream's, and whether the upstream's is being dropped.
    response_replace: Option<Bytes>,
    response_swallow: bool,
    /// A response being collected for the cache.
    cache_pending: Option<Pending>,
    /// What the response cache did with this request: HIT, MISS or BYPASS.
    cache_result: &'static str,
    trace: Option<TraceContext>,
    user_agent: String,
    http_version: &'static str,
    tls_version: String,
    /// The query string as received, for the access log (masked there).
    raw_query: String,
    /// When the current upstream attempt began, and how long the upstream took to answer.
    upstream_started: Option<Instant>,
    /// The address of the attempt in progress.
    upstream_addr: Option<std::net::SocketAddr>,
    upstream_ms: Option<u64>,
    /// Whether this request is counted in the gauge of requests in progress.
    counted_active: bool,
}

const REQUEST_ID_HEADER: &str = "x-request-id";

fn valid_request_id(v: &str) -> bool {
    !v.is_empty() && v.len() <= 128 && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn header<'a>(req: &'a RequestHeader, name: &str) -> Option<&'a str> {
    req.headers.get(name).and_then(|v| v.to_str().ok())
}

/// The path sent upstream (spec §4.6): `strip_path` first, then `rewrite`.
pub fn upstream_path(route: &CompiledRoute, matched_prefix: Option<&str>, path: &str) -> String {
    let prefix = matched_prefix.map(|p| p.strip_suffix('/').unwrap_or(p)).filter(|p| !p.is_empty());
    let remainder = prefix.and_then(|p| path.strip_prefix(p)).unwrap_or(path);
    let rooted = |s: &str| if s.starts_with('/') { s.to_string() } else { format!("/{s}") };
    let stripped = if route.strip_path && prefix.is_some() { rooted(remainder) } else { path.to_string() };
    match &route.rewrite {
        None => stripped,
        Some(CompiledRewrite::Path(p)) => p.clone(),
        Some(CompiledRewrite::Prefix(p)) => {
            // Replace the matched prefix; with no matched prefix, prepend.
            let rest = if prefix.is_some() { remainder } else { path };
            if rest.is_empty() || rest == "/" { p.clone() } else { format!("{}{}", p.strip_suffix('/').unwrap_or(p), rooted(rest)) }
        }
        Some(CompiledRewrite::Regex(re, replacement)) => rooted(&re.replace(&stripped, replacement.as_str())),
    }
}

/// What a key selector (`hash_key`, `split_key`) evaluates to for one request.
/// `None` when the request carries no such value.
struct KeySource<'a> {
    req: &'a RequestHeader,
    host: &'a str,
    client_ip: &'a str,
    path: &'a str,
    query: &'a str,
    workspace_id: &'a str,
    /// Empty until authentication has named a consumer.
    consumer_id: &'a str,
}

impl KeySource<'_> {
    fn value(&self, selector: &str) -> Option<String> {
        let found = match selector {
            "host" => self.host,
            "client_ip" => self.client_ip,
            "path" => self.path,
            "workspace" => self.workspace_id,
            "consumer" => self.consumer_id,
            other => match other.split_once(':')? {
                ("header", name) => header(self.req, name).unwrap_or(""),
                ("cookie", name) => header(self.req, "cookie").unwrap_or("").split(';').filter_map(|pair| pair.trim().split_once('=')).find(|(k, _)| *k == name).map_or("", |(_, v)| v),
                ("path_prefix", n) => return n.parse().ok().map(|n| crate::limits::path_prefix(self.path, n)),
                ("query", name) => self.query.split('&').map(|pair| pair.split_once('=').unwrap_or((pair, ""))).find(|(k, _)| *k == name).map_or("", |(_, v)| v),
                _ => "",
            },
        };
        (!found.is_empty()).then(|| found.to_string())
    }
}

/// Applies header operations in the order rename, remove, set, add.
fn apply_header_ops(head: &mut RequestHeader, ops: &crate::transform::RenderedOps) -> pingora_core::Result<()> {
    for (from, to) in &ops.rename {
        if let Some(value) = head.remove_header(from.as_str()) {
            head.insert_header(to.clone(), value)?;
        }
    }
    for name in &ops.remove {
        head.remove_header(name.as_str());
    }
    for (name, value) in &ops.set {
        head.insert_header(name.clone(), value.clone())?;
    }
    for (name, value) in &ops.add {
        head.append_header(name.clone(), value.clone())?;
    }
    Ok(())
}

fn apply_response_header_ops(head: &mut ResponseHeader, ops: &crate::transform::RenderedOps) -> pingora_core::Result<()> {
    for (from, to) in &ops.rename {
        if let Some(value) = head.remove_header(from.as_str()) {
            head.insert_header(to.clone(), value)?;
        }
    }
    for name in &ops.remove {
        head.remove_header(name.as_str());
    }
    for (name, value) in &ops.set {
        head.insert_header(name.clone(), value.clone())?;
    }
    for (name, value) in &ops.add {
        head.append_header(name.clone(), value.clone())?;
    }
    Ok(())
}

/// Methods that may be sent twice without changing the outcome (spec UP-10).
fn idempotent(method: &str) -> bool {
    matches!(method, "GET" | "HEAD" | "OPTIONS" | "PUT" | "DELETE")
}

const NO_BACKEND: (u16, &str, &str) = (503, "NO_HEALTHY_BACKEND", "no upstream is available for this route");
const UPSTREAM_ERROR: (u16, &str, &str) = (502, "UPSTREAM_ERROR", "the upstream could not be reached or answered invalidly");
const UPSTREAM_TIMEOUT: (u16, &str, &str) = (504, "UPSTREAM_TIMEOUT", "the upstream did not answer in time");
const PAYLOAD_TOO_LARGE: (u16, &str, &str) = (413, "PAYLOAD_TOO_LARGE", "the request body is larger than this route accepts");

impl ApgProxy {
    pub fn new(gateway: Arc<Gateway>, settings: ProxySettings) -> Self {
        Self { gateway, settings, buckets: Arc::new(Buckets::default()), in_flight: Arc::new(InFlight::default()), split_rotation: DashMap::new() }
    }

    /// Chooses the service for this request: the route's only service, or one
    /// side of its split by weight. With a `split_key` value the choice is
    /// the same every time for that value (spec UP-15).
    fn pick_service(&self, snapshot: &Snapshot, route: &CompiledRoute, key: Option<&str>) -> Option<Arc<ServiceEntry>> {
        let weights: Vec<u32> = route.targets.iter().map(|(_, w)| *w).collect();
        let i = if weights.len() == 1 {
            0
        } else {
            let slot = match key {
                Some(k) => hash_parts(&[k, route.id.as_str()]) as usize,
                None => self.split_rotation.entry(route.id.clone()).or_insert_with(|| AtomicUsize::new(0)).fetch_add(1, Ordering::Relaxed),
            };
            weighted_pick(&weights, slot)?
        };
        snapshot.service(&route.targets[i].0).cloned()
    }

    /// The attempt in progress failed: the circuit breaker hears about it and
    /// a retry will avoid this backend.
    fn attempt_failed(&self, ctx: &mut Ctx, reason: &str) {
        if let (Some(snapshot), Some(service), Some(picked)) = (&ctx.snapshot, &ctx.service, ctx.picked.take()) {
            picked.failed_because(reason);
            self.gateway.upstreams.record(snapshot, service, &picked, false);
            ctx.tried.push(picked.backend.target.clone());
        }
        ctx.recorded = true;
    }

    /// Whether the service's retry policy and the route's deadline leave room
    /// for another attempt after a failure of kind `condition`.
    fn may_retry(ctx: &Ctx, condition: &str) -> bool {
        let Some(service) = &ctx.service else { return false };
        let retries = &service.spec.retries;
        retries.on(condition) && ctx.tries <= retries.attempts && ctx.deadline.is_none_or(|d| Instant::now() < d)
    }

    fn refuse<T>(ctx: &mut Ctx, refusal: (u16, &'static str, &'static str)) -> pingora_core::Result<T> {
        ctx.refusal = Some(refusal);
        Err(Error::explain(ErrorType::Custom(refusal.1), refusal.2))
    }

    fn key_source<'a>(&self, session: &'a Session, ctx: &'a Ctx, matched: &'a Matched, query: &'a str) -> KeySource<'a> {
        KeySource {
            req: session.req_header(),
            host: &ctx.host,
            client_ip: &ctx.client_ip,
            path: &ctx.path,
            query,
            workspace_id: &matched.workspace_id,
            consumer_id: ctx.consumer.as_ref().map_or("", |c| c.id.as_str()),
        }
    }

    /// Settles who the caller is once every authentication scheme has had its
    /// say (spec PL-10): each configured scheme must pass, either with a valid
    /// credential or, when no credential of its scheme was presented, through
    /// its `anonymous` consumer.
    fn settle_identity(ctx: &mut Ctx, snapshot: &Snapshot, matched: &Matched, outcomes: Vec<AuthOutcome>) -> Result<(), (u16, &'static str, &'static str)> {
        let mut anonymous: Option<String> = None;
        let mut authenticated = false;
        for outcome in outcomes {
            match outcome {
                AuthOutcome::Authenticated { consumer, claims } => {
                    authenticated = true;
                    if ctx.consumer.is_none() {
                        ctx.consumer = consumer;
                    }
                    if ctx.jwt_claims.is_none() {
                        ctx.jwt_claims = claims;
                    }
                }
                AuthOutcome::NoCredential { anonymous: Some(name), .. } => {
                    anonymous.get_or_insert(name);
                }
                AuthOutcome::NoCredential { anonymous: None, challenge } => {
                    ctx.www_authenticate = challenge;
                    return Err((401, "UNAUTHENTICATED", "authentication is required"));
                }
                // Refused where they were found.
                AuthOutcome::Invalid { .. } | AuthOutcome::Unavailable => {}
            }
        }
        if !authenticated && let Some(name) = anonymous {
            match snapshot.consumers.by_name(&matched.workspace_id, &name) {
                Some(consumer) => ctx.consumer = Some(consumer.clone()),
                // Letting the request through as nobody would be failing open.
                None => return Err((500, "PLUGIN_ERROR", "the anonymous consumer of an authentication plugin does not exist")),
            }
        }
        Ok(())
    }

    /// Runs the request phase of every plugin that applies, highest priority
    /// first (spec §9.2). Returns true when a plugin answered the request.
    async fn run_request_plugins(&self, session: &mut Session, ctx: &mut Ctx, snapshot: &Arc<Snapshot>, matched: &Matched, query: &str) -> pingora_core::Result<bool> {
        let kinds: Vec<&str> = snapshot.plugins.types().filter(|kind| snapshot.flag(&format!("plugin_{kind}"))).collect();
        if kinds.is_empty() {
            return Ok(false);
        }
        let headers = session.req_header().headers.clone();
        let (method, host, path, client_ip) = (ctx.method.clone(), ctx.host.clone(), ctx.path.clone(), ctx.client_ip.clone());
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        let req = Req { method: &method, host: &host, path: &path, query, client_ip: &client_ip, headers: &headers, workspace_id: &matched.workspace_id, system_route: matched.route.system, now };

        let scheme = if ctx.is_tls { "https" } else { "http" };
        let mut done: Vec<&str> = Vec::new();
        let mut outcomes: Vec<AuthOutcome> = Vec::new();
        let mut effects = AuthEffects::default();
        let mut settled = false;
        loop {
            // What still applies, given what is known about the caller so far:
            // an instance qualified by a consumer can only be chosen once
            // authentication has named one.
            let service_id = ctx.service.as_ref().map(|s| s.id.clone()).unwrap_or_default();
            let consumer_id = ctx.consumer.as_ref().map(|c| c.id.clone());
            let site = Site { route_id: &matched.route.id, service_id: &service_id, workspace_id: &matched.workspace_id, consumer_id: consumer_id.as_deref() };
            let remaining: Vec<(i32, &str, &apg_core::plugins::Instance)> = kinds
                .iter()
                .filter(|kind| !done.contains(kind))
                .filter_map(|kind| {
                    let instance = snapshot.plugins.effective(kind, &site)?;
                    let priority = instance.plugin.priority.or_else(|| apg_plugin_sdk::plugin_type(kind).map(|t| t.default_priority)).unwrap_or(0);
                    Some((priority, *kind, instance))
                })
                .collect();

            if !settled && !remaining.iter().any(|(_, kind, _)| AUTH_TYPES.contains(kind)) {
                settled = true;
                if let Err((status, code, message)) = Self::settle_identity(ctx, snapshot, matched, std::mem::take(&mut outcomes)) {
                    self.respond_error(session, ctx, status, code, message).await?;
                    return Ok(true);
                }
                ctx.strip_headers.append(&mut effects.strip_headers);
                ctx.strip_query.append(&mut effects.strip_query);
                ctx.set_headers.append(&mut effects.set_headers);
                if ctx.service.is_none() {
                    // A split keyed on the consumer: the side can be chosen now.
                    let key = ctx.consumer.as_ref().map(|c| c.id.clone());
                    ctx.service = self.pick_service(snapshot, &matched.route, key.as_deref());
                }
                // Look again: the consumer and the service may bring other instances into play.
                continue;
            }
            let Some((_, kind, instance)) = remaining.into_iter().max_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(a.1))) else { break };
            done.push(kind);

            let built = self.gateway.plugins.get(&instance.id);
            let verdict = match built.as_deref() {
                None | Some(Built::Broken(_)) => {
                    metrics::PLUGIN_ERRORS.with_label_values(&[kind]).inc();
                    if FAIL_CLOSED.contains(&kind) { Verdict::Deny { status: 500, code: "PLUGIN_ERROR", message: "a plugin that guards this route could not run" } } else { Verdict::Continue }
                }
                Some(Built::IpRestriction(plugin)) => plugin.check(req.client_ip),
                Some(Built::Cors(plugin)) => {
                    let result = plugin.check(&req);
                    ctx.response_headers.extend(result.response_headers);
                    match result.preflight {
                        Some(headers) => Verdict::Respond { status: 204, headers, body: Bytes::new() },
                        None => Verdict::Continue,
                    }
                }
                Some(Built::RequestSize { max_bytes }) => {
                    ctx.max_body = Some(*max_bytes);
                    let declared = req.header("content-length").and_then(|v| v.parse::<u64>().ok());
                    if declared.is_some_and(|n| n > *max_bytes) { Verdict::Deny { status: PAYLOAD_TOO_LARGE.0, code: PAYLOAD_TOO_LARGE.1, message: PAYLOAD_TOO_LARGE.2 } } else { Verdict::Continue }
                }
                Some(Built::Acl(plugin)) => plugin.check(ctx.consumer.as_ref().map(|c| c.groups.as_slice())),
                Some(Built::KeyAuth(_) | Built::BasicAuth(_) | Built::JwtAuth(_) | Built::MtlsAuth(_)) => {
                    let outcome = match built.as_deref() {
                        Some(Built::KeyAuth(plugin)) => plugin.check(&req, snapshot, &mut effects),
                        Some(Built::BasicAuth(plugin)) => plugin.check(&req, snapshot, &self.gateway.plugins.verified_passwords, &mut effects).await,
                        Some(Built::JwtAuth(plugin)) => plugin.check(&req, snapshot, &mut effects).await,
                        Some(Built::MtlsAuth(plugin)) => {
                            let presented = session.digest().and_then(|d| d.ssl_digest.as_ref()).and_then(|s| s.extension.get::<ClientCert>());
                            plugin.check(presented, &req, snapshot)
                        }
                        _ => unreachable!("matched just above"),
                    };
                    match outcome {
                        AuthOutcome::Invalid { challenge } => {
                            ctx.www_authenticate = challenge;
                            Verdict::Deny { status: 401, code: "UNAUTHENTICATED", message: "the credential presented is not valid" }
                        }
                        AuthOutcome::Unavailable => Verdict::Deny { status: 503, code: "AUTH_UNAVAILABLE", message: "authentication is temporarily unavailable" },
                        other => {
                            outcomes.push(other);
                            Verdict::Continue
                        }
                    }
                }
                Some(Built::RateLimit(cfg)) => {
                    let lookup = |name: &str| req.header(name).map(str::to_string);
                    let subject = Subject { plugin_id: &instance.id, route_id: &matched.route.id, workspace_id: &matched.workspace_id, consumer_id: consumer_id.as_deref(), client_ip: req.client_ip, host: req.host, path: req.path, header: &lookup };
                    let decision = self.buckets.take_request(&bucket_key(&cfg.scope, &subject), cfg);
                    ctx.rate = Some((cfg.clone(), decision.remaining));
                    if decision.allowed {
                        Verdict::Continue
                    } else {
                        metrics::LIMITED.with_label_values(&["rate_limit"]).inc();
                        ctx.retry_after = Some(decision.retry_after_secs.max(1));
                        Verdict::Deny { status: 429, code: "RATE_LIMITED", message: "rate limit exceeded" }
                    }
                }
                Some(Built::ForwardAuth(plugin)) => match plugin.check(&self.gateway.plugins.http, &req, scheme).await {
                    Forwarded::Allow(headers) => {
                        ctx.set_headers.extend(headers);
                        Verdict::Continue
                    }
                    Forwarded::Respond { status, headers, body } => Verdict::Respond { status, headers, body: body.into() },
                    Forwarded::Unavailable => Verdict::Deny { status: 503, code: "AUTH_UNAVAILABLE", message: "authentication is temporarily unavailable" },
                },
                Some(Built::HttpCallout(plugin)) => {
                    let consumer = ctx.consumer.as_ref().map(|c| (c.id.as_str(), c.name.as_str()));
                    let payload = plugin.describe("request", &req, &ctx.request_id, scheme, (&matched.route.id, &matched.route.name), consumer);
                    let verdict = if !plugin.on_request {
                        Verdict::Continue
                    } else {
                        match plugin.call(&self.gateway.plugins.http, &payload, now).await {
                            Ok(answer) if answer.respond => Verdict::Respond { status: answer.status.unwrap_or(200), headers: answer.headers, body: answer.body.unwrap_or_default().into() },
                            Ok(answer) => {
                                ctx.strip_headers.extend(answer.remove_headers);
                                ctx.set_headers.extend(answer.set_headers);
                                Verdict::Continue
                            }
                            Err(error) => {
                                metrics::PLUGIN_ERRORS.with_label_values(&[kind]).inc();
                                tracing::warn!(plugin = %instance.id, %error, fail_open = plugin.fail_open, "the callout service could not be asked");
                                if plugin.fail_open { Verdict::Continue } else { Verdict::Deny { status: 500, code: "PLUGIN_ERROR", message: "a service this route depends on could not be asked" } }
                            }
                        }
                    };
                    if plugin.on_response {
                        ctx.callout = built.clone();
                        ctx.callout_payload = Some(payload);
                    }
                    verdict
                }
                Some(Built::ResponseCache(config, tag)) => {
                    let cacheable = config.methods.iter().any(|m| m == req.method);
                    let authenticated = req.header("authorization").is_some() || ctx.consumer.is_some();
                    if !cacheable {
                        Verdict::Continue
                    } else if authenticated && !config.cache_authenticated {
                        metrics::CACHE_REQUESTS.with_label_values(&["bypass"]).inc();
                        ctx.cache_result = "BYPASS";
                        ctx.response_headers.push(("x-apg-cache".into(), "BYPASS".into()));
                        Verdict::Continue
                    } else {
                        let vary: Vec<(String, String)> = config.vary_headers.iter().map(|h| (h.to_ascii_lowercase(), req.header(h).unwrap_or("").to_string())).collect();
                        let key = response_cache::key(
                            &format!("{}:{tag}", instance.id),
                            matched.route.cache_tag,
                            &matched.workspace_id,
                            req.method,
                            req.host,
                            req.path,
                            query,
                            &vary,
                            consumer_id.as_deref().filter(|_| config.cache_authenticated),
                        );
                        match self.gateway.plugins.cache.get(&key) {
                            Some(hit) => {
                                metrics::CACHE_REQUESTS.with_label_values(&["hit"]).inc();
                                ctx.cache_result = "HIT";
                                let mut headers = hit.headers;
                                headers.push(("x-apg-cache".into(), "HIT".into()));
                                Verdict::Respond { status: hit.status, headers, body: if req.method == "HEAD" { Bytes::new() } else { hit.body } }
                            }
                            None => {
                                metrics::CACHE_REQUESTS.with_label_values(&["miss"]).inc();
                                ctx.cache_result = "MISS";
                                ctx.response_headers.push(("x-apg-cache".into(), "MISS".into()));
                                // A HEAD response has no body to keep.
                                if req.method == "GET" {
                                    ctx.cache_pending = Some(Pending::new(key, config.clone()));
                                }
                                Verdict::Continue
                            }
                        }
                    }
                }
                Some(Built::Quota(quota)) => {
                    let lookup = |name: &str| req.header(name).map(str::to_string);
                    let subject = Subject { plugin_id: &instance.id, route_id: &matched.route.id, workspace_id: &matched.workspace_id, consumer_id: consumer_id.as_deref(), client_ip: req.client_ip, host: req.host, path: req.path, header: &lookup };
                    let decision = self.gateway.plugins.quotas.take(&bucket_key(&quota.scope, &subject), quota, now);
                    ctx.response_headers.push(("x-quota-limit".into(), quota.limit.to_string()));
                    ctx.response_headers.push(("x-quota-remaining".into(), decision.remaining.to_string()));
                    ctx.response_headers.push(("x-quota-reset".into(), decision.reset.to_string()));
                    if decision.allowed {
                        Verdict::Continue
                    } else {
                        metrics::LIMITED.with_label_values(&["quota"]).inc();
                        ctx.retry_after = Some((decision.reset - now).max(1) as u64);
                        Verdict::Deny { status: 429, code: "QUOTA_EXCEEDED", message: "the quota for this period is used up" }
                    }
                }
                Some(Built::Redirect(plugin)) => {
                    let (status, location) = plugin.target(&self.vars(ctx, &req, snapshot, matched));
                    Verdict::Respond { status, headers: vec![("location".into(), location)], body: Bytes::new() }
                }
                Some(Built::StaticResponse(plugin)) => {
                    let (status, headers, body) = plugin.respond(&self.vars(ctx, &req, snapshot, matched));
                    Verdict::Respond { status, headers, body: body.into() }
                }
                Some(Built::RequestTransformer(plugin)) => {
                    let rendered = plugin.render(&self.vars(ctx, &req, snapshot, matched));
                    // A body is rewritten only when it is JSON and not declared larger than the limit.
                    let fits = req.header("content-length").and_then(|v| v.parse::<usize>().ok()).is_none_or(|n| n <= rendered.max_body_bytes);
                    if rendered.has_body_ops() && is_json(req.header("content-type")) {
                        if fits {
                            ctx.request_rewrite = Some(BodyRewrite::new(rendered.clone()));
                        } else {
                            metrics::TRANSFORM_SKIPPED.inc();
                        }
                    }
                    ctx.request_transform = Some(rendered);
                    Verdict::Continue
                }
                Some(Built::ResponseTransformer(plugin)) => {
                    ctx.response_transform = Some(plugin.render(&self.vars(ctx, &req, snapshot, matched)));
                    Verdict::Continue
                }
                Some(Built::Compression(plugin)) => {
                    if let Some(module) = session.downstream_modules_ctx.get_mut::<ResponseCompression>() {
                        // Level 0 switches an algorithm off; the client's Accept-Encoding chooses among the rest.
                        for (name, algorithm) in [("gzip", Algorithm::Gzip), ("br", Algorithm::Brotli), ("zstd", Algorithm::Zstd)] {
                            module.adjust_algorithm_level(algorithm, if plugin.algorithms.iter().any(|a| a == name) { 5 } else { 0 });
                        }
                    }
                    ctx.compression = Some(plugin.clone());
                    Verdict::Continue
                }
                Some(Built::AccessLog(plugin)) => {
                    ctx.log_suppressed = !plugin.writes((crate::upstream::random() >> 11) as f64 / (1u64 << 53) as f64);
                    ctx.log_fields = plugin.fields(&self.vars(ctx, &req, snapshot, matched));
                    Verdict::Continue
                }
                Some(Built::Bandwidth(cfg)) => {
                    let lookup = |name: &str| req.header(name).map(str::to_string);
                    let subject = Subject { plugin_id: &instance.id, route_id: &matched.route.id, workspace_id: &matched.workspace_id, consumer_id: consumer_id.as_deref(), client_ip: req.client_ip, host: req.host, path: req.path, header: &lookup };
                    let key = bucket_key(&cfg.scope, &subject);
                    if self.buckets.admit_bytes(&key, cfg) {
                        // Charged in the log phase, once the real size is known.
                        ctx.bandwidth = Some((key, cfg.clone()));
                        Verdict::Continue
                    } else {
                        metrics::LIMITED.with_label_values(&["bandwidth_limit"]).inc();
                        Verdict::Deny { status: 429, code: "BANDWIDTH_LIMIT_EXCEEDED", message: "bandwidth limit exceeded" }
                    }
                }
                Some(Built::Concurrency(cfg)) => {
                    let lookup = |name: &str| req.header(name).map(str::to_string);
                    let subject = Subject { plugin_id: &instance.id, route_id: &matched.route.id, workspace_id: &matched.workspace_id, consumer_id: consumer_id.as_deref(), client_ip: req.client_ip, host: req.host, path: req.path, header: &lookup };
                    match self.in_flight.acquire(&bucket_key(&cfg.scope, &subject), cfg.max_in_flight) {
                        Some(permit) => {
                            ctx.permits.push(permit);
                            Verdict::Continue
                        }
                        None => {
                            metrics::LIMITED.with_label_values(&["concurrency_limit"]).inc();
                            ctx.retry_after = Some(1);
                            Verdict::Deny { status: 429, code: "CONCURRENCY_LIMITED", message: "too many requests in progress" }
                        }
                    }
                }
            };
            if verdict != Verdict::Continue
                && kind != "access_log"
                && kinds.contains(&"access_log")
                && let Some(log) = snapshot.plugins.effective("access_log", &site)
                && let Some(Built::AccessLog(plugin)) = self.gateway.plugins.get(&log.id).as_deref()
            {
                // The request ends here, but its log line still follows the scope's override (spec PL-8).
                ctx.log_suppressed = !plugin.writes((crate::upstream::random() >> 11) as f64 / (1u64 << 53) as f64);
                ctx.log_fields = plugin.fields(&self.vars(ctx, &req, snapshot, matched));
            }
            match verdict {
                Verdict::Continue => {}
                Verdict::Deny { status, code, message } => {
                    self.respond_error(session, ctx, status, code, message).await?;
                    return Ok(true);
                }
                Verdict::Respond { status, headers, body } => {
                    self.respond_from_plugin(session, ctx, status, headers, body).await?;
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// The values templates may use for this request.
    fn vars<'a>(&'a self, ctx: &'a Ctx, req: &'a Req<'a>, snapshot: &'a Snapshot, matched: &'a Matched) -> Vars<'a> {
        Vars {
            req,
            request_id: &ctx.request_id,
            scheme: if ctx.is_tls { "https" } else { "http" },
            snapshot,
            route: &matched.route,
            service_name: ctx.service.as_ref().map_or("", |s| s.spec.name.as_str()),
            consumer: ctx.consumer.as_deref(),
            claims: ctx.jwt_claims.as_ref(),
            env_allow: self.gateway.plugins.env_allow(),
        }
    }

    /// Sends a response a plugin produced (a preflight answer, a redirect, a static body).
    async fn respond_from_plugin(&self, session: &mut Session, ctx: &mut Ctx, status: u16, headers: Vec<(String, String)>, body: Bytes) -> pingora_core::Result<()> {
        let mut head = ResponseHeader::build(status, None)?;
        head.insert_header("content-length", body.len().to_string())?;
        head.insert_header(REQUEST_ID_HEADER, ctx.request_id.as_str())?;
        for (name, value) in ctx.response_headers.iter().chain(headers.iter()) {
            head.append_header(name.clone(), value.clone())?;
        }
        ctx.bytes_out = body.len() as u64;
        session.write_response_header(Box::new(head), body.is_empty()).await?;
        if !body.is_empty() {
            session.write_response_body(Some(body), true).await?;
        }
        Ok(())
    }

    /// Sends a gateway-generated error (spec §6.7): the standard JSON shape,
    /// or the operator's custom response for this code.
    async fn respond_error(&self, session: &mut Session, ctx: &mut Ctx, status: u16, code: &'static str, message: &str) -> pingora_core::Result<()> {
        ctx.error_code = Some(code);
        metrics::GATEWAY_ERRORS.with_label_values(&[code]).inc();

        let snapshot = ctx.snapshot.clone();
        let route = ctx.matched.as_ref().map(|m| m.route.clone());
        let custom = snapshot.as_deref().and_then(|s| s.error_response(route.as_deref(), code));

        let status = custom.and_then(|c| c.status).unwrap_or(status);
        let (content_type, body) = match custom.and_then(|c| c.body.as_ref().map(|b| (c, b))) {
            Some((c, template)) => {
                let workspace = ctx.matched.as_ref().map(|m| m.workspace_id.clone());
                let lookup = |var: &str| -> Option<String> {
                    match var {
                        "request.id" => Some(ctx.request_id.clone()),
                        "request.method" => Some(ctx.method.clone()),
                        "request.host" => Some(ctx.host.clone()),
                        "request.path" => Some(ctx.path.clone()),
                        "client.ip" => Some(ctx.client_ip.clone()),
                        "error.code" => Some(code.to_string()),
                        "error.message" => Some(message.to_string()),
                        "error.status" => Some(status.to_string()),
                        "workspace.id" => workspace.clone(),
                        "workspace.slug" => workspace.as_deref().and_then(|w| snapshot.as_deref()?.workspace_slug(w)).map(str::to_string),
                        "workspace.name" => workspace.as_deref().and_then(|w| snapshot.as_deref()?.workspace_name(w)).map(str::to_string),
                        "route.id" => route.as_ref().map(|r| r.id.clone()),
                        "route.name" => route.as_ref().map(|r| r.name.clone()),
                        _ => None,
                    }
                };
                (c.content_type.clone().unwrap_or_else(|| "text/plain; charset=utf-8".to_string()), template.render(&lookup))
            }
            // Built by a serialiser, never by string formatting (spec ERR-1).
            None => (
                "application/json".to_string(),
                serde_json::json!({ "error": { "code": code, "message": message, "request_id": ctx.request_id } }).to_string(),
            ),
        };

        let mut head = ResponseHeader::build(status, None)?;
        head.insert_header("content-type", content_type)?;
        head.insert_header("content-length", body.len().to_string())?;
        head.insert_header("x-apg-error", code)?;
        head.insert_header(REQUEST_ID_HEADER, ctx.request_id.as_str())?;
        if let Some(c) = custom {
            for (k, v) in &c.headers {
                head.insert_header(k.clone(), v.clone())?;
            }
        }
        if let Some((cfg, remaining)) = &ctx.rate
            && cfg.response_headers
        {
            head.insert_header("ratelimit-limit", (cfg.burst as u64).to_string())?;
            head.insert_header("ratelimit-remaining", remaining.to_string())?;
        }
        if let Some(secs) = ctx.retry_after {
            head.insert_header("retry-after", secs.to_string())?;
        }
        if let Some(challenge) = ctx.www_authenticate.as_deref().filter(|_| status == 401) {
            head.insert_header("www-authenticate", challenge.to_string())?;
        }
        // Headers from plugins that ran before the refusal, so a browser can read a 401 or 429 (spec PL-8).
        for (name, value) in &ctx.response_headers {
            head.append_header(name.clone(), value.clone())?;
        }
        ctx.bytes_out = body.len() as u64;
        session.write_response_header(Box::new(head), false).await?;
        session.write_response_body(Some(Bytes::from(body)), true).await
    }

    async fn respond_plain(&self, session: &mut Session, status: u16, headers: &[(&'static str, String)], body: &str) -> pingora_core::Result<()> {
        let mut head = ResponseHeader::build(status, None)?;
        head.insert_header("content-type", "text/plain; charset=utf-8")?;
        head.insert_header("content-length", body.len().to_string())?;
        for (k, v) in headers {
            head.insert_header(*k, v.clone())?;
        }
        session.write_response_header(Box::new(head), false).await?;
        session.write_response_body(Some(Bytes::from(body.to_string())), true).await
    }
}

#[async_trait]
impl ProxyHttp for ApgProxy {
    type CTX = Ctx;

    fn new_ctx(&self) -> Self::CTX {
        Ctx::default()
    }

    /// Runs before the engine reads `Accept-Encoding`. Compression has to be
    /// switched on by then for the header to be noted at all; whether this
    /// request is compressed is decided later, by the `compression` plugin.
    async fn early_request_filter(&self, session: &mut Session, _ctx: &mut Self::CTX) -> pingora_core::Result<()> {
        if self.gateway.snapshot().plugins.types().any(|kind| kind == "compression")
            && let Some(module) = session.downstream_modules_ctx.get_mut::<ResponseCompression>()
        {
            module.adjust_level(5);
        }
        Ok(())
    }

    async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> pingora_core::Result<bool> {
        ctx.started = Some(Instant::now());
        // Off again until a `compression` plugin that applies to this request says otherwise.
        if let Some(module) = session.downstream_modules_ctx.get_mut::<ResponseCompression>() {
            module.adjust_level(0);
        }
        ctx.is_tls = session.digest().is_some_and(|d| d.ssl_digest.is_some());
        ctx.upgrade = session.is_upgrade_req();

        let (raw_path, query, method, host, inbound_id, forwarded_for) = {
            let req = session.req_header();
            (
                req.uri.path().to_string(),
                req.uri.query().unwrap_or("").to_string(),
                req.method.as_str().to_string(),
                // HTTP/2 carries the host in :authority; HTTP/1.1 in the Host header.
                req.uri.host().map(str::to_string).or_else(|| header(req, "host").map(str::to_string)),
                header(req, REQUEST_ID_HEADER).map(str::to_string),
                header(req, "x-forwarded-for").map(str::to_string),
            )
        };
        {
            let req = session.req_header();
            ctx.trace = Some(TraceContext::from_header(header(req, "traceparent"), crate::upstream::random));
            ctx.user_agent = header(req, "user-agent").unwrap_or("").chars().take(256).collect();
            ctx.http_version = match req.version {
                http::Version::HTTP_2 => "2",
                http::Version::HTTP_10 => "1.0",
                http::Version::HTTP_3 => "3",
                _ => "1.1",
            };
        }
        ctx.tls_version = session.digest().and_then(|d| d.ssl_digest.as_ref()).map(|s| s.version.to_string()).unwrap_or_default();
        ctx.raw_query = query.clone();
        if !ctx.counted_active {
            ctx.counted_active = true;
            metrics::ACTIVE_REQUESTS.inc();
        }
        ctx.method = method;
        ctx.request_id = inbound_id.filter(|v| valid_request_id(v)).unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let peer: Option<IpAddr> = session.client_addr().and_then(|a| a.as_inet()).map(|a| a.ip());
        ctx.peer_ip = peer.map(|ip| ip.to_string()).unwrap_or_default();
        ctx.peer_trusted = peer.is_some_and(|ip| self.settings.trusted_proxies.iter().any(|c| c.contains(ip)));
        ctx.server_port = session.server_addr().and_then(|a| a.as_inet()).map(|a| a.port());
        ctx.client_ip =client_ip(peer, forwarded_for.as_deref(), &self.settings.trusted_proxies).map(|ip| ip.to_string()).unwrap_or_default();

        // A load balancer that can only probe the traffic port (spec DP-3).
        if self.settings.traffic_health_path.as_deref() == Some(raw_path.as_str()) {
            let ready = self.gateway.health.readiness().ready;
            self.respond_plain(session, if ready { 200 } else { 503 }, &[], if ready { "ready\n" } else { "not ready\n" }).await?;
            return Ok(true);
        }

        if !ctx.is_tls {
            if let Some(token) = raw_path.strip_prefix("/.well-known/acme-challenge/") {
                // Answered by every node that holds the token, whichever one the
                // authority happens to reach (spec TLS-5, TLS-10). Never routed.
                match self.gateway.challenge(token) {
                    Some(answer) => self.respond_plain(session, 200, &[], &answer).await?,
                    None => self.respond_plain(session, 404, &[], "not found\n").await?,
                }
                return Ok(true);
            }
            if self.settings.http_mode == HttpMode::Redirect {
                let Some(h) = host.as_deref().map(normalize_host).filter(|h| !h.is_empty()) else {
                    self.respond_error(session, ctx, 400, "BAD_REQUEST", "the request has no Host").await?;
                    return Ok(true);
                };
                let port = self.settings.https_port.map(|p| format!(":{p}")).unwrap_or_default();
                let q = if query.is_empty() { String::new() } else { format!("?{query}") };
                let location = format!("https://{h}{port}{raw_path}{q}");
                self.respond_plain(session, 308, &[("location", location)], "").await?;
                return Ok(true);
            }
        }

        let Some(host) = host.as_deref().map(normalize_host).filter(|h| !h.is_empty()) else {
            self.respond_error(session, ctx, 400, "BAD_REQUEST", "the request has no Host").await?;
            return Ok(true);
        };
        ctx.host = host;
        // Match against the normalised path, so no spelling of a path reaches a
        // route its plain form would not (spec RT-3).
        ctx.path = match path::normalize(&raw_path) {
            Ok(p) => p,
            Err(_) => {
                ctx.path = raw_path;
                self.respond_error(session, ctx, 400, "BAD_REQUEST", "the request path is not valid").await?;
                return Ok(true);
            }
        };

        let snapshot = self.gateway.snapshot();
        ctx.snapshot = Some(snapshot.clone());
        let matched = {
            let req = session.req_header();
            let lookup = |name: &str| header(req, name).map(str::to_string);
            snapshot.match_request(&MatchRequest { host: &ctx.host, path: &ctx.path, method: &ctx.method, query: &query, header: &lookup })
        };
        let Some(matched) = matched else {
            self.respond_error(session, ctx, 404, "NO_ROUTE", "no route matches this request").await?;
            return Ok(true);
        };
        ctx.matched = Some(matched.clone());

        if snapshot.is_suspended(&matched.workspace_id) {
            self.respond_error(session, ctx, 403, "WORKSPACE_SUSPENDED", "this workspace is suspended").await?;
            return Ok(true);
        }

        // The side of a split keyed on the consumer can only be chosen once
        // the caller is known, so that choice waits for authentication.
        let by_consumer = matched.route.targets.len() > 1 && matched.route.split_key.as_deref() == Some("consumer");
        if !by_consumer {
            let split_key = matched.route.split_key.as_deref().and_then(|selector| self.key_source(session, ctx, &matched, &query).value(selector));
            let Some(service) = self.pick_service(&snapshot, &matched.route, split_key.as_deref()) else {
                self.respond_error(session, ctx, NO_BACKEND.0, NO_BACKEND.1, NO_BACKEND.2).await?;
                return Ok(true);
            };
            ctx.service = Some(service);
        }
        ctx.deadline = matched.route.timeout_ms.zip(ctx.started).map(|(ms, started)| started + Duration::from_millis(ms));

        // ── Request-phase plugins ────────────────────────────────────────────
        if self.run_request_plugins(session, ctx, &snapshot, &matched, &query).await? {
            return Ok(true);
        }
        let service = match ctx.service.clone() {
            Some(service) => service,
            None => {
                let key = ctx.consumer.as_ref().map(|c| c.id.clone());
                let Some(service) = self.pick_service(&snapshot, &matched.route, key.as_deref()) else {
                    self.respond_error(session, ctx, NO_BACKEND.0, NO_BACKEND.1, NO_BACKEND.2).await?;
                    return Ok(true);
                };
                ctx.service = Some(service.clone());
                service
            }
        };
        if service.spec.load_balancing.strategy == "hash" {
            let key = self.key_source(session, ctx, &matched, &query).value(&service.spec.load_balancing.hash_key);
            ctx.hash_key = key;
        }

        // ── Backend ──────────────────────────────────────────────────────────
        let Some(picked) = self.gateway.upstreams.select(&snapshot, &service, ctx.hash_key.as_deref(), &[]) else {
            self.respond_error(session, ctx, NO_BACKEND.0, NO_BACKEND.1, NO_BACKEND.2).await?;
            return Ok(true);
        };
        ctx.backend_target = picked.backend.target.clone();
        ctx.picked = Some(picked);

        if self.settings.stub_upstream {
            // Test mode: describe the routing decision instead of forwarding.
            let body = serde_json::json!({
                "stub": true,
                "route": matched.route.name,
                "service": service.spec.name,
                "backend": ctx.backend_target,
                "workspace": matched.workspace_id,
                "upstream_path": upstream_path(&matched.route, matched.matched_prefix.as_deref(), &ctx.path),
                "client_ip": ctx.client_ip,
            })
            .to_string();
            let mut head = ResponseHeader::build(200, None)?;
            head.insert_header("content-type", "application/json")?;
            head.insert_header("content-length", body.len().to_string())?;
            head.insert_header(REQUEST_ID_HEADER, ctx.request_id.as_str())?;
            ctx.bytes_out = body.len() as u64;
            session.write_response_header(Box::new(head), false).await?;
            session.write_response_body(Some(Bytes::from(body)), true).await?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Called once per attempt. The first attempt uses the backend chosen in
    /// the request phase; a retry chooses again, away from what already failed.
    async fn upstream_peer(&self, _session: &mut Session, ctx: &mut Self::CTX) -> pingora_core::Result<Box<HttpPeer>> {
        let (Some(snapshot), Some(service)) = (ctx.snapshot.clone(), ctx.service.clone()) else {
            return Err(Error::explain(ErrorType::InternalError, "no service was selected"));
        };
        let upstreams = &self.gateway.upstreams;
        loop {
            if ctx.picked.is_none() {
                let Some(picked) = upstreams.select(&snapshot, &service, ctx.hash_key.as_deref(), &ctx.tried) else {
                    return Self::refuse(ctx, NO_BACKEND);
                };
                ctx.backend_target = picked.backend.target.clone();
                ctx.picked = Some(picked);
            }
            ctx.tries += 1;
            ctx.recorded = false;
            ctx.upstream_status = None;
            if ctx.tries > 1 {
                metrics::UPSTREAM_RETRIES.with_label_values(&[&service.workspace_id, &service.spec.name]).inc();
            }

            // The route's deadline covers every attempt (spec UP-8).
            let budget = match ctx.deadline.map(|d| d.saturating_duration_since(Instant::now())) {
                Some(left) if left.is_zero() => return Self::refuse(ctx, UPSTREAM_TIMEOUT),
                left => left,
            };

            let backend = &ctx.picked.as_ref().expect("chosen above").backend;
            let reason = match upstreams.address(&service, backend, ctx.hash_key.as_deref()).await {
                Ok(addr) => match upstreams.peer(&service, backend, addr, budget) {
                    Ok(mut peer) => {
                        // An upgraded connection is closed after the route's idle timeout, not the service's read timeout.
                        // Pingora restarts the read on traffic either way, so this is idle in both directions.
                        if ctx.upgrade
                            && let Some(matched) = &ctx.matched
                        {
                            let idle = Duration::from_millis(matched.route.idle_timeout_ms);
                            peer.options.read_timeout = Some(budget.map_or(idle, |b| idle.min(b)));
                        }
                        ctx.upstream_started = Some(Instant::now());
                        ctx.upstream_addr = Some(addr);
                        return Ok(Box::new(peer));
                    }
                    Err(reason) => reason,
                },
                Err(reason) => reason.to_string(),
            };
            // A backend that cannot even be dialled counts as a connection failure.
            tracing::warn!(service = %service.spec.name, backend = %backend.target, %reason, "backend cannot be used");
            self.attempt_failed(ctx, &reason);
            if !Self::may_retry(ctx, "connect_failure") {
                return Self::refuse(ctx, UPSTREAM_ERROR);
            }
        }
    }

    async fn upstream_request_filter(&self, _session: &mut Session, upstream: &mut RequestHeader, ctx: &mut Self::CTX) -> pingora_core::Result<()> {
        let (Some(matched), Some(service), Some(backend)) = (&ctx.matched, &ctx.service, ctx.picked.as_ref().map(|p| &p.backend)) else { return Ok(()) };

        // Path: strip_path, then rewrite, keeping the query string.
        let new_path = upstream_path(&matched.route, matched.matched_prefix.as_deref(), &ctx.path);
        let path_and_query = match upstream.uri.query() {
            Some(q) => format!("{new_path}?{q}"),
            None => new_path,
        };
        if let Ok(uri) = path_and_query.parse::<http::Uri>() {
            upstream.set_uri(uri);
        }

        // A client must not be able to forge identity: drop anything in our namespace (spec HDR-1).
        let forged: Vec<String> = upstream.headers.keys().map(|k| k.as_str().to_string()).filter(|k| k.starts_with("x-apg-")).collect();
        for name in forged {
            upstream.remove_header(name.as_str());
        }

        // Forwarded headers (spec §6.5). X-Forwarded-For is extended only when it
        // came from a trusted proxy; otherwise whatever the client sent is replaced.
        let inbound_xff = header(upstream, "x-forwarded-for").map(str::to_string);
        let xff = match (&inbound_xff, ctx.peer_trusted) {
            (Some(existing), true) => format!("{existing}, {}", ctx.peer_ip),
            _ => ctx.client_ip.clone(),
        };
        upstream.insert_header("x-forwarded-for", xff)?;
        if let Some(port) = ctx.server_port {
            upstream.insert_header("x-forwarded-port", port.to_string())?;
        }
        upstream.insert_header("x-real-ip", ctx.client_ip.as_str())?;
        upstream.insert_header("x-forwarded-proto", if ctx.is_tls { "https" } else { "http" })?;
        upstream.insert_header("x-forwarded-host", ctx.host.as_str())?;
        upstream.insert_header(REQUEST_ID_HEADER, ctx.request_id.as_str())?;

        // What authentication plugins asked for: credentials hidden, claims passed on.
        for name in &ctx.strip_headers {
            upstream.remove_header(name.as_str());
        }
        if !ctx.strip_query.is_empty()
            && let Some(query) = upstream.uri.query()
        {
            let kept: Vec<&str> = query.split('&').filter(|pair| !ctx.strip_query.iter().any(|name| pair.split('=').next() == Some(name.as_str()))).collect();
            let rebuilt = if kept.is_empty() { upstream.uri.path().to_string() } else { format!("{}?{}", upstream.uri.path(), kept.join("&")) };
            if let Ok(uri) = rebuilt.parse::<http::Uri>() {
                upstream.set_uri(uri);
            }
        }
        for (name, value) in &ctx.set_headers {
            upstream.insert_header(name.clone(), value.clone())?;
        }

        // The trace this request belongs to, with this node as the caller (spec §12.3).
        if let Some(trace) = &ctx.trace {
            upstream.insert_header("traceparent", trace.outgoing(crate::upstream::random))?;
        }
        if let Some(transform) = &ctx.request_transform {
            apply_header_ops(upstream, &transform.headers)?;
            if !transform.query.is_empty() {
                let query = transform.query.apply_to_query(upstream.uri.query().unwrap_or(""));
                let rebuilt = if query.is_empty() { upstream.uri.path().to_string() } else { format!("{}?{query}", upstream.uri.path()) };
                if let Ok(uri) = rebuilt.parse::<http::Uri>() {
                    upstream.set_uri(uri);
                }
            }
        }
        if ctx.request_rewrite.is_some() {
            // The rewritten body has another length, which is not known yet.
            upstream.remove_header("content-length");
            upstream.insert_header("transfer-encoding", "chunked")?;
        }

        if ctx.snapshot.as_ref().is_some_and(|s| s.identity_headers) {
            upstream.insert_header("x-apg-workspace", matched.workspace_id.as_str())?;
            if let Some(consumer) = &ctx.consumer {
                upstream.insert_header("x-apg-consumer-id", consumer.id.as_str())?;
                upstream.insert_header("x-apg-consumer-name", consumer.name.as_str())?;
                if let Some(custom_id) = &consumer.custom_id {
                    upstream.insert_header("x-apg-consumer-custom-id", custom_id.as_str())?;
                }
            }
        }

        // Host header (spec HDR-3).
        match service.spec.host_header.as_str() {
            "preserve" => {}
            "backend" => {
                upstream.insert_header("host", backend.target.as_str())?;
            }
            literal => {
                upstream.insert_header("host", literal)?;
            }
        }
        Ok(())
    }

    async fn request_body_filter(&self, _session: &mut Session, body: &mut Option<Bytes>, end_of_stream: bool, ctx: &mut Self::CTX) -> pingora_core::Result<()> {
        // Bytes actually transferred, including chunked bodies (spec USG-3).
        if let Some(b) = body {
            ctx.bytes_in += b.len() as u64;
        }
        if let Some(rewrite) = &mut ctx.request_rewrite {
            let mut skipped = false;
            *body = rewrite.feed(body.take(), end_of_stream, &mut skipped);
            if skipped {
                metrics::TRANSFORM_SKIPPED.inc();
            }
        }
        // A body with no declared length is measured as it streams.
        if ctx.max_body.is_some_and(|max| ctx.bytes_in > max) {
            return Self::refuse(ctx, PAYLOAD_TOO_LARGE);
        }
        Ok(())
    }

    async fn response_filter(&self, session: &mut Session, upstream_response: &mut ResponseHeader, ctx: &mut Self::CTX) -> pingora_core::Result<()> {
        ctx.upstream_status = Some(upstream_response.status.as_u16());
        let socket = ctx.upstream_socket.take();
        if upstream_response.status == http::StatusCode::SWITCHING_PROTOCOLS
            && let (Some(matched), Some(service)) = (&ctx.matched, &ctx.service)
        {
            session.set_read_timeout(Some(Duration::from_millis(matched.route.idle_timeout_ms)));
            if let Some(socket) = socket {
                let drain = Duration::from_millis(service.spec.drain_timeout_ms);
                ctx.upgraded = Some(self.gateway.long_lived.register(&service.id, &ctx.backend_target, drain, socket));
            }
        }
        if ctx.upstream_ms.is_none() {
            ctx.upstream_ms = ctx.upstream_started.map(|t| t.elapsed().as_millis() as u64);
        }
        let content_type = upstream_response.headers.get("content-type").and_then(|v| v.to_str().ok()).map(str::to_string);
        let content_length = upstream_response.headers.get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        let encoded = upstream_response.headers.contains_key("content-encoding");
        if let Some(transform) = ctx.response_transform.clone() {
            apply_response_header_ops(upstream_response, &transform.headers)?;
            // A body is rewritten only when it is plain JSON of a size that can be held.
            if transform.has_body_ops() && is_json(content_type.as_deref()) && !encoded {
                if content_length.is_none_or(|n| n as usize <= transform.max_body_bytes) {
                    upstream_response.remove_header("content-length");
                    upstream_response.insert_header("transfer-encoding", "chunked")?;
                    ctx.response_rewrite = Some(BodyRewrite::new(transform));
                } else {
                    metrics::TRANSFORM_SKIPPED.inc();
                }
            }
        }
        if let Some(compression) = &ctx.compression
            && !compression.applies(content_type.as_deref(), content_length, encoded)
            && let Some(module) = session.downstream_modules_ctx.get_mut::<ResponseCompression>()
        {
            module.adjust_level(0);
        }
        if let (Some(built), Some(mut payload)) = (ctx.callout.clone(), ctx.callout_payload.take())
            && let Built::HttpCallout(plugin) = &*built
        {
            payload["phase"] = "response".into();
            payload["response"] = serde_json::json!({ "status": upstream_response.status.as_u16(), "headers": plugin.visible_headers(&upstream_response.headers) });
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            let answer = match plugin.call(&self.gateway.plugins.http, &payload, now).await {
                Ok(answer) => Some(answer),
                Err(error) => {
                    metrics::PLUGIN_ERRORS.with_label_values(&["http_callout"]).inc();
                    tracing::warn!(%error, fail_open = plugin.fail_open, "the callout service could not be asked about the response");
                    (!plugin.fail_open).then(|| Answer {
                        respond: true,
                        status: Some(500),
                        headers: vec![("content-type".into(), "application/json".into()), ("x-apg-error".into(), "PLUGIN_ERROR".into())],
                        body: Some(serde_json::json!({ "error": { "code": "PLUGIN_ERROR", "message": "a service this route depends on could not be asked", "request_id": ctx.request_id } }).to_string()),
                        ..Default::default()
                    })
                }
            };
            match answer {
                Some(answer) if answer.respond => {
                    if let Some(status) = answer.status {
                        upstream_response.set_status(status)?;
                    }
                    for (name, value) in &answer.headers {
                        upstream_response.insert_header(name.clone(), value.clone())?;
                    }
                    // The upstream's body is dropped and this one sent in its place.
                    upstream_response.remove_header("content-length");
                    upstream_response.insert_header("transfer-encoding", "chunked")?;
                    ctx.response_replace = Some(Bytes::from(answer.body.unwrap_or_default()));
                    ctx.response_rewrite = None;
                    ctx.cache_pending = None;
                }
                Some(answer) => {
                    for name in &answer.remove_headers {
                        upstream_response.remove_header(name.as_str());
                    }
                    for (name, value) in &answer.set_headers {
                        upstream_response.insert_header(name.clone(), value.clone())?;
                    }
                }
                None => {}
            }
        }
        if let Some(pending) = &mut ctx.cache_pending {
            let status = upstream_response.status.as_u16();
            let cache_control = upstream_response.headers.get("cache-control").and_then(|v| v.to_str().ok());
            // An encoded body is only right for clients that asked for that encoding, so it is not kept.
            if pending.config.statuses.contains(&status)
                && !encoded
                && let Some(ttl) = lifetime(&pending.config, cache_control, upstream_response.headers.contains_key("set-cookie"))
            {
                pending.store = Some((status, storable_headers(&upstream_response.headers), ttl));
            }
        }
        upstream_response.insert_header(REQUEST_ID_HEADER, ctx.request_id.as_str())?;
        if let Some((cfg, remaining)) = &ctx.rate
            && cfg.response_headers
        {
            upstream_response.insert_header("ratelimit-limit", (cfg.burst as u64).to_string())?;
            upstream_response.insert_header("ratelimit-remaining", remaining.to_string())?;
        }
        // Headers from plugins go on last, so they are never stored with a cached response.
        for (name, value) in &ctx.response_headers {
            upstream_response.append_header(name.clone(), value.clone())?;
        }
        Ok(())
    }

    fn response_body_filter(&self, _session: &mut Session, body: &mut Option<Bytes>, end_of_stream: bool, ctx: &mut Self::CTX) -> pingora_core::Result<Option<Duration>> {
        if let Some(replacement) = ctx.response_replace.take() {
            *body = Some(replacement);
            ctx.response_swallow = true;
        } else if ctx.response_swallow {
            *body = Some(Bytes::new());
        }
        if let Some(rewrite) = &mut ctx.response_rewrite {
            let mut skipped = false;
            *body = rewrite.feed(body.take(), end_of_stream, &mut skipped);
            if skipped {
                metrics::TRANSFORM_SKIPPED.inc();
            }
        }
        if let Some(pending) = &mut ctx.cache_pending
            && let Some((cached, ttl)) = pending.feed(body.as_ref(), end_of_stream)
        {
            self.gateway.plugins.cache.put(pending.key.clone(), cached, ttl);
        }
        if let Some(b) = body {
            ctx.bytes_out += b.len() as u64;
        }
        // A response still streaming when the route's deadline passes is cut
        // off: the status is already sent, so the connection is closed (spec UP-8).
        if !end_of_stream && ctx.deadline.is_some_and(|d| Instant::now() > d) {
            return Err(Error::explain(ErrorType::ReadTimedout, "the route's timeout expired while the response was streaming"));
        }
        Ok(None)
    }

    /// No connection was made, so nothing was sent and another backend may
    /// always be tried (spec UP-10).
    fn fail_to_connect(&self, session: &mut Session, _peer: &HttpPeer, ctx: &mut Self::CTX, mut e: Box<Error>) -> Box<Error> {
        self.attempt_failed(ctx, &failure_reason(&e));
        // The address itself did not take a connection: the name's other addresses are preferred for a while.
        if let (Some(addr), ErrorType::ConnectRefused | ErrorType::ConnectNoRoute | ErrorType::ConnectTimedout | ErrorType::ConnectError) = (ctx.upstream_addr, e.etype()) {
            self.gateway.upstreams.connect_failed(addr);
        }
        let timed_out = matches!(e.etype(), ErrorType::ConnectTimedout | ErrorType::TLSHandshakeTimedout);
        let again = (Self::may_retry(ctx, "connect_failure") || (timed_out && Self::may_retry(ctx, "timeout"))) && !session.as_ref().retry_buffer_truncated();
        e.set_retry(again);
        e
    }

    /// A failure after a connection was made. The request may already be with
    /// the upstream, so it is sent again only when that is safe (spec UP-10).
    fn error_while_proxy(&self, peer: &HttpPeer, session: &mut Session, e: Box<Error>, ctx: &mut Self::CTX, client_reused: bool) -> Box<Error> {
        let mut e = e.more_context(format!("Peer: {peer}"));
        if !matches!(e.esource(), ErrorSource::Upstream) {
            // The client went away or sent something invalid: not the backend's doing.
            e.set_retry(false);
            return e;
        }
        let non_idempotent = ctx.service.as_ref().is_some_and(|s| s.spec.retries.non_idempotent);
        let replayable = (idempotent(&ctx.method) || non_idempotent) && !session.as_ref().retry_buffer_truncated() && session.response_written().is_none();

        // A pooled connection the upstream had already closed says nothing
        // about the backend: the same backend gets the request on a fresh one.
        e.retry.decide_reuse(client_reused);
        if e.retry() {
            e.set_retry(replayable);
            return e;
        }

        self.attempt_failed(ctx, &failure_reason(&e));
        let timed_out = matches!(e.etype(), ErrorType::ReadTimedout | ErrorType::WriteTimedout);
        e.set_retry(timed_out && replayable && Self::may_retry(ctx, "timeout"));
        e
    }

    /// Upstream failures answer in the standard error shape too.
    async fn fail_to_proxy(&self, session: &mut Session, e: &Error, ctx: &mut Self::CTX) -> FailToProxy {
        let timeout = matches!(e.etype(), ErrorType::ConnectTimedout | ErrorType::TLSHandshakeTimedout | ErrorType::ReadTimedout | ErrorType::WriteTimedout);
        let (status, code, message) = ctx.refusal.take().unwrap_or(if timeout { UPSTREAM_TIMEOUT } else { UPSTREAM_ERROR });
        // If the response has already started there is nothing left to say.
        if session.response_written().is_none() {
            let _ = self.respond_error(session, ctx, status, code, message).await;
        }
        FailToProxy { error_code: status, can_reuse_downstream: false }
    }

    /// For a request that asks for an upgrade, keeps a second descriptor of
    /// the upstream socket so the connection can be closed if its backend drains.
    async fn connected_to_upstream(
        &self,
        _session: &mut Session,
        _reused: bool,
        _peer: &HttpPeer,
        #[cfg(unix)] fd: std::os::unix::io::RawFd,
        #[cfg(windows)] _sock: std::os::windows::io::RawSocket,
        _digest: Option<&Digest>,
        ctx: &mut Self::CTX,
    ) -> pingora_core::Result<()> {
        #[cfg(unix)]
        if ctx.upgrade {
            // SAFETY: Pingora keeps `fd` open for the whole of this call; it is only duplicated here.
            let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
            ctx.upstream_socket = borrowed.try_clone_to_owned().ok().map(std::net::TcpStream::from);
        }
        Ok(())
    }

    async fn logging(&self, session: &mut Session, e: Option<&Error>, ctx: &mut Self::CTX) {
        // The connection is over: stop watching it and let its socket go.
        ctx.upgraded = None;
        ctx.upstream_socket = None;
        let status = session.response_written().map_or(0, |r| r.status.as_u16());
        let elapsed = ctx.started.map_or(0.0, |s| s.elapsed().as_secs_f64());
        let class = metrics::status_class(status);
        if ctx.counted_active {
            ctx.counted_active = false;
            metrics::ACTIVE_REQUESTS.dec();
        }
        let route_name = ctx.matched.as_ref().map_or("", |m| m.route.name.as_str());
        let service_name = ctx.service.as_ref().map_or("", |s| s.spec.name.as_str());
        let (route_label, service_label) = metrics::series(route_name, service_name);
        metrics::REQUESTS.with_label_values(&[route_label, service_label, class]).inc();
        metrics::DURATION.with_label_values(&[route_label, service_label]).observe(elapsed);
        metrics::REQUEST_BYTES.with_label_values(&[route_label, service_label]).inc_by(ctx.bytes_in);
        metrics::RESPONSE_BYTES.with_label_values(&[route_label, service_label]).inc_by(ctx.bytes_out);
        if let Some(ms) = ctx.upstream_ms {
            metrics::UPSTREAM_DURATION.with_label_values(&[route_label, service_label]).observe(ms as f64 / 1000.0);
        }

        // Usage: only requests that matched a route and chose a service are attributable (spec USG-1).
        if let (Some(usage), Some(matched), Some(service), Some(snapshot)) = (self.gateway.usage.get(), &ctx.matched, &ctx.service, &ctx.snapshot)
            && snapshot.flag("usage_metering")
            && !self.settings.stub_upstream
        {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            let sample = crate::usage::Sample { status, bytes_in: ctx.bytes_in, bytes_out: ctx.bytes_out, latency_ms: (elapsed * 1000.0) as u64, upstream_latency_ms: ctx.upstream_ms.unwrap_or(0) };
            usage.record(now, &matched.workspace_id, &service.id, &matched.route.id, ctx.consumer.as_ref().map(|c| c.id.as_str()), sample);
        }

        // Circuit accounting for an attempt the upstream answered: a status in
        // the service's `passive.statuses` counts against the backend, any
        // other answer for it. Attempts that failed outright were recorded
        // when they failed.
        if let (Some(snapshot), Some(service), Some(picked), Some(upstream_status)) = (&ctx.snapshot, &ctx.service, &ctx.picked, ctx.upstream_status)
            && !ctx.recorded
        {
            let failed = service.spec.health_check.passive.statuses.contains(&upstream_status);
            if failed {
                picked.failed_because(&format!("answered {upstream_status}"));
            }
            self.gateway.upstreams.record(snapshot, service, picked, !failed);
        }
        if let Some(e) = e {
            tracing::debug!(request_id = %ctx.request_id, error = %e, "request ended with an error");
        }

        if let Some((key, cfg)) = &ctx.bandwidth {
            self.buckets.debit_bytes(key, cfg, ctx.bytes_in + ctx.bytes_out);
        }

        if ctx.log_suppressed {
            return;
        }
        // The access log (spec §12.2). The global setting chooses the sink and
        // may sample; an `access_log` plugin has already had its say above.
        let setting = ctx.snapshot.as_ref().map(|s| &s.access_log);
        let sink = Sink::parse(setting.and_then(|s| s.sink.as_deref()));
        let sampled = setting.is_none_or(|s| s.sample_rate >= 1.0 || ((crate::upstream::random() >> 11) as f64 / (1u64 << 53) as f64) < s.sample_rate);
        if sink == Sink::Off || !sampled {
            return;
        }
        let mut line = serde_json::json!({
            "ts": rfc3339_millis(std::time::SystemTime::now()),
            "request_id": ctx.request_id,
            "trace_id": ctx.trace.as_ref().map_or("", |t| t.trace_id.as_str()),
            "client_ip": ctx.client_ip,
            "method": ctx.method,
            "scheme": if ctx.is_tls { "https" } else { "http" },
            "host": ctx.host,
            "path": ctx.path,
            // Header values are never logged; credentials in the query are masked (spec OBS-3).
            "query": self.gateway.access_log.redact_query(&ctx.raw_query, &ctx.strip_query),
            "status": status,
            "error_code": ctx.error_code.unwrap_or(""),
            "bytes_in": ctx.bytes_in,
            "bytes_out": ctx.bytes_out,
            "duration_ms": (elapsed * 1000.0) as u64,
            "upstream_duration_ms": ctx.upstream_ms,
            "route": route_name,
            "service": service_name,
            "backend": ctx.backend_target,
            "workspace": ctx.matched.as_ref().map_or("", |m| m.workspace_id.as_str()),
            "consumer": ctx.consumer.as_ref().map_or("", |c| c.name.as_str()),
            "retries": ctx.tries.saturating_sub(1),
            "cache": ctx.cache_result,
            "http_version": ctx.http_version,
            "tls_version": ctx.tls_version,
            "user_agent": ctx.user_agent,
        });
        // Custom fields: the setting's, then the plugin's on top.
        let mut custom = serde_json::Map::new();
        if let (Some(setting), Some(snapshot), Some(matched)) = (setting.filter(|s| !s.custom_fields.is_empty()), &ctx.snapshot, &ctx.matched) {
            let headers = session.req_header().headers.clone();
            let req = Req { method: &ctx.method, host: &ctx.host, path: &ctx.path, query: &ctx.raw_query, client_ip: &ctx.client_ip, headers: &headers, workspace_id: &matched.workspace_id, system_route: matched.route.system, now: 0 };
            let vars = self.vars(ctx, &req, snapshot, matched);
            for (name, template) in &setting.custom_fields {
                custom.insert(name.clone(), serde_json::Value::String(vars.render(template)));
            }
        }
        if let Some(serde_json::Value::Object(fields)) = ctx.log_fields.as_deref().and_then(|f| serde_json::from_str(f).ok()) {
            custom.extend(fields);
        }
        if !custom.is_empty() {
            line["custom"] = serde_json::Value::Object(custom);
        }
        self.gateway.access_log.write(&sink, line.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use apg_core::resources::Resources;
    use serde_json::json;

    fn route_with(body: serde_json::Value) -> Arc<CompiledRoute> {
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "s", "backends": [{ "target": "a:1" }] })));
        let mut body = body;
        body["name"] = json!("r");
        body["service"] = json!("s");
        r.apply(&ChangeEvent::upsert("route", "r", Some("w".into()), body));
        let snap = Snapshot::build(&r);
        assert_eq!(snap.report, Default::default());
        snap.match_request(&MatchRequest { host: "h", path: "/api/v1/users", method: "GET", query: "", header: &|_| None }).unwrap().route
    }

    #[test]
    fn path_is_passed_through_unless_asked_otherwise() {
        let r = route_with(json!({ "paths": ["/api/v1"] }));
        assert_eq!(upstream_path(&r, Some("/api/v1"), "/api/v1/users"), "/api/v1/users");
    }

    #[test]
    fn strip_path_removes_the_matched_prefix_and_keeps_a_root() {
        let r = route_with(json!({ "paths": ["/api/v1"], "strip_path": true }));
        assert_eq!(upstream_path(&r, Some("/api/v1"), "/api/v1/users"), "/users");
        assert_eq!(upstream_path(&r, Some("/api/v1"), "/api/v1"), "/");
        assert_eq!(upstream_path(&r, Some("/api/v1/"), "/api/v1/users"), "/users");
        // no matched prefix (a regex or host-only match): nothing to strip
        assert_eq!(upstream_path(&r, None, "/api/v1/users"), "/api/v1/users");
    }

    #[test]
    fn rewrite_variants() {
        let whole = route_with(json!({ "paths": ["/api/v1"], "rewrite": { "path": "/rpc" } }));
        assert_eq!(upstream_path(&whole, Some("/api/v1"), "/api/v1/users"), "/rpc");

        let prefix = route_with(json!({ "paths": ["/api/v1"], "rewrite": { "prefix": "/v2" } }));
        assert_eq!(upstream_path(&prefix, Some("/api/v1"), "/api/v1/users"), "/v2/users");
        assert_eq!(upstream_path(&prefix, Some("/api/v1"), "/api/v1"), "/v2");

        let regex = route_with(json!({ "paths": ["/api/v1"], "rewrite": { "regex": "^/api/v1/users/([0-9]+)$", "replacement": "/u/$1" } }));
        assert_eq!(upstream_path(&regex, Some("/api/v1"), "/api/v1/users/42"), "/u/42");
        assert_eq!(upstream_path(&regex, Some("/api/v1"), "/api/v1/users"), "/api/v1/users");

        let both = route_with(json!({ "paths": ["/api/v1"], "strip_path": true, "rewrite": { "regex": "^/users", "replacement": "/people" } }));
        assert_eq!(upstream_path(&both, Some("/api/v1"), "/api/v1/users/7"), "/people/7");
    }

    #[test]
    fn request_ids_are_accepted_only_when_well_formed() {
        assert!(valid_request_id("req-123_abc.DEF"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id("has space"));
        assert!(!valid_request_id("new\nline"));
        assert!(!valid_request_id(&"a".repeat(129)));
    }

    #[test]
    fn key_selectors_read_the_request() {
        let mut req = RequestHeader::build("GET", b"/orders?tenant=acme&flag&empty=", None).unwrap();
        req.insert_header("x-user", "u-7").unwrap();
        req.insert_header("cookie", "theme=dark; session=abc123").unwrap();
        let source = KeySource { req: &req, host: "api.example.com", client_ip: "203.0.113.9", path: "/orders", query: "tenant=acme&flag&empty=", workspace_id: "w1", consumer_id: "c-7" };
        let value = |selector: &str| source.value(selector);
        assert_eq!(value("host").as_deref(), Some("api.example.com"));
        assert_eq!(value("client_ip").as_deref(), Some("203.0.113.9"));
        assert_eq!(value("path").as_deref(), Some("/orders"));
        assert_eq!(value("workspace").as_deref(), Some("w1"));
        assert_eq!(value("header:x-user").as_deref(), Some("u-7"));
        assert_eq!(value("cookie:session").as_deref(), Some("abc123"));
        assert_eq!(value("query:tenant").as_deref(), Some("acme"));
        // Absent or empty: the request has no key, and the caller falls back to rotation.
        assert_eq!(value("consumer").as_deref(), Some("c-7"));
        for absent in ["header:x-missing", "cookie:missing", "query:missing", "query:flag", "query:empty", "nonsense"] {
            assert_eq!(value(absent), None, "{absent}");
        }
        let anonymous = KeySource { req: &req, host: "h", client_ip: "", path: "/", query: "", workspace_id: "w", consumer_id: "" };
        assert_eq!(anonymous.value("client_ip"), None);
        assert_eq!(anonymous.value("consumer"), None, "no consumer was authenticated");

        // The first n segments of the path: one key per database under /db/<name>.
        let deep = KeySource { req: &req, host: "h", client_ip: "", path: "/db/sales/tables/t", query: "", workspace_id: "w", consumer_id: "" };
        assert_eq!(deep.value("path_prefix:2").as_deref(), Some("/db/sales"));
        assert_eq!(deep.value("path_prefix:9").as_deref(), Some("/db/sales/tables/t"));
        assert_eq!(deep.value("path_prefix:x"), None);
    }

    #[test]
    fn only_idempotent_methods_are_replayed_by_default() {
        for m in ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"] {
            assert!(idempotent(m), "{m}");
        }
        for m in ["POST", "PATCH", "CONNECT"] {
            assert!(!idempotent(m), "{m}");
        }
    }

    fn split_proxy(route: serde_json::Value) -> (ApgProxy, Arc<Snapshot>, Arc<CompiledRoute>) {
        let gateway = Gateway::new("n".into(), "file", 30);
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        for name in ["stable", "canary"] {
            r.apply(&ChangeEvent::upsert("service", name, Some("w".into()), json!({ "name": name, "backends": [{ "target": "a:1" }] })));
        }
        r.apply(&ChangeEvent::upsert("route", "r", Some("w".into()), route));
        gateway.install(&r, 1);
        let snap = gateway.snapshot();
        assert_eq!(snap.report, Default::default());
        let route = snap.match_request(&MatchRequest { host: "h", path: "/", method: "GET", query: "", header: &|_| None }).unwrap().route;
        let settings = ProxySettings { http_mode: HttpMode::Proxy, traffic_health_path: None, trusted_proxies: vec![], stub_upstream: false, https_port: None };
        (ApgProxy::new(gateway, settings), snap, route)
    }

    // spec UP-15
    #[test]
    fn a_split_follows_its_weights_and_is_sticky_for_a_key() {
        let (p, snap, route) = split_proxy(json!({ "name": "r", "split": [{ "service": "stable", "weight": 9 }, { "service": "canary", "weight": 1 }], "split_key": "header:x-user" }));
        let side = |key: Option<&str>| p.pick_service(&snap, &route, key).unwrap().spec.name.clone();

        // Without a key: exactly by weight over a cycle.
        let canary = (0..100).filter(|_| side(None) == "canary").count();
        assert_eq!(canary, 10);

        // With a key: always the same side, and about a tenth of keys on the canary.
        let mut on_canary = 0;
        for i in 0..2000 {
            let key = format!("user-{i}");
            let first = side(Some(&key));
            assert_eq!(first, side(Some(&key)));
            if first == "canary" {
                on_canary += 1;
            }
        }
        assert!((140..=260).contains(&on_canary), "about 10 % of keys; got {on_canary}");

        // A side with weight 0 gets nothing, keyed or not.
        let (p, snap, route) = split_proxy(json!({ "name": "r", "split": [{ "service": "stable", "weight": 1 }, { "service": "canary", "weight": 0 }] }));
        assert!((0..50).all(|i| p.pick_service(&snap, &route, Some(&format!("k{i}"))).unwrap().spec.name == "stable"));
        assert!((0..50).all(|_| p.pick_service(&snap, &route, None).unwrap().spec.name == "stable"));
    }

    #[test]
    fn retries_stop_at_the_policy_and_at_the_deadline() {
        let (_p, snap, _route) = split_proxy(json!({ "name": "r", "service": "stable" }));
        let mut service = (**snap.service("stable").unwrap()).clone();
        service.spec.retries.attempts = 2;
        service.spec.retries.on = vec!["connect_failure".into()];
        let mut ctx = Ctx { service: Some(Arc::new(service)), tries: 1, ..Default::default() };
        assert!(ApgProxy::may_retry(&ctx, "connect_failure"));
        assert!(!ApgProxy::may_retry(&ctx, "timeout"), "only the listed conditions are retried");
        ctx.tries = 2;
        assert!(ApgProxy::may_retry(&ctx, "connect_failure"));
        ctx.tries = 3;
        assert!(!ApgProxy::may_retry(&ctx, "connect_failure"), "two extra tries were allowed and made");
        ctx.tries = 1;
        ctx.deadline = Some(Instant::now() - Duration::from_millis(1));
        assert!(!ApgProxy::may_retry(&ctx, "connect_failure"), "the route's deadline has passed");
        assert!(!ApgProxy::may_retry(&Ctx::default(), "connect_failure"));
    }
}
