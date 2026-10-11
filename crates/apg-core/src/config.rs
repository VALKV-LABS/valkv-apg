//! `apg.yaml` to changelog events (spec §14.1).
//!
//! File mode compiles its documents into the same events a control plane
//! would send, then feeds them to the same apply path. That is what keeps the
//! three modes behaving identically (spec ARC-1).
//!
//! Nothing here reads a file or an environment variable itself: the caller
//! passes the text and a lookup function.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::model::ChangeEvent;
use crate::schema::{Fault, Schemas};
use crate::snapshot::anchored;
use crate::template::Template;

/// Plugin types this build can enforce. A document that uses any other type is
/// rejected: accepting configuration nothing enforces is the failure this
/// project exists to avoid (spec property 5).
pub const ENFORCED_PLUGIN_TYPES: &[&str] = &["rate_limit", "bandwidth_limit", "key_auth", "basic_auth", "jwt_auth", "acl", "ip_restriction", "request_size_limit", "cors"];

/// Replaces `${VAR}` and `${VAR:-default}`. An unset variable with no default
/// is an error (spec DEC-2), reported with the line it is on.
pub fn substitute_env(source: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<String, Vec<Fault>> {
    let mut out = String::with_capacity(source.len());
    let mut faults = Vec::new();
    let mut rest = source;
    let mut consumed = 0usize;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        let valid_name = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_name {
            // Not a variable reference (for example a literal "${" in a body); leave it as written.
            out.push_str(&rest[start..start + 2 + end + 1]);
        } else {
            match env(name).filter(|v| !v.is_empty()).or_else(|| default.map(str::to_string)) {
                Some(v) => out.push_str(&v),
                None => {
                    let line = source[..consumed + start].matches('\n').count() + 1;
                    faults.push(Fault::new("/", format!("line {line}: environment variable {name} is not set and has no default")));
                }
            }
        }
        let step = start + 2 + end + 1;
        consumed += step;
        rest = &rest[step..];
    }
    out.push_str(rest);
    if faults.is_empty() { Ok(out) } else { Err(faults) }
}

const LIST_SECTIONS: &[&str] = &["domains", "certificates", "ca_certificates", "services", "routes", "consumers", "plugins", "workspaces"];

/// Parses several YAML documents and merges them into one (spec DEC-3).
/// List sections are concatenated; `settings` and `flags` are merged key by key.
pub fn parse_and_merge(sources: &[(String, String)]) -> Result<Value, Vec<Fault>> {
    let mut merged = Map::new();
    let mut faults = Vec::new();
    for (name, text) in sources {
        let doc: Value = match serde_yaml::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                faults.push(Fault::new("/", format!("{name}: not valid YAML: {e}")));
                continue;
            }
        };
        let Value::Object(obj) = doc else {
            faults.push(Fault::new("/", format!("{name}: the document must be a mapping")));
            continue;
        };
        for (key, value) in obj {
            match merged.get_mut(&key) {
                None => {
                    merged.insert(key, value);
                }
                Some(Value::Array(have)) if LIST_SECTIONS.contains(&key.as_str()) => match value {
                    Value::Array(more) => have.extend(more),
                    _ => faults.push(Fault::new(format!("/{key}"), format!("{name}: must be a list"))),
                },
                Some(Value::Object(have)) if key == "settings" || key == "flags" => match value {
                    Value::Object(more) => {
                        for (k, v) in more {
                            if have.insert(k.clone(), v).is_some() {
                                faults.push(Fault::new(format!("/{key}/{k}"), format!("{name}: defined in more than one file")));
                            }
                        }
                    }
                    _ => faults.push(Fault::new(format!("/{key}"), format!("{name}: must be a mapping"))),
                },
                Some(have) if *have == value => {}
                Some(_) => faults.push(Fault::new(format!("/{key}"), format!("{name}: conflicts with another file"))),
            }
        }
    }
    if faults.is_empty() { Ok(Value::Object(merged)) } else { Err(faults) }
}

/// A stable id for a resource defined by name in a file. The same document
/// always yields the same ids, so reloading an unchanged file changes nothing.
pub fn stable_id(kind: &str, workspace: &str, name: &str) -> String {
    let digest = Sha256::digest(format!("{kind}\u{0}{workspace}\u{0}{name}").as_bytes());
    let h = hex::encode(&digest[..16]);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

struct WorkspaceDoc<'a> {
    name: String,
    system: bool,
    /// JSON pointer prefix of this workspace's sections ("" for top level).
    at: String,
    body: &'a Map<String, Value>,
}

struct Compiler<'a> {
    schemas: &'a Schemas,
    faults: Vec<Fault>,
    events: Vec<ChangeEvent>,
}

