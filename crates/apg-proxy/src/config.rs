//! Process configuration of the node (spec Appendix B).
//!
//! Read once at start from the environment. Anything malformed fails startup
//! with a message naming the variable: a node that guesses its configuration
//! is worse than one that refuses to boot.

use crate::net::{Cidr, parse_cidr_list};

/// Variables this module reads. A test checks each is listed for the node in
/// `schemas/process-config.yaml`.
pub const READ_VARIABLES: &[&str] = &[
    "APG_CONFIG_SOURCE", "APG_CONFIG_FILE", "APG_NODE_ID", "APG_LISTEN_HTTPS", "APG_LISTEN_HTTP", "APG_LISTEN_MGMT",
    "APG_HTTP_MODE", "APG_TRAFFIC_HEALTH_PATH", "APG_DATA_DIR", "APG_TRUSTED_PROXIES", "APG_REGION",
    "APG_TLS_FALLBACK_CERT", "APG_TLS_FALLBACK_KEY", "APG_LOG_LEVEL", "APG_LOG_FORMAT", "APG_SHUTDOWN_GRACE_SECS",
    "APG_STUB_UPSTREAM", "APG_ALLOW_TEST_MODES", "APG_CONFIG_URL", "APG_ADMIN_URL", "APG_NODE_TOKEN",
    "APG_POLL_INTERVAL_MS", "APG_POLL_LIMIT", "APG_POLL_WAIT_MS", "APG_CONFIG_CLIENT_CERT", "APG_CONFIG_CLIENT_KEY",
    "APG_CONFIG_CLIENT_CA", "APG_DNS_REFRESH_SECS", "APG_BACKEND_ALLOW_CIDRS",
    "APG_SECRET_KEY", "APG_SECRET_KEY_FILE", "APG_SECRET_KEY_PREVIOUS", "APG_TLS_MIN_VERSION", "APG_ACME_EMAIL",
    "APG_ACME_DIRECTORY_URL", "APG_ACME_DNS_PROVIDER", "APG_ACME_DNS_WEBHOOK_URL", "APG_ACME_DNS_WEBHOOK_SECRET",
    "APG_ACME_DNS_PROPAGATION_SECS", "APG_ACME_INSECURE_DIRECTORY", "APG_TEMPLATE_ENV_ALLOW", "APG_CACHE_MEMORY_BYTES",
];

/// Where the node reads configuration from (spec §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigSource {
    File,
    ApiPoll,
}

/// Settings of the `api_poll` source.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiPoll {
    /// Base URL of the config API (spec CFG-12a).
    pub url: String,
    /// Where heartbeats go. Defaults to `url`.
    pub admin_url: String,
    pub token: Option<String>,
    pub interval_ms: u64,
    pub limit: u32,
    pub wait_ms: u64,
    pub client_identity: Option<(String, String)>,
    pub ca_file: Option<String>,
}

/// What the plain-HTTP listener does with requests that are not ACME challenges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMode {
    /// Answer 308 to the HTTPS equivalent.
    Redirect,
    /// Serve traffic in clear, for use behind something that terminates TLS.
    Proxy,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub source: ConfigSource,
    pub config_file: String,
    pub node_id: String,
    /// `None` disables the listener.
    pub listen_https: Option<String>,
    pub listen_http: Option<String>,
    pub listen_mgmt: Option<String>,
    pub http_mode: HttpMode,
    pub traffic_health_path: Option<String>,
    pub data_dir: String,
    pub trusted_proxies: Vec<Cidr>,
    pub region: Option<String>,
    pub tls_fallback: Option<(String, String)>,
    pub log_level: String,
    pub log_json: bool,
    pub shutdown_grace_secs: u64,
    pub stub_upstream: bool,
    /// Present exactly when `source` is `ApiPoll`.
    pub api_poll: Option<ApiPoll>,
    pub upstream: crate::upstream::Settings,
    /// Opens keys sealed by the control plane. `None` when no secret key is configured.
    pub secrets: Option<std::sync::Arc<crate::secrets::SecretBox>>,
    /// Refuse TLS 1.2 clients (spec TLS-2).
    pub tls13_only: bool,
    pub acme: crate::acme::Settings,
    /// Environment variable names templates may read as `env.NAME`.
    pub template_env_allow: Vec<String>,
    /// Memory budget of the response cache.
    pub cache_bytes: usize,
}

