//! Plugins that shape requests and responses rather than guard them (spec §9.4):
//! `redirect`, `static_response`, `request_transformer`, `response_transformer`,
//! `quota`, `compression` and the per-scope `access_log`.
//!
//! Everything a request needs is prepared when the instance is built:
//! templates are compiled then, never per request (spec PL-5, TPL-1).

use std::collections::BTreeMap;
use std::path::Path;

use apg_core::consumers::Consumer;
use apg_core::snapshot::{CompiledRoute, Snapshot};
use apg_core::template::Template;
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::Value;

use crate::limits::Scope;
use crate::plugins::Req;

// ── Template variables (spec §9.5) ───────────────────────────────────────────

/// What a template may refer to for one request.
pub struct Vars<'a> {
    pub req: &'a Req<'a>,
    pub request_id: &'a str,
    pub scheme: &'a str,
    pub snapshot: &'a Snapshot,
    pub route: &'a CompiledRoute,
    pub service_name: &'a str,
    pub consumer: Option<&'a Consumer>,
    pub claims: Option<&'a Value>,
    /// Environment variable names templates may read (`APG_TEMPLATE_ENV_ALLOW`).
    pub env_allow: &'a [String],
}

impl Vars<'_> {
    pub fn lookup(&self, variable: &str) -> Option<String> {
        let owned = |s: &str| Some(s.to_string());
        match variable {
            "request.id" => owned(self.request_id),
            "request.method" => owned(self.req.method),
            "request.scheme" => owned(self.scheme),
            "request.host" => owned(self.req.host),
            "request.path" => owned(self.req.path),
            "client.ip" => owned(self.req.client_ip),
            "workspace.id" => owned(self.req.workspace_id),
            "workspace.slug" => self.snapshot.workspace_slug(self.req.workspace_id).map(str::to_string),
            "workspace.name" => self.snapshot.workspace_name(self.req.workspace_id).map(str::to_string),
            "route.id" => owned(&self.route.id),
            "route.name" => owned(&self.route.name),
            "service.name" => owned(self.service_name),
            "consumer.id" => self.consumer.map(|c| c.id.clone()),
            "consumer.name" => self.consumer.map(|c| c.name.clone()),
            "consumer.custom_id" => self.consumer.and_then(|c| c.custom_id.clone()),
            other => {
                if let Some(name) = other.strip_prefix("request.header.") {
                    self.req.header(name).map(str::to_string)
                } else if let Some(name) = other.strip_prefix("request.query.") {
                    self.req.query_param(name).map(str::to_string)
                } else if let Some(key) = other.strip_prefix("consumer.labels.") {
                    self.consumer.and_then(|c| c.labels.get(key).cloned())
                } else if let Some(name) = other.strip_prefix("jwt.claim.") {
                    match self.claims?.get(name)? {
                        Value::String(s) => Some(s.clone()),
                        Value::Number(n) => Some(n.to_string()),
                        Value::Bool(b) => Some(b.to_string()),
                        _ => None,
                    }
                } else if let Some(name) = other.strip_prefix("env.") {
                    // Only names the operator listed: a template must not be a way to read the node's secrets.
                    self.env_allow.iter().any(|allowed| allowed == name).then(|| std::env::var(name).ok()).flatten()
                } else {
                    None
                }
            }
        }
    }

    pub fn render(&self, template: &Template) -> String {
        template.render(&|variable| self.lookup(variable))
    }
}

fn template(source: &str) -> Result<Template, String> {
    Template::compile(source).map_err(|e| e.to_string())
}

// ── redirect ─────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Redirect {
    status: u16,
    scheme: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    path: Option<Template>,
    preserve_query: bool,
}

impl Redirect {
    pub fn build(config: &Value) -> Result<Self, String> {
        let text = |key: &str| config.get(key).and_then(Value::as_str).map(str::to_string);
        Ok(Self {
            status: config.get("status").and_then(Value::as_u64).unwrap_or(308) as u16,
            scheme: text("scheme"),
            host: text("host"),
            port: config.get("port").and_then(Value::as_u64).map(|p| p as u16),
            path: config.get("path").and_then(Value::as_str).map(template).transpose()?,
            preserve_query: config.get("preserve_query").and_then(Value::as_bool).unwrap_or(true),
        })
    }

