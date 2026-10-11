//! The JSON Schemas in `schemas/`, compiled into the binary.
//!
//! The same files are loaded by the admin, so the node in file mode and the
//! admin in database mode accept and reject exactly the same documents.

use std::collections::HashMap;

use serde_json::Value;

const BASE: &str = "https://valkv-apg.dev/schemas/";

macro_rules! schema_files {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_str!(concat!("../../../schemas/", $path)))),*]
    };
}

/// Every schema file. Adding a file to `schemas/` means adding it here.
const FILES: &[(&str, &str)] = schema_files![
    "common.json",
    "apg-config.json",
    "changelog-event.json",
    "resources/workspace.json",
    "resources/domain.json",
    "resources/certificate.json",
    "resources/ca-certificate.json",
    "resources/service.json",
    "resources/route.json",
    "resources/plugin.json",
    "resources/consumer.json",
    "resources/credential.json",
    "resources/wasm-module.json",
    "resources/flag.json",
    "resources/settings.json",
    "plugins/rate_limit.json",
    "plugins/bandwidth_limit.json",
    "plugins/key_auth.json",
    "plugins/basic_auth.json",
    "plugins/jwt_auth.json",
    "plugins/acl.json",
    "plugins/ip_restriction.json",
    "plugins/request_size_limit.json",
    "plugins/cors.json",
    "plugins/quota.json",
    "plugins/redirect.json",
    "plugins/static_response.json",
    "plugins/request_transformer.json",
    "plugins/response_transformer.json",
    "plugins/compression.json",
    "plugins/access_log.json",
];

/// One validation fault, located by JSON pointer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub pointer: String,
    pub message: String,
}

impl Fault {
    pub fn new(pointer: impl Into<String>, message: impl Into<String>) -> Self {
        Self { pointer: pointer.into(), message: message.into() }
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.pointer, self.message)
    }
}

/// Compiled validators, addressed by path relative to `schemas/`.
pub struct Schemas {
    validators: HashMap<&'static str, jsonschema::Validator>,
}

impl Schemas {
    /// Compiles every schema. Fails only if the files shipped in the binary are broken.
    pub fn load() -> anyhow::Result<Self> {
        let mut docs: Vec<(&'static str, Value)> = Vec::new();
        for (path, text) in FILES {
            let value: Value = serde_json::from_str(text).map_err(|e| anyhow::anyhow!("schema {path} is not JSON: {e}"))?;
            docs.push((path, value));
        }
        // Every file is registered under its $id so `$ref`s between files resolve
        // without any network access.
        let mut builder = jsonschema::Registry::new();
        for (path, value) in &docs {
            builder = builder.add(format!("{BASE}{path}"), value).map_err(|e| anyhow::anyhow!("schema {path} cannot be registered: {e}"))?;
        }
        let registry = builder.prepare().map_err(|e| anyhow::anyhow!("schemas do not link: {e}"))?;
        let mut validators = HashMap::new();
        for (path, schema) in &docs {
            let validator = jsonschema::options()
                .with_registry(&registry)
                .build(schema)
                .map_err(|e| anyhow::anyhow!("schema {path} does not compile: {e}"))?;
            validators.insert(*path, validator);
        }
        Ok(Self { validators })
    }

    /// True when a schema with this path exists.
    pub fn has(&self, path: &str) -> bool {
        self.validators.contains_key(path)
    }

    /// Paths of every schema.
    pub fn list(&self) -> Vec<&'static str> {
        let mut v: Vec<_> = self.validators.keys().copied().collect();
        v.sort_unstable();
        v
    }

    /// Validates a value. An empty result means valid.
    pub fn validate(&self, path: &str, value: &Value) -> Vec<Fault> {
        let Some(validator) = self.validators.get(path) else {
            return vec![Fault::new("/", format!("unknown schema '{path}'"))];
        };
        validator
            .iter_errors(value)
            .map(|e| {
                let pointer = e.instance_path().to_string();
                Fault::new(if pointer.is_empty() { "/".to_string() } else { pointer }, e.to_string())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_shipped_schema_compiles_including_cross_file_references() {
        let s = Schemas::load().unwrap();
        assert_eq!(s.list().len(), FILES.len());
        assert!(s.has("resources/route.json"));
        assert!(!s.has("resources/nope.json"));
    }

    #[test]
    fn reports_faults_with_pointers() {
        let s = Schemas::load().unwrap();
        assert!(s.validate("plugins/rate_limit.json", &json!({ "per_second": 5 })).is_empty());
        let faults = s.validate("plugins/rate_limit.json", &json!({ "per_sec": 5 }));
        assert_eq!(faults.len(), 1);
        assert!(faults[0].message.contains("per_sec"), "{}", faults[0].message);
        let faults = s.validate("resources/service.json", &json!({ "name": "s", "backends": [{ "target": "no-port" }] }));
        assert!(faults.iter().any(|f| f.pointer == "/backends/0/target"), "{faults:?}");
    }

    // The same fixtures the admin's test suite runs (spec DEC-5): both sides must agree.
    #[test]
    fn shared_config_fixtures() {
        let s = Schemas::load().unwrap();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/config");
        for name in ["minimal.yaml", "full.yaml"] {
            let text = std::fs::read_to_string(format!("{dir}/valid/{name}")).unwrap();
            let doc: Value = serde_yaml::from_str(&text).unwrap();
            assert_eq!(s.validate("apg-config.json", &doc), vec![], "{name}");
        }
        let cases: Vec<Value> = serde_yaml::from_str(&std::fs::read_to_string(format!("{dir}/invalid/cases.yaml")).unwrap()).unwrap();
        assert!(cases.len() >= 16);
        for case in cases {
            let (name, pointer) = (case["name"].as_str().unwrap(), case["pointer"].as_str().unwrap());
            let faults = s.validate("apg-config.json", &case["doc"]);
            assert!(!faults.is_empty(), "'{name}' was accepted");
            let under = |p: &str| p == pointer || pointer == "/" || p.starts_with(&format!("{pointer}/"));
            assert!(faults.iter().any(|f| under(&f.pointer)), "'{name}': no fault at or under {pointer}: {faults:?}");
        }
    }

    #[test]
    fn shared_event_fixtures() {
        let s = Schemas::load().unwrap();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/events/cases.yaml");
        let cases: Vec<Value> = serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(cases.len() >= 14);
        for case in cases {
            let valid = s.validate("changelog-event.json", &case["event"]).is_empty();
            assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}", case["name"]);
        }
    }
}
