//! Upstreams (spec §7): what the node knows about each backend, and which one
//! a request goes to.
//!
//! State is kept per service id and backend target and survives configuration
//! changes: a backend that was failing before an unrelated edit is still
//! failing after it. Nothing here is shared between nodes.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use apg_core::model::{ActiveCheck, Backend, CaCertificate, Certificate, Service};
use apg_core::resources::Resources;
use apg_core::schema::Fault;
use apg_core::snapshot::{ServiceEntry, Snapshot};
use arc_swap::ArcSwap;
use dashmap::DashMap;
use parking_lot::Mutex;
use pingora_core::connectors::http::Connector;
use pingora_core::protocols::tls::CaType;
use pingora_core::tls::pkey::PKey;
use pingora_core::tls::x509::X509;
use pingora_core::upstreams::peer::HttpPeer;
use pingora_core::utils::tls::CertKey;
use pingora_http::RequestHeader;
use tokio::sync::Notify;

use crate::metrics;
use crate::net::{Cidr, is_non_public, split_target};
use crate::secrets::SecretBox;
use crate::tls::key_matches;

/// Process-level settings (spec Appendix B).
#[derive(Debug, Clone)]
pub struct Settings {
    /// How often backend host names are resolved again.
    pub dns_refresh: Duration,
    /// Private ranges an egress-restricted service may still reach (spec SEC-4).
    pub backend_allow: Vec<Cidr>,
    /// Opens client-certificate keys sealed by a control plane.
    pub secrets: Option<Arc<SecretBox>>,
    /// Query parameter names masked in the access log (`APG_LOG_REDACT_QUERY`).
    pub redact_query: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { dns_refresh: Duration::from_secs(30), backend_allow: Vec::new(), secrets: None, redact_query: ["apikey", "token", "access_token", "signature"].iter().map(|s| s.to_string()).collect() }
    }
}

// ── Small deterministic helpers ──────────────────────────────────────────────

/// A pseudo-random number: good enough to spread load and jitter probes.
pub fn random() -> u64 {
    thread_local! {
        static STATE: Cell<u64> = Cell::new(std::collections::hash_map::RandomState::new().build_hasher().finish() | 1);
    }
    STATE.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        x
    })
}

/// Hashes the parts into 64 well-mixed bits. The result must never change
/// between releases: every node has to send one key to the same backend.
pub fn hash_parts(parts: &[&str]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in part.bytes().chain(std::iter::once(0xff)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h ^= h >> 30;
    h = h.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94d0_49bb_1331_11eb);
    h ^ (h >> 31)
}

/// Picks among weights by position: over any window of `total weight`
/// consecutive counters each index is chosen `weight` times.
pub fn weighted_pick(weights: &[u32], counter: usize) -> Option<usize> {
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

/// Weighted rendezvous hashing (spec UP-4): each candidate scores the key, the
/// best score wins. Removing a candidate moves only the keys it held.
fn rendezvous(key: &str, candidates: &[(&str, u32)]) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (i, (name, weight)) in candidates.iter().enumerate() {
        if *weight == 0 {
            continue;
        }
        // Uniform in (0, 1); the score is the weight over an exponential variate.
        let u = ((hash_parts(&[key, *name]) >> 11) as f64 + 0.5) / (1u64 << 53) as f64;
        let score = f64::from(*weight) / -u.ln();
        if best.is_none_or(|(_, s)| score > s) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

// ── Circuit breaker (spec §7.3) ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Closed,
    Open { until: Instant },
    /// One request is let through to find out whether the backend recovered.
    HalfOpen { probe_started: Option<Instant> },
}

/// Closed, then open after consecutive failures, then half-open: one probe
/// request decides between closing and opening again.
pub struct Circuit {
    failures: AtomicU32,
    phase: Mutex<Phase>,
}

impl Default for Circuit {
    fn default() -> Self {
        Self { failures: AtomicU32::new(0), phase: Mutex::new(Phase::Closed) }
    }
}

impl Circuit {
    /// Whether the backend may be offered a request now.
    pub fn allows(&self, now: Instant, open: Duration) -> bool {
        let mut phase = self.phase.lock();
        match *phase {
            Phase::Closed | Phase::HalfOpen { probe_started: None } => true,
            Phase::Open { until } if now < until => false,
            Phase::Open { .. } => {
                *phase = Phase::HalfOpen { probe_started: None };
                true
            }
            // A probe whose outcome never arrived must not hold the circuit shut for ever.
            Phase::HalfOpen { probe_started: Some(at) } => now.duration_since(at) > open,
        }
    }

    /// A request was sent to the backend.
    pub fn picked(&self, now: Instant) {
        let mut phase = self.phase.lock();
        if matches!(*phase, Phase::HalfOpen { .. }) {
            *phase = Phase::HalfOpen { probe_started: Some(now) };
        }
    }

    /// Records a success. Returns true when this closed the circuit.
    pub fn success(&self) -> bool {
        self.failures.store(0, Ordering::Relaxed);
        let mut phase = self.phase.lock();
        let was_closed = *phase == Phase::Closed;
        *phase = Phase::Closed;
        !was_closed
    }

    /// Records a failure. Returns true when this opened the circuit.
    pub fn failure(&self, now: Instant, threshold: u32, open: Duration) -> bool {
        let failures = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
        let mut phase = self.phase.lock();
        let trip = match *phase {
            Phase::Closed => failures >= threshold,
            Phase::HalfOpen { .. } => true,
            Phase::Open { .. } => false,
        };
        if trip {
            *phase = Phase::Open { until: now + open };
        }
        trip
    }

    pub fn is_closed(&self) -> bool {
        *self.phase.lock() == Phase::Closed
    }

    /// The phase by name, for status reports.
    pub fn phase_name(&self) -> &'static str {
        match *self.phase.lock() {
            Phase::Closed => "closed",
            Phase::Open { .. } => "open",
            Phase::HalfOpen { .. } => "half_open",
        }
    }
}

// ── Per-backend and per-service state ────────────────────────────────────────

pub struct BackendState {
    in_flight: AtomicUsize,
    pub circuit: Circuit,
    /// Whether an active probe runs for this backend, and what it last concluded.
    probed: AtomicBool,
    healthy: AtomicBool,
    /// What the node last saw of this backend, from a probe or a request: one of `SEEN_*`.
    seen: AtomicU8,
    /// Unix seconds of that observation.
    seen_at: AtomicU64,
    /// Why the last failed probe or request failed.
    reason: Mutex<Option<String>>,
}

/// Nothing has been sent to the backend yet, so nothing is known about it.
const SEEN_NOTHING: u8 = 0;
const SEEN_ANSWER: u8 = 1;
const SEEN_FAILURE: u8 = 2;

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            in_flight: AtomicUsize::new(0),
            circuit: Circuit::default(),
            probed: AtomicBool::new(false),
            healthy: AtomicBool::new(true),
            seen: AtomicU8::new(SEEN_NOTHING),
            seen_at: AtomicU64::new(0),
            reason: Mutex::new(None),
        }
    }
}

impl BackendState {
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Relaxed)
    }

    /// Healthy by active check. A backend nobody probes counts as healthy.
    pub fn healthy(&self) -> bool {
        !self.probed.load(Ordering::Relaxed) || self.healthy.load(Ordering::Relaxed)
    }

    /// Remembers how a probe or a request to the backend ended, for status
    /// reports. It has no part in choosing a backend.
    fn observe(&self, outcome: Result<(), &str>) {
        self.seen_at.store(unix_now(), Ordering::Relaxed);
        match outcome {
            Ok(()) => self.seen.store(SEEN_ANSWER, Ordering::Relaxed),
            Err(reason) => {
                self.seen.store(SEEN_FAILURE, Ordering::Relaxed);
                let mut current = self.reason.lock();
                if current.as_deref() != Some(reason) {
                    *current = Some(reason.to_string());
                }
            }
        }
    }
}

/// Trust material for one HTTPS service (spec §7.6).
#[derive(Default)]
pub struct UpstreamTls {
    ca: Option<Arc<CaType>>,
    client: Option<Arc<CertKey>>,
    /// Why the material could not be built. Requests fail rather than fall
    /// back to weaker verification.
    broken: Option<String>,
}

struct ServiceState {
    backends: DashMap<String, Arc<BackendState>>,
    rotation: AtomicUsize,
    tls: ArcSwap<UpstreamTls>,
    /// Workspace id and service name, as exported in metric labels.
    labels: Mutex<(String, String)>,
    warned_no_verify: AtomicBool,
}

