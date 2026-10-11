//! Certificates served by the TLS listener (spec §8.1, §8.2).
//!
//! Selection by SNI: an exact name, then a wildcard that covers the name, then
//! the fallback certificate. The lookup reads an immutable table that is
//! swapped whole when configuration changes, so a handshake never waits on a lock.
//!
//! Phase 2a serves manually configured certificates and the fallback. Issuing
//! certificates from an ACME authority is build phase 2d.

use std::collections::HashMap;
use std::sync::Arc;

use apg_core::model::Certificate;
use apg_core::resources::Resources;
use apg_core::schema::Fault;
use arc_swap::ArcSwap;
use async_trait::async_trait;
use pingora_core::listeners::TlsAccept;
use pingora_core::protocols::tls::TlsRef;
use pingora_core::tls::ext::{ssl_add_chain_cert, ssl_use_certificate, ssl_use_private_key};
use pingora_core::tls::pkey::PKey;
use pingora_core::tls::ssl::NameType;
use pingora_core::tls::x509::X509;

/// A certificate chain and its key, PEM-encoded.
#[derive(Clone)]
pub struct CertPair {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
}

#[derive(Default)]
struct Table {
    exact: HashMap<String, Arc<CertPair>>,
    /// Keyed by the suffix after the first label, with its dot: `.example.com`.
    wildcard: HashMap<String, Arc<CertPair>>,
}

impl Table {
    fn insert(&mut self, host: &str, pair: &Arc<CertPair>) {
        let host = host.to_ascii_lowercase();
        match host.strip_prefix('*') {
            Some(suffix) => self.wildcard.insert(suffix.to_string(), pair.clone()),
            None => self.exact.insert(host, pair.clone()),
        };
    }

    fn find(&self, sni: &str) -> Option<&Arc<CertPair>> {
        let sni = sni.to_ascii_lowercase();
        self.exact.get(&sni).or_else(|| sni.find('.').and_then(|i| self.wildcard.get(&sni[i..])))
    }
}

/// The certificates the node can present.
pub struct TlsStore {
    table: ArcSwap<Table>,
    fallback: Arc<CertPair>,
}

/// DNS names a certificate is valid for, from its subject alternative names.
pub fn certificate_hosts(cert_pem: &[u8]) -> Result<Vec<String>, String> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem).map_err(|_| "not a PEM-encoded certificate".to_string())?;
    let cert = pem.parse_x509().map_err(|_| "not an X.509 certificate".to_string())?;
    let mut hosts = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in &san.value.general_names {
            if let x509_parser::extensions::GeneralName::DNSName(dns) = name {
                hosts.push(dns.to_ascii_lowercase());
            }
        }
    }
    Ok(hosts)
}

fn key_matches(cert_pem: &[u8], key_pem: &[u8]) -> Result<(), String> {
    let cert = X509::from_pem(cert_pem).map_err(|_| "not a PEM-encoded certificate".to_string())?;
    let key = PKey::private_key_from_pem(key_pem).map_err(|_| "not a PEM-encoded private key".to_string())?;
    let public = cert.public_key().map_err(|_| "the certificate has no usable public key".to_string())?;
    if public.public_eq(&key) { Ok(()) } else { Err("the private key does not match the certificate".to_string()) }
}

fn self_signed() -> anyhow::Result<CertPair> {
    let key = rcgen::KeyPair::generate()?;
    let mut params = rcgen::CertificateParams::new(vec!["valkv-apg.invalid".to_string()])?;
    params.distinguished_name.push(rcgen::DnType::CommonName, "valkv-apg fallback certificate");
    let cert = params.self_signed(&key)?;
    Ok(CertPair { cert_pem: cert.pem().into_bytes(), key_pem: key.serialize_pem().into_bytes() })
}

/// Reads one configured certificate. `read` loads a file named by `cert_file` / `key_file`.
pub fn load_certificate(cert: &Certificate, read: &dyn Fn(&str) -> std::io::Result<Vec<u8>>) -> Result<(CertPair, Vec<String>), String> {
    let load = |inline: &Option<String>, file: &Option<String>, what: &str| -> Result<Vec<u8>, String> {
        match (inline, file) {
            (Some(pem), _) => Ok(pem.clone().into_bytes()),
            (None, Some(path)) => read(path).map_err(|e| format!("cannot read {what} '{path}': {e}")),
            (None, None) => Err(format!("no {what} is configured")),
        }
    };
    let cert_pem = load(&cert.cert_pem, &cert.cert_file, "certificate")?;
    let key_pem = load(&cert.key_pem, &cert.key_file, "key")?;
    key_matches(&cert_pem, &key_pem)?;
    let hosts = certificate_hosts(&cert_pem)?;
    if hosts.is_empty() {
        return Err("the certificate names no DNS host (no subject alternative names)".to_string());
    }
    Ok((CertPair { cert_pem, key_pem }, hosts))
}

