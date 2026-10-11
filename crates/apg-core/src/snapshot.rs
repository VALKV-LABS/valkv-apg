//! An immutable, indexed view of the configuration: what requests are matched against.
//!
//! A [`Snapshot`] is built from [`Resources`] and then never changes. The node
//! swaps in a new one atomically when configuration changes, so applying a
//! change never blocks a request (spec NFR-6).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

use regex::Regex;

use crate::model::{BaseDomain, Domain, ErrorResponseSpec, Plugin, Rewrite, Route, Service, Workspace};
use crate::consumers::ConsumerIndex;
use crate::path::prefix_matches;
use crate::plugins::PluginIndex;
use crate::resources::Resources;
use crate::template::Template;

/// A service with its id and owner.
#[derive(Debug, Clone)]
pub struct ServiceEntry {
    pub id: String,
    pub workspace_id: String,
    pub spec: Service,
}

#[derive(Debug, Clone)]
enum PredicateKind {
    Present,
    Exact(String),
    Regex(Regex),
}

#[derive(Debug, Clone)]
struct CompiledPredicate {
    /// Lower-cased for headers; as written for query parameters.
    name: String,
    kind: PredicateKind,
}

impl CompiledPredicate {
    fn matches(&self, value: Option<&str>) -> bool {
        match (&self.kind, value) {
            (_, None) => false,
            (PredicateKind::Present, Some(_)) => true,
            (PredicateKind::Exact(want), Some(got)) => want == got,
            (PredicateKind::Regex(re), Some(got)) => re.is_match(got),
        }
    }
}

/// A compiled path rewrite.
#[derive(Debug, Clone)]
pub enum CompiledRewrite {
    Path(String),
    Prefix(String),
    Regex(Regex, String),
}

/// A custom error response with its body compiled.
#[derive(Debug, Clone)]
pub struct CompiledErrorResponse {
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Option<Template>,
}

/// A route ready to match and forward.
#[derive(Debug)]
pub struct CompiledRoute {
    pub id: String,
    pub name: String,
    pub workspace_id: String,
    /// True when the route belongs to the system workspace.
    pub system: bool,
    /// `(service id, weight)`. One entry unless the route splits traffic.
    pub targets: Vec<(String, u32)>,
    pub split_key: Option<String>,
    pub strip_path: bool,
    pub rewrite: Option<CompiledRewrite>,
    pub timeout_ms: Option<u64>,
    pub idle_timeout_ms: u64,
    pub error_responses: HashMap<String, CompiledErrorResponse>,
    /// Changes whenever anything about the route does. Cached responses carry it.
    pub cache_tag: u64,
    methods: Vec<String>,
    headers: Vec<CompiledPredicate>,
    query: Vec<CompiledPredicate>,
}

#[derive(Debug, Clone)]
enum PathMatcher {
    Any,
    Exact(String),
    Prefix(String),
    Regex(Regex),
}

/// Total order of spec RT-2. Smaller sorts first, so "more important" fields are negated.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SortKey {
    neg_priority: i64,
    neg_host_rank: i8,
    neg_path_rank: i8,
    neg_path_len: i64,
    neg_predicates: i64,
    neg_has_method: i8,
    id: String,
    path_index: usize,
}

#[derive(Debug, Clone)]
struct Entry {
    key: SortKey,
    route: Arc<CompiledRoute>,
    path: PathMatcher,
}

#[derive(Debug, Default)]
struct RouteIndex {
    exact: HashMap<String, Vec<Entry>>,
    /// Keyed by the suffix after the first label, with its leading dot: `.example.com`.
    wildcard: HashMap<String, Vec<Entry>>,
    any: Vec<Entry>,
}

impl RouteIndex {
    fn sort(&mut self) {
        for v in self.exact.values_mut().chain(self.wildcard.values_mut()) {
            v.sort_by(|a, b| a.key.cmp(&b.key));
        }
        self.any.sort_by(|a, b| a.key.cmp(&b.key));
    }

    /// The first entry, in RT-2 order across the three buckets, that matches.
    /// Cost depends on the size of this host's buckets, not on the total
    /// number of routes (spec RT-5).
    fn find<'a>(&'a self, req: &Request<'_>) -> Option<(&'a Entry, Option<String>)> {
        let exact: &[Entry] = self.exact.get(req.host).map_or(&[], Vec::as_slice);
        let wild: &[Entry] = req.host.find('.').and_then(|i| self.wildcard.get(&req.host[i..])).map_or(&[], Vec::as_slice);
        let mut cursors = [(exact, 0usize), (wild, 0usize), (self.any.as_slice(), 0usize)];
        loop {
            let mut best: Option<usize> = None;
            for (i, (list, pos)) in cursors.iter().enumerate() {
                if *pos >= list.len() {
                    continue;
                }
                best = match best {
                    Some(b) if cursors[b].0[cursors[b].1].key.cmp(&list[*pos].key) != Ordering::Greater => Some(b),
                    _ => Some(i),
                };
            }
            let b = best?;
            let entry = &cursors[b].0[cursors[b].1];
            cursors[b].1 += 1;
            if let Some(prefix) = entry.matches(req) {
                return Some((entry, prefix));
            }
        }
    }
}