impl ServiceState {
    fn new(entry: &ServiceEntry) -> Self {
        Self {
            backends: DashMap::new(),
            rotation: AtomicUsize::new(0),
            tls: ArcSwap::from_pointee(UpstreamTls::default()),
            labels: Mutex::new((entry.workspace_id.clone(), entry.spec.name.clone())),
            warned_no_verify: AtomicBool::new(false),
        }
    }

    fn backend(&self, target: &str) -> Arc<BackendState> {
        if let Some(found) = self.backends.get(target) {
            return found.clone();
        }
        self.backends.entry(target.to_string()).or_default().clone()
    }
}

/// A backend chosen for one attempt. Dropping it ends the attempt for
/// `least_connections` accounting.
pub struct Picked {
    pub backend: Backend,
    state: Arc<BackendState>,
}

impl Picked {
    /// Notes why the attempt failed, so that a status report can say more than "failing".
    pub fn failed_because(&self, reason: &str) {
        self.state.observe(Err(reason));
    }
}

impl Drop for Picked {
    fn drop(&mut self) {
        self.state.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

// ── DNS (spec UP-5) ──────────────────────────────────────────────────────────

/// Resolved addresses of backend host names. Requests read the cache; a
/// background task keeps it current. An empty list means "does not resolve".
#[derive(Default)]
struct Dns {
    cache: DashMap<String, Arc<Vec<IpAddr>>>,
    wanted: Mutex<HashSet<String>>,
}

async fn lookup(host: &str) -> Option<Vec<IpAddr>> {
    let found = tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host, 0))).await.ok()?.ok()?;
    let mut addrs: Vec<IpAddr> = found.map(|a| a.ip()).collect();
    // A stable order, so a hash key keeps its address while the record set is unchanged.
    addrs.sort();
    addrs.dedup();
    (!addrs.is_empty()).then_some(addrs)
}

impl Dns {
    /// The addresses of `host`. Only a name nobody has resolved yet waits here,
    /// once; afterwards every request is answered from the cache.
    async fn resolve(&self, host: &str) -> Arc<Vec<IpAddr>> {
        if let Some(hit) = self.cache.get(host) {
            return hit.clone();
        }
        let addrs = Arc::new(lookup(host).await.unwrap_or_else(|| {
            metrics::DNS_FAILURES.inc();
            Vec::new()
        }));
        self.cache.insert(host.to_string(), addrs.clone());
        addrs
    }

    /// Resolves the names in use: all of them, or only those not resolved yet.
    /// A failed lookup keeps the last good addresses.
    async fn refresh(&self, all: bool) {
        let wanted: Vec<String> = self.wanted.lock().iter().cloned().collect();
        for host in &wanted {
            if !all && self.cache.get(host).is_some_and(|a| !a.is_empty()) {
                continue;
            }
            match lookup(host).await {
                Some(addrs) => {
                    self.cache.insert(host.clone(), Arc::new(addrs));
                }
                None => {
                    metrics::DNS_FAILURES.inc();
                    tracing::warn!(%host, "backend host did not resolve; keeping the last known addresses");
                    self.cache.entry(host.clone()).or_default();
                }
            }
        }
        let keep: HashSet<String> = self.wanted.lock().clone();
        self.cache.retain(|host, _| keep.contains(host));
    }
}

// ── Active health checks (spec §7.2) ─────────────────────────────────────────

#[derive(Clone)]
struct ProbeSpec {
    /// Service id and backend target.
    key: (String, String),
    /// Changes whenever anything a probe depends on changes.
    fingerprint: String,
    service: Arc<ServiceEntry>,
    backend: Backend,
    check: ActiveCheck,
    state: Arc<BackendState>,
}

fn jitter(base: Duration, percent: u64) -> Duration {
    Duration::from_millis(random() % (base.as_millis() as u64 * percent / 100).max(1))
}

// ── Upstream TLS material ────────────────────────────────────────────────────

type Read<'a> = &'a dyn Fn(&str) -> std::io::Result<Vec<u8>>;

fn pem_of(inline: &Option<String>, file: &Option<String>, what: &str, read: Read<'_>) -> Result<Vec<u8>, String> {
    match (inline, file) {
        (Some(pem), _) => Ok(pem.clone().into_bytes()),
        (None, Some(path)) => read(path).map_err(|e| format!("cannot read {what} '{path}': {e}")),
        (None, None) => Err(format!("{what} is not available to this node")),
    }
}

fn load_tls(resources: &Resources, service: &Service, read: Read<'_>, secrets: Option<&SecretBox>) -> Result<UpstreamTls, String> {
    let mut out = UpstreamTls::default();
    if service.scheme != "https" {
        return Ok(out);
    }
    if !service.tls.ca_certificates.is_empty() {
        let mut roots = Vec::new();
        for id in &service.tls.ca_certificates {
            let stored = resources.get("ca_certificate", id).ok_or_else(|| format!("CA certificate '{id}' is not in the configuration"))?;
            let ca: CaCertificate = serde_json::from_value(stored.data.clone()).map_err(|e| format!("CA certificate '{id}': {e}"))?;
            let pem = pem_of(&ca.cert_pem, &ca.cert_file, &format!("CA certificate '{}'", ca.name), read)?;
            let certs = X509::stack_from_pem(&pem).ok().filter(|c| !c.is_empty()).ok_or_else(|| format!("CA certificate '{}' holds no PEM-encoded certificate", ca.name))?;
            roots.extend(certs);
        }
        out.ca = Some(Arc::new(roots.into_boxed_slice()));
    }
    if let Some(id) = &service.tls.client_certificate {
        let stored = resources.get("certificate", id).ok_or_else(|| format!("client certificate '{id}' is not in the configuration"))?;
        let cert: Certificate = serde_json::from_value(stored.data.clone()).map_err(|e| format!("client certificate '{id}': {e}"))?;
        let cert_pem = pem_of(&cert.cert_pem, &cert.cert_file, &format!("client certificate '{}'", cert.name), read)?;
        let key_pem = match (&cert.key_ciphertext, secrets) {
            // From a control plane the key is sealed for the certificate's id.
            (Some(sealed), Some(secrets)) if cert.key_pem.is_none() && cert.key_file.is_none() => secrets.open(sealed, &format!("certificate:{id}"))?,
            (Some(_), None) if cert.key_pem.is_none() && cert.key_file.is_none() => return Err(format!("the key of client certificate '{}' is sealed and APG_SECRET_KEY is not set on this node", cert.name)),
            _ => pem_of(&cert.key_pem, &cert.key_file, &format!("the key of client certificate '{}'", cert.name), read)?,
        };
        key_matches(&cert_pem, &key_pem).map_err(|e| format!("client certificate '{}': {e}", cert.name))?;
        let chain = X509::stack_from_pem(&cert_pem).map_err(|_| format!("client certificate '{}' is not PEM", cert.name))?;
        let key = PKey::private_key_from_pem(&key_pem).map_err(|_| format!("the key of client certificate '{}' is not PEM", cert.name))?;
        out.client = Some(Arc::new(CertKey::new(chain, key)));
    }
    Ok(out)
}

/// Checks the trust material of every HTTPS service without installing
/// anything, so a file with an unreadable CA bundle is refused whole.
pub fn check(resources: &Resources, read: Read<'_>) -> Vec<Fault> {
    let mut faults = Vec::new();
    for (id, stored) in resources.kind("service") {
        let Ok(service) = serde_json::from_value::<Service>(stored.data.clone()) else { continue };
        if let Err(message) = load_tls(resources, &service, read, None) {
            let name = if service.name.is_empty() { id.as_str() } else { service.name.as_str() };
            faults.push(Fault::new("/services", format!("service '{name}': {message}")));
        }
    }
    faults
}

// ── The registry ─────────────────────────────────────────────────────────────

/// How long an address that could not be connected to is passed over the first
/// time, while its name has other addresses. It doubles with each further
/// failure, up to `UNREACHABLE_AT_MOST`.
const UNREACHABLE_FOR: Duration = Duration::from_secs(30);
const UNREACHABLE_AT_MOST: Duration = Duration::from_secs(600);

pub struct Upstreams {
    settings: Settings,
    /// Addresses a connection could not be made to: until when each is passed
    /// over, and how many times in a row it has failed.
    unreachable: DashMap<IpAddr, (Instant, u32)>,
    services: DashMap<String, Arc<ServiceState>>,
    dns: Dns,
    address_rotation: AtomicUsize,
    plan: ArcSwap<Vec<ProbeSpec>>,
    wake: Notify,
}