impl TlsStore {
    /// Creates the store with the operator's fallback certificate, or a
    /// self-signed one generated now.
    pub fn new(fallback_files: Option<&(String, String)>) -> anyhow::Result<Self> {
        let fallback = match fallback_files {
            Some((cert, key)) => {
                let pair = CertPair { cert_pem: std::fs::read(cert)?, key_pem: std::fs::read(key)? };
                key_matches(&pair.cert_pem, &pair.key_pem).map_err(|e| anyhow::anyhow!("APG_TLS_FALLBACK_CERT / APG_TLS_FALLBACK_KEY: {e}"))?;
                pair
            }
            None => self_signed()?,
        };
        Ok(Self { table: ArcSwap::from_pointee(Table::default()), fallback: Arc::new(fallback) })
    }

    /// Checks every certificate in `resources` without installing anything.
    /// Faults are located at the certificate's position in its section.
    pub fn check(resources: &Resources, read: &dyn Fn(&str) -> std::io::Result<Vec<u8>>) -> Vec<Fault> {
        let mut faults = Vec::new();
        for (id, stored) in resources.kind("certificate") {
            let outcome = serde_json::from_value::<Certificate>(stored.data.clone()).map_err(|e| e.to_string()).and_then(|c| load_certificate(&c, read).map(|_| c.name));
            if let Err(message) = outcome {
                let name = stored.data.get("name").and_then(|n| n.as_str()).unwrap_or(id);
                faults.push(Fault::new("/certificates", format!("certificate '{name}': {message}")));
            }
        }
        faults
    }

    /// Installs the certificates in `resources`, replacing the previous set.
    /// Returns how many names are now served. A certificate that fails to load
    /// is skipped and logged; `check` is how a caller refuses it up front.
    pub fn install(&self, resources: &Resources, read: &dyn Fn(&str) -> std::io::Result<Vec<u8>>) -> usize {
        let mut table = Table::default();
        for (id, stored) in resources.kind("certificate") {
            let Ok(cert) = serde_json::from_value::<Certificate>(stored.data.clone()) else { continue };
            // A certificate from a control plane carries its key as ciphertext,
            // which this build cannot open yet (build phase 2d). Until then such a
            // certificate is not served; handshakes for its names get the fallback.
            if cert.key_pem.is_none() && cert.key_file.is_none() {
                tracing::debug!(certificate = %id, "certificate has no key this build can read; not installed");
                continue;
            }
            match load_certificate(&cert, read) {
                Ok((pair, hosts)) => {
                    let pair = Arc::new(pair);
                    for h in &hosts {
                        table.insert(h, &pair);
                    }
                }
                Err(message) => tracing::error!(certificate = %id, %message, "certificate not installed"),
            }
        }
        let names = table.exact.len() + table.wildcard.len();
        self.table.store(Arc::new(table));
        names
    }

    /// The certificate for an SNI name, or the fallback.
    pub fn select(&self, sni: Option<&str>) -> Arc<CertPair> {
        sni.and_then(|name| self.table.load().find(name).cloned()).unwrap_or_else(|| self.fallback.clone())
    }

    /// True when a configured (non-fallback) certificate covers the name.
    pub fn covers(&self, sni: &str) -> bool {
        self.table.load().find(sni).is_some()
    }
}

/// Presents the selected certificate during the handshake.
pub struct SniAcceptor {
    pub store: Arc<TlsStore>,
}