impl Entry {
    /// `Some(matched prefix)` when the entry matches; the prefix is what `strip_path` removes.
    fn matches(&self, req: &Request<'_>) -> Option<Option<String>> {
        let matched = match &self.path {
            PathMatcher::Any => None,
            PathMatcher::Exact(p) => (p == req.path).then(|| Some(p.clone()))?,
            PathMatcher::Prefix(p) => prefix_matches(p, req.path).then(|| Some(p.clone()))?,
            PathMatcher::Regex(re) => re.is_match(req.path).then_some(None)?,
        };
        let r = &self.route;
        if !r.methods.is_empty() && !r.methods.iter().any(|m| m.eq_ignore_ascii_case(req.method)) {
            return None;
        }
        if !r.headers.iter().all(|p| p.matches((req.header)(&p.name).as_deref())) {
            return None;
        }
        if !r.query.is_empty() {
            let pairs = parse_query(req.query);
            if !r.query.iter().all(|p| p.matches(pairs.iter().find(|(k, _)| *k == p.name).map(|(_, v)| v.as_str()))) {
                return None;
            }
        }
        Some(matched)
    }
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_component(k), decode_component(v))
        })
        .collect()
}

fn decode_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16);
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the matcher needs to know about a request.
pub struct Request<'a> {
    /// Lower-cased, without a port.
    pub host: &'a str,
    /// Normalised (see [`crate::path::normalize`]).
    pub path: &'a str,
    pub method: &'a str,
    /// Raw query string, without the `?`.
    pub query: &'a str,
    /// Looks up a request header by lower-cased name.
    pub header: &'a dyn Fn(&str) -> Option<String>,
}

/// The result of matching a request.
#[derive(Debug, Clone)]
pub struct Matched {
    pub route: Arc<CompiledRoute>,
    /// The path prefix that matched, when the route matched by `prefix` or `exact`.
    pub matched_prefix: Option<String>,
    /// The workspace the request is attributed to before authentication (spec §6.4).
    pub workspace_id: String,
}

/// Counts worth exporting after a build.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BuildReport {
    /// Resources that could not be decoded and were left out.
    pub undecodable: usize,
    /// Routes left unmatchable because a service they name has not arrived (spec CFG-3).
    pub dangling: usize,
}

#[derive(Debug)]
struct WorkspaceEntry {
    spec: Workspace,
}

/// The `access_log` setting (spec §12.2).
#[derive(Debug, Clone)]
pub struct AccessLogSetting {
    /// `stdout`, `off` or `file:<path>`. `None` means the default, `stdout`.
    pub sink: Option<String>,
    pub sample_rate: f64,
    /// Field name to template.
    pub custom_fields: Vec<(String, Template)>,
}

impl Default for AccessLogSetting {
    fn default() -> Self {
        Self { sink: None, sample_rate: 1.0, custom_fields: Vec::new() }
    }
}

/// A hostname to obtain a certificate for from an ACME authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcmeHost {
    pub hostname: String,
    /// Prove control through a DNS record; otherwise through HTTP.
    pub dns01: bool,
}

/// The whole configuration, indexed.
#[derive(Debug, Default)]
pub struct Snapshot {
    workspaces: HashMap<String, WorkspaceEntry>,
    slug_to_workspace: HashMap<String, String>,
    system_workspace: Option<String>,
    services: HashMap<String, Arc<ServiceEntry>>,
    system_routes: RouteIndex,
    workspace_routes: HashMap<String, RouteIndex>,
    domains_exact: HashMap<String, String>,
    domains_wildcard: HashMap<String, String>,
    base_domains: Vec<String>,
    /// Hostnames to hold an ACME certificate for, with the challenge type to use (spec TLS-4).
    acme_hosts: Vec<AcmeHost>,
    pub plugins: PluginIndex,
    pub consumers: ConsumerIndex,
    flags: HashMap<String, bool>,
    error_responses: HashMap<String, CompiledErrorResponse>,
    pub identity_headers: bool,
    pub access_log: AccessLogSetting,
    route_count: usize,
    pub report: BuildReport,
}

fn compile_predicates(preds: &[crate::model::Predicate], lower: bool) -> Option<Vec<CompiledPredicate>> {
    preds
        .iter()
        .map(|p| {
            let kind = match (p.kind.as_str(), &p.value) {
                ("present", _) => PredicateKind::Present,
                ("regex", Some(v)) => PredicateKind::Regex(anchored(v)?),
                ("exact", Some(v)) => PredicateKind::Exact(v.clone()),
                _ => return None,
            };
            Some(CompiledPredicate { name: if lower { p.name.to_ascii_lowercase() } else { p.name.clone() }, kind })
        })
        .collect()
}

/// Compiles a pattern anchored at both ends (spec RT-3). The engine is linear-time.
pub fn anchored(pattern: &str) -> Option<Regex> {
    Regex::new(&format!("^(?:{pattern})$")).ok()
}

