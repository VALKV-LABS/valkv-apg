//! The request pipeline (spec §6.2).
//!
//! 1. assign a request id, resolve the client address
//! 2. match a route, attribute a workspace
//! 3. run request-phase plugins
//! 4. pick a backend
//! 5. build the upstream request (path, Host, forwarded and identity headers)
//! 6. forward
//! 7. response headers, body accounting
//! 8. log phase: metrics, circuit accounting, bandwidth debit, access log

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use apg_core::model::Backend;
use apg_core::path;
use apg_core::plugins::Site;
use apg_core::snapshot::{CompiledRewrite, CompiledRoute, Matched, Request as MatchRequest, ServiceEntry, Snapshot};
use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use pingora_core::upstreams::peer::HttpPeer;
use pingora_core::{Error, ErrorType};
use pingora_http::{RequestHeader, ResponseHeader};
use pingora_proxy::{FailToProxy, ProxyHttp, Session};

use crate::circuit::CircuitBreaker;
use crate::config::HttpMode;
use crate::gateway::Gateway;
use crate::limits::{BandwidthConfig, Buckets, RateLimitConfig, Subject, bucket_key};
use crate::metrics;
use crate::net::{Cidr, client_ip, normalize_host};

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
    circuits: DashMap<String, Arc<CircuitBreaker>>,
    round_robin: DashMap<String, AtomicUsize>,
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
    backend: Option<Backend>,
    /// Set when the gateway itself produced the response.
    error_code: Option<&'static str>,
    bytes_in: u64,
    bytes_out: u64,
    rate: Option<(RateLimitConfig, u64)>,
    bandwidth: Option<(String, BandwidthConfig)>,
    upstream_failed: bool,
    /// The socket peer's address, and whether it is a trusted proxy.
    peer_ip: String,
    peer_trusted: bool,
    /// Port the client connected to.
    server_port: Option<u16>,
    /// Seconds a refused client should wait; sent as `Retry-After`.
    retry_after: Option<u64>,
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

/// Picks among `(index, weight)` candidates by smooth rotation: over any window
/// of `total weight` picks each candidate is chosen `weight` times.
fn weighted_pick(weights: &[u32], counter: usize) -> Option<usize> {
    let total: usize = weights.iter().map(|w| *w as usize).sum();
    if total == 0 {
        return None;
    }
    let mut slot = counter % total;
    for (i, w) in weights.iter().enumerate() {
        if slot < *w as usize {
            return Some(i);
        }
        slot -= *w as usize;
    }
    None
}

impl ApgProxy {
    pub fn new(gateway: Arc<Gateway>, settings: ProxySettings) -> Self {
        Self { gateway, settings, buckets: Arc::new(Buckets::default()), circuits: DashMap::new(), round_robin: DashMap::new() }
    }

    fn next(&self, key: &str) -> usize {
        self.round_robin.entry(key.to_string()).or_insert_with(|| AtomicUsize::new(0)).fetch_add(1, Ordering::Relaxed)
    }

    fn circuit(&self, backend_id: &str) -> Arc<CircuitBreaker> {
        self.circuits.entry(backend_id.to_string()).or_insert_with(|| Arc::new(CircuitBreaker::new(3, Duration::from_secs(30)))).clone()
    }

    /// Chooses the service for this request: the route's only service, or one
    /// side of its split by weight.
    fn pick_service(&self, snapshot: &Snapshot, route: &CompiledRoute) -> Option<Arc<ServiceEntry>> {
        let weights: Vec<u32> = route.targets.iter().map(|(_, w)| *w).collect();
        let i = if weights.len() == 1 { 0 } else { weighted_pick(&weights, self.next(&format!("split:{}", route.id)))? };
        snapshot.service(&route.targets[i].0).cloned()
    }