    /// The status and the `Location` to send. Parts the configuration leaves
    /// out are taken from the request.
    pub fn target(&self, vars: &Vars<'_>) -> (u16, String) {
        let scheme = self.scheme.as_deref().unwrap_or(vars.scheme);
        let host = self.host.as_deref().unwrap_or(vars.req.host);
        let port = self.port.map(|p| format!(":{p}")).unwrap_or_default();
        let path = self.path.as_ref().map(|t| vars.render(t)).unwrap_or_else(|| vars.req.path.to_string());
        let path = if path.starts_with('/') { path } else { format!("/{path}") };
        let query = if self.preserve_query && !vars.req.query.is_empty() { format!("?{}", vars.req.query) } else { String::new() };
        (self.status, format!("{scheme}://{host}{port}{path}{query}"))
    }
}

// ── static_response ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct StaticResponse {
    status: u16,
    content_type: String,
    headers: Vec<(String, String)>,
    body: Option<Template>,
}

impl StaticResponse {
    pub fn build(config: &Value) -> Result<Self, String> {
        Ok(Self {
            status: config.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
            content_type: config.get("content_type").and_then(Value::as_str).unwrap_or("application/json").to_string(),
            headers: config.get("headers").and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| Some((k.to_ascii_lowercase(), v.as_str()?.to_string()))).collect(),
            body: config.get("body").and_then(Value::as_str).map(template).transpose()?,
        })
    }

    pub fn respond(&self, vars: &Vars<'_>) -> (u16, Vec<(String, String)>, String) {
        let mut headers = vec![("content-type".to_string(), self.content_type.clone())];
        headers.extend(self.headers.iter().cloned());
        (self.status, headers, self.body.as_ref().map(|t| vars.render(t)).unwrap_or_default())
    }
}

// ── request_transformer / response_transformer ───────────────────────────────

#[derive(Debug, Default)]
struct Ops {
    set: Vec<(String, Template)>,
    add: Vec<(String, Template)>,
    remove: Vec<String>,
    rename: Vec<(String, String)>,
}

impl Ops {
    fn build(config: Option<&Value>, lower: bool) -> Result<Self, String> {
        let Some(config) = config else { return Ok(Self::default()) };
        let name = |s: &str| if lower { s.to_ascii_lowercase() } else { s.to_string() };
        let templated = |key: &str| -> Result<Vec<(String, Template)>, String> {
            config.get(key).and_then(Value::as_object).into_iter().flatten().map(|(k, v)| Ok((name(k), template(v.as_str().unwrap_or_default())?))).collect()
        };
        Ok(Self {
            set: templated("set")?,
            add: templated("add")?,
            remove: config.get("remove").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(name).collect(),
            rename: config.get("rename").and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| Some((name(k), name(v.as_str()?)))).collect(),
        })
    }

    fn render(&self, vars: &Vars<'_>) -> RenderedOps {
        let each = |list: &[(String, Template)]| list.iter().map(|(k, t)| (k.clone(), vars.render(t))).collect();
        RenderedOps { set: each(&self.set), add: each(&self.add), remove: self.remove.clone(), rename: self.rename.clone() }
    }
}

/// Header or query operations with their values filled in for one request.
/// Applied in the order rename, remove, set, add.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RenderedOps {
    pub set: Vec<(String, String)>,
    pub add: Vec<(String, String)>,
    pub remove: Vec<String>,
    pub rename: Vec<(String, String)>,
}

impl RenderedOps {
    pub fn is_empty(&self) -> bool {
        self.set.is_empty() && self.add.is_empty() && self.remove.is_empty() && self.rename.is_empty()
    }

    /// Applies the operations to a query string (without the leading `?`).
    pub fn apply_to_query(&self, query: &str) -> String {
        let mut pairs: Vec<(String, String)> = query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').map_or((p.to_string(), String::new()), |(k, v)| (k.to_string(), v.to_string()))).collect();
        for (from, to) in &self.rename {
            for pair in pairs.iter_mut().filter(|(k, _)| k == from) {
                pair.0 = to.clone();
            }
        }
        pairs.retain(|(k, _)| !self.remove.contains(k));
        for (name, value) in &self.set {
            pairs.retain(|(k, _)| k != name);
            pairs.push((name.clone(), encode_query_value(value)));
        }
        for (name, value) in &self.add {
            pairs.push((name.clone(), encode_query_value(value)));
        }
        pairs.iter().map(|(k, v)| if v.is_empty() { k.clone() } else { format!("{k}={v}") }).collect::<Vec<_>>().join("&")
    }
}