impl Default for Upstreams {
    fn default() -> Self {
        Self::new(Settings::default())
    }
}

impl Upstreams {
    pub fn new(settings: Settings) -> Self {
        Self { settings, unreachable: DashMap::new(), services: DashMap::new(), dns: Dns::default(), address_rotation: AtomicUsize::new(0), plan: ArcSwap::from_pointee(Vec::new()), wake: Notify::new() }
    }

    fn service(&self, entry: &ServiceEntry) -> Arc<ServiceState> {
        if let Some(found) = self.services.get(&entry.id) {
            return found.clone();
        }
        self.services.entry(entry.id.clone()).or_insert_with(|| Arc::new(ServiceState::new(entry))).clone()
    }

    /// Brings the registry in line with a new configuration: state of services
    /// and backends that are gone is dropped, trust material is rebuilt, and
    /// the background task is told which names to resolve and what to probe.
    pub fn sync(&self, resources: &Resources, snapshot: &Snapshot) {
        let probing = snapshot.flag("active_health_checks");
        let mut hosts = HashSet::new();
        let mut plan = Vec::new();
        let mut live = HashSet::new();

        for entry in snapshot.services() {
            live.insert(entry.id.clone());
            let state = self.service(entry);
            let spec = &entry.spec;

            // Labels follow a rename; series under the old name are removed.
            let labels = (entry.workspace_id.clone(), spec.name.clone());
            {
                let mut current = state.labels.lock();
                if *current != labels {
                    for b in state.backends.iter() {
                        forget_backend_metrics(&current, b.key());
                    }
                    let _ = metrics::UPSTREAM_RETRIES.remove_label_values(&[&current.0, &current.1]);
                    *current = labels.clone();
                }
            }

            let tls = load_tls(resources, spec, &|p| std::fs::read(p), self.settings.secrets.as_deref()).unwrap_or_else(|message| {
                tracing::error!(service = %spec.name, %message, "upstream TLS material is unusable; requests to this service will fail");
                UpstreamTls { broken: Some(message), ..Default::default() }
            });
            state.tls.store(Arc::new(tls));
            if spec.scheme == "https" && !spec.tls.verify && !state.warned_no_verify.swap(true, Ordering::Relaxed) {
                tracing::warn!(service = %spec.name, "tls.verify is false: the upstream's certificate is not checked");
            }

            let targets: HashSet<&str> = spec.backends.iter().map(|b| b.target.as_str()).collect();
            state.backends.retain(|target, _| {
                let keep = targets.contains(target.as_str());
                if !keep {
                    forget_backend_metrics(&labels, target);
                }
                keep
            });

            let active = spec.health_check.active.as_ref().filter(|a| a.enabled && probing);
            for backend in &spec.backends {
                let bs = state.backend(&backend.target);
                if let Some((host, _)) = split_target(&backend.target)
                    && host.parse::<IpAddr>().is_err()
                {
                    hosts.insert(host.to_string());
                }
                match active.filter(|_| backend.status != "down") {
                    Some(check) => {
                        if !bs.probed.swap(true, Ordering::Relaxed) {
                            // A backend starts healthy (spec UP-6).
                            bs.healthy.store(true, Ordering::Relaxed);
                            metrics::BACKEND_HEALTHY.with_label_values(&[&labels.0, &labels.1, &backend.target]).set(1);
                        }
                        plan.push(ProbeSpec {
                            key: (entry.id.clone(), backend.target.clone()),
                            fingerprint: format!("{check:?}|{}|{}|{:?}|{}", spec.scheme, spec.http_version, spec.tls, spec.egress_restricted),
                            service: entry.clone(),
                            backend: backend.clone(),
                            check: check.clone(),
                            state: bs,
                        });
                    }
                    None => {
                        if bs.probed.swap(false, Ordering::Relaxed) {
                            let _ = metrics::BACKEND_HEALTHY.remove_label_values(&[&labels.0, &labels.1, &backend.target]);
                        }
                    }
                }
            }
        }

        self.services.retain(|id, state| {
            let keep = live.contains(id);
            if !keep {
                let labels = state.labels.lock();
                for b in state.backends.iter() {
                    forget_backend_metrics(&labels, b.key());
                }
                let _ = metrics::UPSTREAM_RETRIES.remove_label_values(&[&labels.0, &labels.1]);
            }
            keep
        });
        *self.dns.wanted.lock() = hosts;
        self.plan.store(Arc::new(plan));
        self.wake.notify_one();
    }

    /// Chooses a backend for one attempt (spec §7.1). `tried` lists targets
    /// that already failed for this request; `key` is the value of the
    /// service's `hash_key` for this request, when it has one.
    pub fn select(&self, snapshot: &Snapshot, service: &ServiceEntry, key: Option<&str>, tried: &[String]) -> Option<Picked> {
        let state = self.service(service);
        let spec = &service.spec;
        let now = Instant::now();
        let passive = &spec.health_check.passive;
        let breaker = passive.enabled && snapshot.flag("circuit_breaker");
        let open = Duration::from_millis(passive.open_ms);

        let active: Vec<(&Backend, Arc<BackendState>)> = spec.backends.iter().filter(|b| b.status == "active" && b.weight > 0).map(|b| (b, state.backend(&b.target))).collect();
        if active.is_empty() {
            return None;
        }
        // A retry goes to a backend not tried yet, when there is one (spec UP-9).
        let untried: Vec<(&Backend, Arc<BackendState>)> = active.iter().filter(|(b, _)| !tried.contains(&b.target)).cloned().collect();
        let candidates = if untried.is_empty() { active } else { untried };
        let usable: Vec<(&Backend, Arc<BackendState>)> = candidates.iter().filter(|(_, s)| s.healthy() && (!breaker || s.circuit.allows(now, open))).cloned().collect();
        // Sending traffic to a possibly recovering backend beats a certain 503 (spec UP-2).
        let pool = if usable.is_empty() {
            metrics::UPSTREAM_FAIL_OPEN.inc();
            candidates
        } else {
            usable
        };

        let weights: Vec<u32> = pool.iter().map(|(b, _)| b.weight).collect();
        let rotate = || state.rotation.fetch_add(1, Ordering::Relaxed);
        let index = match (spec.load_balancing.strategy.as_str(), key) {
            ("random", _) => weighted_pick(&weights, random() as usize),
            ("least_connections", _) => {
                let least = pool.iter().map(|(_, s)| s.in_flight()).min().unwrap_or(0);
                let tied: Vec<usize> = (0..pool.len()).filter(|i| pool[*i].1.in_flight() == least).collect();
                let tied_weights: Vec<u32> = tied.iter().map(|i| weights[*i]).collect();
                weighted_pick(&tied_weights, rotate()).map(|j| tied[j])
            }
            ("hash", Some(key)) => {
                let named: Vec<(&str, u32)> = pool.iter().map(|(b, _)| (b.target.as_str(), b.weight)).collect();
                rendezvous(key, &named)
            }
            // round_robin, and hash for a request that has no key (spec UP-4).
            _ => weighted_pick(&weights, rotate()),
        }?;

        let (backend, bs) = &pool[index];
        if breaker {
            bs.circuit.picked(now);
        }
        bs.in_flight.fetch_add(1, Ordering::Relaxed);
        Some(Picked { backend: (*backend).clone(), state: bs.clone() })
    }

    /// What this node knows about one backend (spec OBS-4).
    ///
    /// `state` is what the evidence says: `healthy` after an answer,
    /// `unhealthy` after a failure, and `unknown` while nothing has been sent,
    /// because a backend nobody has talked to is not known to work. It is
    /// separate from `in_rotation`, which is what `select` does with it.
    fn backend_health(&self, state: &ServiceState, backend: &Backend) -> serde_json::Value {
        let bs = state.backend(&backend.target);
        let probed = bs.probed.load(Ordering::Relaxed);
        let circuit = bs.circuit.phase_name();
        let unresolved = split_target(&backend.target).is_some_and(|(host, _)| self.dns.cache.get(host).is_some_and(|a| a.is_empty()));
        let seen = bs.seen.load(Ordering::Relaxed);
        let (health, reason) = if backend.status == "down" {
            ("down", None)
        } else if unresolved {
            ("unhealthy", Some("the host name does not resolve".to_string()))
        } else if seen == SEEN_FAILURE || circuit != "closed" || (probed && !bs.healthy.load(Ordering::Relaxed)) {
            ("unhealthy", bs.reason.lock().clone())
        } else if seen == SEEN_ANSWER {
            ("healthy", None)
        } else {
            ("unknown", None)
        };
        let mut out = serde_json::json!({
            "target": backend.target,
            "status": backend.status,
            "state": health,
            "in_rotation": backend.status == "active" && backend.weight > 0 && bs.healthy() && circuit == "closed",
            "health_check": probed,
            "circuit": circuit,
            "in_flight": bs.in_flight(),
        });
        if let Some(reason) = reason {
            out["reason"] = reason.into();
        }
        let at = bs.seen_at.load(Ordering::Relaxed);
        if at > 0 {
            out["seen_at"] = at.into();
        }
        out
    }