    /// Chooses a backend: active ones whose circuit is closed, by weight. If
    /// every active backend's circuit is open, they are all tried anyway:
    /// sending traffic to a possibly recovering backend beats a certain 503
    /// (spec UP-2).
    fn pick_backend(&self, snapshot: &Snapshot, service: &ServiceEntry) -> Option<Backend> {
        let active: Vec<&Backend> = service.spec.backends.iter().filter(|b| b.status == "active" && b.weight > 0).collect();
        if active.is_empty() {
            return None;
        }
        let breaker_on = snapshot.flag("circuit_breaker");
        let healthy: Vec<&Backend> = if breaker_on { active.iter().copied().filter(|b| !self.circuit(&b.id).is_open()).collect() } else { active.clone() };
        let pool = if healthy.is_empty() {
            metrics::UPSTREAM_FAIL_OPEN.inc();
            active
        } else {
            healthy
        };
        let weights: Vec<u32> = pool.iter().map(|b| b.weight).collect();
        weighted_pick(&weights, self.next(&format!("svc:{}", service.id))).map(|i| pool[i].clone())
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

    async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> pingora_core::Result<bool> {
        ctx.started = Some(Instant::now());
        ctx.is_tls = session.digest().is_some_and(|d| d.ssl_digest.is_some());

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
            if raw_path.starts_with("/.well-known/acme-challenge/") {
                // Challenges are answered here once certificate issuance exists (build phase 2d).
                self.respond_plain(session, 404, &[], "not found\n").await?;
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

        let Some(service) = self.pick_service(&snapshot, &matched.route) else {
            self.respond_error(session, ctx, 503, "NO_HEALTHY_BACKEND", "no upstream is available for this route").await?;
            return Ok(true);
        };
        ctx.service = Some(service.clone());

        // ── Request-phase plugins ────────────────────────────────────────────
        let site = Site { route_id: &matched.route.id, service_id: &service.id, workspace_id: &matched.workspace_id, consumer_id: None };

        if snapshot.flag("plugin_rate_limit")
            && let Some(instance) = snapshot.plugins.effective("rate_limit", &site)
        {
            let cfg = RateLimitConfig::from_json(&instance.plugin.config);
            let decision = {
                let req = session.req_header();
                let lookup = |name: &str| header(req, name).map(str::to_string);
                let subject = Subject { plugin_id: &instance.id, route_id: &matched.route.id, workspace_id: &matched.workspace_id, consumer_id: None, client_ip: &ctx.client_ip, header: &lookup };
                self.buckets.take_request(&bucket_key(&cfg.scope, &subject), &cfg)
            };
            ctx.rate = Some((cfg, decision.remaining));
            if !decision.allowed {
                metrics::LIMITED.with_label_values(&["rate_limit"]).inc();
                ctx.retry_after = Some(decision.retry_after_secs.max(1));
                self.respond_error(session, ctx, 429, "RATE_LIMITED", "rate limit exceeded").await?;
                return Ok(true);
            }
        }

        if snapshot.flag("plugin_bandwidth_limit")
            && let Some(instance) = snapshot.plugins.effective("bandwidth_limit", &site)
        {
            let cfg = BandwidthConfig::from_json(&instance.plugin.config);
            let key = {
                let req = session.req_header();
                let lookup = |name: &str| header(req, name).map(str::to_string);
                let subject = Subject { plugin_id: &instance.id, route_id: &matched.route.id, workspace_id: &matched.workspace_id, consumer_id: None, client_ip: &ctx.client_ip, header: &lookup };
                bucket_key(&cfg.scope, &subject)
            };
            if !self.buckets.admit_bytes(&key, &cfg) {
                metrics::LIMITED.with_label_values(&["bandwidth_limit"]).inc();
                self.respond_error(session, ctx, 429, "BANDWIDTH_LIMIT_EXCEEDED", "bandwidth limit exceeded").await?;
                return Ok(true);
            }
            // Charged in the log phase, once the real size is known.
            ctx.bandwidth = Some((key, cfg));
        }

        // ── Backend ──────────────────────────────────────────────────────────
        let Some(backend) = self.pick_backend(&snapshot, &service) else {
            self.respond_error(session, ctx, 503, "NO_HEALTHY_BACKEND", "no upstream is available for this route").await?;
            return Ok(true);
        };
        ctx.backend = Some(backend.clone());

        if self.settings.stub_upstream {
            // Test mode: describe the routing decision instead of forwarding.
            let body = serde_json::json!({
                "stub": true,
                "route": matched.route.name,
                "service": service.spec.name,
                "backend": backend.target,
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

    async fn upstream_peer(&self, _session: &mut Session, ctx: &mut Self::CTX) -> pingora_core::Result<Box<HttpPeer>> {
        let (Some(service), Some(backend)) = (&ctx.service, &ctx.backend) else {
            return Err(Error::explain(ErrorType::InternalError, "no backend was selected"));
        };
        let tls = service.spec.scheme == "https";
        // SNI defaults to the backend's host name (spec UP-13); the seed sent none.
        let host = backend.target.rsplit_once(':').map_or(backend.target.as_str(), |(h, _)| h).trim_matches(|c| c == '[' || c == ']');
        let sni = service.spec.tls.sni.clone().unwrap_or_else(|| host.to_string());
        let mut peer = HttpPeer::new(backend.target.as_str(), tls, sni);
        peer.options.verify_cert = service.spec.tls.verify;
        peer.options.verify_hostname = service.spec.tls.verify;
        Ok(Box::new(peer))
    }

    async fn upstream_request_filter(&self, _session: &mut Session, upstream: &mut RequestHeader, ctx: &mut Self::CTX) -> pingora_core::Result<()> {
        let (Some(matched), Some(service), Some(backend)) = (&ctx.matched, &ctx.service, &ctx.backend) else { return Ok(()) };

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

        if ctx.snapshot.as_ref().is_some_and(|s| s.identity_headers) {
            upstream.insert_header("x-apg-workspace", matched.workspace_id.as_str())?;
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

    async fn request_body_filter(&self, _session: &mut Session, body: &mut Option<Bytes>, _end_of_stream: bool, ctx: &mut Self::CTX) -> pingora_core::Result<()> {
        // Bytes actually transferred, including chunked bodies (spec USG-3).
        if let Some(b) = body {
            ctx.bytes_in += b.len() as u64;
        }
        Ok(())
    }

    async fn response_filter(&self, _session: &mut Session, upstream_response: &mut ResponseHeader, ctx: &mut Self::CTX) -> pingora_core::Result<()> {
        upstream_response.insert_header(REQUEST_ID_HEADER, ctx.request_id.as_str())?;
        if let Some((cfg, remaining)) = &ctx.rate
            && cfg.response_headers
        {
            upstream_response.insert_header("ratelimit-limit", (cfg.burst as u64).to_string())?;
            upstream_response.insert_header("ratelimit-remaining", remaining.to_string())?;
        }
        Ok(())
    }

    fn response_body_filter(&self, _session: &mut Session, body: &mut Option<Bytes>, _end_of_stream: bool, ctx: &mut Self::CTX) -> pingora_core::Result<Option<Duration>> {
        if let Some(b) = body {
            ctx.bytes_out += b.len() as u64;
        }
        Ok(None)
    }

    fn fail_to_connect(&self, _session: &mut Session, _peer: &HttpPeer, ctx: &mut Self::CTX, e: Box<Error>) -> Box<Error> {
        ctx.upstream_failed = true;
        e
    }

    fn error_while_proxy(&self, _peer: &HttpPeer, _session: &mut Session, e: Box<Error>, ctx: &mut Self::CTX, _client_reused: bool) -> Box<Error> {
        ctx.upstream_failed = true;
        e
    }

    /// Upstream failures answer in the standard error shape too.
    async fn fail_to_proxy(&self, session: &mut Session, e: &Error, ctx: &mut Self::CTX) -> FailToProxy {
        let timeout = matches!(e.etype(), ErrorType::ConnectTimedout | ErrorType::ReadTimedout | ErrorType::WriteTimedout);
        let (status, code, message) = if timeout { (504, "UPSTREAM_TIMEOUT", "the upstream did not answer in time") } else { (502, "UPSTREAM_ERROR", "the upstream could not be reached or answered invalidly") };
        // If the response has already started there is nothing left to say.
        if session.response_written().is_none() {
            let _ = self.respond_error(session, ctx, status, code, message).await;
        }
        FailToProxy { error_code: status, can_reuse_downstream: false }
    }

    async fn logging(&self, session: &mut Session, e: Option<&Error>, ctx: &mut Self::CTX) {
        let status = session.response_written().map_or(0, |r| r.status.as_u16());
        let elapsed = ctx.started.map_or(0.0, |s| s.elapsed().as_secs_f64());
        let class = metrics::status_class(status);
        metrics::REQUESTS.with_label_values(&[class]).inc();
        metrics::DURATION.with_label_values(&[class]).observe(elapsed);

        // Circuit accounting: a connection failure or a gateway-class status
        // from the upstream counts against the backend.
        if let Some(backend) = &ctx.backend
            && !self.settings.stub_upstream
        {
            let failed = ctx.upstream_failed || (ctx.error_code.is_none() && matches!(status, 502..=504));
            if failed {
                self.circuit(&backend.id).record_failure();
            } else if ctx.error_code.is_none() && e.is_none() {
                self.circuit(&backend.id).record_success();
            }
        }

        if let Some((key, cfg)) = &ctx.bandwidth {
            self.buckets.debit_bytes(key, cfg, ctx.bytes_in + ctx.bytes_out);
        }

        // Structured access line. Authorization, Cookie and the query string are never logged here.
        tracing::info!(
            target: "apg::access",
            request_id = %ctx.request_id,
            client_ip = %ctx.client_ip,
            method = %ctx.method,
            scheme = if ctx.is_tls { "https" } else { "http" },
            host = %ctx.host,
            path = %ctx.path,
            status,
            error_code = ctx.error_code.unwrap_or(""),
            bytes_in = ctx.bytes_in,
            bytes_out = ctx.bytes_out,
            duration_ms = (elapsed * 1000.0) as u64,
            route = ctx.matched.as_ref().map_or("", |m| m.route.name.as_str()),
            service = ctx.service.as_ref().map_or("", |s| s.spec.name.as_str()),
            backend = ctx.backend.as_ref().map_or("", |b| b.target.as_str()),
            workspace = ctx.matched.as_ref().map_or("", |m| m.workspace_id.as_str()),
            "request"
        );
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
    fn weighted_pick_honours_weights_exactly_over_a_cycle() {
        let weights = [3, 1, 0];
        let picks: Vec<usize> = (0..8).map(|i| weighted_pick(&weights, i).unwrap()).collect();
        assert_eq!(picks, [0, 0, 0, 1, 0, 0, 0, 1]);
        assert_eq!(weighted_pick(&[0, 0], 5), None);
        assert_eq!(weighted_pick(&[], 5), None);
        assert_eq!(weighted_pick(&[1], 12345), Some(0));
    }

    #[test]
    fn request_ids_are_accepted_only_when_well_formed() {
        assert!(valid_request_id("req-123_abc.DEF"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id("has space"));
        assert!(!valid_request_id("new\nline"));
        assert!(!valid_request_id(&"a".repeat(129)));
    }

    fn proxy_with(services: serde_json::Value) -> (ApgProxy, Arc<Snapshot>) {
        let gateway = Gateway::new("n".into(), "file", 30);
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        for (i, svc) in services.as_array().unwrap().iter().enumerate() {
            r.apply(&ChangeEvent::upsert("service", format!("s{i}"), Some("w".into()), svc.clone()));
        }
        gateway.install(&r, 1);
        let snap = gateway.snapshot();
        let settings = ProxySettings { http_mode: HttpMode::Proxy, traffic_health_path: None, trusted_proxies: vec![], stub_upstream: false, https_port: None };
        (ApgProxy::new(gateway, settings), snap)
    }

    #[test]
    fn backends_are_chosen_by_weight_and_only_when_active() {
        let (p, snap) = proxy_with(json!([{ "name": "s", "backends": [
            { "id": "a", "target": "a:1", "weight": 2 },
            { "id": "b", "target": "b:1" },
            { "id": "c", "target": "c:1", "status": "draining" },
            { "id": "d", "target": "d:1", "status": "down" },
            { "id": "e", "target": "e:1", "weight": 0 }
        ] }]));
        let svc = snap.service("s0").unwrap();
        let picks: Vec<String> = (0..6).map(|_| p.pick_backend(&snap, svc).unwrap().target).collect();
        assert_eq!(picks, ["a:1", "a:1", "b:1", "a:1", "a:1", "b:1"]);
    }

    #[test]
    fn a_service_with_no_active_backend_has_none() {
        let (p, snap) = proxy_with(json!([{ "name": "s", "backends": [{ "id": "a", "target": "a:1", "status": "down" }] }]));
        assert!(p.pick_backend(&snap, snap.service("s0").unwrap()).is_none());
    }

    // spec UP-2
    #[test]
    fn an_open_circuit_is_skipped_but_all_open_fails_open() {
        let (p, snap) = proxy_with(json!([{ "name": "s", "backends": [{ "id": "a", "target": "a:1" }, { "id": "b", "target": "b:1" }] }]));
        let svc = snap.service("s0").unwrap();
        for _ in 0..3 {
            p.circuit("a").record_failure();
        }
        let picks: Vec<String> = (0..4).map(|_| p.pick_backend(&snap, svc).unwrap().target).collect();
        assert_eq!(picks, ["b:1", "b:1", "b:1", "b:1"], "the failing backend is skipped");
        for _ in 0..3 {
            p.circuit("b").record_failure();
        }
        let before = metrics::UPSTREAM_FAIL_OPEN.get();
        assert!(p.pick_backend(&snap, svc).is_some(), "with every circuit open a backend is still tried");
        assert!(metrics::UPSTREAM_FAIL_OPEN.get() > before);
        p.circuit("a").record_success();
        assert_eq!(p.pick_backend(&snap, svc).unwrap().target, "a:1");
    }
}