/// Percent-encodes what would otherwise change the shape of a query string.
fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/' | b':' | b',' | b'@') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Debug, Default)]
struct BodyOps {
    /// JSON Pointer to value. String values are templates.
    set: Vec<(String, Value, Option<Template>)>,
    remove: Vec<String>,
}

#[derive(Debug)]
pub struct Transformer {
    headers: Ops,
    query: Ops,
    body: BodyOps,
    max_body_bytes: usize,
}

/// A transformer with its values filled in for one request.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Rendered {
    pub headers: RenderedOps,
    pub query: RenderedOps,
    pub body_set: Vec<(String, Value)>,
    pub body_remove: Vec<String>,
    pub max_body_bytes: usize,
}

impl Rendered {
    pub fn has_body_ops(&self) -> bool {
        !self.body_set.is_empty() || !self.body_remove.is_empty()
    }

    /// Applies the body operations to a JSON document. Anything that is not
    /// JSON is returned unchanged.
    pub fn apply_to_body(&self, body: &[u8]) -> Vec<u8> {
        let Ok(mut doc) = serde_json::from_slice::<Value>(body) else { return body.to_vec() };
        for pointer in &self.body_remove {
            pointer_remove(&mut doc, pointer);
        }
        for (pointer, value) in &self.body_set {
            pointer_set(&mut doc, pointer, value.clone());
        }
        serde_json::to_vec(&doc).unwrap_or_else(|_| body.to_vec())
    }
}

fn pointer_tokens(pointer: &str) -> Option<Vec<String>> {
    if pointer.is_empty() {
        return Some(Vec::new());
    }
    Some(pointer.strip_prefix('/')?.split('/').map(|t| t.replace("~1", "/").replace("~0", "~")).collect())
}

/// Sets the value at a JSON Pointer, creating objects on the way. A step
/// through something that is neither an object nor an existing array index
/// changes nothing.
fn pointer_set(doc: &mut Value, pointer: &str, value: Value) {
    let Some(tokens) = pointer_tokens(pointer) else { return };
    let Some((last, parents)) = tokens.split_last() else {
        *doc = value;
        return;
    };
    let mut node = doc;
    for token in parents {
        node = match node {
            Value::Object(map) => map.entry(token.clone()).or_insert_with(|| Value::Object(Default::default())),
            Value::Array(list) => match token.parse::<usize>().ok().and_then(|i| list.get_mut(i)) {
                Some(next) => next,
                None => return,
            },
            _ => return,
        };
    }
    match node {
        Value::Object(map) => {
            map.insert(last.clone(), value);
        }
        Value::Array(list) if last == "-" => list.push(value),
        Value::Array(list) => {
            if let Some(slot) = last.parse::<usize>().ok().and_then(|i| list.get_mut(i)) {
                *slot = value;
            }
        }
        _ => {}
    }
}

fn pointer_remove(doc: &mut Value, pointer: &str) {
    let Some(tokens) = pointer_tokens(pointer) else { return };
    let Some((last, parents)) = tokens.split_last() else { return };
    let parent_pointer: String = parents.iter().map(|t| format!("/{}", t.replace('~', "~0").replace('/', "~1"))).collect();
    match doc.pointer_mut(&parent_pointer) {
        Some(Value::Object(map)) => {
            map.remove(last);
        }
        Some(Value::Array(list)) => {
            if let Some(i) = last.parse::<usize>().ok().filter(|i| *i < list.len()) {
                list.remove(i);
            }
        }
        _ => {}
    }
}

impl Transformer {
    pub fn build(config: &Value) -> Result<Self, String> {
        let body = config.get("body");
        let set = body
            .and_then(|b| b.get("set"))
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .map(|(pointer, value)| Ok((pointer.clone(), value.clone(), value.as_str().map(template).transpose()?)))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self {
            headers: Ops::build(config.get("headers"), true)?,
            query: Ops::build(config.get("query"), false)?,
            body: BodyOps { set, remove: body.and_then(|b| b.get("remove")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect() },
            max_body_bytes: config.get("max_body_bytes").and_then(Value::as_u64).unwrap_or(1_048_576) as usize,
        })
    }

    pub fn render(&self, vars: &Vars<'_>) -> Rendered {
        Rendered {
            headers: self.headers.render(vars),
            query: self.query.render(vars),
            body_set: self.body.set.iter().map(|(pointer, value, t)| (pointer.clone(), t.as_ref().map_or_else(|| value.clone(), |t| Value::String(vars.render(t))))).collect(),
            body_remove: self.body.remove.clone(),
            max_body_bytes: self.max_body_bytes,
        }
    }
}