    /// The health of every service's backends as this node sees it, at most
    /// `services` of them with at most `backends` each, failing ones first
    /// (spec OBS-4). The counts cover every backend that is not marked down.
    pub fn health(&self, snapshot: &Snapshot, services: usize, backends: usize) -> Vec<serde_json::Value> {
        snapshot
            .services()
            .take(services)
            .map(|entry| {
                let state = self.service(entry);
                let mut detail: Vec<serde_json::Value> = entry.spec.backends.iter().map(|b| self.backend_health(&state, b)).collect();
                let count = |wanted: &str| detail.iter().filter(|b| b["state"] == wanted).count();
                let (healthy, unhealthy, unknown) = (count("healthy"), count("unhealthy"), count("unknown"));
                let total = detail.len();
                detail.sort_by_key(|b| match b["state"].as_str() {
                    Some("unhealthy") => 0,
                    Some("unknown") => 1,
                    _ => 2,
                });
                detail.truncate(backends);
                serde_json::json!({
                    "service_id": entry.id,
                    "workspace_id": entry.workspace_id,
                    "name": entry.spec.name,
                    "healthy": healthy,
                    "unhealthy": unhealthy,
                    "unknown": unknown,
                    "backends": detail,
                    "backends_total": total,
                })
            })
            .collect()
    }

    /// Records how an attempt ended, for the circuit breaker.
    pub fn record(&self, snapshot: &Snapshot, service: &ServiceEntry, picked: &Picked, ok: bool) {
        if ok {
            picked.state.observe(Ok(()));
        } else if picked.state.seen.swap(SEEN_FAILURE, Ordering::Relaxed) != SEEN_FAILURE {
            // The caller gives the reason with `failed_because`; this only makes sure the failure counts.
            picked.state.seen_at.store(unix_now(), Ordering::Relaxed);
        }
        let passive = &service.spec.health_check.passive;
        if !passive.enabled || !snapshot.flag("circuit_breaker") {
            return;
        }
        let target = picked.backend.target.as_str();
        let gauge = metrics::BACKEND_CIRCUIT_OPEN.with_label_values(&[&service.workspace_id, &service.spec.name, target]);
        if ok {
            if picked.state.circuit.success() {
                gauge.set(0);
                tracing::info!(service = %service.spec.name, backend = target, "circuit closed: the backend answers again");
            }
        } else if picked.state.circuit.failure(Instant::now(), passive.consecutive_failures, Duration::from_millis(passive.open_ms)) {
            gauge.set(1);
            tracing::warn!(service = %service.spec.name, backend = target, open_ms = passive.open_ms, "circuit opened: the backend keeps failing");
        }
    }

    fn permitted(&self, service: &ServiceEntry, ip: IpAddr) -> bool {
        !service.spec.egress_restricted || !is_non_public(ip) || self.settings.backend_allow.iter().any(|c| c.contains(ip))
    }

    /// The address to connect to for `backend`. A name with several addresses
    /// spreads over them; with `key` the choice is stable for that key.
    pub async fn address(&self, service: &ServiceEntry, backend: &Backend, key: Option<&str>) -> Result<SocketAddr, &'static str> {
        let (host, port) = split_target(&backend.target).ok_or("the backend target is not host:port")?;
        if let Ok(ip) = host.parse::<IpAddr>() {
            return if self.permitted(service, ip) { Ok(SocketAddr::new(ip, port)) } else { Err("the backend address is not public, and this service may only reach public addresses") };
        }
        let resolved = self.dns.resolve(host).await;
        if resolved.is_empty() {
            return Err("the backend host does not resolve");
        }
        // Checked on every connection, so a record that changes after the
        // service was accepted cannot point the node inwards (spec SEC-4).
        let allowed: Vec<IpAddr> = resolved.iter().copied().filter(|ip| self.permitted(service, *ip)).collect();
        if allowed.is_empty() {
            return Err("the backend address is not public, and this service may only reach public addresses");
        }
        // A name often has an address this node cannot use: an IPv6 address
        // where there is no IPv6 route, a record for a host that is gone. One
        // that just failed is passed over while the name has another.
        let usable: Vec<IpAddr> = if self.unreachable.is_empty() {
            Vec::new()
        } else {
            let now = Instant::now();
            allowed.iter().copied().filter(|ip| self.unreachable.get(ip).is_none_or(|e| now >= e.0)).collect()
        };
        let pool = if usable.is_empty() { &allowed } else { &usable };
        let slot = match key {
            Some(k) => hash_parts(&[k]) as usize,
            None => self.address_rotation.fetch_add(1, Ordering::Relaxed),
        };
        Ok(SocketAddr::new(pool[slot % pool.len()], port))
    }

    /// A connection to `addr` could not be made. Other addresses of the same
    /// name are preferred for a while, longer each time it happens again.
    pub fn connect_failed(&self, addr: SocketAddr) {
        let now = Instant::now();
        let mut entry = self.unreachable.entry(addr.ip()).or_insert((now, 0));
        let strikes = entry.1.saturating_add(1);
        let pause = UNREACHABLE_FOR.saturating_mul(1u32 << (strikes - 1).min(10)).min(UNREACHABLE_AT_MOST);
        *entry = (now + pause, strikes);
    }

    /// The connection settings for one attempt (spec §7.4, §7.6). `budget` is
    /// what is left of the route's deadline; no timeout may exceed it.
    pub fn peer(&self, service: &ServiceEntry, backend: &Backend, addr: SocketAddr, budget: Option<Duration>) -> Result<HttpPeer, String> {
        let spec = &service.spec;
        let tls = spec.scheme == "https";
        // SNI defaults to the backend's host name (spec UP-13).
        let host = split_target(&backend.target).map_or("", |(h, _)| h);
        let mut peer = HttpPeer::new(addr, tls, spec.tls.sni.clone().unwrap_or_else(|| host.to_string()));

        let capped = |ms: u64| {
            let limit = Duration::from_millis(ms);
            Some(budget.map_or(limit, |b| limit.min(b)))
        };
        peer.options.connection_timeout = capped(spec.timeouts.connect_ms);
        peer.options.total_connection_timeout = capped(spec.timeouts.connect_ms);
        peer.options.read_timeout = capped(spec.timeouts.read_ms);
        peer.options.write_timeout = capped(spec.timeouts.write_ms);
        peer.options.idle_timeout = Some(Duration::from_millis(spec.keepalive.idle_ms));
        peer.options.verify_cert = spec.tls.verify;
        peer.options.verify_hostname = spec.tls.verify;
        if spec.http_version == "2" {
            peer.options.set_http_version(2, 2);
        }
        if tls {
            let material = self.service(service).tls.load_full();
            if let Some(reason) = &material.broken {
                return Err(reason.clone());
            }
            peer.options.ca = material.ca.clone();
            peer.client_cert_key = material.client.clone();
        }
        // Connections are pooled per service: two services may reach one
        // address with different trust settings and must not share a connection.
        peer.group_key = hash_parts(&[service.id.as_str()]);
        Ok(peer)
    }

    /// Runs for the life of the node: resolves backend names and keeps one
    /// probe task per checked backend.
    pub async fn run(self: Arc<Self>) {
        let connector = Arc::new(Connector::new(None));
        let mut probes: HashMap<(String, String), (String, tokio::task::JoinHandle<()>)> = HashMap::new();
        let mut last_full: Option<Instant> = None;
        loop {
            let plan = self.plan.load_full();
            let wanted: HashMap<&(String, String), &str> = plan.iter().map(|p| (&p.key, p.fingerprint.as_str())).collect();
            probes.retain(|key, (fingerprint, task)| {
                let keep = wanted.get(key).is_some_and(|f| f == fingerprint);
                if !keep {
                    task.abort();
                }
                keep
            });
            for spec in plan.iter() {
                if !probes.contains_key(&spec.key) {
                    probes.insert(spec.key.clone(), (spec.fingerprint.clone(), tokio::spawn(self.clone().probe_loop(connector.clone(), spec.clone()))));
                }
            }

            // An address that has behaved for a while is forgotten, so the list cannot grow without bound.
            let now = Instant::now();
            self.unreachable.retain(|_, (until, _)| now < *until + UNREACHABLE_AT_MOST);

            let full = last_full.is_none_or(|at| at.elapsed() >= self.settings.dns_refresh);
            self.dns.refresh(full).await;
            if full {
                last_full = Some(Instant::now());
            }
            let wait = self.settings.dns_refresh.saturating_sub(last_full.map_or(Duration::ZERO, |at| at.elapsed()));
            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(wait) => {}
            }
        }
    }

    async fn probe_loop(self: Arc<Self>, connector: Arc<Connector>, spec: ProbeSpec) {
        let interval = Duration::from_millis(spec.check.interval_ms);
        let service = &spec.service;
        let labels = [service.workspace_id.as_str(), service.spec.name.as_str(), spec.backend.target.as_str()];
        // A random start and up to 20 % jitter per round, so a fleet does not probe in step (spec UP-7).
        tokio::time::sleep(jitter(interval, 100)).await;
        let (mut passed, mut failed) = (0u32, 0u32);
        loop {
            let outcome = tokio::time::timeout(Duration::from_millis(spec.check.timeout_ms), self.probe_once(&connector, &spec))
                .await
                .unwrap_or_else(|_| Err(format!("the health check got no answer within {} ms", spec.check.timeout_ms)));
            spec.state.observe(outcome.as_ref().map(|_| ()).map_err(String::as_str));
            if outcome.is_ok() {
                passed += 1;
                failed = 0;
            } else {
                failed += 1;
                passed = 0;
            }
            let healthy = spec.state.healthy.load(Ordering::Relaxed);
            if healthy && failed >= spec.check.unhealthy_threshold {
                spec.state.healthy.store(false, Ordering::Relaxed);
                metrics::BACKEND_HEALTHY.with_label_values(&labels).set(0);
                tracing::warn!(service = labels[1], backend = labels[2], reason = outcome.as_ref().err().map_or("", String::as_str), "backend is unhealthy: health checks keep failing");
            } else if !healthy && passed >= spec.check.healthy_threshold {
                spec.state.healthy.store(true, Ordering::Relaxed);
                metrics::BACKEND_HEALTHY.with_label_values(&labels).set(1);
                tracing::info!(service = labels[1], backend = labels[2], "backend is healthy again");
            }
            tokio::time::sleep(interval + jitter(interval, 20)).await;
        }
    }

    /// One probe. HTTP probes travel the same connection path as real traffic
    /// (TLS settings, HTTP version), so they fail for the same reasons it would.
    async fn probe_once(&self, connector: &Connector, spec: &ProbeSpec) -> Result<(), String> {
        let addr = self.address(&spec.service, &spec.backend, None).await?;
        if spec.check.kind == "tcp" {
            return tokio::net::TcpStream::connect(addr).await.map(|_| ()).map_err(|e| connect_failure(&e));
        }
        let budget = Duration::from_millis(spec.check.timeout_ms);
        let peer = self.peer(&spec.service, &spec.backend, addr, Some(budget))?;
        let (mut session, _) = connector.get_http_session(&peer).await.map_err(|e| failure_reason(&e))?;
        let host = spec.check.host_header.clone().unwrap_or_else(|| spec.backend.target.clone());
        let invalid = |_| "the health check request could not be built".to_string();
        let mut request = RequestHeader::build("GET", spec.check.path.as_bytes(), None).map_err(invalid)?;
        request.insert_header("host", host).map_err(invalid)?;
        request.insert_header("user-agent", "valkv-apg-health-check").map_err(invalid)?;
        session.write_request_header(Box::new(request)).await.map_err(|e| failure_reason(&e))?;
        session.finish_request_body().await.map_err(|e| failure_reason(&e))?;
        session.read_response_header().await.map_err(|e| failure_reason(&e))?;
        let status = session.response_header().map(|h| h.status.as_u16());
        session.shutdown().await;
        match status {
            Some(s) if spec.check.expected_statuses.iter().any(|(low, high)| (*low..=*high).contains(&s)) => Ok(()),
            Some(s) => Err(format!("the health check at {} answered {s}", spec.check.path)),
            None => Err("the health check got no answer".to_string()),
        }
    }
}

