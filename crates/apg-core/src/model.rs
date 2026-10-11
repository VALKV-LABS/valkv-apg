//! Resources as a node receives them, and the event that carries them.
//!
//! These types mirror `schemas/`. Defaults here must equal the `default`
//! values in the schemas: the admin does not send nested objects the caller
//! omitted, so the node fills them in. Unknown fields are ignored, never an
//! error, so a node one release behind the admin keeps working (spec PKG-2).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One row of the changelog, or one line of a snapshot (contract version 2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangeEvent {
    pub v: u32,
    pub kind: String,
    pub op: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ChangeEvent {
    /// An `upsert` event.
    pub fn upsert(kind: &str, id: impl Into<String>, workspace_id: Option<String>, data: Value) -> Self {
        Self { v: 2, kind: kind.to_string(), op: "upsert".into(), id: id.into(), workspace_id, revision: Some(1), data: Some(data) }
    }
}

/// Event kinds this build understands. Anything else is skipped and counted.
pub const KINDS: &[&str] = &[
    "workspace", "domain", "certificate", "ca_certificate", "service", "route", "plugin", "consumer",
    "credential", "wasm_module", "flag", "setting", "acme_challenge",
];

fn d_true() -> bool { true }
fn d_one() -> u32 { 1 }
fn d_active() -> String { "active".into() }
fn d_http() -> String { "http".into() }
fn d_http11() -> String { "1.1".into() }
fn d_preserve() -> String { "preserve".into() }
fn d_acme() -> String { "acme".into() }
fn d_http01() -> String { "http01".into() }
fn d_idle() -> u64 { 300_000 }
fn d_drain() -> u64 { 30_000 }
fn d_round_robin() -> String { "round_robin".into() }
fn d_client_ip() -> String { "client_ip".into() }
fn d_exact() -> String { "exact".into() }
fn d_connect_ms() -> u64 { 5_000 }
fn d_io_ms() -> u64 { 60_000 }
fn d_retry_on() -> Vec<String> { vec!["connect_failure".into()] }
fn d_healthz() -> String { "/healthz".into() }
fn d_probe_interval() -> u64 { 5_000 }
fn d_probe_timeout() -> u64 { 2_000 }
fn d_two() -> u32 { 2 }
fn d_three() -> u32 { 3 }
fn d_expected() -> Vec<(u16, u16)> { vec![(200, 399)] }
fn d_open_ms() -> u64 { 30_000 }
fn d_passive_statuses() -> Vec<u16> { vec![502, 503, 504] }
fn d_keepalive_idle() -> u64 { 60_000 }

/// The tenancy unit (spec §4.2).
#[derive(Debug, Clone, Deserialize)]
pub struct Workspace {
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub system: bool,
    #[serde(default = "d_active")]
    pub status: String,
}

/// TLS policy of a domain.
#[derive(Debug, Clone, Deserialize)]
pub struct DomainTls {
    #[serde(default = "d_acme")]
    pub mode: String,
    #[serde(default = "d_http01")]
    pub challenge: String,
    #[serde(default)]
    pub certificate: Option<String>,
}

impl Default for DomainTls {
    fn default() -> Self {
        Self { mode: d_acme(), challenge: d_http01(), certificate: None }
    }
}

/// A hostname owned by one workspace (spec §4.3).
#[derive(Debug, Clone, Deserialize)]
pub struct Domain {
    pub hostname: String,
    #[serde(default)]
    pub tls: DomainTls,
    #[serde(default = "d_active")]
    pub status: String,
}

/// One upstream address.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Backend {
    #[serde(default)]
    pub id: String,
    pub target: String,
    #[serde(default = "d_one")]
    pub weight: u32,
    #[serde(default = "d_active")]
    pub status: String,
}

/// How a service picks a backend.
#[derive(Debug, Clone, Deserialize)]
pub struct LoadBalancing {
    #[serde(default = "d_round_robin")]
    pub strategy: String,
    #[serde(default = "d_client_ip")]
    pub hash_key: String,
}

