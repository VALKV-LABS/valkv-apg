//! Certificates served by the TLS listener (spec §8.1, §8.2).
//!
//! Selection by SNI: an exact name, then a wildcard that covers the name, then
//! the fallback certificate. The lookup reads an immutable table that is
//! swapped whole when configuration changes, so a handshake never waits on a lock.
//!
//! Certificates come from configuration (files or inline in file mode; from a
//! control plane with the key sealed) and, in file mode, from this node's own
//! ACME issuance (`acme.rs`).

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

use crate::metrics;
use crate::secrets::SecretBox;

/// A certificate chain and its key, PEM-encoded.
#[derive(Clone)]
pub struct CertPair {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
    /// When the leaf expires, in seconds since the epoch.
    pub not_after: i64,
}

impl CertPair {
    /// Builds a pair after checking that the key belongs to the certificate.
    pub fn new(cert_pem: Vec<u8>, key_pem: Vec<u8>) -> Result<Self, String> {
        key_matches(&cert_pem, &key_pem)?;
        let not_after = certificate_not_after(&cert_pem)?;
        Ok(Self { cert_pem, key_pem, not_after })
    }
}

/// When the first certificate in a PEM bundle expires, in seconds since the epoch.
pub fn certificate_not_after(cert_pem: &[u8]) -> Result<i64, String> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem).map_err(|_| "not a PEM-encoded certificate".to_string())?;
    let cert = pem.parse_x509().map_err(|_| "not an X.509 certificate".to_string())?;
    Ok(cert.validity().not_after.timestamp())
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
    /// Certificates from configuration.
    table: ArcSwap<Table>,
    /// Certificates this node issued itself (file mode).
    issued: ArcSwap<Table>,
    fallback: Arc<CertPair>,
    secrets: Option<Arc<SecretBox>>,
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

pub(crate) fn key_matches(cert_pem: &[u8], key_pem: &[u8]) -> Result<(), String> {
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
    CertPair::new(cert.pem().into_bytes(), key.serialize_pem().into_bytes()).map_err(|e| anyhow::anyhow!(e))
}

type Read<'a> = &'a dyn Fn(&str) -> std::io::Result<Vec<u8>>;
type Open<'a> = &'a dyn Fn(&str) -> Result<Vec<u8>, String>;

/// Reads one configured certificate. `read` loads a file named by `cert_file` /
/// `key_file`; `open` decrypts a key that arrived sealed from a control plane.
pub fn load_certificate(cert: &Certificate, read: Read<'_>, open: Open<'_>) -> Result<(CertPair, Vec<String>), String> {
    let load = |inline: &Option<String>, file: &Option<String>, what: &str| -> Result<Vec<u8>, String> {
        match (inline, file) {
            (Some(pem), _) => Ok(pem.clone().into_bytes()),
            (None, Some(path)) => read(path).map_err(|e| format!("cannot read {what} '{path}': {e}")),
            (None, None) => Err(format!("no {what} is configured")),
        }
    };
    let cert_pem = load(&cert.cert_pem, &cert.cert_file, "certificate")?;
    let key_pem = match &cert.key_ciphertext {
        Some(sealed) if cert.key_pem.is_none() && cert.key_file.is_none() => open(sealed)?,
        _ => load(&cert.key_pem, &cert.key_file, "key")?,
    };
    let hosts = certificate_hosts(&cert_pem)?;
    if hosts.is_empty() {
        return Err("the certificate names no DNS host (no subject alternative names)".to_string());
    }
    Ok((CertPair::new(cert_pem, key_pem)?, hosts))
}

impl TlsStore {
    /// Creates the store with the operator's fallback certificate, or a
    /// self-signed one generated now.
    pub fn new(fallback_files: Option<&(String, String)>) -> anyhow::Result<Self> {
        let fallback = match fallback_files {
            Some((cert, key)) => {
                CertPair::new(std::fs::read(cert)?, std::fs::read(key)?).map_err(|e| anyhow::anyhow!("APG_TLS_FALLBACK_CERT / APG_TLS_FALLBACK_KEY: {e}"))?
            }
            None => self_signed()?,
        };
        Ok(Self { table: ArcSwap::from_pointee(Table::default()), issued: ArcSwap::from_pointee(Table::default()), fallback: Arc::new(fallback), secrets: None })
    }

    /// Gives the store the key that opens certificate keys sealed by a control plane.
    pub fn with_secrets(mut self, secrets: Option<Arc<SecretBox>>) -> Self {
        self.secrets = secrets;
        self
    }