/// A body being collected so that it can be rewritten as a whole.
#[derive(Debug, Default)]
pub struct BodyRewrite {
    pub rendered: Rendered,
    buffer: Vec<u8>,
    /// False once the body turned out to be too large: the rest passes through.
    collecting: bool,
}

impl BodyRewrite {
    pub fn new(rendered: Rendered) -> Self {
        Self { rendered, buffer: Vec::new(), collecting: true }
    }

    /// Feeds one chunk. Returns what to send on in its place; `skipped` is set
    /// the moment the body is found too large to rewrite.
    pub fn feed(&mut self, chunk: Option<bytes::Bytes>, end: bool, skipped: &mut bool) -> Option<bytes::Bytes> {
        if !self.collecting {
            return chunk;
        }
        if let Some(c) = &chunk {
            self.buffer.extend_from_slice(c);
        }
        if self.buffer.len() > self.rendered.max_body_bytes {
            // Too large to hold: send what was collected and stop rewriting.
            self.collecting = false;
            *skipped = true;
            return Some(bytes::Bytes::from(std::mem::take(&mut self.buffer)));
        }
        if !end {
            // An empty chunk, not `None`: to the proxy engine `None` means the body has ended.
            return Some(bytes::Bytes::new());
        }
        self.collecting = false;
        if self.buffer.is_empty() {
            return chunk;
        }
        Some(bytes::Bytes::from(self.rendered.apply_to_body(&self.buffer)))
    }
}

/// Whether a content type is JSON (`application/json`, `application/problem+json`, …).
pub fn is_json(content_type: Option<&str>) -> bool {
    content_type.map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).is_some_and(|c| c == "application/json" || c.ends_with("+json"))
}

// ── quota ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Window {
    Hour,
    Day,
    Month,
}

#[derive(Debug)]
pub struct Quota {
    pub limit: u64,
    pub window: Window,
    pub scope: Scope,
}

/// Days since the epoch for a civil date, and back (Howard Hinnant's algorithms).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let (era, yoe) = (y.div_euclid(400), y.rem_euclid(400));
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64) {
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m)
}

impl Window {
    /// The start of the window that contains `now`, and the start of the next, both UTC.
    pub fn bounds(self, now: i64) -> (i64, i64) {
        match self {
            Window::Hour => (now - now.rem_euclid(3600), now - now.rem_euclid(3600) + 3600),
            Window::Day => (now - now.rem_euclid(86_400), now - now.rem_euclid(86_400) + 86_400),
            Window::Month => {
                let (y, m) = civil_from_days(now.div_euclid(86_400));
                let (next_y, next_m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
                (days_from_civil(y, m, 1) * 86_400, days_from_civil(next_y, next_m, 1) * 86_400)
            }
        }
    }
}

impl Quota {
    pub fn build(config: &Value) -> Result<Self, String> {
        let window = match config.get("window").and_then(Value::as_str).unwrap_or("hour") {
            "hour" => Window::Hour,
            "day" => Window::Day,
            "month" => Window::Month,
            other => return Err(format!("unknown window '{other}'")),
        };
        Ok(Self { limit: config.get("limit").and_then(Value::as_u64).ok_or("limit is required")?, window, scope: Scope::parse(config.get("scope").and_then(Value::as_str)) })
    }
}

/// What a quota check found.
#[derive(Debug, PartialEq)]
pub struct QuotaDecision {
    pub allowed: bool,
    pub remaining: u64,
    /// When the window ends, seconds since the epoch.
    pub reset: i64,
}

/// Per-node quota counters, written to disk so a restart does not hand
/// everyone a fresh allowance.
#[derive(Default)]
pub struct Quotas {
    /// Key to (window start, count).
    counts: DashMap<String, (i64, u64)>,
}

impl Quotas {
    pub fn take(&self, key: &str, quota: &Quota, now: i64) -> QuotaDecision {
        let (start, reset) = quota.window.bounds(now);
        let mut entry = self.counts.entry(key.to_string()).or_insert((start, 0));
        if entry.0 != start {
            *entry = (start, 0);
        }
        if entry.1 >= quota.limit {
            return QuotaDecision { allowed: false, remaining: 0, reset };
        }
        entry.1 += 1;
        QuotaDecision { allowed: true, remaining: quota.limit - entry.1, reset }
    }