impl Default for LoadBalancing {
    fn default() -> Self {
        Self { strategy: d_round_robin(), hash_key: d_client_ip() }
    }
}

/// TLS towards the upstream (spec §7.6). The references hold ids.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceTls {
    #[serde(default = "d_true")]
    pub verify: bool,
    #[serde(default)]
    pub sni: Option<String>,
    #[serde(default)]
    pub ca_certificates: Vec<String>,
    #[serde(default)]
    pub client_certificate: Option<String>,
}

impl Default for ServiceTls {
    fn default() -> Self {
        Self { verify: true, sni: None, ca_certificates: Vec::new(), client_certificate: None }
    }
}

/// Limits on one upstream connection (spec UP-8).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Timeouts {
    #[serde(default = "d_connect_ms")]
    pub connect_ms: u64,
    #[serde(default = "d_io_ms")]
    pub read_ms: u64,
    #[serde(default = "d_io_ms")]
    pub write_ms: u64,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self { connect_ms: d_connect_ms(), read_ms: d_io_ms(), write_ms: d_io_ms() }
    }
}

/// When a failed attempt is tried again on another backend (spec UP-9, UP-10).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Retries {
    /// Extra tries after the first.
    #[serde(default = "d_one")]
    pub attempts: u32,
    /// "connect_failure" and/or "timeout".
    #[serde(default = "d_retry_on")]
    pub on: Vec<String>,
    #[serde(default)]
    pub non_idempotent: bool,
}

impl Default for Retries {
    fn default() -> Self {
        Self { attempts: 1, on: d_retry_on(), non_idempotent: false }
    }
}

impl Retries {
    pub fn on(&self, condition: &str) -> bool {
        self.on.iter().any(|c| c == condition)
    }
}

/// A probe the node sends to each backend (spec §7.2).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ActiveCheck {
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(rename = "type", default = "d_http")]
    pub kind: String,
    #[serde(default = "d_healthz")]
    pub path: String,
    #[serde(default = "d_probe_interval")]
    pub interval_ms: u64,
    #[serde(default = "d_probe_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "d_two")]
    pub healthy_threshold: u32,
    #[serde(default = "d_three")]
    pub unhealthy_threshold: u32,
    /// Inclusive status ranges that count as healthy.
    #[serde(default = "d_expected")]
    pub expected_statuses: Vec<(u16, u16)>,
    #[serde(default)]
    pub host_header: Option<String>,
}

/// The circuit breaker fed by real traffic (spec §7.3).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PassiveCheck {
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default = "d_three")]
    pub consecutive_failures: u32,
    #[serde(default = "d_open_ms")]
    pub open_ms: u64,
    #[serde(default = "d_passive_statuses")]
    pub statuses: Vec<u16>,
}

impl Default for PassiveCheck {
    fn default() -> Self {
        Self { enabled: true, consecutive_failures: 3, open_ms: d_open_ms(), statuses: d_passive_statuses() }
    }
}

/// Health policy of a service. Active probing happens only when "active" is
/// present; the passive circuit breaker is on unless disabled.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
pub struct HealthCheck {
    #[serde(default)]
    pub active: Option<ActiveCheck>,
    #[serde(default)]
    pub passive: PassiveCheck,
}

/// Reuse of idle upstream connections.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Keepalive {
    #[serde(default = "d_keepalive_idle")]
    pub idle_ms: u64,
}

impl Default for Keepalive {
    fn default() -> Self {
        Self { idle_ms: d_keepalive_idle() }
    }
}

