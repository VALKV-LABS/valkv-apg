//! Certificates from an ACME authority (spec §8.3, §8.4).
//!
//! Two parts:
//!
//! - [`Client`] speaks the ACME protocol (RFC 8555): account, order, challenge,
//!   finalisation. It knows nothing about nodes or control planes.
//! - [`Manager`] decides which hostnames need a certificate and when, and
//!   coordinates with the rest of the fleet. With a control plane, one node
//!   takes a lease, publishes the challenge to every node, waits until they
//!   all hold it, and hands the certificate to the control plane, which
//!   distributes it. Without one (file mode) the node answers its own
//!   challenge and keeps the certificate in its data directory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use apg_core::snapshot::AcmeHost;
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use openssl::bn::{BigNum, BigNumContext};
use openssl::ec::{EcGroup, EcKey};
use openssl::ecdsa::EcdsaSig;
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{PKey, Private};
use openssl::sha::sha256;
use openssl::stack::Stack;
use openssl::x509::extension::SubjectAlternativeName;
use openssl::x509::{X509NameBuilder, X509Req};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::gateway::Gateway;
use crate::metrics;
use crate::secrets::SecretBox;
use crate::tls::{CertPair, TlsStore};
use crate::upstream::random;

/// Renew this long before a certificate expires (spec TLS-6).
const RENEW_BEFORE_SECS: i64 = 30 * 86_400;
/// Retry delays after a failure grow from one minute to six hours (spec TLS-7).
const BACKOFF_FIRST: Duration = Duration::from_secs(60);
const BACKOFF_MAX: Duration = Duration::from_secs(6 * 3600);

/// A failed attempt, with the step that failed for `apg_acme_failures_total{reason}`.
#[derive(Debug)]
pub struct Failure {
    pub reason: &'static str,
    pub error: anyhow::Error,
}

trait Stage<T> {
    fn stage(self, reason: &'static str) -> Result<T, Failure>;
}

impl<T, E: Into<anyhow::Error>> Stage<T> for Result<T, E> {
    fn stage(self, reason: &'static str) -> Result<T, Failure> {
        self.map_err(|e| Failure { reason, error: e.into() })
    }
}

// ── Protocol ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct Directory {
    #[serde(rename = "newNonce")]
    new_nonce: String,
    #[serde(rename = "newAccount")]
    new_account: String,
    #[serde(rename = "newOrder")]
    new_order: String,
}

/// What identifies the fleet's account to the authority. Kept sealed at rest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Credentials {
    pub directory_url: String,
    /// The account URL the authority assigned.
    pub kid: String,
    pub key_pem: String,
}

#[derive(Debug, Deserialize)]
struct Order {
    status: String,
    #[serde(default)]
    authorizations: Vec<String>,
    #[serde(default)]
    finalize: String,
    #[serde(default)]
    certificate: Option<String>,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct Identifier {
    value: String,
}

#[derive(Debug, Deserialize)]
struct ChallengeDoc {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct Authorization {
    status: String,
    identifier: Identifier,
    #[serde(default)]
    challenges: Vec<ChallengeDoc>,
}

/// What the authority wants to see before it believes we control a name.
#[derive(Debug, Clone, PartialEq)]
pub enum Challenge {
    /// Serve `key_authorization` at `/.well-known/acme-challenge/<token>` over HTTP.
    Http { token: String, key_authorization: String },
    /// Publish `value` as a TXT record at `fqdn`.
    Dns { fqdn: String, value: String },
}

/// Puts a challenge answer where the authority will look, and removes it afterwards.
#[async_trait]
pub trait Solver: Send + Sync {
    async fn present(&self, challenge: &Challenge) -> anyhow::Result<()>;
    async fn cleanup(&self, challenge: &Challenge);
}

/// A certificate chain and the key generated for it, PEM-encoded.
pub struct Issued {
    pub cert_pem: String,
    pub key_pem: String,
}

struct Reply {
    location: Option<String>,
    body: Vec<u8>,
}

pub struct Client {
    http: reqwest::Client,
    directory_url: String,
    directory: Directory,
    key: EcKey<Private>,
    kid: Option<String>,
    nonce: tokio::sync::Mutex<Option<String>>,
}

/// A new P-256 key, the curve every ACME authority accepts.
fn new_key() -> anyhow::Result<EcKey<Private>> {
    let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1)?;
    Ok(EcKey::generate(&group)?)
}

/// An ES256 signature in the JOSE form: r and s, 32 bytes each.
fn sign(key: &EcKey<Private>, input: &[u8]) -> anyhow::Result<Vec<u8>> {
    let signature = EcdsaSig::sign(&sha256(input), key)?;
    let mut out = signature.r().to_vec_padded(32)?;
    out.extend(signature.s().to_vec_padded(32)?);
    Ok(out)
}

/// The public key as a JSON Web Key. Member order matters for the thumbprint.
fn jwk(key: &EcKey<Private>) -> anyhow::Result<(String, String)> {
    let (mut x, mut y, mut ctx) = (BigNum::new()?, BigNum::new()?, BigNumContext::new()?);
    key.public_key().affine_coordinates(key.group(), &mut x, &mut y, &mut ctx)?;
    Ok((B64.encode(x.to_vec_padded(32)?), B64.encode(y.to_vec_padded(32)?)))
}

/// A certificate request for one hostname, and the new key it is for.
fn certificate_request(hostname: &str) -> anyhow::Result<(Vec<u8>, String)> {
    let key = PKey::from_ec_key(new_key()?)?;
    let mut request = X509Req::builder()?;
    request.set_pubkey(&key)?;
    let mut name = X509NameBuilder::new()?;
    // A common name is limited to 64 characters; the name that counts is the SAN.
    if hostname.len() <= 64 {
        name.append_entry_by_nid(Nid::COMMONNAME, hostname)?;
    }
    request.set_subject_name(&name.build())?;
    let mut extensions = Stack::new()?;
    extensions.push(SubjectAlternativeName::new().dns(hostname).build(&request.x509v3_context(None))?)?;
    request.add_extensions(&extensions)?;
    request.sign(&key, MessageDigest::sha256())?;
    Ok((request.build().to_der()?, String::from_utf8(key.private_key_to_pem_pkcs8()?)?))
}

/// The authority's own explanation of a failure, when it gave one.
fn problem(body: &[u8]) -> String {
    let text = match serde_json::from_slice::<Value>(body) {
        Ok(v) => v.get("detail").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| v.to_string()),
        Err(_) => String::from_utf8_lossy(body).into_owned(),
    };
    text.chars().take(300).collect()
}