    pub fn load(&self, path: &Path, now: i64) {
        let Ok(text) = std::fs::read(path) else { return };
        let Ok(stored) = serde_json::from_slice::<BTreeMap<String, (i64, u64)>>(&text) else { return };
        for (key, (start, count)) in stored {
            // The longest window is a month; anything older has expired whatever its window.
            if now - start < 32 * 86_400 {
                self.counts.insert(key, (start, count));
            }
        }
    }

    pub fn save(&self, path: &Path, now: i64) -> std::io::Result<()> {
        self.counts.retain(|_, (start, _)| now - *start < 32 * 86_400);
        let snapshot: BTreeMap<String, (i64, u64)> = self.counts.iter().map(|e| (e.key().clone(), *e.value())).collect();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Written beside and renamed, so a crash never leaves half a file.
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(&snapshot).unwrap_or_default())?;
        std::fs::rename(tmp, path)
    }

    pub fn len(&self) -> usize {
        self.counts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.counts.is_empty()
    }
}

// ── compression ──────────────────────────────────────────────────────────────

fn d_algorithms() -> Vec<String> {
    vec!["br".into(), "gzip".into()]
}
fn d_min_bytes() -> u64 {
    1024
}
fn d_content_types() -> Vec<String> {
    ["text/*", "application/json", "application/javascript", "application/xml", "image/svg+xml"].iter().map(|s| s.to_string()).collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct Compression {
    #[serde(default = "d_algorithms")]
    pub algorithms: Vec<String>,
    #[serde(default = "d_min_bytes")]
    pub min_bytes: u64,
    #[serde(default = "d_content_types")]
    pub content_types: Vec<String>,
}

impl Compression {
    /// Whether a response with this content type and length should be compressed.
    pub fn applies(&self, content_type: Option<&str>, content_length: Option<u64>, already_encoded: bool) -> bool {
        if already_encoded || content_length.is_some_and(|n| n < self.min_bytes) {
            return false;
        }
        let Some(kind) = content_type.map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase()) else { return false };
        self.content_types.iter().any(|pattern| match pattern.strip_suffix("/*") {
            Some(family) => kind.split('/').next() == Some(family),
            None => kind == pattern.to_ascii_lowercase() || (pattern == "application/json" && kind.ends_with("+json")) || (pattern == "application/xml" && kind.ends_with("+xml")),
        })
    }
}

// ── access_log ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct AccessLog {
    pub enabled: bool,
    pub sample_rate: f64,
    custom_fields: Vec<(String, Template)>,
}

impl AccessLog {
    pub fn build(config: &Value) -> Result<Self, String> {
        Ok(Self {
            enabled: config.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            sample_rate: config.get("sample_rate").and_then(Value::as_f64).unwrap_or(1.0),
            custom_fields: config.get("custom_fields").and_then(Value::as_object).into_iter().flatten().map(|(k, v)| Ok((k.clone(), template(v.as_str().unwrap_or_default())?))).collect::<Result<_, String>>()?,
        })
    }

    /// Whether this request's line is written, given a number drawn uniformly from [0, 1).
    pub fn writes(&self, draw: f64) -> bool {
        self.enabled && draw < self.sample_rate
    }