/// Compiles a merged document into events, in dependency order.
///
/// Returns every fault found, not just the first, each with a JSON pointer.
pub fn compile(doc: &Value, schemas: &Schemas) -> Result<Vec<ChangeEvent>, Vec<Fault>> {
    let schema_faults = schemas.validate("apg-config.json", doc);
    if !schema_faults.is_empty() {
        return Err(schema_faults);
    }
    let root = doc.as_object().expect("validated as an object");
    let mut c = Compiler { schemas, faults: Vec::new(), events: Vec::new() };

    // Settings and flags are global.
    let mut base_domains: Vec<String> = Vec::new();
    if let Some(settings) = root.get("settings").and_then(Value::as_object) {
        c.refuse_unbuilt(settings, &unbuilt().settings, "/settings");
        c.refuse_unbuilt(settings, &unbuilt().settings_file_mode, "/settings");
        for (name, value) in settings {
            if name == "workspace_base_domains" {
                base_domains = value.as_array().into_iter().flatten().filter_map(|b| b["domain"].as_str().map(str::to_string)).collect();
            }
            if name == "error_responses" {
                c.check_error_responses(value, "/settings/error_responses");
            }
            c.events.push(ChangeEvent::upsert("setting", name.clone(), None, json!({ "value": value })));
        }
    }
    if let Some(flags) = root.get("flags").and_then(Value::as_object) {
        for (name, enabled) in flags {
            let f = c.schemas.validate("resources/flag.json", &json!({ "name": name, "enabled": enabled }));
            if !f.is_empty() {
                c.faults.push(Fault::new(format!("/flags/{name}"), "unknown flag"));
            }
            c.events.push(ChangeEvent::upsert("flag", name.clone(), None, json!({ "enabled": enabled })));
        }
    }

    // The top level is one workspace; `workspaces:` lists more.
    let top_name = root.get("workspace").and_then(Value::as_str).unwrap_or("default").to_string();
    let mut docs = vec![WorkspaceDoc { system: top_name == "default", name: top_name, at: String::new(), body: root }];
    if let Some(list) = root.get("workspaces").and_then(Value::as_array) {
        for (i, w) in list.iter().enumerate() {
            let body = w.as_object().expect("validated");
            let name = body["name"].as_str().expect("validated").to_string();
            docs.push(WorkspaceDoc { system: name == "default", name, at: format!("/workspaces/{i}"), body });
        }
    }
    let mut seen = HashSet::new();
    for d in &docs {
        if !seen.insert(d.name.clone()) {
            c.faults.push(Fault::new(format!("{}/name", d.at), format!("workspace '{}' is defined more than once", d.name)));
        }
    }
    // The system workspace always exists.
    if !docs.iter().any(|d| d.system) {
        c.events.push(ChangeEvent::upsert("workspace", stable_id("workspace", "", "default"), None, json!({ "name": "default", "slug": "default", "system": true, "status": "active" })));
    }
    for d in &docs {
        let slug = d.body.get("slug").and_then(Value::as_str).unwrap_or(&d.name).to_string();
        let status = d.body.get("status").and_then(Value::as_str).unwrap_or("active");
        c.events.push(ChangeEvent::upsert(
            "workspace",
            stable_id("workspace", "", &d.name),
            None,
            json!({ "name": d.name, "slug": slug, "system": d.system, "status": status, "labels": d.body.get("labels").cloned().unwrap_or(json!({})) }),
        ));
    }

    // Shared services of the system workspace are visible to every workspace,
    // so collect them before compiling any route.
    let shared: HashMap<String, String> = docs
        .iter()
        .filter(|d| d.system)
        .flat_map(|d| d.body.get("services").and_then(Value::as_array).into_iter().flatten())
        .filter(|s| s["shared"].as_bool() == Some(true))
        .filter_map(|s| s["name"].as_str())
        .map(|n| (n.to_string(), stable_id("service", "default", n)))
        .collect();

    // Emit kind by kind across workspaces, so everything referenced comes first.
    let mut per_ws: Vec<Names> = docs.iter().map(|_| Names::default()).collect();
    for (d, names) in docs.iter().zip(per_ws.iter_mut()) {
        c.certificates(d, names);
    }
    for (d, names) in docs.iter().zip(per_ws.iter_mut()) {
        c.domains(d, names, &base_domains);
    }
    for (d, names) in docs.iter().zip(per_ws.iter_mut()) {
        c.services(d, names);
    }
    for (d, names) in docs.iter().zip(per_ws.iter_mut()) {
        c.routes(d, names, &shared, &base_domains);
    }
    for (d, names) in docs.iter().zip(per_ws.iter_mut()) {
        c.consumers(d, names);
    }
    for (d, names) in docs.iter().zip(per_ws.iter()) {
        c.plugins(d, names, &docs);
    }

    if c.faults.is_empty() { Ok(c.events) } else { Err(c.faults) }
}

#[derive(Default)]
struct Names {
    certificates: HashMap<String, String>,
    ca_certificates: HashMap<String, String>,
    services: HashMap<String, String>,
    routes: HashMap<String, String>,
    consumers: HashMap<String, String>,
    /// Hostnames this workspace owns through its domains.
    hosts: Vec<String>,
    /// Plugins written under a route or service, to be emitted with the rest.
    nested_plugins: Vec<(String, Value, String, String)>,
}

fn items<'a>(d: &'a WorkspaceDoc<'_>, section: &str) -> impl Iterator<Item = (usize, &'a Map<String, Value>)> {
    d.body.get(section).and_then(Value::as_array).into_iter().flatten().enumerate().filter_map(|(i, v)| v.as_object().map(|o| (i, o)))
}

fn host_covered(pattern: &str, host: &str) -> bool {
    if pattern == host {
        return true;
    }
    match (pattern.strip_prefix('*'), host.starts_with("*.")) {
        (Some(suffix), false) => host.strip_suffix(suffix).is_some_and(|label| !label.is_empty() && !label.contains('.')),
        _ => false,
    }
}

/// One key the schemas define that the node does not enforce yet.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct UnbuiltKey {
    /// Dotted path inside the resource.
    pub path: String,
    /// The schema default. A document may carry this value; anything else is refused.
    #[serde(default)]
    pub default: Option<Value>,
}

/// `schemas/unbuilt.yaml`: the keys both the file loader and the admin refuse
/// until the node enforces them. See that file for why it exists.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Unbuilt {
    #[serde(default)]
    pub service: Vec<UnbuiltKey>,
    #[serde(default)]
    pub route: Vec<UnbuiltKey>,
    #[serde(default)]
    pub settings: Vec<UnbuiltKey>,
    #[serde(default)]
    pub settings_file_mode: Vec<UnbuiltKey>,
}

/// The parsed list, compiled into the binary.
pub fn unbuilt() -> &'static Unbuilt {
    static LIST: std::sync::OnceLock<Unbuilt> = std::sync::OnceLock::new();
    LIST.get_or_init(|| serde_yaml::from_str(include_str!("../../../schemas/unbuilt.yaml")).expect("schemas/unbuilt.yaml is valid"))
}