impl Config {
    /// Seconds of silence from the config source after which it counts as stale:
    /// at least 30, and comfortably more than one poll cycle (spec CFG-21).
    pub fn stale_after_secs(&self) -> u64 {
        match &self.api_poll {
            Some(p) => 30.max((p.wait_ms * 2 + p.interval_ms * 5).div_ceil(1000)),
            None => 30,
        }
    }
}

type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;

// A variable that is set but empty counts as unset: container tooling passes
// "" for an unset interpolation, and "" is never a usable value here.
fn get(env: Lookup<'_>, key: &str) -> Option<String> {
    env(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn one_of<'a>(key: &str, value: &'a str, allowed: &[&'a str]) -> anyhow::Result<&'a str> {
    allowed.iter().copied().find(|a| a.eq_ignore_ascii_case(value)).ok_or_else(|| anyhow::anyhow!("{key} must be one of {}; got '{value}'", allowed.join(", ")))
}

fn boolean(key: &str, value: &str) -> anyhow::Result<bool> {
    match value {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => anyhow::bail!("{key} must be true or false; got '{other}'"),
    }
}

fn listener(env: Lookup<'_>, key: &str, default: &str) -> anyhow::Result<Option<String>> {
    // Explicitly empty disables the listener; unset uses the default.
    let value = match env(key) {
        Some(v) if v.trim().is_empty() => return Ok(None),
        Some(v) => v.trim().to_string(),
        None => default.to_string(),
    };
    value.parse::<std::net::SocketAddr>().map_err(|_| anyhow::anyhow!("{key} must be address:port; got '{value}'"))?;
    Ok(Some(value))
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(&|k| std::env::var(k).ok(), &|| std::env::var("HOSTNAME").ok())
    }

    /// Builds a configuration from a variable lookup. `hostname` supplies the default node id.
    pub fn from_lookup(env: Lookup<'_>, hostname: &dyn Fn() -> Option<String>) -> anyhow::Result<Self> {
        let source = get(env, "APG_CONFIG_SOURCE").unwrap_or_else(|| "file".into());
        let source = match one_of("APG_CONFIG_SOURCE", &source, &["file", "api_poll", "db_tail"])? {
            "file" => ConfigSource::File,
            "api_poll" => ConfigSource::ApiPoll,
            // Refuse rather than fall back: starting in a mode the operator did not choose
            // is not something to discover from a routing outage.
            other => anyhow::bail!("APG_CONFIG_SOURCE={other} is not available in this build yet; use 'file' or 'api_poll'"),
        };

        let number = |key: &str, default: u64, min: u64, max: u64| -> anyhow::Result<u64> {
            match get(env, key) {
                None => Ok(default),
                Some(v) => v.parse::<u64>().ok().filter(|n| (min..=max).contains(n)).ok_or_else(|| anyhow::anyhow!("{key} must be a whole number from {min} to {max}; got '{v}'")),
            }
        };
        let api_poll = if source == ConfigSource::ApiPoll {
            let url = get(env, "APG_CONFIG_URL").ok_or_else(|| anyhow::anyhow!("APG_CONFIG_URL is required when APG_CONFIG_SOURCE=api_poll"))?;
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                anyhow::bail!("APG_CONFIG_URL must start with http:// or https://; got '{url}'");
            }
            let client_identity = match (get(env, "APG_CONFIG_CLIENT_CERT"), get(env, "APG_CONFIG_CLIENT_KEY")) {
                (Some(c), Some(k)) => Some((c, k)),
                (None, None) => None,
                _ => anyhow::bail!("APG_CONFIG_CLIENT_CERT and APG_CONFIG_CLIENT_KEY must be set together"),
            };
            Some(ApiPoll {
                admin_url: get(env, "APG_ADMIN_URL").unwrap_or_else(|| url.clone()),
                url,
                token: get(env, "APG_NODE_TOKEN"),
                interval_ms: number("APG_POLL_INTERVAL_MS", 1000, 10, 3_600_000)?,
                limit: number("APG_POLL_LIMIT", 500, 1, 1000)? as u32,
                wait_ms: number("APG_POLL_WAIT_MS", 25_000, 0, 55_000)?,
                client_identity,
                ca_file: get(env, "APG_CONFIG_CLIENT_CA"),
            })
        } else {
            None
        };
        // In the database modes the node id names this node to the control plane,
        // so it must be chosen, not guessed: two nodes sharing a guessed id would
        // overwrite each other's status.
        if api_poll.is_some() && get(env, "APG_NODE_ID").is_none() {
            anyhow::bail!("APG_NODE_ID is required when APG_CONFIG_SOURCE=api_poll");
        }

        let http_mode = match one_of("APG_HTTP_MODE", &get(env, "APG_HTTP_MODE").unwrap_or_else(|| "redirect".into()), &["redirect", "proxy"])? {
            "proxy" => HttpMode::Proxy,
            _ => HttpMode::Redirect,
        };

        let traffic_health_path = get(env, "APG_TRAFFIC_HEALTH_PATH");
        if let Some(p) = &traffic_health_path
            && !p.starts_with('/')
        {
            anyhow::bail!("APG_TRAFFIC_HEALTH_PATH must start with '/'; got '{p}'");
        }

        let tls_fallback = match (get(env, "APG_TLS_FALLBACK_CERT"), get(env, "APG_TLS_FALLBACK_KEY")) {
            (Some(c), Some(k)) => Some((c, k)),
            (None, None) => None,
            _ => anyhow::bail!("APG_TLS_FALLBACK_CERT and APG_TLS_FALLBACK_KEY must be set together"),
        };

        let log_level = one_of("APG_LOG_LEVEL", &get(env, "APG_LOG_LEVEL").unwrap_or_else(|| "info".into()), &["trace", "debug", "info", "warn", "error"])?.to_string();
        let log_json = one_of("APG_LOG_FORMAT", &get(env, "APG_LOG_FORMAT").unwrap_or_else(|| "json".into()), &["json", "text"])? == "json";

        let grace = get(env, "APG_SHUTDOWN_GRACE_SECS").unwrap_or_else(|| "30".into());
        let shutdown_grace_secs = grace.parse::<u64>().map_err(|_| anyhow::anyhow!("APG_SHUTDOWN_GRACE_SECS must be a whole number of seconds; got '{grace}'"))?;

        let stub_upstream = boolean("APG_STUB_UPSTREAM", &get(env, "APG_STUB_UPSTREAM").unwrap_or_else(|| "false".into()))?;
        let allow_test = boolean("APG_ALLOW_TEST_MODES", &get(env, "APG_ALLOW_TEST_MODES").unwrap_or_else(|| "false".into()))?;
        if stub_upstream && !allow_test {
            // A node that answers instead of forwarding must never run by accident.
            anyhow::bail!("APG_STUB_UPSTREAM is a test mode; it needs APG_ALLOW_TEST_MODES=true");
        }

        let secret_key = match (get(env, "APG_SECRET_KEY"), get(env, "APG_SECRET_KEY_FILE")) {
            (Some(key), _) => Some(key),
            (None, Some(path)) => Some(std::fs::read_to_string(&path).map_err(|e| anyhow::anyhow!("APG_SECRET_KEY_FILE: cannot read '{path}': {e}"))?),
            (None, None) => None,
        };
        let secrets = match secret_key {
            Some(key) => Some(std::sync::Arc::new(crate::secrets::SecretBox::from_base64(&key, get(env, "APG_SECRET_KEY_PREVIOUS").as_deref())?)),
            None => None,
        };

        let tls13_only = one_of("APG_TLS_MIN_VERSION", &get(env, "APG_TLS_MIN_VERSION").unwrap_or_else(|| "1.2".into()), &["1.2", "1.3"])? == "1.3";

        let directory_url = get(env, "APG_ACME_DIRECTORY_URL").unwrap_or_else(|| crate::acme::LETS_ENCRYPT.to_string());
        if !(directory_url.starts_with("https://") || directory_url.starts_with("http://")) {
            anyhow::bail!("APG_ACME_DIRECTORY_URL must start with https://; got '{directory_url}'");
        }
        let insecure_directory = boolean("APG_ACME_INSECURE_DIRECTORY", &get(env, "APG_ACME_INSECURE_DIRECTORY").unwrap_or_else(|| "false".into()))?;
        if insecure_directory && !allow_test {
            anyhow::bail!("APG_ACME_INSECURE_DIRECTORY is a test mode; it needs APG_ALLOW_TEST_MODES=true");
        }
        let dns_webhook = match get(env, "APG_ACME_DNS_PROVIDER") {
            None => None,
            Some(provider) => match one_of("APG_ACME_DNS_PROVIDER", &provider, &["webhook", "cloudflare", "route53"])? {
                "webhook" => {
                    let url = get(env, "APG_ACME_DNS_WEBHOOK_URL").ok_or_else(|| anyhow::anyhow!("APG_ACME_DNS_WEBHOOK_URL is required when APG_ACME_DNS_PROVIDER=webhook"))?;
                    if !(url.starts_with("https://") || url.starts_with("http://")) {
                        anyhow::bail!("APG_ACME_DNS_WEBHOOK_URL must start with http:// or https://; got '{url}'");
                    }
                    Some(crate::acme::DnsWebhook {
                        url,
                        secret: get(env, "APG_ACME_DNS_WEBHOOK_SECRET"),
                        propagation: std::time::Duration::from_secs(number("APG_ACME_DNS_PROPAGATION_SECS", 30, 0, 600)?),
                    })
                }
                // Refused rather than accepted and ignored: a wildcard certificate that never arrives is hard to trace back to this line.
                other => anyhow::bail!("APG_ACME_DNS_PROVIDER={other} is not available in this build yet; use 'webhook'"),
            },
        };
        let acme = crate::acme::Settings { email: get(env, "APG_ACME_EMAIL"), directory_url, insecure_directory, dns_webhook };

        let listen_https = listener(env, "APG_LISTEN_HTTPS", "0.0.0.0:8443")?;
        let listen_http = listener(env, "APG_LISTEN_HTTP", "0.0.0.0:8080")?;
        if listen_https.is_none() && listen_http.is_none() {
            anyhow::bail!("both APG_LISTEN_HTTPS and APG_LISTEN_HTTP are disabled; the node would serve nothing");
        }

        Ok(Self {
            source,
            config_file: get(env, "APG_CONFIG_FILE").unwrap_or_else(|| "/etc/apg/apg.yaml".into()),
            node_id: get(env, "APG_NODE_ID").or_else(|| hostname().filter(|h| !h.trim().is_empty())).unwrap_or_else(|| "node".into()),
            listen_https,
            listen_http,
            listen_mgmt: listener(env, "APG_LISTEN_MGMT", "127.0.0.1:9100")?,
            http_mode,
            traffic_health_path,
            data_dir: get(env, "APG_DATA_DIR").unwrap_or_else(|| "/var/lib/apg".into()),
            trusted_proxies: parse_cidr_list(&get(env, "APG_TRUSTED_PROXIES").unwrap_or_default()).map_err(|e| anyhow::anyhow!("APG_TRUSTED_PROXIES: {e}"))?,
            region: get(env, "APG_REGION"),
            tls_fallback,
            log_level,
            log_json,
            shutdown_grace_secs,
            stub_upstream,
            api_poll,
            upstream: crate::upstream::Settings {
                dns_refresh: std::time::Duration::from_secs(number("APG_DNS_REFRESH_SECS", 30, 5, 300)?),
                backend_allow: parse_cidr_list(&get(env, "APG_BACKEND_ALLOW_CIDRS").unwrap_or_default()).map_err(|e| anyhow::anyhow!("APG_BACKEND_ALLOW_CIDRS: {e}"))?,
                secrets: secrets.clone(),
            },
            secrets,
            tls13_only,
            acme,
            cache_bytes: number("APG_CACHE_MEMORY_BYTES", 268_435_456, 0, 1 << 40)? as usize,
            template_env_allow: get(env, "APG_TEMPLATE_ENV_ALLOW").unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(vars: &[(&str, &str)]) -> anyhow::Result<Config> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(&|k| map.get(k).cloned(), &|| Some("host-1".into()))
    }

    fn err(vars: &[(&str, &str)]) -> String {
        load(vars).unwrap_err().to_string()
    }

    #[test]
    fn defaults_make_a_standalone_node() {
        let c = load(&[]).unwrap();
        assert_eq!(c.source, ConfigSource::File);
        assert_eq!(c.config_file, "/etc/apg/apg.yaml");
        assert_eq!(c.node_id, "host-1");
        assert_eq!(c.listen_https.as_deref(), Some("0.0.0.0:8443"));
        assert_eq!(c.listen_http.as_deref(), Some("0.0.0.0:8080"));
        // the management listener is not reachable from outside the host by default
        assert_eq!(c.listen_mgmt.as_deref(), Some("127.0.0.1:9100"));
        assert_eq!(c.http_mode, HttpMode::Redirect);
        assert!(c.trusted_proxies.is_empty() && c.traffic_health_path.is_none() && !c.stub_upstream && c.log_json);
        assert_eq!(c.shutdown_grace_secs, 30);
    }

    // A typo must fail loudly, never fall back to a mode the operator did not choose.
    #[test]
    fn unknown_or_unbuilt_sources_refuse_to_start() {
        assert!(err(&[("APG_CONFIG_SOURCE", "tail")]).contains("must be one of"));
        assert!(err(&[("APG_CONFIG_SOURCE", "db_tail")]).contains("not available in this build"));
        assert_eq!(load(&[("APG_CONFIG_SOURCE", "FILE")]).unwrap().source, ConfigSource::File);
    }

    #[test]
    fn api_poll_needs_a_url_and_a_chosen_node_id() {
        let base = [("APG_CONFIG_SOURCE", "api_poll"), ("APG_CONFIG_URL", "http://admin:9000/dp"), ("APG_NODE_ID", "node-a")];
        let c = load(&base).unwrap();
        let p = c.api_poll.clone().unwrap();
        assert_eq!(c.source, ConfigSource::ApiPoll);
        assert_eq!((p.url.as_str(), p.admin_url.as_str(), p.interval_ms, p.limit, p.wait_ms), ("http://admin:9000/dp", "http://admin:9000/dp", 1000, 500, 25_000));
        assert!(p.token.is_none() && p.client_identity.is_none());
        // long polling: silence up to the wait is normal, so the stale threshold must exceed it
        assert!(c.stale_after_secs() > 25);
        assert_eq!(load(&[]).unwrap().stale_after_secs(), 30);

        assert!(err(&[("APG_CONFIG_SOURCE", "api_poll"), ("APG_NODE_ID", "n")]).contains("APG_CONFIG_URL is required"));
        assert!(err(&[("APG_CONFIG_SOURCE", "api_poll"), ("APG_CONFIG_URL", "http://a/dp")]).contains("APG_NODE_ID is required"));
        assert!(err(&[("APG_CONFIG_SOURCE", "api_poll"), ("APG_CONFIG_URL", "admin:9000"), ("APG_NODE_ID", "n")]).contains("http://"));
        let mut with = base.to_vec();
        with.push(("APG_POLL_LIMIT", "5000"));
        assert!(err(&with).contains("APG_POLL_LIMIT"));
        let mut half = base.to_vec();
        half.push(("APG_CONFIG_CLIENT_CERT", "/c.pem"));
        assert!(err(&half).contains("together"));
        // settings of another source are ignored, not required
        assert!(load(&[("APG_CONFIG_URL", "http://a/dp")]).unwrap().api_poll.is_none());
    }

    #[test]
    fn empty_values_are_treated_as_unset_except_listeners_where_empty_disables() {
        assert_eq!(load(&[("APG_NODE_ID", "  ")]).unwrap().node_id, "host-1");
        let c = load(&[("APG_LISTEN_HTTP", ""), ("APG_LISTEN_MGMT", "")]).unwrap();
        assert!(c.listen_http.is_none() && c.listen_mgmt.is_none() && c.listen_https.is_some());
        assert!(err(&[("APG_LISTEN_HTTP", ""), ("APG_LISTEN_HTTPS", "")]).contains("serve nothing"));
    }

    #[test]
    fn malformed_values_name_the_variable() {
        assert!(err(&[("APG_LISTEN_HTTPS", "8443")]).contains("APG_LISTEN_HTTPS"));
        assert!(err(&[("APG_HTTP_MODE", "both")]).contains("APG_HTTP_MODE"));
        assert!(err(&[("APG_TRUSTED_PROXIES", "10.0.0.0/8,nope")]).contains("APG_TRUSTED_PROXIES"));
        assert!(err(&[("APG_TRAFFIC_HEALTH_PATH", "healthz")]).contains("start with '/'"));
        assert!(err(&[("APG_TLS_FALLBACK_CERT", "/c.pem")]).contains("together"));
        assert!(err(&[("APG_SHUTDOWN_GRACE_SECS", "soon")]).contains("APG_SHUTDOWN_GRACE_SECS"));
        assert!(err(&[("APG_LOG_LEVEL", "verbose")]).contains("APG_LOG_LEVEL"));
        assert!(err(&[("APG_STUB_UPSTREAM", "yes")]).contains("true or false"));
        assert!(err(&[("APG_DNS_REFRESH_SECS", "1")]).contains("APG_DNS_REFRESH_SECS"));
        assert!(err(&[("APG_BACKEND_ALLOW_CIDRS", "private")]).contains("APG_BACKEND_ALLOW_CIDRS"));
        let c = load(&[("APG_BACKEND_ALLOW_CIDRS", "10.0.0.0/8"), ("APG_DNS_REFRESH_SECS", "10")]).unwrap();
        assert_eq!((c.upstream.backend_allow.len(), c.upstream.dns_refresh.as_secs()), (1, 10));
        assert_eq!(load(&[]).unwrap().upstream.dns_refresh.as_secs(), 30);
    }

    #[test]
    fn the_stub_upstream_test_mode_cannot_be_enabled_by_itself() {
        assert!(err(&[("APG_STUB_UPSTREAM", "true")]).contains("APG_ALLOW_TEST_MODES"));
        assert!(load(&[("APG_STUB_UPSTREAM", "true"), ("APG_ALLOW_TEST_MODES", "true")]).unwrap().stub_upstream);
    }

    #[test]
    fn secrets_tls_version_and_acme_settings() {
        const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let c = load(&[]).unwrap();
        assert!(c.secrets.is_none() && !c.tls13_only && c.acme.email.is_none() && c.acme.dns_webhook.is_none());
        assert_eq!(c.acme.directory_url, crate::acme::LETS_ENCRYPT);

        let c = load(&[("APG_SECRET_KEY", KEY), ("APG_TLS_MIN_VERSION", "1.3"), ("APG_ACME_EMAIL", "ops@example.com")]).unwrap();
        assert!(c.secrets.is_some() && c.upstream.secrets.is_some() && c.tls13_only);
        assert_eq!(c.acme.email.as_deref(), Some("ops@example.com"));
        // The key never shows up in debug output.
        assert!(!format!("{c:?}").contains(KEY));

        assert!(err(&[("APG_SECRET_KEY", "c2hvcnQ=")]).contains("32 random bytes"));
        assert!(err(&[("APG_SECRET_KEY_FILE", "/no/such/file")]).contains("APG_SECRET_KEY_FILE"));
        assert!(err(&[("APG_TLS_MIN_VERSION", "1.1")]).contains("APG_TLS_MIN_VERSION"));
        assert!(err(&[("APG_ACME_DIRECTORY_URL", "acme.example")]).contains("APG_ACME_DIRECTORY_URL"));

        let hook = load(&[("APG_ACME_DNS_PROVIDER", "webhook"), ("APG_ACME_DNS_WEBHOOK_URL", "https://dns.example/hook"), ("APG_ACME_DNS_WEBHOOK_SECRET", "s")]).unwrap().acme.dns_webhook.unwrap();
        assert_eq!((hook.url.as_str(), hook.secret.as_deref(), hook.propagation.as_secs()), ("https://dns.example/hook", Some("s"), 30));
        assert!(err(&[("APG_ACME_DNS_PROVIDER", "webhook")]).contains("APG_ACME_DNS_WEBHOOK_URL is required"));
        // Providers that are documented but not built refuse to start, they are not silently ignored.
        assert!(err(&[("APG_ACME_DNS_PROVIDER", "cloudflare")]).contains("not available in this build"));
        assert!(err(&[("APG_ACME_DNS_PROVIDER", "bind")]).contains("must be one of"));

        assert!(err(&[("APG_ACME_INSECURE_DIRECTORY", "true")]).contains("APG_ALLOW_TEST_MODES"));
        assert!(load(&[("APG_ACME_INSECURE_DIRECTORY", "true"), ("APG_ALLOW_TEST_MODES", "true")]).unwrap().acme.insecure_directory);
    }

    // spec Appendix B: the documented list and the code must not drift.
    #[test]
    fn every_variable_read_is_documented_for_the_node() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../schemas/process-config.yaml");
        let text = std::fs::read_to_string(path).unwrap();
        for name in READ_VARIABLES {
            let listed = text.lines().any(|l| l.contains(&format!("name: {name},")) && l.contains("component: node"));
            assert!(listed, "{name} is read by the node but not listed in schemas/process-config.yaml");
        }
    }
}