impl Client {
    async fn connect(http: reqwest::Client, directory_url: &str, key: EcKey<Private>, kid: Option<String>) -> anyhow::Result<Self> {
        let res = http.get(directory_url).send().await.map_err(|e| anyhow::anyhow!("cannot reach the ACME directory {directory_url}: {e}"))?;
        if !res.status().is_success() {
            anyhow::bail!("the ACME directory {directory_url} answered {}", res.status());
        }
        let directory: Directory = res.json().await.map_err(|e| anyhow::anyhow!("{directory_url} is not an ACME directory: {e}"))?;
        Ok(Self { http, directory_url: directory_url.to_string(), directory, key, kid, nonce: tokio::sync::Mutex::new(None) })
    }

    /// Opens an existing account.
    pub async fn with_credentials(http: reqwest::Client, credentials: &Credentials) -> anyhow::Result<Self> {
        let key = EcKey::private_key_from_pem(credentials.key_pem.as_bytes()).map_err(|_| anyhow::anyhow!("the stored ACME account key is not a PEM-encoded EC key"))?;
        Self::connect(http, &credentials.directory_url, key, Some(credentials.kid.clone())).await
    }

    /// Creates an account with a new key.
    pub async fn register(http: reqwest::Client, directory_url: &str, email: &str) -> anyhow::Result<Self> {
        let mut client = Self::connect(http, directory_url, new_key()?, None).await?;
        let reply = client.post(&client.directory.new_account.clone(), Some(&json!({ "termsOfServiceAgreed": true, "contact": [format!("mailto:{email}")] }))).await?;
        client.kid = Some(reply.location.ok_or_else(|| anyhow::anyhow!("the authority did not return an account URL"))?);
        Ok(client)
    }

    pub fn credentials(&self) -> anyhow::Result<Credentials> {
        Ok(Credentials {
            directory_url: self.directory_url.clone(),
            kid: self.kid.clone().ok_or_else(|| anyhow::anyhow!("the account is not registered"))?,
            key_pem: String::from_utf8(self.key.private_key_to_pem()?)?,
        })
    }