/// True when a `{ "$secret": … }` form appears anywhere in a plugin configuration.
fn holds_clear_secret(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.contains_key("$secret") || map.values().any(holds_clear_secret),
        Value::Array(list) => list.iter().any(holds_clear_secret),
        _ => false,
    }
}

const UNBUILT: &str ="is not enforced by this build yet, so it is refused rather than silently ignored";

impl Compiler<'_> {
    fn fault(&mut self, pointer: String, message: impl Into<String>) {
        self.faults.push(Fault::new(pointer, message));
    }

    /// Refuses any listed key the object sets to something other than its default.
    fn refuse_unbuilt(&mut self, obj: &Map<String, Value>, keys: &[UnbuiltKey], at: &str) {
        for key in keys {
            let mut value = None;
            let mut cursor = Some(obj);
            for part in key.path.split('.') {
                value = cursor.and_then(|o| o.get(part));
                cursor = value.and_then(Value::as_object);
            }
            if let Some(v) = value
                && key.default.as_ref() != Some(v)
            {
                self.fault(format!("{at}/{}", key.path.replace('.', "/")), format!("'{}' {UNBUILT}", key.path));
            }
        }
    }

    fn ws_id(d: &WorkspaceDoc<'_>) -> String {
        stable_id("workspace", "", &d.name)
    }

    /// Registers a name, reporting a duplicate. Returns the resource's id.
    fn name(&mut self, d: &WorkspaceDoc<'_>, kind: &str, map: &mut HashMap<String, String>, name: &str, pointer: String) -> String {
        let id = stable_id(kind, &d.name, name);
        if map.insert(name.to_string(), id.clone()).is_some() {
            self.fault(pointer, format!("{kind} '{name}' is defined more than once"));
        }
        id
    }

    fn check_error_responses(&mut self, value: &Value, at: &str) {
        for (code, spec) in value.as_object().into_iter().flatten() {
            if let Some(body) = spec.get("body").and_then(Value::as_str)
                && let Err(e) = Template::compile(body)
            {
                self.fault(format!("{at}/{code}/body"), e.to_string());
            }
        }
    }

    fn certificates(&mut self, d: &WorkspaceDoc<'_>, names: &mut Names) {
        for (i, cert) in items(d, "certificates") {
            let name = cert["name"].as_str().unwrap_or_default();
            let id = self.name(d, "certificate", &mut names.certificates, name, format!("{}/certificates/{i}/name", d.at));
            self.events.push(ChangeEvent::upsert("certificate", id, Some(Self::ws_id(d)), Value::Object(cert.clone())));
        }
        for (i, ca) in items(d, "ca_certificates") {
            let name = ca["name"].as_str().unwrap_or_default();
            let id = self.name(d, "ca_certificate", &mut names.ca_certificates, name, format!("{}/ca_certificates/{i}/name", d.at));
            self.events.push(ChangeEvent::upsert("ca_certificate", id, Some(Self::ws_id(d)), Value::Object(ca.clone())));
        }
    }

    fn domains(&mut self, d: &WorkspaceDoc<'_>, names: &mut Names, base_domains: &[String]) {
        for (i, dom) in items(d, "domains") {
            let at = format!("{}/domains/{i}", d.at);
            let hostname = dom["hostname"].as_str().unwrap_or_default().to_string();
            let mode = dom.get("tls").and_then(|t| t.get("mode")).and_then(Value::as_str).unwrap_or("acme");
            let mut tls = json!({ "mode": mode, "challenge": dom.get("tls").and_then(|t| t.get("challenge")).and_then(Value::as_str).unwrap_or("http01") });
            if mode == "manual" {
                let reference = dom["tls"]["certificate"].as_str().unwrap_or_default();
                match names.certificates.get(reference) {
                    Some(id) => tls["certificate"] = json!(id),
                    None => self.fault(format!("{at}/tls/certificate"), format!("certificate '{reference}' is not defined in this workspace")),
                }
            }
            if !d.system && base_domains.iter().any(|b| hostname == *b || hostname.ends_with(&format!(".{b}"))) {
                self.fault(format!("{at}/hostname"), format!("'{hostname}' is inside a base domain and cannot be claimed"));
            }
            names.hosts.push(hostname.clone());
            let name = dom.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| hostname.replacen("*.", "wildcard.", 1));
            // A hostname has one owner across all workspaces, so its id does not include the workspace.
            let id = stable_id("domain", "", &hostname);
            if self.events.iter().any(|e| e.kind == "domain" && e.id == id) {
                self.fault(format!("{at}/hostname"), format!("'{hostname}' is claimed more than once"));
            }
            self.events.push(ChangeEvent::upsert("domain", id, Some(Self::ws_id(d)), json!({ "name": name, "hostname": hostname, "tls": tls, "status": "active" })));
        }
    }

    fn services(&mut self, d: &WorkspaceDoc<'_>, names: &mut Names) {
        for (i, svc) in items(d, "services") {
            let at = format!("{}/services/{i}", d.at);
            let name = svc["name"].as_str().unwrap_or_default();
            let id = self.name(d, "service", &mut names.services, name, format!("{at}/name"));
            if svc.get("shared").and_then(Value::as_bool) == Some(true) && !d.system {
                self.fault(format!("{at}/shared"), "only a service in the system workspace can be shared");
            }
            self.refuse_unbuilt(svc, &unbuilt().service, &at);
            // The node cannot replay a request after the upstream has answered,
            // so retrying on a response status is refused, not ignored.
            for (r_i, on) in svc.get("retries").and_then(|r| r.get("on")).and_then(Value::as_array).into_iter().flatten().enumerate() {
                if on.is_number() {
                    self.fault(format!("{at}/retries/on/{r_i}"), format!("retrying on a response status {UNBUILT}; use connect_failure and timeout"));
                }
            }
            let mut data = svc.clone();
            data.remove("plugins");
            let mut seen = HashSet::new();
            if let Some(Value::Array(backends)) = data.get_mut("backends") {
                for (b_i, b) in backends.iter_mut().enumerate() {
                    let target = b["target"].as_str().unwrap_or_default().to_string();
                    if !seen.insert(target.clone()) {
                        self.faults.push(Fault::new(format!("{at}/backends/{b_i}/target"), format!("duplicate backend '{target}'")));
                    }
                    b["id"] = json!(stable_id("backend", &id, &target));
                }
            }
            if let Some(tls) = data.get_mut("tls").and_then(Value::as_object_mut) {
                if let Some(Value::Array(cas)) = tls.get_mut("ca_certificates") {
                    for (c_i, ca) in cas.iter_mut().enumerate() {
                        let reference = ca.as_str().unwrap_or_default().to_string();
                        match names.ca_certificates.get(&reference) {
                            Some(cid) => *ca = json!(cid),
                            None => self.faults.push(Fault::new(format!("{at}/tls/ca_certificates/{c_i}"), format!("CA certificate '{reference}' is not defined in this workspace"))),
                        }
                    }
                }
                if let Some(reference) = tls.get("client_certificate").and_then(Value::as_str).map(str::to_string) {
                    match names.certificates.get(&reference) {
                        Some(cid) => {
                            tls.insert("client_certificate".into(), json!(cid));
                        }
                        None => self.faults.push(Fault::new(format!("{at}/tls/client_certificate"), format!("certificate '{reference}' is not defined in this workspace"))),
                    }
                }
            }
            for (p_i, p) in svc.get("plugins").and_then(Value::as_array).into_iter().flatten().enumerate() {
                names.nested_plugins.push(("service".into(), p.clone(), id.clone(), format!("{at}/plugins/{p_i}")));
            }
            self.events.push(ChangeEvent::upsert("service", id, Some(Self::ws_id(d)), Value::Object(data)));
        }
    }

    fn routes(&mut self, d: &WorkspaceDoc<'_>, names: &mut Names, shared: &HashMap<String, String>, base_domains: &[String]) {
        let slug = d.body.get("slug").and_then(Value::as_str).unwrap_or(&d.name).to_string();
        let mut owned = names.hosts.clone();
        owned.extend(base_domains.iter().map(|b| format!("{slug}.{b}")));

        for (i, route) in items(d, "routes") {
            let at = format!("{}/routes/{i}", d.at);
            let name = route["name"].as_str().unwrap_or_default();
            let id = self.name(d, "route", &mut names.routes, name, format!("{at}/name"));
            self.refuse_unbuilt(route, &unbuilt().route, &at);
            let mut data = route.clone();
            data.remove("plugins");

            let resolve = |this: &mut Self, reference: &str, pointer: String| -> Value {
                match names.services.get(reference).or_else(|| shared.get(reference)) {
                    Some(sid) => json!(sid),
                    None => {
                        this.fault(pointer, format!("service '{reference}' is not defined in this workspace and is not a shared service"));
                        Value::Null
                    }
                }
            };
            if let Some(reference) = route.get("service").and_then(Value::as_str) {
                let v = resolve(self, reference, format!("{at}/service"));
                data.insert("service".into(), v);
            }
            if let Some(Value::Array(split)) = data.get_mut("split") {
                let mut all_zero = true;
                for (s_i, side) in split.iter_mut().enumerate() {
                    let reference = side["service"].as_str().unwrap_or_default().to_string();
                    side["service"] = resolve(self, &reference, format!("{at}/split/{s_i}/service"));
                    all_zero &= side["weight"].as_u64() == Some(0);
                }
                if all_zero {
                    self.fault(format!("{at}/split"), "at least one side of the split needs a weight above 0");
                }
            }

            let hosts: Vec<&str> = route.get("hosts").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            if !d.system {
                // Host ownership (spec DOM-1), enforced in file mode exactly as the admin enforces it.
                if hosts.is_empty() {
                    self.fault(format!("{at}/hosts"), "a route outside the system workspace must list at least one host");
                }
                for (h_i, h) in hosts.iter().enumerate() {
                    if !owned.iter().any(|o| host_covered(o, h)) {
                        self.fault(format!("{at}/hosts/{h_i}"), format!("'{h}' is not covered by a domain of this workspace"));
                    }
                }
            }

            if let Some(Value::Array(paths)) = data.get_mut("paths") {
                for (p_i, p) in paths.iter_mut().enumerate() {
                    if let Some(s) = p.as_str() {
                        *p = json!({ "type": "prefix", "value": s });
                    }
                    let (kind, value) = (p["type"].as_str().unwrap_or_default(), p["value"].as_str().unwrap_or_default());
                    if kind == "regex" {
                        if anchored(value).is_none() {
                            self.faults.push(Fault::new(format!("{at}/paths/{p_i}/value"), "not a valid regular expression (look-around and back-references are not supported)"));
                        }
                    } else if !value.starts_with('/') {
                        self.faults.push(Fault::new(format!("{at}/paths/{p_i}/value"), "a path must start with '/'"));
                    }
                }
            }
            for section in ["headers", "query"] {
                for (p_i, p) in route.get(section).and_then(Value::as_array).into_iter().flatten().enumerate() {
                    if p["type"].as_str() == Some("regex") && anchored(p["value"].as_str().unwrap_or_default()).is_none() {
                        self.fault(format!("{at}/{section}/{p_i}/value"), "not a valid regular expression");
                    }
                }
            }
            if let Some(pattern) = route.get("rewrite").and_then(|r| r.get("regex")).and_then(Value::as_str)
                && regex::Regex::new(pattern).is_err()
            {
                self.fault(format!("{at}/rewrite/regex"), "not a valid regular expression");
            }
            if let Some(er) = route.get("error_responses") {
                self.check_error_responses(er, &format!("{at}/error_responses"));
            }
            for (p_i, p) in route.get("plugins").and_then(Value::as_array).into_iter().flatten().enumerate() {
                names.nested_plugins.push(("route".into(), p.clone(), id.clone(), format!("{at}/plugins/{p_i}")));
            }
            self.events.push(ChangeEvent::upsert("route", id, Some(Self::ws_id(d)), Value::Object(data)));
        }
    }

    /// A credential from a file. Nodes hold hashes only, so a key or password
    /// written in the file is hashed here; one given as `$env` or `$file` is
    /// passed on for the node to read and hash when it loads the file.
    fn credential(&mut self, d: &WorkspaceDoc<'_>, consumer_id: &str, credential: &Value, at: &str, index: usize) {
        let kind = credential["type"].as_str().unwrap_or_default();
        let name = credential.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("{kind}-{index}"));
        let mut data = json!({ "name": name, "type": kind, "consumer_id": consumer_id, "enabled": credential.get("enabled").and_then(Value::as_bool).unwrap_or(true) });
        if let Some(expires) = credential.get("expires_at") {
            data["expires_at"] = expires.clone();
        }
        let mut secret = |field: &str, hashed: &str, this: &mut Self| match credential.get(field) {
            Some(Value::String(clear)) => data[hashed] = json!(crate::consumers::sha256_hex(clear.as_bytes())),
            Some(Value::Object(form)) if form.contains_key("$secret") => this.fault(format!("{at}/{field}"), "$secret is sealed by a control plane; in a file use $env or $file"),
            Some(reference @ Value::Object(_)) => data[field] = reference.clone(),
            _ => this.fault(format!("{at}/{field}"), format!("{field} is required: a file cannot generate one")),
        };
        match kind {
            "key" => secret("key", "key_hash", self),
            "basic" => {
                secret("password", "password_sha256", self);
                data["username"] = credential.get("username").cloned().unwrap_or_default();
            }
            _ => data["identity"] = credential.get("identity").cloned().unwrap_or_default(),
        }
        let id = stable_id("credential", consumer_id, &name);
        self.events.push(ChangeEvent::upsert("credential", id, Some(Self::ws_id(d)), data));
    }

    fn consumers(&mut self, d: &WorkspaceDoc<'_>, names: &mut Names) {
        for (i, consumer) in items(d, "consumers") {
            let at = format!("{}/consumers/{i}", d.at);
            let name = consumer["name"].as_str().unwrap_or_default();
            let id = self.name(d, "consumer", &mut names.consumers, name, format!("{at}/name"));
            for (c_i, credential) in consumer.get("credentials").and_then(Value::as_array).into_iter().flatten().enumerate() {
                self.credential(d, &id, credential, &format!("{at}/credentials/{c_i}"), c_i);
            }
            let mut data = consumer.clone();
            data.remove("credentials");
            self.events.push(ChangeEvent::upsert("consumer", id, Some(Self::ws_id(d)), Value::Object(data)));
        }
    }

    fn plugins(&mut self, d: &WorkspaceDoc<'_>, names: &Names, all: &[WorkspaceDoc<'_>]) {
        // (plugin document, scope, scope id, pointer)
        let mut list: Vec<(Value, String, Option<String>, String)> = names.nested_plugins.iter().map(|(scope, p, sid, at)| (p.clone(), scope.clone(), Some(sid.clone()), at.clone())).collect();
        for (i, p) in items(d, "plugins") {
            let at = format!("{}/plugins/{i}", d.at);
            let scope = p["scope"].as_str().unwrap_or_default().to_string();
            let scope_id = match scope.as_str() {
                "service" | "route" => {
                    let reference = p.get("scope_ref").and_then(Value::as_str).unwrap_or_default();
                    let map = if scope == "service" { &names.services } else { &names.routes };
                    match map.get(reference) {
                        Some(id) => Some(id.clone()),
                        None => {
                            self.fault(format!("{at}/scope_ref"), format!("{scope} '{reference}' is not defined in this workspace"));
                            continue;
                        }
                    }
                }
                _ => None,
            };
            list.push((Value::Object(p.clone()), scope, scope_id, at));
        }

        let mut attachments: BTreeMap<String, String> = BTreeMap::new();
        for (p, scope, scope_id, at) in list {
            let kind = p["type"].as_str().unwrap_or_default().to_string();
            if !ENFORCED_PLUGIN_TYPES.contains(&kind.as_str()) {
                self.fault(format!("{at}/type"), format!("plugin type '{kind}' is not available in this build"));
                continue;
            }
            if scope == "global" && !d.system {
                self.fault(format!("{at}/scope"), "a global plugin belongs to the system workspace");
            }
            let config = p.get("config").cloned().unwrap_or_else(|| json!({}));
            for f in self.schemas.validate(&format!("plugins/{kind}.json"), &config) {
                let suffix = if f.pointer == "/" { String::new() } else { f.pointer };
                self.faults.push(Fault::new(format!("{at}/config{suffix}"), f.message));
            }
            if holds_clear_secret(&config) {
                // Only a control plane can seal a value; a node given `$secret` from a file could not open it.
                self.fault(format!("{at}/config"), "$secret is for the Admin API; in a file give the value as $env or $file");
            }
            let consumer_id = match p.get("consumer").and_then(Value::as_str) {
                None => None,
                Some(reference) => match names.consumers.get(reference) {
                    Some(id) => Some(id.clone()),
                    None => {
                        self.fault(format!("{at}/consumer"), format!("consumer '{reference}' is not defined in this workspace"));
                        None
                    }
                },
            };
            let target_workspace = match p.get("target_workspace").and_then(Value::as_str) {
                None => None,
                Some(reference) => {
                    if !d.system {
                        self.fault(format!("{at}/target_workspace"), "only a plugin in the system workspace can target another workspace");
                    }
                    match all.iter().find(|w| w.name == reference) {
                        Some(w) => Some(Self::ws_id(w)),
                        None => {
                            self.fault(format!("{at}/target_workspace"), format!("workspace '{reference}' is not defined"));
                            None
                        }
                    }
                }
            };
            // One instance per type at each exact attachment point (spec PL-1).
            let attachment = format!("{kind}|{scope}|{}|{}|{}", scope_id.as_deref().unwrap_or(""), consumer_id.as_deref().unwrap_or(""), target_workspace.as_deref().unwrap_or(""));
            if let Some(first) = attachments.insert(attachment.clone(), at.clone()) {
                self.fault(at.clone(), format!("a {kind} plugin is already attached at exactly this scope (see {first})"));
            }
            let id = stable_id("plugin", &d.name, &attachment);
            self.events.push(ChangeEvent::upsert(
                "plugin",
                id,
                Some(Self::ws_id(d)),
                json!({
                    "type": kind,
                    "scope": scope,
                    "service_id": (scope == "service").then(|| scope_id.clone()).flatten(),
                    "route_id": (scope == "route").then(|| scope_id.clone()).flatten(),
                    "consumer_id": consumer_id,
                    "target_workspace": target_workspace,
                    "enabled": p.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                    "priority": p.get("priority").cloned().unwrap_or(Value::Null),
                    "config": config,
                }),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::Resources;
    use crate::snapshot::{Request, Snapshot};

    fn schemas() -> Schemas {
        Schemas::load().unwrap()
    }

    fn compile_yaml(yaml: &str) -> Result<Vec<ChangeEvent>, Vec<Fault>> {
        let doc = parse_and_merge(&[("test.yaml".into(), yaml.into())])?;
        compile(&doc, &schemas())
    }

    fn pointers(r: Result<Vec<ChangeEvent>, Vec<Fault>>) -> Vec<String> {
        r.err().unwrap_or_default().into_iter().map(|f| f.pointer).collect()
    }

    const QUICKSTART: &str = r#"
version: 1
services:
  - name: echo
    backends: [{ target: "echo:8080" }, { target: "echo-b:8080", weight: 2 }]
routes:
  - name: everything
    service: echo
    paths: [/api]
    strip_path: true
    plugins:
      - type: rate_limit
        config: { per_second: 5, burst: 10, scope: ip }
"#;

    #[test]
    fn a_document_compiles_to_events_a_snapshot_can_route_with() {
        let events = compile_yaml(QUICKSTART).unwrap();
        assert_eq!(events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["workspace", "service", "route", "plugin"]);
        let mut r = Resources::new();
        for e in &events {
            assert_eq!(r.apply(e), crate::resources::Applied::Changed);
        }
        let snap = Snapshot::build(&r);
        assert_eq!(snap.report, Default::default());
        let m = snap.match_request(&Request { host: "any.host", path: "/api/x", method: "GET", query: "", header: &|_| None }).unwrap();
        assert_eq!(m.route.name, "everything");
        assert_eq!(m.matched_prefix.as_deref(), Some("/api"));
        let svc = snap.service(&m.route.targets[0].0).unwrap();
        assert_eq!(svc.spec.backends.iter().map(|b| (b.target.as_str(), b.weight)).collect::<Vec<_>>(), [("echo:8080", 1), ("echo-b:8080", 2)]);
        assert!(!svc.spec.backends[0].id.is_empty());
        let site = crate::plugins::Site { route_id: &m.route.id, service_id: &svc.id, workspace_id: &m.workspace_id, consumer_id: None };
        assert_eq!(snap.plugins.effective("rate_limit", &site).unwrap().plugin.config["per_second"], 5);
    }

    #[test]
    fn the_same_document_always_compiles_to_the_same_events() {
        assert_eq!(compile_yaml(QUICKSTART).unwrap(), compile_yaml(QUICKSTART).unwrap());
        assert_eq!(stable_id("route", "default", "a"), stable_id("route", "default", "a"));
        assert_ne!(stable_id("route", "default", "a"), stable_id("route", "other", "a"));
        assert_ne!(stable_id("route", "default", "a"), stable_id("service", "default", "a"));
    }

    #[test]
    fn schema_faults_are_reported_with_pointers_and_nothing_compiles() {
        let p = pointers(compile_yaml("version: 1\nroutes:\n  - name: r\n    service: s\n    strip_prefix: true\n"));
        assert!(p.iter().any(|x| x.starts_with("/routes/0")), "{p:?}");
        assert!(!pointers(compile_yaml("routes: []")).is_empty()); // no version
    }

    #[test]
    fn references_must_resolve() {
        assert_eq!(pointers(compile_yaml("version: 1\nroutes:\n  - { name: r, service: missing }\n")), ["/routes/0/service"]);
        let p = pointers(compile_yaml("version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }] }\nplugins:\n  - { type: rate_limit, scope: route, scope_ref: nope }\n"));
        assert_eq!(p, ["/plugins/0/scope_ref"]);
    }

    #[test]
    fn duplicates_are_errors() {
        let dup = "version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }, { target: 'a:1' }] }\n  - { name: s, backends: [{ target: 'b:1' }] }\n";
        let p = pointers(compile_yaml(dup));
        assert!(p.contains(&"/services/0/backends/1/target".to_string()) && p.contains(&"/services/1/name".to_string()), "{p:?}");
        let two = "version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }] }\nroutes:\n  - name: r\n    service: s\n    plugins: [{ type: rate_limit }, { type: rate_limit }]\n";
        assert_eq!(pointers(compile_yaml(two)), ["/routes/0/plugins/1"]);
    }

    // spec property 5: what this build cannot enforce is refused, with a pointer.
    #[test]
    fn features_this_build_cannot_enforce_are_refused_not_ignored() {
        let base = "version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }] }\n";
        assert_eq!(pointers(compile_yaml(&format!("{base}routes:\n  - name: r\n    service: s\n    plugins: [{{ type: wasm, config: {{ module: m }} }}]\n"))), ["/routes/0/plugins/0/type"]);
        // A domain defaults to an ACME certificate, which the node now obtains itself.
        assert!(compile_yaml(&format!("{base}domains:\n  - hostname: a.example.com\n")).is_ok());
        // A file cannot generate a key, and cannot hold a secret only a control plane can open.
        assert_eq!(pointers(compile_yaml(&format!("{base}consumers:\n  - name: c\n    credentials: [{{ type: key }}]\n"))), ["/consumers/0/credentials/0/key"]);
        assert_eq!(
            pointers(compile_yaml(&format!("{base}consumers:\n  - name: c\n    credentials: [{{ type: key, key: {{ $secret: abcdefghijklmnopqrstuvwxyz }} }}]\n"))),
            ["/consumers/0/credentials/0/key"]
        );
    }

    // spec CON-4
    #[test]
    fn credentials_in_a_file_become_hashes_and_never_travel_in_clear() {
        let doc = "version: 1\nconsumers:\n  - name: app\n    groups: [partners]\n    credentials:\n      - { type: key, key: apg_k_0123456789abcdef }\n      - { type: basic, username: app, password: correct-horse }\n      - { type: mtls, identity: client.example.com }\n      - { type: key, name: from-env, key: { $env: APG_SECRET_APP_KEY } }\n";
        let events = compile_yaml(doc).unwrap();
        let text = serde_json::to_string(&events).unwrap();
        assert!(!text.contains("apg_k_0123456789abcdef") && !text.contains("correct-horse"));
        let consumer = events.iter().find(|e| e.kind == "consumer").unwrap();
        assert!(consumer.data.as_ref().unwrap().get("credentials").is_none());
        let creds: Vec<&Value> = events.iter().filter(|e| e.kind == "credential").map(|e| e.data.as_ref().unwrap()).collect();
        assert_eq!(creds.len(), 4);
        assert!(creds.iter().all(|c| c["consumer_id"] == consumer.id.as_str()));
        assert_eq!(creds[0]["key_hash"], crate::consumers::sha256_hex(b"apg_k_0123456789abcdef"));
        assert_eq!(creds[1]["password_sha256"], crate::consumers::sha256_hex(b"correct-horse"));
        assert_eq!((creds[1]["username"].as_str(), creds[2]["identity"].as_str()), (Some("app"), Some("client.example.com")));
        // A reference is passed on for the node to read; it is not a secret itself.
        assert_eq!(creds[3]["key"], json!({ "$env": "APG_SECRET_APP_KEY" }));
        // Ids are stable across reloads.
        let again = compile_yaml(doc).unwrap();
        assert_eq!(events.iter().map(|e| &e.id).collect::<Vec<_>>(), again.iter().map(|e| &e.id).collect::<Vec<_>>());
    }

    #[test]
    fn other_refusals_stay_in_place() {
        let base = "version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }] }\n";
        assert_eq!(pointers(compile_yaml(&format!("{base}plugins:\n  - {{ type: rate_limit, scope: workspace, config: {{ per_sec: 1 }} }}\n"))), ["/plugins/0/config"]);
        assert_eq!(pointers(compile_yaml(&format!("{base}flags: {{ make_it_fast: true }}\n"))), ["/flags/make_it_fast"]);
    }

    // Schema-valid keys that nothing enforces yet must be refused too, each with its own pointer.
    #[test]
    fn schema_valid_keys_with_no_implementation_are_refused() {
        let svc = |extra: &str| format!("version: 1\nservices:\n  - name: s\n    backends: [{{ target: 'a:1' }}]\n    {extra}\n");
        assert_eq!(pointers(compile_yaml(&svc("drain_timeout_ms: 5000"))), ["/services/0/drain_timeout_ms"]);
        assert_eq!(pointers(compile_yaml(&svc("keepalive: { max_idle_per_backend: 8 }"))), ["/services/0/keepalive/max_idle_per_backend"]);
        assert_eq!(pointers(compile_yaml(&svc("retries: { attempts: 2, buffer_bytes: 1024 }"))), ["/services/0/retries/buffer_bytes"]);
        assert_eq!(pointers(compile_yaml(&svc("retries: { attempts: 2, 'on': [connect_failure, 503] }"))), ["/services/0/retries/on/1"]);
        // a key carrying its schema default is what a GET returns, so it is not refused
        assert!(compile_yaml(&svc("drain_timeout_ms: 30000")).is_ok());
        // what IS enforced is accepted
        assert!(compile_yaml(&svc("timeouts: { connect_ms: 100, read_ms: 2000 }\n    retries: { attempts: 2, 'on': [connect_failure, timeout] }")).is_ok());
        assert!(compile_yaml(&svc("health_check: { active: { path: /h, interval_ms: 1000 }, passive: { consecutive_failures: 2 } }")).is_ok());
        assert!(compile_yaml(&svc("load_balancing: { strategy: hash, hash_key: 'header:x-user' }\n    http_version: '2'\n    keepalive: { idle_ms: 5000 }")).is_ok());
        assert!(compile_yaml(&svc("scheme: https\n    tls: { verify: false, sni: internal.example }\n    host_header: backend")).is_ok());

        let route = |extra: &str| format!("version: 1\nservices:\n  - {{ name: s, backends: [{{ target: 'a:1' }}] }}\nroutes:\n  - name: r\n    service: s\n    {extra}\n");
        assert_eq!(pointers(compile_yaml(&route("idle_timeout_ms: 60000"))), ["/routes/0/idle_timeout_ms"]);
        assert!(compile_yaml(&route("timeout_ms: 1000")).is_ok());
        assert!(compile_yaml(&route("strip_path: true\n    rewrite: { prefix: /v2 }\n    methods: [GET]\n    priority: 5")).is_ok());

        // the list itself: every entry names a real schema property
        let schemas: Value = serde_json::from_str(include_str!("../../../schemas/resources/service.json")).unwrap();
        for key in &unbuilt().service {
            let mut node = &schemas;
            for part in key.path.split('.') {
                node = &node["properties"][part];
            }
            assert!(node.is_object(), "unbuilt.yaml names '{}', which is not in service.json", key.path);
            assert_eq!(key.default.as_ref(), node.get("default"), "default of '{}' differs from the schema", key.path);
        }

        assert_eq!(pointers(compile_yaml("version: 1\nsettings: { workspace_resolvers: [host] }\n")), ["/settings/workspace_resolvers"]);
        assert!(compile_yaml("version: 1\nsettings: { identity_headers: false }\n").is_ok());
    }

    const TENANTS: &str = r#"
version: 1
settings:
  workspace_base_domains: [{ domain: gw.example.net }]
services:
  - { name: shared-api, shared: true, backends: [{ target: "10.0.0.1:80" }] }
  - { name: private-api, backends: [{ target: "10.0.0.2:80" }] }
workspaces:
  - name: acme
    domains:
      - { hostname: shop.acme.test, tls: { mode: none } }
    services:
      - { name: app, backends: [{ target: "10.1.0.1:80" }] }
    routes:
      - { name: shop, service: app, hosts: [shop.acme.test] }
      - { name: slug, service: shared-api, hosts: [acme.gw.example.net] }
"#;

    #[test]
    fn workspaces_own_hosts_and_may_use_shared_system_services() {
        let events = compile_yaml(TENANTS).unwrap();
        let mut r = Resources::new();
        for e in &events {
            r.apply(e);
        }
        let snap = Snapshot::build(&r);
        assert_eq!(snap.report, Default::default());
        let find = |host: &str| snap.match_request(&Request { host, path: "/", method: "GET", query: "", header: &|_| None }).map(|m| m.route.name.clone());
        assert_eq!(find("shop.acme.test").as_deref(), Some("shop"));
        assert_eq!(find("acme.gw.example.net").as_deref(), Some("slug"));
        assert_eq!(find("other.test"), None);
    }

    #[test]
    fn file_mode_enforces_host_ownership_like_the_admin_does() {
        let steal = TENANTS.replace("hosts: [shop.acme.test] }", "hosts: [shop.rival.test] }");
        assert_eq!(pointers(compile_yaml(&steal)), ["/workspaces/0/routes/0/hosts/0"]);
        let no_host = TENANTS.replace(", hosts: [shop.acme.test] }", " }");
        assert_eq!(pointers(compile_yaml(&no_host)), ["/workspaces/0/routes/0/hosts"]);
        let private = TENANTS.replace("service: shared-api", "service: private-api");
        assert_eq!(pointers(compile_yaml(&private)), ["/workspaces/0/routes/1/service"]);
        let other_slug = TENANTS.replace("acme.gw.example.net", "rival.gw.example.net");
        assert_eq!(pointers(compile_yaml(&other_slug)), ["/workspaces/0/routes/1/hosts/0"]);
        let claim_base = TENANTS.replace("hostname: shop.acme.test", "hostname: x.gw.example.net");
        assert!(pointers(compile_yaml(&claim_base)).contains(&"/workspaces/0/domains/0/hostname".to_string()));
    }

    #[test]
    fn bad_patterns_and_templates_are_caught_at_load() {
        let base = "version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }] }\nroutes:\n  - name: r\n    service: s\n";
        assert_eq!(pointers(compile_yaml(&format!("{base}    paths: [{{ type: regex, value: '/a(?=b)' }}]\n"))), ["/routes/0/paths/0/value"]);
        assert_eq!(pointers(compile_yaml(&format!("{base}    error_responses: {{ NO_ROUTE: {{ body: '{{{{ nope.x }}}}' }} }}\n"))), ["/routes/0/error_responses/NO_ROUTE/body"]);
    }

    #[test]
    fn env_substitution() {
        let env = |name: &str| (name == "TARGET").then(|| "10.0.0.9:80".to_string());
        assert_eq!(substitute_env("t: ${TARGET}", &env).unwrap(), "t: 10.0.0.9:80");
        assert_eq!(substitute_env("t: ${MISSING:-fallback}", &env).unwrap(), "t: fallback");
        assert_eq!(substitute_env("t: ${TARGET:-fallback}", &env).unwrap(), "t: 10.0.0.9:80");
        assert_eq!(substitute_env("no variables here", &env).unwrap(), "no variables here");
        // a literal that is not a variable name is left alone
        assert_eq!(substitute_env("body: '${not a var}'", &env).unwrap(), "body: '${not a var}'");
        // spec DEC-2: unset with no default is an error, with the line number
        let err = substitute_env("a: 1\nb: ${MISSING}\n", &env).unwrap_err();
        assert!(err[0].message.contains("line 2") && err[0].message.contains("MISSING"), "{}", err[0].message);
    }

    #[test]
    fn several_files_merge_and_conflicts_are_errors() {
        let a = ("a.yaml".to_string(), "version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }] }\nflags: { usage_metering: true }\n".to_string());
        let b = ("b.yaml".to_string(), "version: 1\nroutes:\n  - { name: r, service: s }\nflags: { access_log: false }\n".to_string());
        let merged = parse_and_merge(&[a.clone(), b]).unwrap();
        assert_eq!(compile(&merged, &schemas()).unwrap().len(), 5); // 2 flags, workspace, service, route
        let dup = ("c.yaml".to_string(), "version: 1\nflags: { usage_metering: false }\n".to_string());
        assert_eq!(parse_and_merge(&[a.clone(), dup]).unwrap_err()[0].pointer, "/flags/usage_metering");
        let bad = ("d.yaml".to_string(), "version: 1\nroutes: [unclosed".to_string());
        assert!(parse_and_merge(&[bad]).unwrap_err()[0].message.contains("d.yaml"));
        let other_version = ("e.yaml".to_string(), "version: 2\n".to_string());
        assert_eq!(parse_and_merge(&[a, other_version]).unwrap_err()[0].pointer, "/version");
    }
}
