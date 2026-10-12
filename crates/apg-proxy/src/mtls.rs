//! `mtls_auth`: authentication by client certificate (spec §9.4, TLS-3).
//!
//! The TLS listener asks for a client certificate, without requiring one, on
//! the names where an `mtls_auth` plugin applies, and accepts whatever is
//! presented. Trust is decided here, per plugin instance: the chain must lead
//! to one of the instance's CA certificates. Revocation is not checked.

use std::sync::Arc;

use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::stack::Stack;
use openssl::x509::store::{X509Store, X509StoreBuilder};
use openssl::x509::{X509, X509StoreContext};
use serde_json::Value;

use crate::auth::AuthOutcome;
use crate::plugins::Req;
use apg_core::snapshot::Snapshot;

/// The certificate a client presented in the TLS handshake: leaf first, DER-encoded.
#[derive(Debug, Clone)]
pub struct ClientCert {
    pub chain_der: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum By {
    SanDns,
    SanUri,
    SubjectCn,
    Fingerprint,
}

pub struct MtlsAuth {
    trusted: X509Store,
    consumer_by: By,
    skip_consumer_lookup: bool,
    anonymous: Option<String>,
}

impl std::fmt::Debug for MtlsAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MtlsAuth").field("consumer_by", &self.consumer_by).finish_non_exhaustive()
    }
}

/// The values of a certificate that may name a consumer, for one `consumer_by`.
fn identities(leaf: &X509, by: By) -> Vec<String> {
    match by {
        By::SanDns => leaf.subject_alt_names().into_iter().flatten().filter_map(|n| n.dnsname().map(str::to_ascii_lowercase)).collect(),
        By::SanUri => leaf.subject_alt_names().into_iter().flatten().filter_map(|n| n.uri().map(str::to_string)).collect(),
        By::SubjectCn => leaf.subject_name().entries_by_nid(Nid::COMMONNAME).filter_map(|e| String::from_utf8(e.data().as_slice().to_vec()).ok()).collect(),
        By::Fingerprint => leaf.digest(MessageDigest::sha256()).map(|d| vec![d.iter().map(|b| format!("{b:02x}")).collect()]).unwrap_or_default(),
    }
}

impl MtlsAuth {
    /// Builds the plugin. `ca_pem` returns the PEM bundle of a CA certificate by id.
    pub fn build(config: &Value, ca_pem: &dyn Fn(&str) -> Result<Vec<u8>, String>) -> Result<Self, String> {
        let bad = |e: openssl::error::ErrorStack| e.to_string();
        let mut store = X509StoreBuilder::new().map_err(bad)?;
        let ids: Vec<&str> = config.get("ca_certificates").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        if ids.is_empty() {
            return Err("ca_certificates is required".into());
        }
        for id in ids {
            let certs = X509::stack_from_pem(&ca_pem(id)?).ok().filter(|c| !c.is_empty()).ok_or_else(|| format!("CA certificate '{id}' holds no PEM-encoded certificate"))?;
            for cert in certs {
                store.add_cert(cert).map_err(bad)?;
            }
        }
        let consumer_by = match config.get("consumer_by").and_then(Value::as_str).unwrap_or("san_dns") {
            "san_dns" => By::SanDns,
            "san_uri" => By::SanUri,
            "subject_cn" => By::SubjectCn,
            "fingerprint" => By::Fingerprint,
            other => return Err(format!("unknown consumer_by '{other}'")),
        };
        Ok(Self {
            trusted: store.build(),
            consumer_by,
            skip_consumer_lookup: config.get("skip_consumer_lookup").and_then(Value::as_bool).unwrap_or(false),
            anonymous: config.get("anonymous").and_then(Value::as_str).map(str::to_string),
        })
    }

    /// Whether the presented chain leads to one of this instance's CAs.
    fn trusted(&self, leaf: &X509, intermediates: &[X509]) -> bool {
        let attempt = || -> Result<bool, openssl::error::ErrorStack> {
            let mut chain = Stack::new()?;
            for cert in intermediates {
                chain.push(cert.clone())?;
            }
            X509StoreContext::new()?.init(&self.trusted, leaf, &chain, |ctx| ctx.verify_cert())
        };
        attempt().unwrap_or(false)
    }

    pub fn check(&self, presented: Option<&ClientCert>, req: &Req<'_>, snapshot: &Snapshot) -> AuthOutcome {
        let Some(presented) = presented.filter(|c| !c.chain_der.is_empty()) else { return AuthOutcome::NoCredential { anonymous: self.anonymous.clone(), challenge: None } };
        let invalid = AuthOutcome::Invalid { challenge: None };
        let certs: Vec<X509> = presented.chain_der.iter().filter_map(|der| X509::from_der(der).ok()).collect();
        let Some((leaf, intermediates)) = certs.split_first() else { return invalid };
        if !self.trusted(leaf, intermediates) {
            return invalid;
        }
        if self.skip_consumer_lookup {
            return AuthOutcome::Authenticated { consumer: None, claims: None };
        }
        match identities(leaf, self.consumer_by).iter().find_map(|identity| snapshot.consumers.by_mtls_identity(identity, req.workspace_id, req.system_route, req.now)) {
            Some(consumer) => AuthOutcome::Authenticated { consumer: Some(consumer.clone()), claims: None },
            // A certificate we trust, for nobody we know.
            None => invalid,
        }
    }
}