    /// The account key's thumbprint (RFC 7638), the second half of every key authorisation.
    fn thumbprint(&self) -> anyhow::Result<String> {
        let (x, y) = jwk(&self.key)?;
        // Exactly these members, in this order, with no whitespace.
        Ok(B64.encode(sha256(format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#).as_bytes())))
    }

    async fn fresh_nonce(&self) -> anyhow::Result<String> {
        let res = self.http.head(&self.directory.new_nonce).send().await?;
        res.headers().get("replay-nonce").and_then(|v| v.to_str().ok()).map(str::to_string).ok_or_else(|| anyhow::anyhow!("the authority returned no nonce"))
    }

    /// One signed request. `None` as payload is "POST-as-GET". A rejected
    /// nonce is replaced and the request sent again, as the protocol expects.
    async fn post(&self, url: &str, payload: Option<&Value>) -> anyhow::Result<Reply> {
        for _ in 0..5 {
            let nonce = match self.nonce.lock().await.take() {
                Some(n) => n,
                None => self.fresh_nonce().await?,
            };
            let protected = match &self.kid {
                Some(kid) => json!({ "alg": "ES256", "kid": kid, "nonce": nonce, "url": url }),
                None => {
                    let (x, y) = jwk(&self.key)?;
                    json!({ "alg": "ES256", "jwk": { "crv": "P-256", "kty": "EC", "x": x, "y": y }, "nonce": nonce, "url": url })
                }
            };
            let protected = B64.encode(protected.to_string());
            let payload = payload.map(|p| B64.encode(p.to_string())).unwrap_or_default();
            let signature = B64.encode(sign(&self.key, format!("{protected}.{payload}").as_bytes())?);
            let body = json!({ "protected": protected, "payload": payload, "signature": signature }).to_string();

            let res = self.http.post(url).header("content-type", "application/jose+json").body(body).send().await?;
            if let Some(next) = res.headers().get("replay-nonce").and_then(|v| v.to_str().ok()) {
                *self.nonce.lock().await = Some(next.to_string());
            }
            let status = res.status();
            let location = res.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string);
            let body = res.bytes().await?.to_vec();
            if status == StatusCode::BAD_REQUEST && String::from_utf8_lossy(&body).contains("badNonce") {
                continue;
            }
            if !status.is_success() {
                anyhow::bail!("the authority answered {status}: {}", problem(&body));
            }
            return Ok(Reply { location, body });
        }
        anyhow::bail!("the authority kept rejecting the request's nonce")
    }

    async fn fetch<T: serde::de::DeserializeOwned>(&self, url: &str) -> anyhow::Result<T> {
        Ok(serde_json::from_slice(&self.post(url, None).await?.body)?)
    }

    /// Polls `url` until `done` returns a value or the time runs out.
    async fn poll<T: serde::de::DeserializeOwned, R>(&self, url: &str, what: &str, done: impl Fn(&T) -> anyhow::Result<Option<R>>) -> anyhow::Result<R> {
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut wait = Duration::from_millis(500);
        loop {
            let doc: T = self.fetch(url).await?;
            if let Some(result) = done(&doc)? {
                return Ok(result);
            }
            if Instant::now() > deadline {
                anyhow::bail!("timed out waiting for {what}");
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(5));
        }
    }

    /// Obtains a certificate for one hostname. Every challenge presented
    /// through `solver` is cleaned up again, whether or not issuance worked.
    pub async fn issue(&self, hostname: &str, dns01: bool, solver: &dyn Solver) -> Result<Issued, Failure> {
        let mut presented = Vec::new();
        let result = self.run_order(hostname, dns01, solver, &mut presented).await;
        for challenge in &presented {
            solver.cleanup(challenge).await;
        }
        result
    }

    async fn run_order(&self, hostname: &str, dns01: bool, solver: &dyn Solver, presented: &mut Vec<Challenge>) -> Result<Issued, Failure> {
        let created = self.post(&self.directory.new_order, Some(&json!({ "identifiers": [{ "type": "dns", "value": hostname }] }))).await.stage("order")?;
        let order_url = created.location.clone().ok_or_else(|| anyhow::anyhow!("the authority did not return an order URL")).stage("order")?;
        let order: Order = serde_json::from_slice(&created.body).stage("order")?;
        let thumbprint = self.thumbprint().stage("order")?;
        let wanted = if dns01 { "dns-01" } else { "http-01" };

        for url in &order.authorizations {
            let authorization: Authorization = self.fetch(url).await.stage("challenge")?;
            if authorization.status == "valid" {
                continue;
            }
            let offered = authorization
                .challenges
                .iter()
                .find(|c| c.kind == wanted)
                .ok_or_else(|| anyhow::anyhow!("the authority offers no {wanted} challenge for {}", authorization.identifier.value))
                .stage("challenge")?;
            let key_authorization = format!("{}.{thumbprint}", offered.token);
            let challenge = if dns01 {
                Challenge::Dns { fqdn: format!("_acme-challenge.{}", authorization.identifier.value), value: B64.encode(sha256(key_authorization.as_bytes())) }
            } else {
                Challenge::Http { token: offered.token.clone(), key_authorization }
            };
            // Recorded first, so a half-finished presentation is still cleaned up.
            presented.push(challenge.clone());
            solver.present(&challenge).await.stage("challenge")?;
            self.post(&offered.url, Some(&json!({}))).await.stage("challenge")?;
            self.poll(url, "the authority to validate the challenge", |a: &Authorization| match a.status.as_str() {
                "valid" => Ok(Some(())),
                "pending" | "processing" => Ok(None),
                other => {
                    let why = a.challenges.iter().find_map(|c| c.error.as_ref()).map(|e| problem(e.to_string().as_bytes())).unwrap_or_default();
                    anyhow::bail!("the authority could not validate {} ({other}): {why}", a.identifier.value)
                }
            })
            .await
            .stage("challenge")?;
        }

        let failed = |o: &Order| anyhow::anyhow!("the order became {}: {}", o.status, o.error.as_ref().map(|e| problem(e.to_string().as_bytes())).unwrap_or_default());
        let finalize_url = self
            .poll(&order_url, "the order to become ready", |o: &Order| match o.status.as_str() {
                "ready" | "valid" => Ok(Some(o.finalize.clone())),
                "pending" | "processing" => Ok(None),
                _ => Err(failed(o)),
            })
            .await
            .stage("order")?;

        let (csr, key_pem) = certificate_request(hostname).stage("finalize")?;
        self.post(&finalize_url, Some(&json!({ "csr": B64.encode(csr) }))).await.stage("finalize")?;
        let certificate_url = self
            .poll(&order_url, "the certificate to be issued", |o: &Order| match (o.status.as_str(), &o.certificate) {
                ("valid", Some(url)) => Ok(Some(url.clone())),
                ("valid" | "ready" | "processing", _) => Ok(None),
                _ => Err(failed(o)),
            })
            .await
            .stage("finalize")?;
        let cert_pem = String::from_utf8(self.post(&certificate_url, None).await.stage("finalize")?.body).stage("finalize")?;
        Ok(Issued { cert_pem, key_pem })
    }
}

// ── DNS-01 through a webhook (spec TLS-5) ────────────────────────────────────

/// Publishes challenge records by calling an operator-supplied endpoint, which
/// covers any DNS host without provider-specific code here.
#[derive(Debug, Clone)]
pub struct DnsWebhook {
    pub url: String,
    /// Signs each request so the endpoint can tell it came from this fleet.
    pub secret: Option<String>,
    /// How long to wait after publishing before the authority is asked to look.
    pub propagation: Duration,
}

/// Lower-case hex HMAC-SHA256 of `body`.
pub fn hmac_hex(secret: &str, body: &[u8]) -> anyhow::Result<String> {
    let key = PKey::hmac(secret.as_bytes())?;
    let mut signer = openssl::sign::Signer::new(MessageDigest::sha256(), &key)?;
    signer.update(body)?;
    Ok(signer.sign_to_vec()?.iter().map(|b| format!("{b:02x}")).collect())
}

impl DnsWebhook {
    async fn call(&self, http: &reqwest::Client, action: &str, fqdn: &str, value: &str) -> anyhow::Result<()> {
        let body = json!({ "action": action, "fqdn": fqdn, "value": value }).to_string();
        let mut request = http.post(&self.url).header("content-type", "application/json").timeout(Duration::from_secs(30));
        if let Some(secret) = &self.secret {
            request = request.header("x-apg-signature", format!("sha256={}", hmac_hex(secret, body.as_bytes())?));
        }
        let res = request.body(body).send().await.map_err(|e| anyhow::anyhow!("the DNS webhook could not be reached: {e}"))?;
        if !res.status().is_success() {
            anyhow::bail!("the DNS webhook answered {} to '{action}'", res.status());
        }
        Ok(())
    }
}

// ── Coordination with the fleet (spec §8.4) ──────────────────────────────────

/// The control plane's certificate endpoints, as this node calls them.
pub struct Fleet {
    /// Base URL of the data-plane API, without a trailing slash.
    pub base: String,
    pub token: Option<String>,
    pub http: reqwest::Client,
    pub node_id: String,
}

impl Fleet {
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let request = self.http.request(method, format!("{}{path}", self.base)).timeout(Duration::from_secs(15));
        match &self.token {
            Some(t) => request.bearer_auth(t),
            None => request,
        }
    }

    /// Takes the lease for a hostname. `None` when another node holds it.
    async fn lease(&self, hostname: &str) -> anyhow::Result<Option<String>> {
        let res = self.request(reqwest::Method::POST, "/certs/lease").json(&json!({ "hostname": hostname, "node_id": self.node_id, "ttl_secs": 600 })).send().await?;
        match res.status() {
            StatusCode::CONFLICT => Ok(None),
            s if s.is_success() => {
                let body: Value = res.json().await?;
                Ok(Some(body.get("lease_id").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("the control plane returned no lease id"))?.to_string()))
            }
            s => anyhow::bail!("the control plane answered {s} to the lease request"),
        }
    }