    /// Checks every certificate in `resources` without installing anything.
    /// Faults are located at the certificate's position in its section.
    pub fn check(resources: &Resources, read: Read<'_>) -> Vec<Fault> {
        let no_sealed_keys = |_: &str| Err("a sealed key needs a control plane and APG_SECRET_KEY".to_string());
        let mut faults = Vec::new();
        for (id, stored) in resources.kind("certificate") {
            let outcome = serde_json::from_value::<Certificate>(stored.data.clone()).map_err(|e| e.to_string()).and_then(|c| load_certificate(&c, read, &no_sealed_keys).map(|_| c.name));
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
    pub fn install(&self, resources: &Resources, read: Read<'_>) -> usize {
        let mut table = Table::default();
        for (id, stored) in resources.kind("certificate") {
            let Ok(cert) = serde_json::from_value::<Certificate>(stored.data.clone()) else { continue };
            // A certificate from a control plane carries its key sealed for this
            // certificate's id (spec CFG-6); only the fleet's secret key opens it.
            let open = |sealed: &str| match &self.secrets {
                Some(secrets) => secrets.open(sealed, &format!("certificate:{id}")),
                None => Err("APG_SECRET_KEY is not set on this node, so the certificate's key cannot be opened".to_string()),
            };
            match load_certificate(&cert, read, &open) {
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
        self.export_expiry();
        names
    }

    /// Adds a certificate this node issued itself. It serves the names it
    /// carries unless a configured certificate covers them.
    pub fn add_issued(&self, pair: CertPair) -> Result<(), String> {
        let hosts = certificate_hosts(&pair.cert_pem)?;
        let pair = Arc::new(pair);
        let current = self.issued.load();
        let mut next = Table { exact: current.exact.clone(), wildcard: current.wildcard.clone() };
        for h in &hosts {
            next.insert(h, &pair);
        }
        self.issued.store(Arc::new(next));
        self.export_expiry();
        Ok(())
    }

    fn find(&self, name: &str) -> Option<Arc<CertPair>> {
        self.table.load().find(name).cloned().or_else(|| self.issued.load().find(name).cloned())
    }

    /// When the certificate held for exactly this name (`api.example.com` or
    /// `*.example.com`) expires. `None` when no certificate names it.
    pub fn not_after(&self, hostname: &str) -> Option<i64> {
        let host = hostname.to_ascii_lowercase();
        let lookup = |t: &Table| match host.strip_prefix('*') {
            Some(suffix) => t.wildcard.get(suffix).map(|p| p.not_after),
            None => t.exact.get(&host).map(|p| p.not_after),
        };
        lookup(&self.table.load()).or_else(|| lookup(&self.issued.load()))
    }

    /// Exports how many served certificates expire soon (spec Appendix C).
    pub fn export_expiry(&self) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        let (table, issued) = (self.table.load(), self.issued.load());
        // One certificate usually serves several names; count it once.
        let mut expiries: HashMap<*const CertPair, i64> = HashMap::new();
        for pair in table.exact.values().chain(table.wildcard.values()).chain(issued.exact.values()).chain(issued.wildcard.values()) {
            expiries.insert(Arc::as_ptr(pair), pair.not_after);
        }
        for (label, days) in [("7d", 7), ("14d", 14), ("30d", 30)] {
            let soon = expiries.values().filter(|t| **t - now < days * 86_400).count();
            metrics::CERTS_EXPIRING.with_label_values(&[label]).set(soon as i64);
        }
    }

    /// The certificate for an SNI name, or the fallback.
    pub fn select(&self, sni: Option<&str>) -> Arc<CertPair> {
        sni.and_then(|name| self.find(name)).unwrap_or_else(|| self.fallback.clone())
    }

    /// True when a configured or issued (non-fallback) certificate covers the name.
    pub fn covers(&self, sni: &str) -> bool {
        self.find(sni).is_some()
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

    // spec CFG-6, SEC-1
    #[test]
    fn a_key_sealed_by_the_control_plane_is_opened_with_the_secret_key_only() {
        const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let (c, k) = make(&["sealed.example.com"]);
        let secrets = Arc::new(SecretBox::from_base64(KEY, None).unwrap());
        let sealed = secrets.seal(k.as_bytes(), "certificate:c1");
        let r = resources_with(&[("c1", json!({ "name": "c", "cert_pem": c, "key_ciphertext": sealed }))]);

        let with_key = TlsStore::new(None).unwrap().with_secrets(Some(secrets.clone()));
        assert_eq!(with_key.install(&r, &no_files), 1);
        assert_eq!(with_key.select(Some("sealed.example.com")).key_pem, k.as_bytes());

        // No secret key on the node: the certificate is not served, the fallback is.
        let without = TlsStore::new(None).unwrap();
        assert_eq!(without.install(&r, &no_files), 0);
        assert!(!without.covers("sealed.example.com"));

        // A ciphertext moved onto another certificate does not open.
        let moved = resources_with(&[("c2", json!({ "name": "c", "cert_pem": c, "key_ciphertext": sealed }))]);
        assert_eq!(with_key.install(&moved, &no_files), 0);
    }

    #[test]
    fn issued_certificates_serve_until_configuration_covers_the_name() {
        let (issued_cert, issued_key) = make(&["shop.example.com"]);
        let (configured_cert, configured_key) = make(&["shop.example.com"]);
        let store = TlsStore::new(None).unwrap();
        assert_eq!(store.not_after("shop.example.com"), None);
        store.add_issued(CertPair::new(issued_cert.clone().into_bytes(), issued_key.into_bytes()).unwrap()).unwrap();
        assert_eq!(store.select(Some("shop.example.com")).cert_pem, issued_cert.as_bytes());
        let expires = store.not_after("shop.example.com").unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        assert!(expires > now, "the expiry is read from the certificate");

        // Installing configuration does not drop what was issued, but takes precedence for the same name.
        store.install(&resources_with(&[("a", json!({ "name": "a", "cert_pem": configured_cert, "key_pem": configured_key }))]), &no_files);
        assert_eq!(store.select(Some("shop.example.com")).cert_pem, configured_cert.as_bytes());
        store.install(&Resources::new(), &no_files);
        assert_eq!(store.select(Some("shop.example.com")).cert_pem, issued_cert.as_bytes());

        // Lookup by exact name: a wildcard certificate does not answer for a plain host.
        let (wild_cert, wild_key) = make(&["*.apps.example.com"]);
        store.add_issued(CertPair::new(wild_cert.into_bytes(), wild_key.into_bytes()).unwrap()).unwrap();
        assert!(store.not_after("*.apps.example.com").is_some());
        assert_eq!(store.not_after("x.apps.example.com"), None);
        assert!(CertPair::new(b"junk".to_vec(), b"junk".to_vec()).is_err());
    }
}