#[async_trait]
impl TlsAccept for SniAcceptor {
    async fn certificate_callback(&self, ssl: &mut TlsRef) {
        let sni = ssl.servername(NameType::HOST_NAME).map(str::to_owned);
        let pair = self.store.select(sni.as_deref());

        // The PEM holds the leaf first, then any intermediates.
        let mut chain = match X509::stack_from_pem(&pair.cert_pem) {
            Ok(c) if !c.is_empty() => c,
            _ => {
                tracing::error!(?sni, "certificate could not be parsed for the handshake");
                return;
            }
        };
        let leaf = chain.remove(0);
        if let Err(e) = ssl_use_certificate(ssl, &leaf) {
            tracing::error!(?sni, %e, "failed to install the certificate");
            return;
        }
        for intermediate in chain {
            if let Err(e) = ssl_add_chain_cert(ssl, &intermediate) {
                tracing::error!(?sni, %e, "failed to install an intermediate certificate");
                return;
            }
        }
        if let Err(e) = PKey::private_key_from_pem(&pair.key_pem).and_then(|key| ssl_use_private_key(ssl, &key)) {
            tracing::error!(?sni, %e, "failed to install the private key");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use serde_json::json;

    fn make(names: &[&str]) -> (String, String) {
        let key = rcgen::KeyPair::generate().unwrap();
        let params = rcgen::CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
        (params.self_signed(&key).unwrap().pem(), key.serialize_pem())
    }

    fn no_files(path: &str) -> std::io::Result<Vec<u8>> {
        Err(std::io::Error::new(std::io::ErrorKind::NotFound, path.to_string()))
    }

    fn resources_with(certs: &[(&str, serde_json::Value)]) -> Resources {
        let mut r = Resources::new();
        for (id, data) in certs {
            r.apply(&ChangeEvent::upsert("certificate", *id, Some("ws".into()), data.clone()));
        }
        r
    }

    #[test]
    fn selects_exact_then_wildcard_then_fallback() {
        let (c1, k1) = make(&["api.example.com"]);
        let (c2, k2) = make(&["*.apps.example.com"]);
        let store = TlsStore::new(None).unwrap();
        let r = resources_with(&[("a", json!({ "name": "a", "cert_pem": c1, "key_pem": k1 })), ("b", json!({ "name": "b", "cert_pem": c2, "key_pem": k2 }))]);
        assert_eq!(store.install(&r, &no_files), 2);
        assert_eq!(store.select(Some("API.example.com")).cert_pem, c1.as_bytes());
        assert_eq!(store.select(Some("x.apps.example.com")).cert_pem, c2.as_bytes());
        // a wildcard covers exactly one label
        assert!(!store.covers("a.b.apps.example.com"));
        assert!(!store.covers("apps.example.com"));
        let fallback = store.select(None).cert_pem.clone();
        assert_eq!(store.select(Some("unknown.test")).cert_pem, fallback);
        assert_ne!(fallback, c1.as_bytes());
    }

    #[test]
    fn reads_certificates_from_files_in_file_mode() {
        let (c, k) = make(&["files.example.com"]);
        let read = |path: &str| -> std::io::Result<Vec<u8>> {
            match path {
                "/certs/a.crt" => Ok(c.clone().into_bytes()),
                "/certs/a.key" => Ok(k.clone().into_bytes()),
                other => no_files(other),
            }
        };
        let store = TlsStore::new(None).unwrap();
        let r = resources_with(&[("a", json!({ "name": "a", "cert_file": "/certs/a.crt", "key_file": "/certs/a.key" }))]);
        assert!(TlsStore::check(&r, &read).is_empty());
        assert_eq!(store.install(&r, &read), 1);
        assert!(store.covers("files.example.com"));
    }

    #[test]
    fn check_reports_missing_files_mismatched_keys_and_garbage() {
        let (c1, _) = make(&["a.example.com"]);
        let (_, k2) = make(&["b.example.com"]);
        let r = resources_with(&[
            ("missing", json!({ "name": "missing", "cert_file": "/nope.crt", "key_file": "/nope.key" })),
            ("mismatch", json!({ "name": "mismatch", "cert_pem": c1, "key_pem": k2 })),
            ("garbage", json!({ "name": "garbage", "cert_pem": "not a cert", "key_pem": "not a key" })),
        ]);
        let faults = TlsStore::check(&r, &no_files);
        assert_eq!(faults.len(), 3);
        let text = faults.iter().map(|f| f.message.clone()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("'missing': cannot read certificate '/nope.crt'"), "{text}");
        assert!(text.contains("'mismatch': the private key does not match"), "{text}");
        assert!(text.contains("'garbage': not a PEM-encoded certificate"), "{text}");
        // and install skips them rather than serving something broken
        let store = TlsStore::new(None).unwrap();
        assert_eq!(store.install(&r, &no_files), 0);
    }

    #[test]
    fn installing_replaces_the_previous_set() {
        let (c1, k1) = make(&["old.example.com"]);
        let (c2, k2) = make(&["new.example.com"]);
        let store = TlsStore::new(None).unwrap();
        store.install(&resources_with(&[("a", json!({ "name": "a", "cert_pem": c1, "key_pem": k1 }))]), &no_files);
        store.install(&resources_with(&[("b", json!({ "name": "b", "cert_pem": c2, "key_pem": k2 }))]), &no_files);
        assert!(!store.covers("old.example.com") && store.covers("new.example.com"));
    }
}