    async fn release(&self, hostname: &str, lease_id: &str) {
        let _ = self.request(reqwest::Method::POST, "/certs/lease/release").json(&json!({ "hostname": hostname, "lease_id": lease_id })).send().await;
    }

    async fn publish(&self, hostname: &str, lease_id: &str, issued: &Issued) -> anyhow::Result<()> {
        let res = self
            .request(reqwest::Method::POST, "/certs")
            .json(&json!({ "hostname": hostname, "lease_id": lease_id, "cert_pem": issued.cert_pem, "key_pem": issued.key_pem }))
            .send()
            .await?;
        if !res.status().is_success() {
            anyhow::bail!("the control plane answered {} to the certificate", res.status());
        }
        Ok(())
    }

    /// The fleet's account for this directory, creating it if nobody has yet.
    /// Two nodes racing to register end up sharing whichever was stored first.
    async fn account(&self, http: reqwest::Client, settings: &Settings, email: &str, secrets: &SecretBox) -> anyhow::Result<Client> {
        let aad = format!("acme_account:{}", settings.directory_url);
        let open = |body: Value| -> anyhow::Result<Credentials> {
            let sealed = body.get("credentials_ciphertext").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("the control plane returned no account"))?;
            Ok(serde_json::from_slice(&secrets.open(sealed, &aad).map_err(|e| anyhow::anyhow!("the stored ACME account: {e}"))?)?)
        };
        let res = self.request(reqwest::Method::GET, "/acme/account").query(&[("directory_url", settings.directory_url.as_str())]).send().await?;
        if res.status().is_success() {
            return Client::with_credentials(http, &open(res.json().await?)?).await;
        }
        if res.status() != StatusCode::NOT_FOUND {
            anyhow::bail!("the control plane answered {} to the account request", res.status());
        }
        let fresh = Client::register(http.clone(), &settings.directory_url, email).await?;
        let sealed = secrets.seal(&serde_json::to_vec(&fresh.credentials()?)?, &aad);
        let stored = self.request(reqwest::Method::PUT, "/acme/account").json(&json!({ "directory_url": settings.directory_url, "credentials_ciphertext": sealed })).send().await?;
        if !stored.status().is_success() {
            anyhow::bail!("the control plane answered {} when storing the account", stored.status());
        }
        let winner = open(stored.json().await?)?;
        if winner == fresh.credentials()? { Ok(fresh) } else { Client::with_credentials(http, &winner).await }
    }
}