fn compile_error_responses(specs: &HashMap<String, ErrorResponseSpec>) -> HashMap<String, CompiledErrorResponse> {
    specs
        .iter()
        .filter_map(|(code, s)| {
            let body = match &s.body {
                Some(b) => Some(Template::compile(b).ok()?),
                None => None,
            };
            Some((
                code.clone(),
                CompiledErrorResponse { status: s.status, content_type: s.content_type.clone(), headers: s.headers.clone().into_iter().collect(), body },
            ))
        })
        .collect()
}

impl Snapshot {
    /// Builds a snapshot. Resources that cannot be decoded, and routes whose
    /// services are missing, are left out and counted; nothing here fails.
    pub fn build(resources: &Resources) -> Self {
        let mut snap = Snapshot { identity_headers: true, ..Default::default() };

        for (id, s) in resources.kind("workspace") {
            match serde_json::from_value::<Workspace>(s.data.clone()) {
                Ok(spec) => {
                    if spec.system {
                        snap.system_workspace = Some(id.clone());
                    }
                    snap.slug_to_workspace.insert(spec.slug.clone(), id.clone());
                    snap.workspaces.insert(id.clone(), WorkspaceEntry { spec });
                }
                Err(_) => snap.report.undecodable += 1,
            }
        }

        for (name, s) in resources.kind("flag") {
            if let Some(enabled) = s.data.get("enabled").and_then(|v| v.as_bool()) {
                snap.flags.insert(name.clone(), enabled);
            }
        }
        for (name, s) in resources.kind("setting") {
            let Some(value) = s.data.get("value") else { continue };
            match name.as_str() {
                "workspace_base_domains" => {
                    if let Ok(list) = serde_json::from_value::<Vec<BaseDomain>>(value.clone()) {
                        for b in &list {
                            // One wildcard certificate serves every workspace's host under a base domain.
                            if b.tls.mode == "acme" {
                                snap.acme_hosts.push(AcmeHost { hostname: format!("*.{}", b.domain.to_ascii_lowercase()), dns01: true });
                            }
                        }
                        snap.base_domains = list.into_iter().map(|b| b.domain.to_ascii_lowercase()).collect();
                    }
                }
                "error_responses" => {
                    if let Ok(map) = serde_json::from_value::<HashMap<String, ErrorResponseSpec>>(value.clone()) {
                        snap.error_responses = compile_error_responses(&map);
                    }
                }
                "identity_headers" => snap.identity_headers = value.as_bool().unwrap_or(true),
                "access_log" => {
                    snap.access_log = AccessLogSetting {
                        sink: value.get("sink").and_then(|s| s.as_str()).map(str::to_string),
                        sample_rate: value.get("sample_rate").and_then(|r| r.as_f64()).unwrap_or(1.0),
                        // A field whose template does not compile is left out; the loaders refuse it up front.
                        custom_fields: value.get("custom_fields").and_then(|f| f.as_object()).into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), Template::compile(v.as_str()?).ok()?))).collect(),
                    };
                }
                _ => {}
            }
        }

        for (_, s) in resources.kind("domain") {
            let (Ok(d), Some(ws)) = (serde_json::from_value::<Domain>(s.data.clone()), &s.workspace_id) else {
                snap.report.undecodable += 1;
                continue;
            };
            // A pending domain owns nothing yet.
            if d.status != "active" {
                continue;
            }
            let host = d.hostname.to_ascii_lowercase();
            if d.tls.mode == "acme" {
                // A wildcard can only be proven through DNS.
                snap.acme_hosts.push(AcmeHost { dns01: d.tls.challenge == "dns01" || host.starts_with('*'), hostname: host.clone() });
            }
            match host.strip_prefix('*') {
                Some(suffix) => snap.domains_wildcard.insert(suffix.to_string(), ws.clone()),
                None => snap.domains_exact.insert(host, ws.clone()),
            };
        }

        let (consumers, undecodable) = ConsumerIndex::build(resources);
        snap.consumers = consumers;
        snap.report.undecodable += undecodable;

        for (id, s) in resources.kind("service") {
            let (Ok(spec), Some(ws)) = (serde_json::from_value::<Service>(s.data.clone()), &s.workspace_id) else {
                snap.report.undecodable += 1;
                continue;
            };
            snap.services.insert(id.clone(), Arc::new(ServiceEntry { id: id.clone(), workspace_id: ws.clone(), spec }));
        }

        for (id, s) in resources.kind("route") {
            let (Ok(spec), Some(ws)) = (serde_json::from_value::<Route>(s.data.clone()), &s.workspace_id) else {
                snap.report.undecodable += 1;
                continue;
            };
            let tag = u64::from_str_radix(&crate::consumers::sha256_hex(s.data.to_string().as_bytes())[..16], 16).unwrap_or(0);
            snap.add_route(id, ws, spec, tag);
        }
        snap.system_routes.sort();
        for ix in snap.workspace_routes.values_mut() {
            ix.sort();
        }

        for (id, s) in resources.kind("plugin") {
            let (Ok(p), Some(ws)) = (serde_json::from_value::<Plugin>(s.data.clone()), &s.workspace_id) else {
                snap.report.undecodable += 1;
                continue;
            };
            snap.plugins.insert(id.clone(), ws, p);
        }
        snap
    }

    fn add_route(&mut self, id: &str, workspace_id: &str, spec: Route, cache_tag: u64) {
        if !spec.enabled {
            return;
        }
        let targets: Vec<(String, u32)> = match (&spec.service, &spec.split) {
            (Some(s), _) => vec![(s.clone(), 1)],
            (None, Some(split)) => split.iter().map(|t| (t.service.clone(), t.weight)).collect(),
            (None, None) => Vec::new(),
        };
        if targets.is_empty() || targets.iter().any(|(sid, _)| !self.services.contains_key(sid)) {
            self.report.dangling += 1;
            return;
        }
        let (Some(headers), Some(query)) = (compile_predicates(&spec.headers, true), compile_predicates(&spec.query, false)) else {
            self.report.undecodable += 1;
            return;
        };
        let rewrite = match &spec.rewrite {
            None => None,
            Some(Rewrite::Path { path }) => Some(CompiledRewrite::Path(path.clone())),
            Some(Rewrite::Prefix { prefix }) => Some(CompiledRewrite::Prefix(prefix.clone())),
            Some(Rewrite::Regex { regex, replacement }) => match Regex::new(regex) {
                Ok(re) => Some(CompiledRewrite::Regex(re, replacement.clone())),
                Err(_) => {
                    self.report.undecodable += 1;
                    return;
                }
            },
        };
        let mut paths = Vec::new();
        for p in &spec.paths {
            let (kind, value) = p.parts();
            paths.push(match kind {
                "exact" => PathMatcher::Exact(value.to_string()),
                "prefix" => PathMatcher::Prefix(value.to_string()),
                "regex" => match anchored(value) {
                    Some(re) => PathMatcher::Regex(re),
                    None => {
                        self.report.undecodable += 1;
                        return;
                    }
                },
                _ => {
                    self.report.undecodable += 1;
                    return;
                }
            });
        }
        if paths.is_empty() {
            paths.push(PathMatcher::Any);
        }

        let system = self.workspaces.get(workspace_id).is_some_and(|w| w.spec.system);
        let route = Arc::new(CompiledRoute {
            id: id.to_string(),
            name: spec.name.clone(),
            workspace_id: workspace_id.to_string(),
            system,
            targets,
            split_key: spec.split_key.clone(),
            strip_path: spec.strip_path,
            rewrite,
            timeout_ms: spec.timeout_ms,
            idle_timeout_ms: spec.idle_timeout_ms,
            error_responses: compile_error_responses(&spec.error_responses),
            cache_tag,
            methods: spec.methods.clone(),
            headers,
            query,
        });
        self.route_count += 1;

        let index = if system { &mut self.system_routes } else { self.workspace_routes.entry(workspace_id.to_string()).or_default() };
        let predicates = (route.headers.len() + route.query.len()) as i64;
        let has_method = i8::from(!route.methods.is_empty());
        // One entry per (host, path) pair, so each can be ordered by its own specificity.
        let hosts: Vec<Option<String>> = if spec.hosts.is_empty() { vec![None] } else { spec.hosts.iter().map(|h| Some(h.to_ascii_lowercase())).collect() };
        for host in &hosts {
            for (path_index, path) in paths.iter().enumerate() {
                let (path_rank, path_len) = match path {
                    PathMatcher::Exact(p) => (3, p.len()),
                    PathMatcher::Prefix(p) => (2, p.len()),
                    PathMatcher::Regex(_) => (1, 0),
                    PathMatcher::Any => (0, 0),
                };
                let host_rank = match host {
                    Some(h) if h.starts_with("*.") => 1,
                    Some(_) => 2,
                    None => 0,
                };
                let entry = Entry {
                    key: SortKey {
                        neg_priority: -spec.priority,
                        neg_host_rank: -host_rank,
                        neg_path_rank: -path_rank,
                        neg_path_len: -(path_len as i64),
                        neg_predicates: -predicates,
                        neg_has_method: -has_method,
                        id: id.to_string(),
                        path_index,
                    },
                    route: route.clone(),
                    path: path.clone(),
                };
                match host {
                    None => index.any.push(entry),
                    Some(h) => match h.strip_prefix('*') {
                        Some(suffix) => index.wildcard.entry(suffix.to_string()).or_default().push(entry),
                        None => index.exact.entry(h.clone()).or_default().push(entry),
                    },
                }
            }
        }
    }

    /// The workspace that owns `host` through a domain or a base domain (spec DOM-1, DOM-2).
    pub fn host_owner(&self, host: &str) -> Option<&str> {
        if let Some(ws) = self.domains_exact.get(host) {
            return Some(ws);
        }
        let dot = host.find('.')?;
        if let Some(ws) = self.domains_wildcard.get(&host[dot..]) {
            return Some(ws);
        }
        let (label, rest) = (&host[..dot], &host[dot + 1..]);
        if self.base_domains.iter().any(|b| b == rest) {
            return self.slug_to_workspace.get(label).map(String::as_str);
        }
        None
    }

    /// Matches a request to a route (spec §6.3).
    ///
    /// System routes are tried first. Only if none matches are the routes of
    /// the workspace that owns the host tried, so a tenant can never shadow an
    /// operator route and can never match a host it does not own (RT-1).
    pub fn match_request(&self, req: &Request<'_>) -> Option<Matched> {
        let owner = self.host_owner(req.host);
        if let Some((entry, prefix)) = self.system_routes.find(req) {
            let workspace_id = owner.or(self.system_workspace.as_deref()).unwrap_or(&entry.route.workspace_id).to_string();
            return Some(Matched { route: entry.route.clone(), matched_prefix: prefix, workspace_id });
        }
        let owner = owner?;
        let (entry, prefix) = self.workspace_routes.get(owner)?.find(req)?;
        Some(Matched { route: entry.route.clone(), matched_prefix: prefix, workspace_id: owner.to_string() })
    }

    pub fn service(&self, id: &str) -> Option<&Arc<ServiceEntry>> {
        self.services.get(id)
    }

    /// Hostnames this configuration wants an ACME certificate for.
    pub fn acme_hosts(&self) -> &[AcmeHost] {
        &self.acme_hosts
    }

    /// Every service, in no particular order.
    pub fn services(&self) -> impl Iterator<Item = &Arc<ServiceEntry>> {
        self.services.values()
    }

    /// True when the workspace exists and is suspended (spec §4.2).
    pub fn is_suspended(&self, workspace_id: &str) -> bool {
        self.workspaces.get(workspace_id).is_some_and(|w| w.spec.status == "suspended")
    }

    pub fn workspace_slug(&self, workspace_id: &str) -> Option<&str> {
        self.workspaces.get(workspace_id).map(|w| w.spec.slug.as_str())
    }

    pub fn workspace_name(&self, workspace_id: &str) -> Option<&str> {
        self.workspaces.get(workspace_id).map(|w| w.spec.name.as_str())
    }

    /// A flag's value. An unknown flag reads as enabled (spec §4.8).
    pub fn flag(&self, name: &str) -> bool {
        self.flags.get(name).copied().unwrap_or(true)
    }

    /// The custom response for an error code: the route's, else the global one (spec ERR-2).
    pub fn error_response<'a>(&'a self, route: Option<&'a CompiledRoute>, code: &str) -> Option<&'a CompiledErrorResponse> {
        route.and_then(|r| r.error_responses.get(code)).or_else(|| self.error_responses.get(code))
    }

    pub fn route_count(&self) -> usize {
        self.route_count
    }

    pub fn service_count(&self) -> usize {
        self.services.len()
    }

    pub fn workspace_count(&self) -> usize {
        self.workspaces.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ChangeEvent;
    use serde_json::{Value, json};

    const SYS: &str = "ws-sys";
    const ACME: &str = "ws-acme";
    const RIVAL: &str = "ws-rival";

    fn base() -> Resources {
        let mut r = Resources::new();
        for (id, name, system) in [(SYS, "default", true), (ACME, "acme", false), (RIVAL, "rival", false)] {
            r.apply(&ChangeEvent::upsert("workspace", id, None, json!({ "name": name, "slug": name, "system": system })));
        }
        for (id, ws) in [("svc-sys", SYS), ("svc-acme", ACME), ("svc-rival", RIVAL)] {
            r.apply(&ChangeEvent::upsert("service", id, Some(ws.into()), json!({ "name": id, "backends": [{ "target": "10.0.0.1:80" }] })));
        }
        r
    }

    fn route(r: &mut Resources, id: &str, ws: &str, service: &str, mut body: Value) {
        body["name"] = json!(id);
        body["service"] = json!(service);
        r.apply(&ChangeEvent::upsert("route", id, Some(ws.into()), body));
    }

    fn domain(r: &mut Resources, ws: &str, hostname: &str, status: &str) {
        r.apply(&ChangeEvent::upsert("domain", format!("d-{hostname}"), Some(ws.into()), json!({ "hostname": hostname, "status": status })));
    }

    fn find(snap: &Snapshot, method: &str, host: &str, path: &str) -> Option<String> {
        find_full(snap, method, host, path, "", &|_| None).map(|m| m.route.id.clone())
    }

    fn find_full(snap: &Snapshot, method: &str, host: &str, path: &str, query: &str, header: &dyn Fn(&str) -> Option<String>) -> Option<Matched> {
        snap.match_request(&Request { host, path, method, query, header })
    }

    #[test]
    fn matches_by_host_path_and_method() {
        let mut r = base();
        route(&mut r, "orders", SYS, "svc-sys", json!({ "hosts": ["api.example.com"], "paths": ["/orders"], "methods": ["GET", "POST"] }));
        let s = Snapshot::build(&r);
        assert_eq!(find(&s, "GET", "api.example.com", "/orders/1").as_deref(), Some("orders"));
        assert_eq!(find(&s, "get", "api.example.com", "/orders").as_deref(), Some("orders"));
        assert_eq!(find(&s, "DELETE", "api.example.com", "/orders"), None);
        assert_eq!(find(&s, "GET", "other.example.com", "/orders"), None);
        assert_eq!(find(&s, "GET", "api.example.com", "/ordersx"), None);
    }

    #[test]
    fn path_types() {
        let mut r = base();
        route(&mut r, "exact", SYS, "svc-sys", json!({ "paths": [{ "type": "exact", "value": "/health" }] }));
        route(&mut r, "regex", SYS, "svc-sys", json!({ "paths": [{ "type": "regex", "value": "/items/[0-9]+" }] }));
        let s = Snapshot::build(&r);
        assert_eq!(find(&s, "GET", "h", "/health").as_deref(), Some("exact"));
        assert_eq!(find(&s, "GET", "h", "/health/x"), None);
        assert_eq!(find(&s, "GET", "h", "/items/42").as_deref(), Some("regex"));
        // anchored at both ends
        assert_eq!(find(&s, "GET", "h", "/items/42/extra"), None);
        assert_eq!(find(&s, "GET", "h", "/x/items/42"), None);
    }

    // spec RT-2: the order is total and does not depend on insertion order.
    #[test]
    fn precedence_priority_then_host_then_path_specificity() {
        let mut r = base();
        route(&mut r, "any-host", SYS, "svc-sys", json!({ "paths": ["/a"] }));
        route(&mut r, "wild-host", SYS, "svc-sys", json!({ "hosts": ["*.example.com"], "paths": ["/a"] }));
        route(&mut r, "exact-host", SYS, "svc-sys", json!({ "hosts": ["api.example.com"], "paths": ["/a"] }));
        route(&mut r, "longer-prefix", SYS, "svc-sys", json!({ "hosts": ["api.example.com"], "paths": ["/a/b"] }));
        route(&mut r, "exact-path", SYS, "svc-sys", json!({ "hosts": ["api.example.com"], "paths": [{ "type": "exact", "value": "/a/b/c" }] }));
        let s = Snapshot::build(&r);
        assert_eq!(find(&s, "GET", "api.example.com", "/a").as_deref(), Some("exact-host"));
        assert_eq!(find(&s, "GET", "www.example.com", "/a").as_deref(), Some("wild-host"));
        assert_eq!(find(&s, "GET", "elsewhere.test", "/a").as_deref(), Some("any-host"));
        assert_eq!(find(&s, "GET", "api.example.com", "/a/b/x").as_deref(), Some("longer-prefix"));
        assert_eq!(find(&s, "GET", "api.example.com", "/a/b/c").as_deref(), Some("exact-path"));

        // priority beats specificity
        route(&mut r, "boosted", SYS, "svc-sys", json!({ "paths": ["/a"], "priority": 100 }));
        let s = Snapshot::build(&r);
        assert_eq!(find(&s, "GET", "api.example.com", "/a/b/c").as_deref(), Some("boosted"));
    }

    #[test]
    fn more_predicates_and_a_method_win_ties_and_id_breaks_the_rest() {
        let mut r = base();
        route(&mut r, "b-plain", SYS, "svc-sys", json!({ "paths": ["/p"] }));
        route(&mut r, "a-plain", SYS, "svc-sys", json!({ "paths": ["/p"] }));
        route(&mut r, "with-method", SYS, "svc-sys", json!({ "paths": ["/p"], "methods": ["GET"] }));
        route(&mut r, "with-header", SYS, "svc-sys", json!({ "paths": ["/p"], "headers": [{ "name": "X-Api-Version", "value": "2" }] }));
        let s = Snapshot::build(&r);
        let v2 = |n: &str| (n == "x-api-version").then(|| "2".to_string());
        assert_eq!(find_full(&s, "GET", "h", "/p", "", &v2).unwrap().route.id, "with-header");
        assert_eq!(find(&s, "GET", "h", "/p").as_deref(), Some("with-method"));
        assert_eq!(find(&s, "POST", "h", "/p").as_deref(), Some("a-plain"));
    }

    #[test]
    fn header_and_query_predicates() {
        let mut r = base();
        route(&mut r, "r", SYS, "svc-sys", json!({
            "headers": [{ "name": "x-debug", "type": "present" }, { "name": "x-env", "type": "regex", "value": "prod|stage" }],
            "query": [{ "name": "format", "value": "json" }]
        }));
        let s = Snapshot::build(&r);
        let h = |n: &str| match n { "x-debug" => Some(String::new()), "x-env" => Some("prod".to_string()), _ => None };
        assert!(find_full(&s, "GET", "h", "/", "format=json&x=1", &h).is_some());
        assert!(find_full(&s, "GET", "h", "/", "x=1&format=json", &h).is_some());
        assert!(find_full(&s, "GET", "h", "/", "format=xml", &h).is_none());
        assert!(find_full(&s, "GET", "h", "/", "", &h).is_none());
        let wrong_env = |n: &str| match n { "x-debug" => Some(String::new()), "x-env" => Some("production".to_string()), _ => None };
        assert!(find_full(&s, "GET", "h", "/", "format=json", &wrong_env).is_none());
        assert!(find_full(&s, "GET", "h", "/", "format=json", &|_| None).is_none());
    }

    // spec RT-1 and DOM-1: the isolation guarantee.
    #[test]
    fn a_tenant_route_only_matches_hosts_its_workspace_owns() {
        let mut r = base();
        domain(&mut r, ACME, "shop.acme.test", "active");
        domain(&mut r, RIVAL, "shop.rival.test", "active");
        route(&mut r, "acme-shop", ACME, "svc-acme", json!({ "hosts": ["shop.acme.test"] }));
        // rival tries to route acme's host; the admin would refuse this, and the node must not honour it either
        route(&mut r, "rival-steals", RIVAL, "svc-rival", json!({ "hosts": ["shop.acme.test"], "priority": 1000 }));
        route(&mut r, "rival-shop", RIVAL, "svc-rival", json!({ "hosts": ["shop.rival.test"] }));
        let s = Snapshot::build(&r);
        let m = find_full(&s, "GET", "shop.acme.test", "/", "", &|_| None).unwrap();
        assert_eq!((m.route.id.as_str(), m.workspace_id.as_str()), ("acme-shop", ACME));
        assert_eq!(find(&s, "GET", "shop.rival.test", "/").as_deref(), Some("rival-shop"));
        assert_eq!(find(&s, "GET", "unowned.test", "/"), None);
    }

    #[test]
    fn system_routes_come_first_and_are_attributed_to_the_host_owner() {
        let mut r = base();
        domain(&mut r, ACME, "shop.acme.test", "active");
        route(&mut r, "acme-all", ACME, "svc-acme", json!({ "hosts": ["shop.acme.test"], "priority": 1000 }));
        route(&mut r, "operator-api", SYS, "svc-sys", json!({ "paths": ["/v1/platform"] }));
        let s = Snapshot::build(&r);
        // the operator's route wins on the tenant's host, whatever the tenant's priority
        let m = find_full(&s, "GET", "shop.acme.test", "/v1/platform/x", "", &|_| None).unwrap();
        assert_eq!((m.route.id.as_str(), m.workspace_id.as_str()), ("operator-api", ACME));
        assert!(m.route.system);
        // elsewhere it is attributed to the system workspace
        assert_eq!(find_full(&s, "GET", "other.test", "/v1/platform", "", &|_| None).unwrap().workspace_id, SYS);
        // and the tenant route still serves everything else on its host
        assert_eq!(find(&s, "GET", "shop.acme.test", "/cart").as_deref(), Some("acme-all"));
    }

    #[test]
    fn wildcard_domains_base_domains_and_pending_domains() {
        let mut r = base();
        r.apply(&ChangeEvent::upsert("setting", "workspace_base_domains", None, json!({ "value": [{ "domain": "gw.example.net" }] })));
        domain(&mut r, ACME, "*.apps.acme.test", "active");
        domain(&mut r, RIVAL, "soon.rival.test", "pending");
        route(&mut r, "acme-apps", ACME, "svc-acme", json!({ "hosts": ["*.apps.acme.test"] }));
        route(&mut r, "acme-slug", ACME, "svc-acme", json!({ "hosts": ["acme.gw.example.net"] }));
        route(&mut r, "rival-soon", RIVAL, "svc-rival", json!({ "hosts": ["soon.rival.test"] }));
        let s = Snapshot::build(&r);
        assert_eq!(s.host_owner("a.apps.acme.test"), Some(ACME));
        assert_eq!(s.host_owner("a.b.apps.acme.test"), None);
        assert_eq!(s.host_owner("acme.gw.example.net"), Some(ACME));
        assert_eq!(s.host_owner("rival.gw.example.net"), Some(RIVAL));
        assert_eq!(s.host_owner("nobody.gw.example.net"), None);
        assert_eq!(find(&s, "GET", "x.apps.acme.test", "/").as_deref(), Some("acme-apps"));
        assert_eq!(find(&s, "GET", "acme.gw.example.net", "/").as_deref(), Some("acme-slug"));
        // a pending domain owns nothing, so its route cannot match yet
        assert_eq!(find(&s, "GET", "soon.rival.test", "/"), None);
    }

    // spec TLS-4, DOM-3
    #[test]
    fn certificates_are_wanted_only_for_active_acme_domains_and_base_domains() {
        let mut r = base();
        r.apply(&ChangeEvent::upsert("setting", "workspace_base_domains", None, json!({ "value": [{ "domain": "gw.example.net" }, { "domain": "plain.example.net", "tls": { "mode": "none" } }] })));
        let add = |r: &mut Resources, hostname: &str, extra: serde_json::Value| {
            let mut data = json!({ "hostname": hostname, "status": "active" });
            data.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            r.apply(&ChangeEvent::upsert("domain", format!("d-{hostname}"), Some(ACME.into()), data));
        };
        add(&mut r, "shop.acme.test", json!({}));
        add(&mut r, "dns.acme.test", json!({ "tls": { "mode": "acme", "challenge": "dns01" } }));
        add(&mut r, "*.wild.acme.test", json!({ "tls": { "mode": "acme" } }));
        add(&mut r, "manual.acme.test", json!({ "tls": { "mode": "manual", "certificate": "c1" } }));
        add(&mut r, "clear.acme.test", json!({ "tls": { "mode": "none" } }));
        add(&mut r, "pending.acme.test", json!({ "status": "pending" }));
        let mut wanted: Vec<(String, bool)> = Snapshot::build(&r).acme_hosts().iter().map(|h| (h.hostname.clone(), h.dns01)).collect();
        wanted.sort();
        assert_eq!(
            wanted,
            [
                ("*.gw.example.net".to_string(), true),
                ("*.wild.acme.test".to_string(), true),
                ("dns.acme.test".to_string(), true),
                ("shop.acme.test".to_string(), false),
            ]
        );
    }

    // spec CFG-3
    #[test]
    fn a_route_whose_service_is_missing_is_held_back_and_counted_not_fatal() {
        let mut r = base();
        route(&mut r, "dangling", SYS, "svc-not-here-yet", json!({ "paths": ["/d"] }));
        route(&mut r, "fine", SYS, "svc-sys", json!({ "paths": ["/f"] }));
        let s = Snapshot::build(&r);
        assert_eq!(s.report.dangling, 1);
        assert_eq!(find(&s, "GET", "h", "/d"), None);
        assert_eq!(find(&s, "GET", "h", "/f").as_deref(), Some("fine"));
        // once the service arrives the same route matches
        r.apply(&ChangeEvent::upsert("service", "svc-not-here-yet", Some(SYS.into()), json!({ "name": "late", "backends": [{ "target": "1.1.1.1:80" }] })));
        assert_eq!(find(&Snapshot::build(&r), "GET", "h", "/d").as_deref(), Some("dangling"));
    }

    #[test]
    fn undecodable_resources_and_bad_patterns_are_counted_and_skipped() {
        let mut r = base();
        r.apply(&ChangeEvent::upsert("route", "no-name", Some(SYS.into()), json!({ "service": "svc-sys" })));
        route(&mut r, "bad-regex", SYS, "svc-sys", json!({ "paths": [{ "type": "regex", "value": "(" }] }));
        route(&mut r, "ok", SYS, "svc-sys", json!({ "paths": ["/ok"] }));
        let s = Snapshot::build(&r);
        assert_eq!(s.report.undecodable, 2);
        assert_eq!(find(&s, "GET", "h", "/ok").as_deref(), Some("ok"));
    }

    #[test]
    fn disabled_routes_do_not_match_and_strip_prefix_is_reported() {
        let mut r = base();
        route(&mut r, "off", SYS, "svc-sys", json!({ "paths": ["/x"], "enabled": false }));
        route(&mut r, "on", SYS, "svc-sys", json!({ "paths": ["/api/v1", "/api/v2"], "strip_path": true }));
        let s = Snapshot::build(&r);
        assert_eq!(find(&s, "GET", "h", "/x"), None);
        let m = find_full(&s, "GET", "h", "/api/v2/users", "", &|_| None).unwrap();
        assert_eq!(m.matched_prefix.as_deref(), Some("/api/v2"));
        assert!(m.route.strip_path);
        assert_eq!(s.route_count(), 1);
    }

    #[test]
    fn flags_default_to_enabled_and_suspension_is_visible() {
        let mut r = base();
        r.apply(&ChangeEvent::upsert("flag", "usage_metering", None, json!({ "enabled": false })));
        r.apply(&ChangeEvent { revision: Some(2), ..ChangeEvent::upsert("workspace", RIVAL, None, json!({ "name": "rival", "slug": "rival", "status": "suspended" })) });
        let s = Snapshot::build(&r);
        assert!(!s.flag("usage_metering"));
        assert!(s.flag("something_new"));
        assert!(s.is_suspended(RIVAL));
        assert!(!s.is_suspended(ACME));
        assert_eq!(s.workspace_slug(ACME), Some("acme"));
    }

    // spec RT-5: cost depends on the host's own routes, not the total.
    #[test]
    fn lookup_does_not_scan_other_hosts_routes() {
        let mut r = base();
        for i in 0..5000 {
            route(&mut r, &format!("r{i:05}"), SYS, "svc-sys", json!({ "hosts": [format!("h{i}.example.com")], "paths": ["/"] }));
        }
        let s = Snapshot::build(&r);
        assert_eq!(s.route_count(), 5000);
        assert_eq!(s.system_routes.exact.get("h4999.example.com").map(Vec::len), Some(1));
        assert!(s.system_routes.any.is_empty());
        assert_eq!(find(&s, "GET", "h4999.example.com", "/x").as_deref(), Some("r04999"));
        assert_eq!(find(&s, "GET", "h5000.example.com", "/x"), None);
    }

    #[test]
    fn query_decoding() {
        assert_eq!(parse_query("a=1&b=hello+world&c=%2Fx&d"), vec![
            ("a".to_string(), "1".to_string()), ("b".into(), "hello world".into()), ("c".into(), "/x".into()), ("d".into(), String::new()),
        ]);
    }
}