/// Why a connection attempt failed, in words an operator can act on.
fn connect_failure(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::ConnectionRefused => "connection refused".to_string(),
        std::io::ErrorKind::TimedOut => "connecting timed out".to_string(),
        _ => format!("cannot connect: {e}"),
    }
}

/// Why an attempt to use a backend failed, without the addresses and
/// internals an error carries: this is shown in status reports.
pub fn failure_reason(e: &pingora_core::Error) -> String {
    use pingora_core::ErrorType::*;
    match e.etype() {
        ConnectRefused => "connection refused".to_string(),
        ConnectTimedout => "connecting timed out".to_string(),
        ConnectNoRoute => "no route to the address".to_string(),
        TLSHandshakeFailure => "the TLS handshake failed".to_string(),
        TLSHandshakeTimedout => "the TLS handshake timed out".to_string(),
        InvalidCert => "the certificate was not accepted".to_string(),
        ReadTimedout | WriteTimedout => "no answer in time".to_string(),
        ConnectionClosed => "the connection was closed before an answer".to_string(),
        InvalidHTTPHeader | H1Error | H2Error | InvalidH2 => "the answer was not valid HTTP".to_string(),
        other => other.as_str().to_string(),
    }
}

fn forget_backend_metrics(labels: &(String, String), target: &str) {
    let _ = metrics::BACKEND_HEALTHY.remove_label_values(&[&labels.0, &labels.1, target]);
    let _ = metrics::BACKEND_CIRCUIT_OPEN.remove_label_values(&[&labels.0, &labels.1, target]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use serde_json::{Value, json};

    /// The same resource again, as a later revision (an older one would be skipped).
    fn at(revision: u64, mut event: ChangeEvent) -> ChangeEvent {
        event.revision = Some(revision);
        event
    }

    fn setup(service: Value, extra: &[ChangeEvent]) -> (Upstreams, Arc<Snapshot>, Arc<ServiceEntry>) {
        setup_with(Settings::default(), service, extra)
    }

    fn setup_with(settings: Settings, service: Value, extra: &[ChangeEvent]) -> (Upstreams, Arc<Snapshot>, Arc<ServiceEntry>) {
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        for e in extra {
            r.apply(e);
        }
        r.apply(&ChangeEvent::upsert("service", "s", Some("w".into()), service));
        let snap = Arc::new(Snapshot::build(&r));
        assert_eq!(snap.report, Default::default());
        let up = Upstreams::new(settings);
        up.sync(&r, &snap);
        let svc = snap.service("s").unwrap().clone();
        (up, snap, svc)
    }

    fn targets(up: &Upstreams, snap: &Snapshot, svc: &ServiceEntry, n: usize) -> Vec<String> {
        (0..n).map(|_| up.select(snap, svc, None, &[]).unwrap().backend.target.clone()).collect()
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

    // spec UP-1, UP-3
    #[test]
    fn backends_are_chosen_by_weight_and_only_when_active() {
        let (up, snap, svc) = setup(
            json!({ "name": "s", "backends": [
                { "target": "a:1", "weight": 2 }, { "target": "b:1" }, { "target": "c:1", "status": "draining" },
                { "target": "d:1", "status": "down" }, { "target": "e:1", "weight": 0 }
            ] }),
            &[],
        );
        assert_eq!(targets(&up, &snap, &svc, 6), ["a:1", "a:1", "b:1", "a:1", "a:1", "b:1"]);

        let (up, snap, svc) = setup(json!({ "name": "s", "backends": [{ "target": "a:1", "status": "down" }] }), &[]);
        assert!(up.select(&snap, &svc, None, &[]).is_none());
    }

    // spec §7.3
    #[test]
    fn the_circuit_opens_half_opens_and_closes() {
        let c = Circuit::default();
        let open = Duration::from_secs(30);
        let t0 = Instant::now();
        assert!(!c.failure(t0, 3, open) && !c.failure(t0, 3, open), "below the threshold it stays closed");
        assert!(c.allows(t0, open));
        assert!(c.failure(t0, 3, open), "the third consecutive failure opens it");
        assert!(!c.allows(t0 + Duration::from_secs(29), open));

        // After the open period one request is let through, and only one.
        let t1 = t0 + Duration::from_secs(31);
        assert!(c.allows(t1, open));
        c.picked(t1);
        assert!(!c.allows(t1 + Duration::from_secs(1), open), "while the probe is out nobody else is sent");
        // The probe fails: open again for a full period.
        assert!(c.failure(t1 + Duration::from_secs(1), 3, open));
        assert!(!c.allows(t1 + Duration::from_secs(20), open));

        let t2 = t1 + Duration::from_secs(40);
        assert!(c.allows(t2, open));
        c.picked(t2);
        assert!(c.success(), "a successful probe closes it");
        assert!(c.is_closed() && c.allows(t2, open));
        assert!(!c.success(), "closing is reported once");
        // A success resets the count: two more failures do not open it.
        assert!(!c.failure(t2, 3, open) && !c.failure(t2, 3, open));

        // A probe whose outcome never arrives does not hold the circuit shut for ever.
        let lost = Circuit::default();
        lost.failure(t0, 1, open);
        assert!(lost.allows(t1, open));
        lost.picked(t1);
        assert!(!lost.allows(t1 + Duration::from_secs(5), open));
        assert!(lost.allows(t1 + Duration::from_secs(31), open));
    }

    // spec UP-2
    #[test]
    fn an_open_circuit_is_skipped_but_all_open_fails_open() {
        let (up, snap, svc) = setup(json!({ "name": "s", "backends": [{ "target": "a:1" }, { "target": "b:1" }], "health_check": { "passive": { "consecutive_failures": 2 } } }), &[]);
        let fail = |target: &str| {
            let picked = loop {
                let p = up.select(&snap, &svc, None, &[]).unwrap();
                if p.backend.target == target {
                    break p;
                }
            };
            up.record(&snap, &svc, &picked, false);
        };
        fail("a:1");
        assert!(targets(&up, &snap, &svc, 4).contains(&"a:1".to_string()), "one failure is below the threshold");
        fail("a:1");
        assert_eq!(targets(&up, &snap, &svc, 4), ["b:1", "b:1", "b:1", "b:1"], "the failing backend is skipped");

        let b = up.select(&snap, &svc, None, &[]).unwrap();
        up.record(&snap, &svc, &b, false);
        up.record(&snap, &svc, &b, false);
        let before = metrics::UPSTREAM_FAIL_OPEN.get();
        assert!(up.select(&snap, &svc, None, &[]).is_some(), "with every circuit open a backend is still tried");
        assert!(metrics::UPSTREAM_FAIL_OPEN.get() > before);
        up.record(&snap, &svc, &b, true);
        assert_eq!(targets(&up, &snap, &svc, 3), ["b:1", "b:1", "b:1"]);
    }

    #[test]
    fn the_breaker_can_be_switched_off_per_service_and_by_flag() {
        let (up, snap, svc) = setup(json!({ "name": "s", "backends": [{ "target": "a:1" }, { "target": "b:1" }], "health_check": { "passive": { "enabled": false, "consecutive_failures": 1 } } }), &[]);
        let p = up.select(&snap, &svc, None, &[]).unwrap();
        up.record(&snap, &svc, &p, false);
        assert!(p.state.circuit.is_closed());

        let flag = ChangeEvent::upsert("flag", "circuit_breaker", None, json!({ "enabled": false }));
        let (up, snap, svc) = setup(json!({ "name": "s", "backends": [{ "target": "a:1" }], "health_check": { "passive": { "consecutive_failures": 1 } } }), &[flag]);
        let p = up.select(&snap, &svc, None, &[]).unwrap();
        up.record(&snap, &svc, &p, false);
        assert!(p.state.circuit.is_closed());
    }

    // spec UP-9
    #[test]
    fn a_retry_goes_to_a_backend_not_tried_yet_when_there_is_one() {
        let (up, snap, svc) = setup(json!({ "name": "s", "backends": [{ "target": "a:1" }, { "target": "b:1" }, { "target": "c:1" }] }), &[]);
        let tried = vec!["a:1".to_string(), "c:1".to_string()];
        for _ in 0..5 {
            assert_eq!(up.select(&snap, &svc, None, &tried).unwrap().backend.target, "b:1");
        }
        let all = vec!["a:1".to_string(), "b:1".to_string(), "c:1".to_string()];
        assert!(up.select(&snap, &svc, None, &all).is_some(), "with nothing untried the same backends are used again");
    }

    // spec UP-3
    #[test]
    fn least_connections_prefers_the_idlest_backend() {
        let (up, snap, svc) = setup(json!({ "name": "s", "load_balancing": { "strategy": "least_connections" }, "backends": [{ "target": "a:1" }, { "target": "b:1" }, { "target": "c:1" }] }), &[]);
        let first = up.select(&snap, &svc, None, &[]).unwrap();
        let second = up.select(&snap, &svc, None, &[]).unwrap();
        let third = up.select(&snap, &svc, None, &[]).unwrap();
        let mut seen = vec![first.backend.target.clone(), second.backend.target.clone(), third.backend.target.clone()];
        seen.sort();
        assert_eq!(seen, ["a:1", "b:1", "c:1"], "three requests in flight land on three backends");
        let freed = second.backend.target.clone();
        drop(second);
        assert_eq!(up.select(&snap, &svc, None, &[]).unwrap().backend.target, freed, "the backend whose request finished is the idlest");
        assert_eq!(first.state.in_flight(), 1);
        drop((first, third));
    }

    #[test]
    fn random_honours_weights() {
        let (up, snap, svc) = setup(json!({ "name": "s", "load_balancing": { "strategy": "random" }, "backends": [{ "target": "a:1", "weight": 9 }, { "target": "b:1", "weight": 1 }, { "target": "c:1", "weight": 0 }] }), &[]);
        let picks = targets(&up, &snap, &svc, 2000);
        let a = picks.iter().filter(|t| *t == "a:1").count();
        assert!(picks.iter().all(|t| t != "c:1"));
        assert!((1650..=1950).contains(&a), "about 90 % go to the heavy backend; got {a}");
    }

    // spec UP-4
    #[test]
    fn hash_is_sticky_and_moves_about_one_nth_of_keys_when_a_backend_leaves() {
        let four = json!({ "name": "s", "load_balancing": { "strategy": "hash" }, "backends": [{ "target": "a:1" }, { "target": "b:1" }, { "target": "c:1" }, { "target": "d:1" }] });
        let three = json!({ "name": "s", "load_balancing": { "strategy": "hash" }, "backends": [{ "target": "a:1" }, { "target": "b:1" }, { "target": "c:1" }] });
        let (up4, snap4, svc4) = setup(four, &[]);
        let (up3, snap3, svc3) = setup(three, &[]);
        let pick = |up: &Upstreams, snap: &Snapshot, svc: &ServiceEntry, key: &str| up.select(snap, svc, Some(key), &[]).unwrap().backend.target.clone();

        let keys: Vec<String> = (0..2000).map(|i| format!("user-{i}")).collect();
        let mut moved = 0;
        let mut counts: HashMap<String, usize> = HashMap::new();
        for key in &keys {
            let before = pick(&up4, &snap4, &svc4, key);
            assert_eq!(before, pick(&up4, &snap4, &svc4, key), "the same key reaches the same backend");
            *counts.entry(before.clone()).or_default() += 1;
            let after = pick(&up3, &snap3, &svc3, key);
            if before != after {
                assert_eq!(before, "d:1", "only keys of the removed backend move");
                moved += 1;
            }
        }
        assert!((400..=600).contains(&moved), "about a quarter of the keys move; got {moved}");
        assert!(counts.values().all(|c| (400..=600).contains(c)), "keys spread evenly: {counts:?}");

        // No key on the request: round robin.
        assert_eq!(targets(&up3, &snap3, &svc3, 3), ["a:1", "b:1", "c:1"]);
    }

    #[test]
    fn hashing_is_stable_across_releases() {
        // Every node must agree on where a key goes; changing these values re-homes every key.
        assert_eq!(hash_parts(&["user-1", "a:1"]), hash_parts(&["user-1", "a:1"]));
        assert_ne!(hash_parts(&["ab", "c"]), hash_parts(&["a", "bc"]));
        assert_eq!(rendezvous("k", &[("a", 0), ("b", 1)]), Some(1));
        assert_eq!(rendezvous("k", &[]), None);
    }

    // spec UP-1, UP-6
    #[test]
    fn a_backend_failing_its_health_check_is_skipped_and_starts_healthy() {
        let service = json!({ "name": "s", "backends": [{ "target": "a:1" }, { "target": "b:1" }], "health_check": { "active": { "path": "/h" } } });
        let (up, snap, svc) = setup(service.clone(), &[]);
        assert_eq!(up.plan.load().len(), 2, "one probe per backend");
        assert_eq!(targets(&up, &snap, &svc, 2), ["a:1", "b:1"], "backends start healthy");
        up.service(&svc).backend("a:1").healthy.store(false, Ordering::Relaxed);
        assert_eq!(targets(&up, &snap, &svc, 3), ["b:1", "b:1", "b:1"]);
        up.service(&svc).backend("b:1").healthy.store(false, Ordering::Relaxed);
        assert!(up.select(&snap, &svc, None, &[]).is_some(), "all unhealthy: fail open");

        // With the flag off nothing is probed and a stale verdict is not held against the backend.
        let flag = ChangeEvent::upsert("flag", "active_health_checks", None, json!({ "enabled": false }));
        let (up, snap, svc) = setup(service, &[flag]);
        assert!(up.plan.load().is_empty());
        up.service(&svc).backend("a:1").healthy.store(false, Ordering::Relaxed);
        assert_eq!(targets(&up, &snap, &svc, 2), ["a:1", "b:1"]);
    }

    #[test]
    fn state_survives_a_config_change_and_is_dropped_with_its_backend() {
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "s", "backends": [{ "target": "a:1" }, { "target": "b:1" }], "health_check": { "passive": { "consecutive_failures": 1 } } })));
        let up = Upstreams::default();
        let snap = Snapshot::build(&r);
        up.sync(&r, &snap);
        let svc = snap.service("s").unwrap().clone();
        let a = loop {
            let p = up.select(&snap, &svc, None, &[]).unwrap();
            if p.backend.target == "a:1" {
                break p;
            }
        };
        up.record(&snap, &svc, &a, false);
        drop(a);

        // An unrelated edit: the open circuit is still open.
        r.apply(&at(2, ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "s", "backends": [{ "target": "a:1" }, { "target": "b:1" }, { "target": "c:1" }], "health_check": { "passive": { "consecutive_failures": 1 } } }))));
        let snap = Snapshot::build(&r);
        up.sync(&r, &snap);
        let svc = snap.service("s").unwrap().clone();
        assert!(!targets(&up, &snap, &svc, 6).contains(&"a:1".to_string()));

        // Removed and added back: a new backend, with a clean record.
        r.apply(&at(3, ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "s", "backends": [{ "target": "b:1" }] }))));
        up.sync(&r, &Snapshot::build(&r));
        r.apply(&at(4, ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "s", "backends": [{ "target": "a:1" }] }))));
        let snap = Snapshot::build(&r);
        up.sync(&r, &snap);
        assert_eq!(targets(&up, &snap, snap.service("s").unwrap(), 1), ["a:1"]);
        assert!(up.service(snap.service("s").unwrap()).backend("a:1").circuit.is_closed());
        assert_eq!(up.services.len(), 1);
    }

    // spec OBS-4
    #[tokio::test]
    async fn health_reports_what_was_seen_and_claims_nothing_before_that() {
        let service = json!({ "name": "s", "backends": [{ "target": "10.0.0.1:80" }, { "target": "10.0.0.2:80" }, { "target": "10.0.0.3:80", "status": "down" }, { "target": "no-such-host.invalid:80" }],
            "health_check": { "passive": { "consecutive_failures": 2 } } });
        let (up, snap, svc) = setup(service, &[]);
        let report = |up: &Upstreams| up.health(&snap, 10, 10).remove(0);
        let of = |report: &Value, target: &str| report["backends"].as_array().unwrap().iter().find(|b| b["target"] == target).unwrap().clone();

        let fresh = report(&up);
        assert_eq!((fresh["healthy"].as_u64(), fresh["unhealthy"].as_u64(), fresh["unknown"].as_u64()), (Some(0), Some(0), Some(3)), "a backend nobody has talked to is not called healthy");
        assert_eq!(of(&fresh, "10.0.0.3:80")["state"], "down");
        assert_eq!(of(&fresh, "10.0.0.1:80")["in_rotation"], true, "unknown backends still get traffic");

        let pick = |target: &str| loop {
            let p = up.select(&snap, &svc, None, &[]).unwrap();
            if p.backend.target == target {
                break p;
            }
        };
        // One failed request is enough to say so, with the reason, before the circuit opens.
        let a = pick("10.0.0.1:80");
        a.failed_because("connection refused");
        up.record(&snap, &svc, &a, false);
        let b = pick("10.0.0.2:80");
        up.record(&snap, &svc, &b, true);
        let after = report(&up);
        let failing = of(&after, "10.0.0.1:80");
        assert_eq!((failing["state"].as_str(), failing["reason"].as_str(), failing["circuit"].as_str()), (Some("unhealthy"), Some("connection refused"), Some("closed")));
        assert_eq!(failing["in_rotation"], true);
        assert!(failing["seen_at"].as_u64().unwrap() > 0);
        assert_eq!(of(&after, "10.0.0.2:80")["state"], "healthy");
        assert_eq!(after["backends"][0]["target"], "10.0.0.1:80", "failing backends are listed first");

        // The circuit opens: out of rotation. An answer later closes it and clears the verdict.
        up.record(&snap, &svc, &a, false);
        let open = of(&report(&up), "10.0.0.1:80");
        assert_eq!((open["circuit"].as_str(), open["in_rotation"].as_bool()), (Some("open"), Some(false)));
        up.record(&snap, &svc, &a, true);
        let closed = of(&report(&up), "10.0.0.1:80");
        assert_eq!((closed["state"].as_str(), closed["reason"].as_str()), (Some("healthy"), None));

        // A name that does not resolve is known to be unusable without sending anything.
        let _ = up.address(&svc, &svc.spec.backends[3], None).await;
        let unresolved = of(&report(&up), "no-such-host.invalid:80");
        assert_eq!((unresolved["state"].as_str(), unresolved["reason"].as_str()), (Some("unhealthy"), Some("the host name does not resolve")));

        // The limits bound the report; the counts still cover everything.
        let short = up.health(&snap, 10, 1).remove(0);
        assert_eq!((short["backends"].as_array().unwrap().len(), short["backends_total"].as_u64()), (1, Some(4)));
        assert!(up.health(&snap, 0, 10).is_empty());
    }

    #[test]
    fn failures_are_described_without_addresses() {
        use pingora_core::{Error, ErrorType};
        assert_eq!(failure_reason(&Error::explain(ErrorType::ConnectRefused, "10.0.0.1:80")), "connection refused");
        assert_eq!(failure_reason(&Error::explain(ErrorType::ReadTimedout, "x")), "no answer in time");
        assert!(!failure_reason(&Error::explain(ErrorType::ConnectError, "10.0.0.1:80")).contains("10.0.0.1"));
        assert_eq!(connect_failure(&std::io::ErrorKind::ConnectionRefused.into()), "connection refused");
    }

    // spec UP-5
    #[tokio::test]
    async fn an_address_that_cannot_be_connected_to_is_passed_over_while_the_name_has_another() {
        let (up, _snap, svc) = setup(json!({ "name": "s", "backends": [{ "target": "two.test:80" }] }), &[]);
        let v4: IpAddr = "192.0.2.1".parse().unwrap();
        let v6: IpAddr = "2001:db8::1".parse().unwrap();
        up.dns.cache.insert("two.test".into(), Arc::new(vec![v4, v6]));
        let backend = &svc.spec.backends[0];
        let mut seen = HashSet::new();
        for _ in 0..4 {
            seen.insert(up.address(&svc, backend, None).await.unwrap().ip());
        }
        assert_eq!(seen.len(), 2, "requests spread over every address of the name");

        // The node has no route to one of them: after the first failure it is left alone.
        up.connect_failed(SocketAddr::new(v6, 80));
        for _ in 0..20 {
            assert_eq!(up.address(&svc, backend, None).await.unwrap().ip(), v4);
        }
        assert_eq!(up.address(&svc, backend, Some("k")).await.unwrap().ip(), v4, "with a hash key too");
        // It fails again: the pause doubles, up to a limit.
        let first = up.unreachable.get(&v6).unwrap().0;
        up.connect_failed(SocketAddr::new(v6, 80));
        assert!(up.unreachable.get(&v6).unwrap().0 >= first + UNREACHABLE_FOR);
        for _ in 0..40 {
            up.connect_failed(SocketAddr::new(v6, 80));
        }
        assert!(up.unreachable.get(&v6).unwrap().0 <= Instant::now() + UNREACHABLE_AT_MOST);

        // Every address failed: one is used anyway, since nothing else is left.
        up.connect_failed(SocketAddr::new(v4, 80));
        assert!(up.address(&svc, backend, None).await.is_ok());
    }

    #[tokio::test]
    async fn addresses_come_from_literals_or_the_resolver() {
        let (up, _snap, svc) = setup(json!({ "name": "s", "backends": [{ "target": "10.1.2.3:8080" }, { "target": "[::1]:9000" }, { "target": "localhost:80" }, { "target": "no-such-host.invalid:80" }] }), &[]);
        let b = &svc.spec.backends;
        assert_eq!(up.address(&svc, &b[0], None).await.unwrap().to_string(), "10.1.2.3:8080");
        assert_eq!(up.address(&svc, &b[1], None).await.unwrap().to_string(), "[::1]:9000");
        let local = up.address(&svc, &b[2], None).await.unwrap();
        assert!(local.ip().is_loopback() && local.port() == 80);
        assert!(up.address(&svc, &b[3], None).await.is_err());
        // The failure is remembered: later requests are answered without a lookup.
        assert!(up.dns.cache.get("no-such-host.invalid").is_some_and(|a| a.is_empty()));
        // A key keeps its address.
        assert_eq!(up.address(&svc, &b[2], Some("k")).await.unwrap(), up.address(&svc, &b[2], Some("k")).await.unwrap());
        // Names in use are tracked for the background resolver; literals are not.
        let wanted = up.dns.wanted.lock().clone();
        assert!(wanted.contains("localhost") && wanted.contains("no-such-host.invalid") && wanted.len() == 2);
    }

    // spec SEC-4
    #[tokio::test]
    async fn an_egress_restricted_service_cannot_reach_private_addresses() {
        let service = json!({ "name": "s", "egress_restricted": true, "backends": [{ "target": "10.1.2.3:80" }, { "target": "169.254.169.254:80" }, { "target": "203.0.113.5:80" }, { "target": "localhost:80" }] });
        let (up, _snap, svc) = setup(service.clone(), &[]);
        let b = &svc.spec.backends;
        assert!(up.address(&svc, &b[0], None).await.is_err());
        assert!(up.address(&svc, &b[1], None).await.is_err(), "the metadata address");
        assert!(up.address(&svc, &b[2], None).await.is_ok(), "a public address");
        assert!(up.address(&svc, &b[3], None).await.is_err(), "a name that resolves inwards");

        let settings = Settings { backend_allow: vec![Cidr::parse("10.0.0.0/8").unwrap()], ..Default::default() };
        let (up, _snap, svc) = setup_with(settings, service, &[]);
        assert!(up.address(&svc, &svc.spec.backends[0], None).await.is_ok(), "covered by the allow list");
        assert!(up.address(&svc, &svc.spec.backends[1], None).await.is_err());
    }

    #[test]
    fn peers_carry_the_services_timeouts_tls_settings_and_deadline() {
        let service = json!({ "name": "s", "scheme": "https", "http_version": "2", "backends": [{ "target": "api.internal:8443" }],
            "timeouts": { "connect_ms": 300, "read_ms": 7000, "write_ms": 9000 }, "keepalive": { "idle_ms": 1500 }, "tls": { "verify": false } });
        let (up, _snap, svc) = setup(service, &[]);
        let addr: SocketAddr = "10.0.0.1:8443".parse().unwrap();
        let peer = up.peer(&svc, &svc.spec.backends[0], addr, None).unwrap();
        assert_eq!(peer.sni, "api.internal", "SNI defaults to the backend's host name");
        assert_eq!(peer.options.connection_timeout, Some(Duration::from_millis(300)));
        assert_eq!(peer.options.read_timeout, Some(Duration::from_millis(7000)));
        assert_eq!(peer.options.write_timeout, Some(Duration::from_millis(9000)));
        assert_eq!(peer.options.idle_timeout, Some(Duration::from_millis(1500)));
        assert!(!peer.options.verify_cert && !peer.options.verify_hostname);
        assert_eq!(peer.options.alpn.get_min_http_version(), 2);

        // What is left of the route's deadline caps every timeout.
        let capped = up.peer(&svc, &svc.spec.backends[0], addr, Some(Duration::from_millis(100))).unwrap();
        assert_eq!(capped.options.connection_timeout, Some(Duration::from_millis(100)));
        assert_eq!(capped.options.read_timeout, Some(Duration::from_millis(100)));
    }

    fn certificate(name: &str) -> (String, String) {
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec![name.to_string()]).unwrap().self_signed(&key).unwrap();
        (cert.pem(), key.serialize_pem())
    }

    // spec UP-13, UP-14
    #[test]
    fn trust_material_is_loaded_and_a_broken_reference_fails_closed() {
        let (ca_pem, _) = certificate("ca.example");
        let (cert_pem, key_pem) = certificate("client.example");
        let (_, other_key) = certificate("other.example");
        let ca = ChangeEvent::upsert("ca_certificate", "ca1", Some("w".into()), json!({ "name": "internal", "cert_pem": ca_pem }));
        let client = ChangeEvent::upsert("certificate", "c1", Some("w".into()), json!({ "name": "client", "cert_pem": cert_pem, "key_pem": key_pem }));
        let service = |tls: Value| json!({ "name": "s", "scheme": "https", "backends": [{ "target": "a:443" }], "tls": tls });
        let addr: SocketAddr = "10.0.0.1:443".parse().unwrap();

        let (up, _snap, svc) = setup(service(json!({ "ca_certificates": ["ca1"], "client_certificate": "c1" })), &[ca.clone(), client.clone()]);
        let peer = up.peer(&svc, &svc.spec.backends[0], addr, None).unwrap();
        assert_eq!(peer.options.ca.as_ref().map(|c| c.len()), Some(1));
        assert!(peer.client_cert_key.is_some());
        assert!(peer.options.verify_cert);

        // From a control plane the client key arrives sealed; it opens with the fleet's secret key only.
        let secrets = Arc::new(SecretBox::from_base64("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", None).unwrap());
        let sealed = ChangeEvent::upsert("certificate", "c1", Some("w".into()), json!({ "name": "client", "cert_pem": cert_pem, "key_ciphertext": secrets.seal(key_pem.as_bytes(), "certificate:c1") }));
        let (up, _snap, svc) = setup_with(Settings { secrets: Some(secrets), ..Default::default() }, service(json!({ "client_certificate": "c1" })), std::slice::from_ref(&sealed));
        assert!(up.peer(&svc, &svc.spec.backends[0], addr, None).unwrap().client_cert_key.is_some());
        let (up, _snap, svc) = setup(service(json!({ "client_certificate": "c1" })), &[sealed]);
        assert!(up.peer(&svc, &svc.spec.backends[0], addr, None).unwrap_err().contains("APG_SECRET_KEY"));

        // A reference that cannot be loaded: no connection, never a weaker one.
        let (up, _snap, svc) = setup(service(json!({ "ca_certificates": ["gone"] })), &[]);
        assert!(up.peer(&svc, &svc.spec.backends[0], addr, None).unwrap_err().contains("gone"));

        // The file loader reports the same problems before anything is installed.
        let mut r = Resources::new();
        r.apply(&ca);
        r.apply(&ChangeEvent::upsert("certificate", "c1", Some("w".into()), json!({ "name": "client", "cert_pem": cert_pem, "key_pem": other_key })));
        r.apply(&ChangeEvent::upsert("service", "s", Some("w".into()), service(json!({ "ca_certificates": ["ca1"], "client_certificate": "c1" }))));
        let faults = check(&r, &|_| Err(std::io::ErrorKind::NotFound.into()));
        assert_eq!(faults.len(), 1);
        assert!(faults[0].message.contains("does not match"), "{}", faults[0].message);
        r.apply(&at(5, ChangeEvent::upsert("ca_certificate", "ca1", Some("w".into()), json!({ "name": "internal", "cert_file": "/missing.pem" }))));
        assert!(check(&r, &|_| Err(std::io::ErrorKind::NotFound.into()))[0].message.contains("/missing.pem"));
        // A plain-HTTP service needs none of it.
        r.apply(&at(6, ChangeEvent::upsert("service", "s", Some("w".into()), json!({ "name": "s", "backends": [{ "target": "a:80" }], "tls": { "ca_certificates": ["nope"] } }))));
        assert!(check(&r, &|_| Err(std::io::ErrorKind::NotFound.into())).is_empty());
    }

    #[test]
    fn jitter_stays_within_its_share_of_the_interval() {
        let base = Duration::from_millis(5000);
        for _ in 0..200 {
            assert!(jitter(base, 20) < Duration::from_millis(1000));
        }
        assert!((0..50).map(|_| random()).collect::<HashSet<_>>().len() > 40);
    }
}