/// A named upstream (spec §4.5).
#[derive(Debug, Clone, Deserialize)]
pub struct Service {
    pub name: String,
    #[serde(default)]
    pub shared: bool,
    #[serde(default = "d_http")]
    pub scheme: String,
    #[serde(default = "d_http11")]
    pub http_version: String,
    pub backends: Vec<Backend>,
    #[serde(default)]
    pub load_balancing: LoadBalancing,
    #[serde(default)]
    pub tls: ServiceTls,
    #[serde(default)]
    pub timeouts: Timeouts,
    #[serde(default)]
    pub retries: Retries,
    #[serde(default)]
    pub health_check: HealthCheck,
    #[serde(default)]
    pub keepalive: Keepalive,
    /// Set by the control plane when the service was written by a caller who
    /// may not reach private addresses (spec SEC-4). The node enforces it at
    /// connect time.
    #[serde(default)]
    pub egress_restricted: bool,
    #[serde(default = "d_preserve")]
    pub host_header: String,
    #[serde(default = "d_drain")]
    pub drain_timeout_ms: u64,
}

/// One path predicate. A bare string in configuration means `prefix`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum PathSpec {
    Shorthand(String),
    Full {
        #[serde(rename = "type")]
        kind: String,
        value: String,
    },
}

impl PathSpec {
    /// `(type, value)`, with the shorthand expanded.
    pub fn parts(&self) -> (&str, &str) {
        match self {
            PathSpec::Shorthand(v) => ("prefix", v),
            PathSpec::Full { kind, value } => (kind, value),
        }
    }
}

/// A header or query predicate.
#[derive(Debug, Clone, Deserialize)]
pub struct Predicate {
    pub name: String,
    #[serde(rename = "type", default = "d_exact")]
    pub kind: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// One side of a traffic split. `service` holds a service id.
#[derive(Debug, Clone, Deserialize)]
pub struct SplitTarget {
    pub service: String,
    pub weight: u32,
}

/// Path rewrite applied after `strip_path` (spec §4.6).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Rewrite {
    Regex { regex: String, replacement: String },
    Path { path: String },
    Prefix { prefix: String },
}

/// A custom gateway error response (spec ERR-2).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ErrorResponseSpec {
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// Match predicates that send a request to a service (spec §4.6).
#[derive(Debug, Clone, Deserialize)]
pub struct Route {
    pub name: String,
    #[serde(default)]
    pub service: Option<String>,
    #[serde(default)]
    pub split: Option<Vec<SplitTarget>>,
    #[serde(default)]
    pub split_key: Option<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub paths: Vec<PathSpec>,
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(default)]
    pub headers: Vec<Predicate>,
    #[serde(default)]
    pub query: Vec<Predicate>,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub strip_path: bool,
    #[serde(default)]
    pub rewrite: Option<Rewrite>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default = "d_idle")]
    pub idle_timeout_ms: u64,
    #[serde(default)]
    pub error_responses: HashMap<String, ErrorResponseSpec>,
    #[serde(default = "d_true")]
    pub enabled: bool,
}

/// A plugin instance as nodes receive it: references are ids (spec §9.1).
#[derive(Debug, Clone, Deserialize)]
pub struct Plugin {
    #[serde(rename = "type")]
    pub kind: String,
    pub scope: String,
    #[serde(default)]
    pub service_id: Option<String>,
    #[serde(default)]
    pub route_id: Option<String>,
    #[serde(default)]
    pub consumer_id: Option<String>,
    #[serde(default)]
    pub target_workspace: Option<String>,
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub config: Value,
}

/// One entry of the `workspace_base_domains` setting (spec DOM-2).
#[derive(Debug, Clone, Deserialize)]
pub struct BaseDomain {
    pub domain: String,
}

/// A PEM bundle used to verify upstreams (spec §4.4). "cert_file" is file mode only.
#[derive(Debug, Clone, Deserialize)]
pub struct CaCertificate {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cert_pem: Option<String>,
    #[serde(default)]
    pub cert_file: Option<String>,
}

/// A certificate. In file mode `cert_file`/`key_file` name files the node reads;
/// from a control plane the key arrives as ciphertext (handled in build phase 2d).
#[derive(Debug, Clone, Deserialize)]
pub struct Certificate {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cert_pem: Option<String>,
    #[serde(default)]
    pub key_pem: Option<String>,
    #[serde(default)]
    pub cert_file: Option<String>,
    #[serde(default)]
    pub key_file: Option<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
}