/// Where issuance state lives and who else has to know about a challenge.
pub enum Coordination {
    /// File mode: this node alone (spec TLS-12).
    Local { data_dir: PathBuf },
    Fleet(Fleet),
}

struct ManagerSolver<'a> {
    manager: &'a Manager,
}

#[async_trait]
impl Solver for ManagerSolver<'_> {
    async fn present(&self, challenge: &Challenge) -> anyhow::Result<()> {
        let m = self.manager;
        match (challenge, &m.coordination) {
            (Challenge::Dns { fqdn, value }, _) => {
                let hook = m.settings.dns_webhook.as_ref().ok_or_else(|| anyhow::anyhow!("no DNS provider is configured"))?;
                hook.call(&m.http, "present", fqdn, value).await?;
                tokio::time::sleep(hook.propagation).await;
                Ok(())
            }
            (Challenge::Http { token, key_authorization }, Coordination::Local { .. }) => {
                m.gateway.set_local_challenge(token, Some(key_authorization));
                Ok(())
            }
            (Challenge::Http { token, key_authorization }, Coordination::Fleet(fleet)) => {
                // The authority may reach any node, so every node must hold the
                // answer before it is asked to look (spec TLS-10).
                let res = fleet.request(reqwest::Method::POST, "/acme/challenges").json(&json!({ "token": token, "key_authorization": key_authorization, "ttl_secs": 900 })).send().await?;
                if !res.status().is_success() {
                    anyhow::bail!("the control plane answered {} to the challenge", res.status());
                }
                let seq = res.json::<Value>().await?.get("seq").and_then(Value::as_u64).ok_or_else(|| anyhow::anyhow!("the control plane returned no sequence number for the challenge"))?;
                let deadline = Instant::now() + Duration::from_secs(90);
                loop {
                    if m.gateway.applied_seq() >= seq && fleet.every_node_applied(seq).await? {
                        return Ok(());
                    }
                    if Instant::now() > deadline {
                        anyhow::bail!("not every node received the challenge within 90 seconds");
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    async fn cleanup(&self, challenge: &Challenge) {
        let m = self.manager;
        match (challenge, &m.coordination) {
            (Challenge::Dns { fqdn, value }, _) => {
                if let Some(hook) = &m.settings.dns_webhook
                    && let Err(e) = hook.call(&m.http, "cleanup", fqdn, value).await
                {
                    tracing::warn!(%fqdn, error = %e, "the challenge record was not removed");
                }
            }
            (Challenge::Http { token, .. }, Coordination::Local { .. }) => m.gateway.set_local_challenge(token, None),
            (Challenge::Http { token, .. }, Coordination::Fleet(fleet)) => {
                let _ = fleet.request(reqwest::Method::DELETE, &format!("/acme/challenges/{token}")).send().await;
            }
        }
    }
}

impl Fleet {
    async fn every_node_applied(&self, seq: u64) -> anyhow::Result<bool> {
        let res = self.request(reqwest::Method::GET, "/nodes/applied").send().await?;
        if !res.status().is_success() {
            anyhow::bail!("the control plane answered {} when asked what nodes have applied", res.status());
        }
        let body: Value = res.json().await?;
        // No live node is known to the control plane yet: this node's own state decides.
        Ok(body.get("min_applied_seq").and_then(Value::as_u64).is_none_or(|min| min >= seq))
    }
}

// ── Deciding what to issue, and when ─────────────────────────────────────────

/// Process-level ACME settings (spec TLS-8, Appendix B).
#[derive(Debug, Clone)]
pub struct Settings {
    pub email: Option<String>,
    pub directory_url: String,
    /// Test mode: do not verify the directory's TLS certificate.
    pub insecure_directory: bool,
    pub dns_webhook: Option<DnsWebhook>,
}

pub const LETS_ENCRYPT: &str = "https://acme-v02.api.letsencrypt.org/directory";

impl Default for Settings {
    fn default() -> Self {
        Self { email: None, directory_url: LETS_ENCRYPT.to_string(), insecure_directory: false, dns_webhook: None }
    }
}

/// True when a name has no certificate or one that expires within the renewal window.
pub fn needs_certificate(not_after: Option<i64>, now: i64) -> bool {
    not_after.is_none_or(|expires| expires - now < RENEW_BEFORE_SECS)
}

/// The wait before the next try after `failures` consecutive failures.
pub fn backoff(failures: u32) -> Duration {
    BACKOFF_FIRST.saturating_mul(1u32 << failures.saturating_sub(1).min(16)).min(BACKOFF_MAX)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn file_name(hostname: &str) -> String {
    hostname.replace('*', "_wildcard").chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect()
}

/// Writes a file only its owner can read.
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(contents)
}

pub struct Manager {
    pub settings: Settings,
    pub gateway: Arc<Gateway>,
    pub tls: Arc<TlsStore>,
    pub secrets: Option<Arc<SecretBox>>,
    pub coordination: Coordination,
    http: reqwest::Client,
}

impl Manager {
    pub fn new(settings: Settings, gateway: Arc<Gateway>, tls: Arc<TlsStore>, secrets: Option<Arc<SecretBox>>, coordination: Coordination) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("valkv-apg/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .danger_accept_invalid_certs(settings.insecure_directory)
            .build()?;
        Ok(Self { settings, gateway, tls, secrets, coordination, http })
    }

    /// Seals a value for local storage when a secret key is configured.
    fn seal_local(&self, plain: &[u8], aad: &str) -> Vec<u8> {
        match &self.secrets {
            Some(secrets) => secrets.seal(plain, aad).into_bytes(),
            None => plain.to_vec(),
        }
    }

    fn open_local(&self, stored: &[u8], aad: &str) -> anyhow::Result<Vec<u8>> {
        if !stored.starts_with(b"v1:") {
            return Ok(stored.to_vec());
        }
        let secrets = self.secrets.as_ref().ok_or_else(|| anyhow::anyhow!("the file is sealed and APG_SECRET_KEY is not set"))?;
        secrets.open(std::str::from_utf8(stored)?, aad).map_err(|e| anyhow::anyhow!(e))
    }

    /// Installs the certificates this node issued in earlier runs (file mode).
    pub fn load_issued(&self) -> usize {
        let Coordination::Local { data_dir } = &self.coordination else { return 0 };
        let Ok(entries) = std::fs::read_dir(data_dir.join("acme").join("certs")) else { return 0 };
        let mut loaded = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            let outcome = std::fs::read(&path)
                .map_err(anyhow::Error::from)
                .and_then(|stored| self.open_local(&stored, &format!("acme_certificate:{name}")))
                .and_then(|plain| Ok(serde_json::from_slice::<Value>(&plain)?))
                .and_then(|doc| {
                    let part = |k: &str| doc.get(k).and_then(Value::as_str).map(|s| s.as_bytes().to_vec()).ok_or_else(|| anyhow::anyhow!("missing {k}"));
                    CertPair::new(part("cert_pem")?, part("key_pem")?).map_err(|e| anyhow::anyhow!(e))
                })
                .and_then(|pair| self.tls.add_issued(pair).map_err(|e| anyhow::anyhow!(e)));
            match outcome {
                Ok(()) => loaded += 1,
                Err(e) => tracing::error!(file = %path.display(), error = %e, "a stored certificate could not be loaded"),
            }
        }
        loaded
    }

    async fn local_account(&self, data_dir: &Path, email: &str) -> anyhow::Result<Client> {
        let path = data_dir.join("acme").join("account.json");
        let aad = format!("acme_account:{}", self.settings.directory_url);
        if let Ok(stored) = std::fs::read(&path) {
            let credentials: Credentials = serde_json::from_slice(&self.open_local(&stored, &aad)?)?;
            // An account belongs to one authority; a changed directory needs a new one.
            if credentials.directory_url == self.settings.directory_url {
                return Client::with_credentials(self.http.clone(), &credentials).await;
            }
        }
        let client = Client::register(self.http.clone(), &self.settings.directory_url, email).await?;
        write_private(&path, &self.seal_local(&serde_json::to_vec(&client.credentials()?)?, &aad))?;
        Ok(client)
    }

    /// Why nothing can be issued at all right now, if that is the case.
    fn blocked(&self) -> Option<&'static str> {
        if self.settings.email.is_none() {
            return Some("APG_ACME_EMAIL is not set");
        }
        if matches!(self.coordination, Coordination::Fleet(_)) && self.secrets.is_none() {
            return Some("APG_SECRET_KEY is not set on this node");
        }
        None
    }

    /// Obtains a certificate for one hostname. `Ok(false)` means another node
    /// is doing it.
    async fn obtain(&self, host: &AcmeHost) -> Result<bool, Failure> {
        let email = self.settings.email.clone().unwrap_or_default();
        if host.dns01 && self.settings.dns_webhook.is_none() {
            return Err(Failure { reason: "config", error: anyhow::anyhow!("the name needs a DNS challenge and no DNS provider is configured (APG_ACME_DNS_PROVIDER)") });
        }
        let solver = ManagerSolver { manager: self };
        match &self.coordination {
            Coordination::Local { data_dir } => {
                let client = self.local_account(data_dir, &email).await.stage("account")?;
                let issued = client.issue(&host.hostname, host.dns01, &solver).await?;
                let pair = CertPair::new(issued.cert_pem.clone().into_bytes(), issued.key_pem.clone().into_bytes()).map_err(|e| anyhow::anyhow!(e)).stage("install")?;
                let name = file_name(&host.hostname);
                let stored = self.seal_local(json!({ "cert_pem": issued.cert_pem, "key_pem": issued.key_pem }).to_string().as_bytes(), &format!("acme_certificate:{name}"));
                write_private(&data_dir.join("acme").join("certs").join(format!("{name}.json")), &stored).stage("install")?;
                self.tls.add_issued(pair).map_err(|e| anyhow::anyhow!(e)).stage("install")?;
                Ok(true)
            }
            Coordination::Fleet(fleet) => {
                let Some(lease) = fleet.lease(&host.hostname).await.stage("lease")? else { return Ok(false) };
                let secrets = self.secrets.as_ref().expect("checked by blocked()");
                let attempt = async {
                    let client = fleet.account(self.http.clone(), &self.settings, &email, secrets).await.stage("account")?;
                    let issued = client.issue(&host.hostname, host.dns01, &solver).await?;
                    // The control plane seals the key and sends the certificate to every node, this one included.
                    fleet.publish(&host.hostname, &lease, &issued).await.stage("publish")
                };
                let result = attempt.await;
                if result.is_err() {
                    fleet.release(&host.hostname, &lease).await;
                }
                result.map(|()| true)
            }
        }
    }

    /// Runs for the life of the node.
    pub async fn run(self) {
        let loaded = self.load_issued();
        if loaded > 0 {
            tracing::info!(certificates = loaded, "certificates issued earlier were loaded from the data directory");
        }
        // Hostname to (consecutive failures, earliest next try).
        let mut retry: HashMap<String, (u32, Instant)> = HashMap::new();
        let mut complaint: Option<Vec<String>> = None;
        let mut warned_single_node = false;
        loop {
            let wanted = self.gateway.snapshot().acme_hosts().to_vec();
            self.tls.export_expiry();
            retry.retain(|hostname, _| wanted.iter().any(|w| &w.hostname == hostname));
            let now = now_unix();
            let due: Vec<&AcmeHost> = wanted
                .iter()
                .filter(|h| needs_certificate(self.tls.not_after(&h.hostname), now) && retry.get(&h.hostname).is_none_or(|(_, at)| Instant::now() >= *at))
                .collect();

            if !wanted.is_empty() && matches!(self.coordination, Coordination::Local { .. }) && !warned_single_node {
                warned_single_node = true;
                tracing::warn!("ACME in file mode works on one node only: nothing shares challenges or certificates between nodes. Use a control plane, or manual certificates, for a fleet.");
            }

            if let Some(why) = self.blocked().filter(|_| !due.is_empty()) {
                // Said once per set of names, not on every pass.
                let names: Vec<String> = due.iter().map(|h| h.hostname.clone()).collect();
                if complaint.as_ref() != Some(&names) {
                    metrics::ACME_FAILURES.with_label_values(&["config"]).inc();
                    tracing::error!(reason = why, hostnames = ?names, "certificates cannot be requested; handshakes for these names get the fallback certificate");
                    complaint = Some(names);
                }
            } else {
                complaint = None;
                for host in due {
                    match self.obtain(host).await {
                        Ok(true) => {
                            metrics::ACME_ISSUANCES.inc();
                            tracing::info!(hostname = %host.hostname, "certificate issued");
                            // With a control plane the certificate comes back through the changelog; give it a moment.
                            retry.insert(host.hostname.clone(), (0, Instant::now() + Duration::from_secs(30)));
                        }
                        Ok(false) => {
                            tracing::debug!(hostname = %host.hostname, "another node is obtaining this certificate");
                            retry.insert(host.hostname.clone(), (0, Instant::now() + Duration::from_secs(20)));
                        }
                        Err(failure) => {
                            let failures = retry.get(&host.hostname).map_or(0, |(n, _)| *n) + 1;
                            let wait = backoff(failures);
                            metrics::ACME_FAILURES.with_label_values(&[failure.reason]).inc();
                            tracing::warn!(hostname = %host.hostname, reason = failure.reason, error = %failure.error, retry_in_secs = wait.as_secs(), "certificate request failed; the fallback certificate is served meanwhile");
                            retry.insert(host.hostname.clone(), (failures, Instant::now() + wait));
                        }
                    }
                }
            }

            // Wake for a configuration change, a due retry, or the periodic renewal check.
            let next_retry = retry.values().map(|(_, at)| at.saturating_duration_since(Instant::now())).min().unwrap_or(Duration::from_secs(3600));
            let periodic = Duration::from_secs(3300 + random() % 600);
            tokio::select! {
                _ = self.gateway.changed.notified() => tokio::time::sleep(Duration::from_millis(500)).await,
                _ = tokio::time::sleep(next_retry.min(periodic).max(Duration::from_secs(1))) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // spec TLS-6
    #[test]
    fn a_certificate_is_wanted_when_missing_or_inside_the_renewal_window() {
        let now = 1_800_000_000;
        assert!(needs_certificate(None, now));
        assert!(needs_certificate(Some(now - 1), now), "expired");
        assert!(needs_certificate(Some(now + 29 * 86_400), now));
        assert!(!needs_certificate(Some(now + 31 * 86_400), now));
    }

    // spec TLS-7
    #[test]
    fn retries_back_off_from_a_minute_to_six_hours() {
        assert_eq!(backoff(1), Duration::from_secs(60));
        assert_eq!(backoff(2), Duration::from_secs(120));
        assert_eq!(backoff(5), Duration::from_secs(960));
        assert_eq!(backoff(10), Duration::from_secs(6 * 3600));
        assert_eq!(backoff(1000), Duration::from_secs(6 * 3600));
    }

    #[test]
    fn signatures_and_thumbprints_follow_the_jose_forms() {
        let key = new_key().unwrap();
        let signature = sign(&key, b"protected.payload").unwrap();
        assert_eq!(signature.len(), 64, "r and s, 32 bytes each");
        let parsed = EcdsaSig::from_private_components(BigNum::from_slice(&signature[..32]).unwrap(), BigNum::from_slice(&signature[32..]).unwrap()).unwrap();
        assert!(parsed.verify(&sha256(b"protected.payload"), &key).unwrap());
        assert!(!parsed.verify(&sha256(b"something else"), &key).unwrap());

        let (x, y) = jwk(&key).unwrap();
        assert_eq!((B64.decode(&x).unwrap().len(), B64.decode(&y).unwrap().len()), (32, 32));
        assert!(!x.contains('=') && !x.contains('+') && !x.contains('/'), "URL-safe, unpadded");
    }

    #[test]
    fn a_certificate_request_names_the_host_and_is_signed_by_its_new_key() {
        let (der, key_pem) = certificate_request("shop.example.com").unwrap();
        let request = X509Req::from_der(&der).unwrap();
        let key = PKey::private_key_from_pem(key_pem.as_bytes()).unwrap();
        assert!(request.verify(&key).unwrap());
        assert!(key_pem.starts_with("-----BEGIN PRIVATE KEY-----"), "PKCS#8, which the control plane accepts");
        let text = String::from_utf8_lossy(&request.to_text().unwrap()).into_owned();
        assert!(text.contains("DNS:shop.example.com"), "{text}");
        // A wildcard and a name too long for a common name still work.
        assert!(certificate_request("*.apps.example.com").is_ok());
        assert!(certificate_request(&format!("{}.example.com", "a".repeat(60))).is_ok());
        // Each request gets its own key.
        assert_ne!(certificate_request("shop.example.com").unwrap().1, key_pem);
    }

    #[test]
    fn problems_from_the_authority_are_summarised() {
        assert_eq!(problem(br#"{"type":"urn:ietf:params:acme:error:rateLimited","detail":"too many certificates"}"#), "too many certificates");
        assert_eq!(problem(b"plain text"), "plain text");
        assert_eq!(problem("x".repeat(1000).as_bytes()).len(), 300);
    }

    #[test]
    fn stored_file_names_are_safe() {
        assert_eq!(file_name("shop.example.com"), "shop.example.com");
        assert_eq!(file_name("*.apps.example.com"), "_wildcard.apps.example.com");
        assert_eq!(file_name("../../etc/passwd"), ".._.._etc_passwd");
    }

    // spec TLS-5
    #[tokio::test]
    async fn the_dns_webhook_is_called_with_a_signature_the_endpoint_can_check() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let received = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let mut seen = Vec::new();
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                seen.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&seen).into_owned();
                if let Some((head, body)) = text.split_once("\r\n\r\n")
                    && body.ends_with('}')
                {
                    socket.write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n").await.unwrap();
                    return (head.to_ascii_lowercase(), body.to_string());
                }
            }
        });
        let hook = DnsWebhook { url: format!("http://{addr}/dns"), secret: Some("s3cret".into()), propagation: Duration::ZERO };
        hook.call(&reqwest::Client::new(), "present", "_acme-challenge.example.com", "abc123").await.unwrap();
        let (head, body) = received.await.unwrap();
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent, json!({ "action": "present", "fqdn": "_acme-challenge.example.com", "value": "abc123" }));
        let expected = hmac_hex("s3cret", body.as_bytes()).unwrap();
        assert!(head.contains(&format!("x-apg-signature: sha256={expected}")), "{head}");
        assert_eq!(expected.len(), 64);
        // RFC 4231 test case 2.
        assert_eq!(hmac_hex("Jefe", b"what do ya want for nothing?").unwrap(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn local_state_is_sealed_when_a_secret_key_is_set_and_plain_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = Gateway::new("n".into(), "file", 30);
        let tls = Arc::new(TlsStore::new(None).unwrap());
        let secrets = Arc::new(SecretBox::from_base64("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", None).unwrap());
        let sealed = Manager::new(Settings::default(), gateway.clone(), tls.clone(), Some(secrets), Coordination::Local { data_dir: dir.path().to_path_buf() }).unwrap();
        let plain = Manager::new(Settings::default(), gateway, tls.clone(), None, Coordination::Local { data_dir: dir.path().to_path_buf() }).unwrap();

        let stored = sealed.seal_local(b"key material", "x");
        assert!(stored.starts_with(b"v1:") && !String::from_utf8_lossy(&stored).contains("key material"));
        assert_eq!(sealed.open_local(&stored, "x").unwrap(), b"key material");
        assert!(plain.open_local(&stored, "x").unwrap_err().to_string().contains("APG_SECRET_KEY"));
        assert_eq!(plain.open_local(&plain.seal_local(b"key material", "x"), "x").unwrap(), b"key material");

        // A certificate stored by an earlier run is served again after a restart.
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["kept.example.com".to_string()]).unwrap().self_signed(&key).unwrap();
        let doc = json!({ "cert_pem": cert.pem(), "key_pem": key.serialize_pem() }).to_string();
        write_private(&dir.path().join("acme/certs/kept.example.com.json"), &sealed.seal_local(doc.as_bytes(), "acme_certificate:kept.example.com")).unwrap();
        write_private(&dir.path().join("acme/certs/broken.json"), b"not json").unwrap();
        assert_eq!(sealed.load_issued(), 1);
        assert!(tls.covers("kept.example.com"));
        assert_eq!(sealed.blocked(), Some("APG_ACME_EMAIL is not set"));
    }
}