/// Reads the certificate chain a client presented, if any, at the end of a handshake.
pub fn presented(ssl: &openssl::ssl::SslRef) -> Option<Arc<ClientCert>> {
    let leaf = ssl.peer_certificate()?.to_der().ok()?;
    let mut chain_der = vec![leaf.clone()];
    // On the server side the peer chain does not include the leaf; guard against a stack that does.
    for cert in ssl.peer_cert_chain().into_iter().flatten() {
        if let Ok(der) = cert.to_der()
            && der != leaf
        {
            chain_der.push(der);
        }
    }
    Some(Arc::new(ClientCert { chain_der }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use apg_core::resources::Resources;
    use http::HeaderMap;
    use serde_json::json;

    /// A CA and a leaf it signed.
    fn issue(names: &[&str], common_name: &str) -> (String, Vec<u8>) {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca_params.distinguished_name.push(rcgen::DnType::CommonName, "test CA");
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let mut leaf_params = rcgen::CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
        leaf_params.distinguished_name.push(rcgen::DnType::CommonName, common_name);
        let leaf = leaf_params.signed_by(&leaf_key, &ca, &ca_key).unwrap();
        (ca.pem(), leaf.der().to_vec())
    }

    fn snapshot() -> Snapshot {
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("consumer", "c1", Some("w".into()), json!({ "name": "billing" })));
        r.apply(&ChangeEvent::upsert("credential", "m1", Some("w".into()), json!({ "type": "mtls", "consumer_id": "c1", "identity": "billing.internal" })));
        r.apply(&ChangeEvent::upsert("credential", "m2", Some("w".into()), json!({ "type": "mtls", "consumer_id": "c1", "identity": "Billing Service" })));
        Snapshot::build(&r)
    }

    fn req(headers: &HeaderMap) -> Req<'_> {
        Req { method: "GET", host: "h", path: "/", query: "", client_ip: "", headers, workspace_id: "w", system_route: true, now: 0 }
    }

    #[test]
    fn a_certificate_from_a_trusted_ca_names_its_consumer() {
        let snap = snapshot();
        let headers = HeaderMap::new();
        let (ca, leaf) = issue(&["billing.internal"], "Billing Service");
        let (other_ca, stranger) = issue(&["billing.internal"], "Billing Service");
        let pem = |id: &str| if id == "ca1" { Ok(ca.clone().into_bytes()) } else { Err(format!("CA certificate '{id}' is not in the configuration")) };

        let plugin = MtlsAuth::build(&json!({ "ca_certificates": ["ca1"] }), &pem).unwrap();
        let cert = ClientCert { chain_der: vec![leaf.clone()] };
        match plugin.check(Some(&cert), &req(&headers), &snap) {
            AuthOutcome::Authenticated { consumer: Some(c), .. } => assert_eq!(c.name, "billing"),
            other => panic!("{other:?}"),
        }
        // The same names, signed by a CA this instance does not trust.
        assert!(matches!(plugin.check(Some(&ClientCert { chain_der: vec![stranger] }), &req(&headers), &snap), AuthOutcome::Invalid { .. }));
        // No certificate at all.
        assert!(matches!(plugin.check(None, &req(&headers), &snap), AuthOutcome::NoCredential { anonymous: None, .. }));
        assert!(matches!(plugin.check(Some(&ClientCert { chain_der: vec![b"junk".to_vec()] }), &req(&headers), &snap), AuthOutcome::Invalid { .. }));

        // Other ways to name the consumer.
        let by_cn = MtlsAuth::build(&json!({ "ca_certificates": ["ca1"], "consumer_by": "subject_cn" }), &pem).unwrap();
        assert!(matches!(by_cn.check(Some(&cert), &req(&headers), &snap), AuthOutcome::Authenticated { consumer: Some(_), .. }));
        let by_fingerprint = MtlsAuth::build(&json!({ "ca_certificates": ["ca1"], "consumer_by": "fingerprint" }), &pem).unwrap();
        assert!(matches!(by_fingerprint.check(Some(&cert), &req(&headers), &snap), AuthOutcome::Invalid { .. }), "trusted, but no credential lists this fingerprint");
        let any = MtlsAuth::build(&json!({ "ca_certificates": ["ca1"], "consumer_by": "fingerprint", "skip_consumer_lookup": true }), &pem).unwrap();
        assert!(matches!(any.check(Some(&cert), &req(&headers), &snap), AuthOutcome::Authenticated { consumer: None, .. }));

        // Configuration that cannot be built.
        assert!(MtlsAuth::build(&json!({ "ca_certificates": ["missing"] }), &pem).unwrap_err().contains("missing"));
        assert!(MtlsAuth::build(&json!({ "ca_certificates": [] }), &pem).is_err());
        assert!(MtlsAuth::build(&json!({ "ca_certificates": ["ca1"] }), &|_| Ok(other_ca.clone().into_bytes())).is_ok());
        let leaf_cert = X509::from_der(&leaf).unwrap();
        assert_eq!(identities(&leaf_cert, By::SanDns), ["billing.internal"]);
        assert_eq!(identities(&leaf_cert, By::Fingerprint)[0].len(), 64);
    }
}