    /// The custom fields for this request, as one JSON object.
    pub fn fields(&self, vars: &Vars<'_>) -> Option<String> {
        if self.custom_fields.is_empty() {
            return None;
        }
        let map: serde_json::Map<String, Value> = self.custom_fields.iter().map(|(k, t)| (k.clone(), Value::String(vars.render(t)))).collect();
        Some(Value::Object(map).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use apg_core::resources::Resources;
    use apg_core::snapshot::Request as MatchRequest;
    use http::HeaderMap;
    use serde_json::json;
    use std::sync::Arc;

    fn fixture() -> (Snapshot, Arc<CompiledRoute>, HeaderMap, Consumer) {
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "Default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "orders", "backends": [{ "target": "a:1" }] })));
        r.apply(&ChangeEvent::upsert("route", "r", Some("w".into()), json!({ "name": "orders-api", "service": "s" })));
        let snap = Snapshot::build(&r);
        let route = snap.match_request(&MatchRequest { host: "h", path: "/", method: "GET", query: "", header: &|_| None }).unwrap().route;
        let mut headers = HeaderMap::new();
        headers.insert("x-tenant", "acme".parse().unwrap());
        let consumer = Consumer { id: "c1".into(), workspace_id: "w".into(), name: "alice".into(), custom_id: Some("alice-1".into()), groups: vec![], labels: [("tier".to_string(), "gold".to_string())].into() };
        (snap, route, headers, consumer)
    }

    macro_rules! vars {
        ($snap:expr, $route:expr, $headers:expr, $consumer:expr, $claims:expr, $allow:expr) => {
            Vars {
                req: &Req { method: "POST", host: "api.example.com", path: "/orders/7", query: "page=2&q=a%20b", client_ip: "203.0.113.9", headers: $headers, workspace_id: "w", system_route: true, now: 0 },
                request_id: "req-1",
                scheme: "https",
                snapshot: $snap,
                route: $route,
                service_name: "orders",
                consumer: $consumer,
                claims: $claims,
                env_allow: $allow,
            }
        };
    }

    // spec §9.5
    #[test]
    fn template_variables() {
        let (snap, route, headers, consumer) = fixture();
        let claims = json!({ "sub": "u-9", "level": 3, "nested": { "x": 1 } });
        let allow = vec!["APG_TEST_ALLOWED".to_string()];
        let v = vars!(&snap, &route, &headers, Some(&consumer), Some(&claims), &allow);
        let expect = [
            ("request.id", "req-1"), ("request.method", "POST"), ("request.scheme", "https"), ("request.host", "api.example.com"), ("request.path", "/orders/7"),
            ("request.query.page", "2"), ("request.header.x-tenant", "acme"), ("client.ip", "203.0.113.9"),
            ("workspace.id", "w"), ("workspace.slug", "default"), ("workspace.name", "Default"),
            ("route.id", "r"), ("route.name", "orders-api"), ("service.name", "orders"),
            ("consumer.id", "c1"), ("consumer.name", "alice"), ("consumer.custom_id", "alice-1"), ("consumer.labels.tier", "gold"),
            ("jwt.claim.sub", "u-9"), ("jwt.claim.level", "3"),
        ];
        for (variable, value) in expect {
            assert_eq!(v.lookup(variable).as_deref(), Some(value), "{variable}");
        }
        for absent in ["request.header.x-none", "request.query.none", "consumer.labels.none", "jwt.claim.nested", "jwt.claim.none", "env.PATH", "nonsense"] {
            assert_eq!(v.lookup(absent), None, "{absent}");
        }
        // Without a consumer or a token those roots have no value.
        let anonymous = vars!(&snap, &route, &headers, None, None, &[]);
        assert_eq!((anonymous.lookup("consumer.name"), anonymous.lookup("jwt.claim.sub")), (None, None));
        assert_eq!(anonymous.render(&Template::compile("{{ consumer.name | default(\"nobody\") }} on {{ route.name }}").unwrap()), "nobody on orders-api");
    }

    #[test]
    fn redirect_fills_missing_parts_from_the_request() {
        let (snap, route, headers, _) = fixture();
        let v = vars!(&snap, &route, &headers, None, None, &[]);
        assert_eq!(Redirect::build(&json!({})).unwrap().target(&v), (308, "https://api.example.com/orders/7?page=2&q=a%20b".to_string()));
        let moved = Redirect::build(&json!({ "status": 301, "host": "new.example.com", "path": "/v2{{ request.path }}", "preserve_query": false })).unwrap();
        assert_eq!(moved.target(&v), (301, "https://new.example.com/v2/orders/7".to_string()));
        let port = Redirect::build(&json!({ "scheme": "http", "port": 8080, "path": "elsewhere" })).unwrap();
        assert_eq!(port.target(&v).1, "http://api.example.com:8080/elsewhere?page=2&q=a%20b");
        assert!(Redirect::build(&json!({ "path": "{{ unclosed" })).is_err());
    }

    #[test]
    fn static_response_renders_its_body() {
        let (snap, route, headers, _) = fixture();
        let v = vars!(&snap, &route, &headers, None, None, &[]);
        let plugin = StaticResponse::build(&json!({ "status": 503, "content_type": "text/plain", "headers": { "Retry-After": "120" }, "body": "down for maintenance ({{ request.id }})" })).unwrap();
        assert_eq!(plugin.respond(&v), (503, vec![("content-type".into(), "text/plain".into()), ("retry-after".into(), "120".into())], "down for maintenance (req-1)".into()));
        assert_eq!(StaticResponse::build(&json!({})).unwrap().respond(&v), (200, vec![("content-type".into(), "application/json".into())], String::new()));
    }

    #[test]
    fn transformer_operations_on_headers_query_and_body() {
        let (snap, route, headers, consumer) = fixture();
        let v = vars!(&snap, &route, &headers, Some(&consumer), None, &[]);
        let t = Transformer::build(&json!({
            "headers": { "set": { "X-Consumer": "{{ consumer.name }}" }, "add": { "X-Trace": "{{ request.id }}" }, "remove": ["X-Internal"], "rename": { "X-Old": "X-New" } },
            "query": { "set": { "page": "1" }, "add": { "who": "{{ consumer.name }} & co" }, "remove": ["q"], "rename": { "sort": "order" } },
            "body": { "set": { "/meta/consumer": "{{ consumer.name }}", "/count": 3, "/items/-": "extra", "/items/0": "first" }, "remove": ["/secret", "/items/1"] },
            "max_body_bytes": 100
        }))
        .unwrap();
        let r = t.render(&v);
        assert_eq!(r.headers.set, [("x-consumer".to_string(), "alice".to_string())]);
        assert_eq!(r.headers.add, [("x-trace".to_string(), "req-1".to_string())]);
        assert_eq!((r.headers.remove.clone(), r.headers.rename.clone()), (vec!["x-internal".to_string()], vec![("x-old".to_string(), "x-new".to_string())]));

        assert_eq!(r.query.apply_to_query("sort=asc&q=secret&page=9&keep"), "order=asc&keep&page=1&who=alice%20%26%20co");
        assert_eq!(RenderedOps::default().apply_to_query("a=1&b"), "a=1&b");

        let out: Value = serde_json::from_slice(&r.apply_to_body(br#"{"secret":"x","items":["a","b","c"],"keep":true}"#)).unwrap();
        assert_eq!(out, json!({ "items": ["first", "c", "extra"], "keep": true, "meta": { "consumer": "alice" }, "count": 3 }));
        // Not JSON: left exactly as it was.
        assert_eq!(r.apply_to_body(b"plain text"), b"plain text");
        assert!(r.has_body_ops() && !Rendered::default().has_body_ops());
    }

    #[test]
    fn json_pointer_edges() {
        let mut doc = json!({ "a": { "b": [1, 2] }, "x/y": 1, "t~": 2 });
        pointer_set(&mut doc, "/a/b/5", json!(9));
        pointer_set(&mut doc, "/a/b/0/deep", json!(9));
        pointer_set(&mut doc, "no-slash", json!(9));
        assert_eq!(doc["a"]["b"], json!([1, 2]), "steps that lead nowhere change nothing");
        pointer_set(&mut doc, "/x~1y", json!("slash"));
        pointer_set(&mut doc, "/t~0", json!("tilde"));
        assert_eq!((doc["x/y"].clone(), doc["t~"].clone()), (json!("slash"), json!("tilde")));
        pointer_remove(&mut doc, "/a/b/9");
        pointer_remove(&mut doc, "/nope/deeper");
        pointer_remove(&mut doc, "/a/b/0");
        assert_eq!(doc["a"]["b"], json!([2]));
        pointer_set(&mut doc, "", json!({ "replaced": true }));
        assert_eq!(doc, json!({ "replaced": true }));
    }

    #[test]
    fn a_body_is_collected_whole_or_passed_through_when_too_large() {
        let rendered = Rendered { body_set: vec![("/added".into(), json!(1))], max_body_bytes: 20, ..Default::default() };
        let chunk = |s: &str| Some(bytes::Bytes::from(s.to_string()));

        let mut small = BodyRewrite::new(rendered.clone());
        let mut skipped = false;
        assert_eq!(small.feed(chunk("{\"a\""), false, &mut skipped), Some(bytes::Bytes::new()), "held until the end");
        let out = small.feed(chunk(":1}"), true, &mut skipped).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&out).unwrap(), json!({ "a": 1, "added": 1 }));
        assert!(!skipped);

        let mut large = BodyRewrite::new(rendered.clone());
        assert_eq!(large.feed(chunk("{\"a\":\"0123456789"), false, &mut skipped), Some(bytes::Bytes::new()));
        assert_eq!(large.feed(chunk("0123456789"), false, &mut skipped).unwrap(), "{\"a\":\"01234567890123456789", "what was held is released");
        assert!(skipped);
        assert_eq!(large.feed(chunk("\"}"), true, &mut skipped).unwrap(), "\"}", "the rest passes through untouched");

        // No body at all: nothing is invented.
        let mut empty = BodyRewrite::new(rendered);
        assert_eq!(empty.feed(None, true, &mut false), None);
        assert!(is_json(Some("application/json; charset=utf-8")) && is_json(Some("application/problem+json")) && !is_json(Some("text/plain")) && !is_json(None));
    }

    #[test]
    fn quota_windows_are_calendar_aligned_in_utc() {
        // 2026-10-10T12:30:45Z
        let now = 1_791_635_445;
        assert_eq!(Window::Hour.bounds(now), (1_791_633_600, 1_791_637_200));
        assert_eq!(Window::Day.bounds(now), (1_791_590_400, 1_791_676_800));
        // October 2026 starts 2026-10-01T00:00:00Z and ends with November's start.
        assert_eq!(Window::Month.bounds(now), (1_790_812_800, 1_793_491_200));
        // December rolls into the next year; February in a leap year has 29 days.
        let december = days_from_civil(2026, 12, 15) * 86_400;
        assert_eq!(Window::Month.bounds(december).1, days_from_civil(2027, 1, 1) * 86_400);
        let february = days_from_civil(2028, 2, 10) * 86_400;
        let (start, end) = Window::Month.bounds(february);
        assert_eq!((end - start) / 86_400, 29);
    }

    #[test]
    fn a_quota_counts_down_resets_with_its_window_and_survives_a_restart() {
        let quota = Quota::build(&json!({ "limit": 3, "window": "hour" })).unwrap();
        let quotas = Quotas::default();
        let now = 1_791_635_445;
        let remaining: Vec<u64> = (0..3).map(|_| quotas.take("k", &quota, now).remaining).collect();
        assert_eq!(remaining, [2, 1, 0]);
        let over = quotas.take("k", &quota, now);
        assert_eq!(over, QuotaDecision { allowed: false, remaining: 0, reset: 1_791_637_200 });
        assert!(quotas.take("other", &quota, now).allowed, "keys are counted apart");

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state/quota.json");
        quotas.save(&path, now).unwrap();
        let restarted = Quotas::default();
        restarted.load(&path, now);
        assert!(!restarted.take("k", &quota, now).allowed, "a restart does not hand out a fresh allowance");
        // The next window starts from zero.
        assert_eq!(restarted.take("k", &quota, now + 3600).remaining, 2);
        // Counters far in the past are dropped rather than kept for ever.
        restarted.save(&path, now + 40 * 86_400).unwrap();
        assert!(restarted.is_empty());
        assert!(Quota::build(&json!({ "window": "hour" })).is_err());
        assert!(Quota::build(&json!({ "limit": 1, "window": "decade" })).is_err());
    }

    #[test]
    fn compression_applies_to_listed_types_above_the_minimum_size() {
        let c: Compression = serde_json::from_value(json!({})).unwrap();
        assert_eq!(c.algorithms, ["br", "gzip"]);
        assert!(c.applies(Some("application/json; charset=utf-8"), Some(5000), false));
        assert!(c.applies(Some("text/html"), None, false), "an unknown length is compressed");
        assert!(c.applies(Some("application/problem+json"), Some(5000), false));
        assert!(!c.applies(Some("application/json"), Some(100), false), "too small to be worth it");
        assert!(!c.applies(Some("image/png"), Some(5000), false));
        assert!(!c.applies(Some("application/json"), Some(5000), true), "already encoded");
        assert!(!c.applies(None, Some(5000), false));
        let only: Compression = serde_json::from_value(json!({ "content_types": ["application/pdf"], "min_bytes": 0 })).unwrap();
        assert!(only.applies(Some("application/pdf"), Some(1), false) && !only.applies(Some("text/html"), Some(5000), false));
    }

    #[test]
    fn access_log_override() {
        let (snap, route, headers, consumer) = fixture();
        let v = vars!(&snap, &route, &headers, Some(&consumer), None, &[]);
        let log = AccessLog::build(&json!({ "sample_rate": 0.25, "custom_fields": { "tenant": "{{ request.header.x-tenant }}", "who": "{{ consumer.name }}" } })).unwrap();
        assert!(log.writes(0.1) && !log.writes(0.25) && !log.writes(0.9));
        assert_eq!(serde_json::from_str::<Value>(&log.fields(&v).unwrap()).unwrap(), json!({ "tenant": "acme", "who": "alice" }));
        let off = AccessLog::build(&json!({ "enabled": false })).unwrap();
        assert!(!off.writes(0.0));
        assert_eq!(off.fields(&v), None);
    }
}
