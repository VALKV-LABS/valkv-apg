//! Authentication plugins: `key_auth`, `basic_auth`, `jwt_auth` (spec §9.4, §10).
//!
//! Each answers one question about a request: did it present a credential of
//! this scheme, and if so, whose is it? Combining the answers of several
//! schemes is the caller's job (spec PL-10).

use std::sync::Arc;
use std::time::{Duration, Instant};

use apg_core::consumers::{Consumer, PasswordHash, sha256_hex};
use apg_core::snapshot::Snapshot;
use arc_swap::ArcSwap;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use dashmap::DashMap;
use openssl::bn::BigNum;
use openssl::ec::{EcGroup, EcKey};
use openssl::ecdsa::EcdsaSig;
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{Id, PKey, Public};
use openssl::rsa::Rsa;
use openssl::sign::{Signer, Verifier};
use serde::Deserialize;
use serde_json::Value;

use crate::plugins::Req;

/// What an authentication plugin concluded.
#[derive(Debug)]
pub enum AuthOutcome {
    /// A valid credential. `consumer` is `None` when the scheme proves a
    /// caller without naming a consumer (a JWT with no `consumer_claim`).
    Authenticated { consumer: Option<Arc<Consumer>>, claims: Option<Value> },
    /// No credential of this scheme on the request.
    NoCredential { anonymous: Option<String>, challenge: Option<String> },
    /// A credential was presented and is not acceptable.
    Invalid { challenge: Option<String> },
    /// The plugin cannot decide right now (its keys could not be fetched).
    Unavailable,
}

/// Changes an authentication plugin asks for on the forwarded request.
#[derive(Debug, Default)]
pub struct AuthEffects {
    pub strip_headers: Vec<String>,
    pub strip_query: Vec<String>,
    pub set_headers: Vec<(String, String)>,
}

fn d_true() -> bool {
    true
}

// ── key_auth ─────────────────────────────────────────────────────────────────

fn d_key_names() -> Vec<String> {
    vec!["x-api-key".into()]
}

#[derive(Debug, Deserialize)]
pub struct KeyAuth {
    #[serde(default = "d_key_names")]
    key_names: Vec<String>,
    #[serde(default = "d_true")]
    in_header: bool,
    #[serde(default)]
    in_query: bool,
    #[serde(default = "d_true")]
    hide_credentials: bool,
    #[serde(default)]
    anonymous: Option<String>,
}

impl KeyAuth {
    pub fn check(&self, req: &Req<'_>, snapshot: &Snapshot, effects: &mut AuthEffects) -> AuthOutcome {
        let mut presented: Option<String> = None;
        for name in &self.key_names {
            if self.in_header
                && let Some(value) = req.header(name)
            {
                presented.get_or_insert_with(|| value.to_string());
                if self.hide_credentials {
                    effects.strip_headers.push(name.to_ascii_lowercase());
                }
            }
            if self.in_query
                && let Some(value) = req.query_param(name)
            {
                presented.get_or_insert_with(|| value.to_string());
                if self.hide_credentials {
                    effects.strip_query.push(name.clone());
                }
            }
        }
        let Some(key) = presented else { return AuthOutcome::NoCredential { anonymous: self.anonymous.clone(), challenge: None } };
        match snapshot.consumers.by_key(&key, req.workspace_id, req.system_route, req.now) {
            Some(consumer) => AuthOutcome::Authenticated { consumer: Some(consumer.clone()), claims: None },
            None => AuthOutcome::Invalid { challenge: None },
        }
    }
}

// ── basic_auth ───────────────────────────────────────────────────────────────

fn d_realm() -> String {
    "api".into()
}

#[derive(Debug, Deserialize)]
pub struct BasicAuth {
    #[serde(default = "d_realm")]
    realm: String,
    #[serde(default = "d_true")]
    hide_credentials: bool,
    #[serde(default)]
    anonymous: Option<String>,
}

/// Successful password checks, remembered for a minute so the cost of the
/// password hash is not paid on every request. Keyed by a keyed hash of the
/// credentials, so the cache never holds anything that can be replayed.
pub struct VerifiedCache {
    salt: [u8; 32],
    entries: DashMap<String, (String, Instant)>,
}

impl Default for VerifiedCache {
    fn default() -> Self {
        let mut salt = [0u8; 32];
        openssl::rand::rand_bytes(&mut salt).expect("the system random source works");
        Self { salt, entries: DashMap::new() }
    }
}

const VERIFIED_FOR: Duration = Duration::from_secs(60);

impl VerifiedCache {
    fn key(&self, username: &str, password: &str) -> String {
        let key = PKey::hmac(&self.salt).expect("an HMAC key of any length is valid");
        let mut signer = Signer::new(MessageDigest::sha256(), &key).expect("HMAC-SHA256 is available");
        let _ = signer.update(username.as_bytes()).and_then(|()| signer.update(&[0])).and_then(|()| signer.update(password.as_bytes()));
        hex(&signer.sign_to_vec().unwrap_or_default())
    }

    fn get(&self, key: &str) -> Option<String> {
        self.entries.get(key).filter(|e| e.1.elapsed() < VERIFIED_FOR).map(|e| e.0.clone())
    }

    fn put(&self, key: String, consumer_id: String) {
        // A flood of distinct valid logins is not expected; if it happens, start over.
        if self.entries.len() > 50_000 {
            self.entries.clear();
        }
        self.entries.insert(key, (consumer_id, Instant::now()));
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Checks a password against an argon2 hash. Deliberately slow, so it runs off
/// the request workers.
async fn argon2_matches(hash: String, password: String) -> bool {
    tokio::task::spawn_blocking(move || {
        use argon2::{Argon2, PasswordVerifier};
        argon2::PasswordHash::new(&hash).is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
    })
    .await
    .unwrap_or(false)
}

impl BasicAuth {
    fn challenge(&self) -> Option<String> {
        Some(format!("Basic realm=\"{}\", charset=\"UTF-8\"", self.realm))
    }

    pub async fn check(&self, req: &Req<'_>, snapshot: &Snapshot, cache: &VerifiedCache, effects: &mut AuthEffects) -> AuthOutcome {
        let encoded = req.header("authorization").and_then(|v| v.split_once(' ')).filter(|(scheme, _)| scheme.eq_ignore_ascii_case("basic")).map(|(_, rest)| rest.trim());
        let Some(encoded) = encoded else { return AuthOutcome::NoCredential { anonymous: self.anonymous.clone(), challenge: self.challenge() } };
        if self.hide_credentials {
            effects.strip_headers.push("authorization".into());
        }
        let invalid = || AuthOutcome::Invalid { challenge: self.challenge() };
        let Some(decoded) = STANDARD.decode(encoded).ok().and_then(|b| String::from_utf8(b).ok()) else { return invalid() };
        let Some((username, password)) = decoded.split_once(':') else { return invalid() };

        let candidates = snapshot.consumers.basic(username, req.workspace_id, req.system_route, req.now);
        if candidates.is_empty() {
            return invalid();
        }
        let cache_key = cache.key(username, password);
        if let Some(consumer_id) = cache.get(&cache_key)
            && let Some(hit) = candidates.iter().find(|c| c.consumer.id == consumer_id)
        {
            return AuthOutcome::Authenticated { consumer: Some(hit.consumer.clone()), claims: None };
        }
        for candidate in candidates {
            let matches = match &candidate.password {
                PasswordHash::Sha256(expected) => openssl::memcmp::eq(expected.as_bytes(), sha256_hex(password.as_bytes()).as_bytes()),
                PasswordHash::Argon2(hash) => argon2_matches(hash.clone(), password.to_string()).await,
            };
            if matches {
                cache.put(cache_key, candidate.consumer.id.clone());
                return AuthOutcome::Authenticated { consumer: Some(candidate.consumer.clone()), claims: None };
            }
        }
        invalid()
    }
}

// ── jwt_auth ─────────────────────────────────────────────────────────────────

fn d_algorithms() -> Vec<String> {
    vec!["RS256".into(), "ES256".into()]
}
fn d_leeway() -> i64 {
    60
}
fn d_sources() -> Vec<String> {
    vec!["header:Authorization".into()]
}
fn d_jwks_cache() -> u64 {
    300
}

#[derive(Debug, Deserialize)]
struct JwtConfig {
    issuer: String,
    #[serde(default)]
    audiences: Vec<String>,
    #[serde(default)]
    jwks_url: Option<String>,
    #[serde(default)]
    jwks: Option<Value>,
    #[serde(default)]
    secret: Option<Value>,
    #[serde(default = "d_algorithms")]
    algorithms: Vec<String>,
    #[serde(default = "d_leeway")]
    leeway_secs: i64,
    #[serde(default = "d_sources")]
    token_sources: Vec<String>,
    #[serde(default = "d_true")]
    required: bool,
    #[serde(default)]
    consumer_claim: Option<String>,
    #[serde(default)]
    claims_to_headers: std::collections::BTreeMap<String, String>,
    #[serde(default = "d_jwks_cache")]
    jwks_cache_secs: u64,
    #[serde(default)]
    anonymous: Option<String>,
}

/// One verification key from a key set.
pub struct Jwk {
    kid: Option<String>,
    key: PKey<Public>,
}

fn b64url(value: &Value, field: &str) -> Result<Vec<u8>, String> {
    let text = value.get(field).and_then(Value::as_str).ok_or_else(|| format!("the key has no '{field}'"))?;
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).map_err(|_| format!("'{field}' is not base64url"))
}

fn parse_jwk(value: &Value) -> Result<Jwk, String> {
    let bad = |e: openssl::error::ErrorStack| format!("unusable key: {e}");
    let key = match value.get("kty").and_then(Value::as_str) {
        Some("RSA") => {
            let (n, e) = (BigNum::from_slice(&b64url(value, "n")?).map_err(bad)?, BigNum::from_slice(&b64url(value, "e")?).map_err(bad)?);
            PKey::from_rsa(Rsa::from_public_components(n, e).map_err(bad)?).map_err(bad)?
        }
        Some("EC") => {
            let nid = match value.get("crv").and_then(Value::as_str) {
                Some("P-256") => Nid::X9_62_PRIME256V1,
                Some("P-384") => Nid::SECP384R1,
                other => return Err(format!("unsupported curve {other:?}")),
            };
            let group = EcGroup::from_curve_name(nid).map_err(bad)?;
            let (x, y) = (BigNum::from_slice(&b64url(value, "x")?).map_err(bad)?, BigNum::from_slice(&b64url(value, "y")?).map_err(bad)?);
            PKey::from_ec_key(EcKey::from_public_key_affine_coordinates(&group, &x, &y).map_err(bad)?).map_err(bad)?
        }
        Some("OKP") if value.get("crv").and_then(Value::as_str) == Some("Ed25519") => PKey::public_key_from_raw_bytes(&b64url(value, "x")?, Id::ED25519).map_err(bad)?,
        other => return Err(format!("unsupported key type {other:?}")),
    };
    Ok(Jwk { kid: value.get("kid").and_then(Value::as_str).map(str::to_string), key })
}

/// Parses a JSON Web Key Set. Keys of a kind this build cannot use are skipped.
pub fn parse_jwks(set: &Value) -> Vec<Jwk> {
    set.get("keys").and_then(Value::as_array).map(|keys| keys.iter().filter_map(|k| parse_jwk(k).ok()).collect()).unwrap_or_default()
}

/// A key set published at a URL, cached and refreshed (spec §9.4).
pub struct RemoteJwks {
    url: String,
    cache_for: Duration,
    http: reqwest::Client,
    keys: ArcSwap<Vec<Jwk>>,
    /// When the set was last fetched, and when a fetch was last tried.
    times: tokio::sync::Mutex<(Option<Instant>, Option<Instant>)>,
}

/// An unknown key id triggers a refresh at most this often.
const REFRESH_AT_MOST_EVERY: Duration = Duration::from_secs(30);

impl RemoteJwks {
    async fn fetch(&self) -> Result<Vec<Jwk>, String> {
        let res = self.http.get(&self.url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("status {}", res.status()));
        }
        let keys = parse_jwks(&res.json::<Value>().await.map_err(|e| e.to_string())?);
        if keys.is_empty() { Err("the key set holds no usable key".into()) } else { Ok(keys) }
    }

    /// The keys to verify with. `refresh` asks for a fresh copy because the
    /// token names a key the cached set does not hold.
    async fn current(self: &Arc<Self>, refresh: bool) -> Option<Arc<Vec<Jwk>>> {
        let mut times = self.times.lock().await;
        let (fetched, tried) = *times;
        let may_try = tried.is_none_or(|at| at.elapsed() >= REFRESH_AT_MOST_EVERY);
        let stale = fetched.is_none_or(|at| at.elapsed() >= self.cache_for);
        if (fetched.is_none() || refresh || stale) && may_try {
            times.1 = Some(Instant::now());
            match self.fetch().await {
                Ok(keys) => {
                    self.keys.store(Arc::new(keys));
                    times.0 = Some(Instant::now());
                }
                // A failed refresh keeps the cached set in use.
                Err(error) => tracing::warn!(url = %self.url, %error, "the signing keys could not be fetched"),
            }
        }
        times.0.map(|_| self.keys.load_full())
    }
}

enum Keys {
    Secret(Vec<u8>),
    Static(Arc<Vec<Jwk>>),
    Remote(Arc<RemoteJwks>),
}

pub struct JwtAuth {
    config: JwtConfig,
    keys: Keys,
}

impl std::fmt::Debug for JwtAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JwtAuth").field("issuer", &self.config.issuer).finish_non_exhaustive()
    }
}

/// Checks one signature. `input` is the signed part of the token.
fn signature_valid(alg: &str, key: &PKey<Public>, input: &[u8], signature: &[u8]) -> bool {
    let attempt = || -> Result<bool, openssl::error::ErrorStack> {
        match (alg, key.id()) {
            ("RS256" | "RS384" | "RS512", Id::RSA) => {
                let digest = match alg {
                    "RS256" => MessageDigest::sha256(),
                    "RS384" => MessageDigest::sha384(),
                    _ => MessageDigest::sha512(),
                };
                let mut verifier = Verifier::new(digest, key)?;
                verifier.update(input)?;
                verifier.verify(signature)
            }
            ("ES256" | "ES384", Id::EC) => {
                let (digest, size, curve) = if alg == "ES256" { (MessageDigest::sha256(), 32, Nid::X9_62_PRIME256V1) } else { (MessageDigest::sha384(), 48, Nid::SECP384R1) };
                // The key's curve must be the one the algorithm names.
                if signature.len() != size * 2 || key.ec_key()?.group().curve_name() != Some(curve) {
                    return Ok(false);
                }
                let der = EcdsaSig::from_private_components(BigNum::from_slice(&signature[..size])?, BigNum::from_slice(&signature[size..])?)?.to_der()?;
                let mut verifier = Verifier::new(digest, key)?;
                verifier.update(input)?;
                verifier.verify(&der)
            }
            ("EdDSA", Id::ED25519) => Verifier::new_without_digest(key)?.verify_oneshot(signature, input),
            _ => Ok(false),
        }
    };
    attempt().unwrap_or(false)
}

fn hmac_valid(secret: &[u8], input: &[u8], signature: &[u8]) -> bool {
    let Ok(key) = PKey::hmac(secret) else { return false };
    let expected = Signer::new(MessageDigest::sha256(), &key).and_then(|mut s| {
        s.update(input)?;
        s.sign_to_vec()
    });
    expected.is_ok_and(|e| e.len() == signature.len() && openssl::memcmp::eq(&e, signature))
}

fn claim_text(claims: &Value, name: &str) -> Option<String> {
    match claims.get(name)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

impl JwtAuth {
    /// Builds the plugin. `secret` resolves a secret-typed value (spec §9.6).
    pub fn build(config: &Value, secret: &dyn Fn(&Value) -> Result<String, String>) -> Result<Self, String> {
        let config: JwtConfig = serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
        let keys = match (&config.secret, &config.jwks, &config.jwks_url) {
            (Some(value), None, None) => Keys::Secret(secret(value)?.into_bytes()),
            (None, Some(set), None) => {
                let keys = parse_jwks(set);
                if keys.is_empty() {
                    return Err("jwks holds no usable key".into());
                }
                Keys::Static(Arc::new(keys))
            }
            (None, None, Some(url)) => Keys::Remote(Arc::new(RemoteJwks {
                url: url.clone(),
                cache_for: Duration::from_secs(config.jwks_cache_secs),
                http: reqwest::Client::builder().timeout(Duration::from_secs(5)).connect_timeout(Duration::from_secs(3)).build().map_err(|e| e.to_string())?,
                keys: ArcSwap::from_pointee(Vec::new()),
                times: tokio::sync::Mutex::new((None, None)),
            })),
            _ => return Err("exactly one of jwks_url, jwks and secret must be set".into()),
        };
        // A shared secret verifies HS256 and nothing else; public keys never verify HS256.
        let hmac_listed = config.algorithms.iter().any(|a| a == "HS256");
        if matches!(keys, Keys::Secret(_)) != hmac_listed || (hmac_listed && config.algorithms.len() > 1) {
            return Err("HS256 goes with 'secret' and nothing else; the other algorithms go with jwks or jwks_url".into());
        }
        Ok(Self { config, keys })
    }

    fn token(&self, req: &Req<'_>) -> Option<String> {
        self.config.token_sources.iter().find_map(|source| {
            let (kind, name) = source.split_once(':')?;
            let value = match kind {
                "header" => {
                    let raw = req.header(name)?;
                    // The usual form is `Bearer <token>`; a bare token is accepted too.
                    raw.split_once(' ').filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer")).map_or(raw, |(_, t)| t.trim())
                }
                "query" => req.query_param(name)?,
                "cookie" => req.cookie(name)?,
                _ => return None,
            };
            (!value.is_empty()).then(|| value.to_string())
        })
    }

    pub async fn check(&self, req: &Req<'_>, snapshot: &Snapshot, effects: &mut AuthEffects) -> AuthOutcome {
        let challenge = || Some("Bearer".to_string());
        let Some(token) = self.token(req) else {
            return if self.config.required {
                AuthOutcome::NoCredential { anonymous: self.config.anonymous.clone(), challenge: challenge() }
            } else {
                AuthOutcome::Authenticated { consumer: None, claims: None }
            };
        };
        let invalid = || AuthOutcome::Invalid { challenge: Some("Bearer error=\"invalid_token\"".to_string()) };

        let mut parts = token.split('.');
        let (Some(head64), Some(body64), Some(sig64), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return invalid() };
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok();
        let (Some(head), Some(body), Some(signature)) = (decode(head64), decode(body64), decode(sig64)) else { return invalid() };
        let (Ok(head), Ok(claims)) = (serde_json::from_slice::<Value>(&head), serde_json::from_slice::<Value>(&body)) else { return invalid() };
        let alg = head.get("alg").and_then(Value::as_str).unwrap_or_default();
        // Only the listed algorithms; "none" is not in the schema and never passes.
        if !self.config.algorithms.iter().any(|a| a == alg) {
            return invalid();
        }
        let kid = head.get("kid").and_then(Value::as_str);
        let input = format!("{head64}.{body64}");

        let signed = match &self.keys {
            Keys::Secret(secret) => alg == "HS256" && hmac_valid(secret, input.as_bytes(), &signature),
            Keys::Static(keys) => verify_with(keys, kid, alg, input.as_bytes(), &signature),
            Keys::Remote(remote) => {
                let Some(mut keys) = remote.current(false).await else { return AuthOutcome::Unavailable };
                if kid.is_some_and(|k| !keys.iter().any(|j| j.kid.as_deref() == Some(k))) {
                    // A key we have not seen: the issuer may have rotated.
                    keys = remote.current(true).await.unwrap_or(keys);
                }
                verify_with(&keys, kid, alg, input.as_bytes(), &signature)
            }
        };
        if !signed {
            return invalid();
        }

        let leeway = self.config.leeway_secs;
        let number = |name: &str| claims.get(name).and_then(Value::as_f64).map(|n| n as i64);
        if number("exp").is_some_and(|exp| req.now > exp + leeway) || number("nbf").is_some_and(|nbf| req.now < nbf - leeway) {
            return invalid();
        }
        if claims.get("iss").and_then(Value::as_str) != Some(self.config.issuer.as_str()) {
            return invalid();
        }
        if !self.config.audiences.is_empty() {
            let accepted = |aud: &str| self.config.audiences.iter().any(|a| a == aud);
            let ok = match claims.get("aud") {
                Some(Value::String(aud)) => accepted(aud),
                Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).any(accepted),
                _ => false,
            };
            if !ok {
                return invalid();
            }
        }

        let consumer = match &self.config.consumer_claim {
            None => None,
            Some(claim) => match claim_text(&claims, claim).and_then(|id| snapshot.consumers.by_custom_id(req.workspace_id, &id).cloned()) {
                Some(consumer) => Some(consumer),
                // A valid token for nobody we know.
                None => return invalid(),
            },
        };
        for (claim, header) in &self.config.claims_to_headers {
            if let Some(value) = claim_text(&claims, claim) {
                effects.set_headers.push((header.to_ascii_lowercase(), value));
            }
        }
        AuthOutcome::Authenticated { consumer, claims: Some(claims) }
    }
}

fn verify_with(keys: &[Jwk], kid: Option<&str>, alg: &str, input: &[u8], signature: &[u8]) -> bool {
    keys.iter().filter(|k| kid.is_none() || k.kid.as_deref() == kid).any(|k| signature_valid(alg, &k.key, input, signature))
}

#[cfg(test)]
mod tests {
    use super::*;
    use apg_core::model::ChangeEvent;
    use apg_core::resources::Resources;
    use http::HeaderMap;
    use openssl::pkey::Private;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000;

    fn snapshot() -> Snapshot {
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("consumer", "c1", Some("w".into()), json!({ "name": "app", "custom_id": "client-42", "groups": ["partners"] })));
        r.apply(&ChangeEvent::upsert("credential", "k1", Some("w".into()), json!({ "type": "key", "consumer_id": "c1", "key_hash": sha256_hex(b"apg_k_valid") })));
        r.apply(&ChangeEvent::upsert("credential", "b1", Some("w".into()), json!({ "type": "basic", "consumer_id": "c1", "username": "app", "password_sha256": sha256_hex(b"correct-horse") })));
        let hash = {
            use argon2::PasswordHasher;
            argon2::Argon2::default().hash_password(b"slow-but-sure", &argon2::password_hash::SaltString::from_b64("c29tZXNhbHRzb21lc2FsdA").unwrap()).unwrap().to_string()
        };
        r.apply(&ChangeEvent::upsert("credential", "b2", Some("w".into()), json!({ "type": "basic", "consumer_id": "c1", "username": "hashed", "password_hash": hash })));
        Snapshot::build(&r)
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        h
    }

    fn req<'a>(headers: &'a HeaderMap, query: &'a str) -> Req<'a> {
        Req { method: "GET", host: "h", path: "/", query, client_ip: "203.0.113.9", headers, workspace_id: "w", system_route: true, now: NOW }
    }

    fn consumer_of(outcome: &AuthOutcome) -> Option<&str> {
        match outcome {
            AuthOutcome::Authenticated { consumer: Some(c), .. } => Some(c.name.as_str()),
            _ => None,
        }
    }

    #[test]
    fn key_auth_finds_the_key_in_a_header_or_the_query_and_hides_it() {
        let snap = snapshot();
        let plugin: KeyAuth = serde_json::from_value(json!({ "in_query": true, "key_names": ["x-api-key", "apikey"] })).unwrap();
        let mut effects = AuthEffects::default();
        let h = headers(&[("x-api-key", "apg_k_valid")]);
        assert_eq!(consumer_of(&plugin.check(&req(&h, ""), &snap, &mut effects)), Some("app"));
        assert_eq!(effects.strip_headers, ["x-api-key"]);

        let mut effects = AuthEffects::default();
        let none = HeaderMap::new();
        assert_eq!(consumer_of(&plugin.check(&req(&none, "a=1&apikey=apg_k_valid"), &snap, &mut effects)), Some("app"));
        assert_eq!(effects.strip_query, ["apikey"]);

        assert!(matches!(plugin.check(&req(&headers(&[("x-api-key", "apg_k_wrong")]), ""), &snap, &mut AuthEffects::default()), AuthOutcome::Invalid { .. }));
        assert!(matches!(plugin.check(&req(&none, ""), &snap, &mut AuthEffects::default()), AuthOutcome::NoCredential { anonymous: None, .. }));

        // Query keys are off unless asked for; hiding can be switched off.
        let strict: KeyAuth = serde_json::from_value(json!({ "hide_credentials": false })).unwrap();
        assert!(matches!(strict.check(&req(&none, "x-api-key=apg_k_valid"), &snap, &mut AuthEffects::default()), AuthOutcome::NoCredential { .. }));
        let mut kept = AuthEffects::default();
        strict.check(&req(&h, ""), &snap, &mut kept);
        assert!(kept.strip_headers.is_empty());
    }

    #[tokio::test]
    async fn basic_auth_checks_the_password_and_remembers_a_success() {
        let snap = snapshot();
        let plugin: BasicAuth = serde_json::from_value(json!({})).unwrap();
        let cache = VerifiedCache::default();
        let basic = |user: &str, pass: &str| headers(&[("authorization", &format!("Basic {}", STANDARD.encode(format!("{user}:{pass}"))))]);

        let mut effects = AuthEffects::default();
        assert_eq!(consumer_of(&plugin.check(&req(&basic("app", "correct-horse"), ""), &snap, &cache, &mut effects).await), Some("app"));
        assert_eq!(effects.strip_headers, ["authorization"]);
        assert!(matches!(plugin.check(&req(&basic("app", "wrong"), ""), &snap, &cache, &mut AuthEffects::default()).await, AuthOutcome::Invalid { .. }));
        assert!(matches!(plugin.check(&req(&basic("nobody", "correct-horse"), ""), &snap, &cache, &mut AuthEffects::default()).await, AuthOutcome::Invalid { .. }));
        assert!(matches!(plugin.check(&req(&headers(&[("authorization", "Basic !!!")]), ""), &snap, &cache, &mut AuthEffects::default()).await, AuthOutcome::Invalid { .. }));

        // A password stored as an argon2 hash by the control plane.
        assert_eq!(consumer_of(&plugin.check(&req(&basic("hashed", "slow-but-sure"), ""), &snap, &cache, &mut AuthEffects::default()).await), Some("app"));
        assert_eq!(cache.entries.len(), 2, "both successes are remembered");
        assert!(matches!(plugin.check(&req(&basic("hashed", "nope"), ""), &snap, &cache, &mut AuthEffects::default()).await, AuthOutcome::Invalid { .. }));
        assert_eq!(cache.entries.len(), 2, "a failure is never remembered");
        // The cache key reveals nothing and differs per password.
        assert_ne!(cache.key("app", "a"), cache.key("app", "b"));
        assert_ne!(cache.key("ab", "c"), cache.key("a", "bc"));

        // No credentials: a challenge naming the realm; another scheme's header is not ours.
        match plugin.check(&req(&headers(&[("authorization", "Bearer abc")]), ""), &snap, &cache, &mut AuthEffects::default()).await {
            AuthOutcome::NoCredential { challenge: Some(c), .. } => assert!(c.contains("realm=\"api\"")),
            other => panic!("{other:?}"),
        }
    }

    fn sign_es256(key: &EcKey<Private>, input: &[u8]) -> Vec<u8> {
        let sig = EcdsaSig::sign(&openssl::sha::sha256(input), key).unwrap();
        let mut out = sig.r().to_vec_padded(32).unwrap();
        out.extend(sig.s().to_vec_padded(32).unwrap());
        out
    }

    fn token(head: Value, claims: Value, sign: &dyn Fn(&[u8]) -> Vec<u8>) -> String {
        let input = format!("{}.{}", URL_SAFE_NO_PAD.encode(head.to_string()), URL_SAFE_NO_PAD.encode(claims.to_string()));
        let signature = sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    fn ec_fixture() -> (EcKey<Private>, Value) {
        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        let key = EcKey::generate(&group).unwrap();
        let (mut x, mut y, mut ctx) = (BigNum::new().unwrap(), BigNum::new().unwrap(), openssl::bn::BigNumContext::new().unwrap());
        key.public_key().affine_coordinates(&group, &mut x, &mut y, &mut ctx).unwrap();
        let jwk = json!({ "kty": "EC", "crv": "P-256", "kid": "k1", "x": URL_SAFE_NO_PAD.encode(x.to_vec_padded(32).unwrap()), "y": URL_SAFE_NO_PAD.encode(y.to_vec_padded(32).unwrap()) });
        (key, jwk)
    }

    #[tokio::test]
    async fn jwt_auth_verifies_signature_times_issuer_and_audience() {
        let snap = snapshot();
        let (key, jwk) = ec_fixture();
        let plugin = JwtAuth::build(
            &json!({ "issuer": "https://idp.example", "audiences": ["api"], "jwks": { "keys": [jwk] }, "algorithms": ["ES256"], "consumer_claim": "sub", "claims_to_headers": { "tenant": "X-Tenant" } }),
            &|_| Err("no secret here".into()),
        )
        .unwrap();
        let good = json!({ "iss": "https://idp.example", "aud": ["api", "other"], "sub": "client-42", "tenant": "acme", "exp": NOW + 300, "nbf": NOW - 10 });
        let es = |input: &[u8]| sign_es256(&key, input);
        let check = |token: String| {
            let h = headers(&[("authorization", &format!("Bearer {token}"))]);
            let plugin = &plugin;
            let snap = &snap;
            async move {
                let mut effects = AuthEffects::default();
                let outcome = plugin.check(&req(&h, ""), snap, &mut effects).await;
                (outcome, effects)
            }
        };
        let head = json!({ "alg": "ES256", "kid": "k1" });

        let (outcome, effects) = check(token(head.clone(), good.clone(), &es)).await;
        assert_eq!(consumer_of(&outcome), Some("app"));
        assert_eq!(effects.set_headers, [("x-tenant".to_string(), "acme".to_string())]);

        let with = |change: &dyn Fn(&mut Value)| {
            let mut claims = good.clone();
            change(&mut claims);
            claims
        };
        let rejected: Vec<(&str, String)> = vec![
            ("expired", token(head.clone(), with(&|c| c["exp"] = json!(NOW - 120)), &es)),
            ("not yet valid", token(head.clone(), with(&|c| c["nbf"] = json!(NOW + 120)), &es)),
            ("wrong issuer", token(head.clone(), with(&|c| c["iss"] = json!("https://evil.example")), &es)),
            ("wrong audience", token(head.clone(), with(&|c| c["aud"] = json!("someone-else")), &es)),
            ("unknown consumer", token(head.clone(), with(&|c| c["sub"] = json!("stranger")), &es)),
            ("algorithm none", token(json!({ "alg": "none" }), good.clone(), &|_| Vec::new())),
            ("algorithm not listed", token(json!({ "alg": "HS256" }), good.clone(), &|i| i.to_vec())),
            ("unknown key id", token(json!({ "alg": "ES256", "kid": "other" }), good.clone(), &es)),
            ("tampered", {
                let t = token(head.clone(), good.clone(), &es);
                let (signed, sig) = t.rsplit_once('.').unwrap();
                format!("{}.{sig}", signed.replace(&URL_SAFE_NO_PAD.encode(good.to_string()), &URL_SAFE_NO_PAD.encode(with(&|c| c["sub"] = json!("admin")).to_string())))
            }),
            ("not a token", "abc.def".to_string()),
        ];
        for (why, t) in rejected {
            assert!(matches!(check(t).await.0, AuthOutcome::Invalid { .. }), "{why}");
        }
        // Inside the leeway an expired token still passes.
        assert_eq!(consumer_of(&check(token(head, with(&|c| c["exp"] = json!(NOW - 30)), &es)).await.0), Some("app"));

        // No token at all.
        let none = HeaderMap::new();
        assert!(matches!(plugin.check(&req(&none, ""), &snap, &mut AuthEffects::default()).await, AuthOutcome::NoCredential { .. }));
    }

    #[tokio::test]
    async fn jwt_auth_with_a_shared_secret_and_other_token_sources() {
        let snap = snapshot();
        let plugin = JwtAuth::build(&json!({ "issuer": "me", "secret": { "$env": "APG_SECRET_JWT" }, "algorithms": ["HS256"], "token_sources": ["query:access_token", "cookie:session"], "required": false }), &|_| Ok("top-secret".into())).unwrap();
        let hs = |input: &[u8]| {
            let key = PKey::hmac(b"top-secret").unwrap();
            let mut s = Signer::new(MessageDigest::sha256(), &key).unwrap();
            s.update(input).unwrap();
            s.sign_to_vec().unwrap()
        };
        let t = token(json!({ "alg": "HS256" }), json!({ "iss": "me" }), &hs);
        let none = HeaderMap::new();
        let query = format!("access_token={t}");
        assert!(matches!(plugin.check(&req(&none, &query), &snap, &mut AuthEffects::default()).await, AuthOutcome::Authenticated { consumer: None, claims: Some(_) }));
        let cookie = headers(&[("cookie", &format!("theme=dark; session={t}"))]);
        assert!(matches!(plugin.check(&req(&cookie, ""), &snap, &mut AuthEffects::default()).await, AuthOutcome::Authenticated { .. }));
        // Signed with another secret.
        let forged = token(json!({ "alg": "HS256" }), json!({ "iss": "me" }), &|i| {
            let key = PKey::hmac(b"guess").unwrap();
            let mut s = Signer::new(MessageDigest::sha256(), &key).unwrap();
            s.update(i).unwrap();
            s.sign_to_vec().unwrap()
        });
        assert!(matches!(plugin.check(&req(&none, &format!("access_token={forged}")), &snap, &mut AuthEffects::default()).await, AuthOutcome::Invalid { .. }));
        // Not required: a request without a token passes, unauthenticated.
        assert!(matches!(plugin.check(&req(&none, ""), &snap, &mut AuthEffects::default()).await, AuthOutcome::Authenticated { consumer: None, claims: None }));
    }

    #[test]
    fn jwt_configuration_that_would_be_unsafe_is_refused() {
        let (_, jwk) = ec_fixture();
        let secret = |_: &Value| Ok("s".to_string());
        // A public key set must never be usable as an HMAC secret.
        assert!(JwtAuth::build(&json!({ "issuer": "i", "jwks": { "keys": [jwk] }, "algorithms": ["HS256"] }), &secret).is_err());
        assert!(JwtAuth::build(&json!({ "issuer": "i", "secret": { "$env": "X" }, "algorithms": ["RS256"] }), &secret).is_err());
        assert!(JwtAuth::build(&json!({ "issuer": "i", "secret": { "$env": "X" }, "algorithms": ["HS256", "RS256"] }), &secret).is_err());
        assert!(JwtAuth::build(&json!({ "issuer": "i", "jwks": { "keys": [{ "kty": "oct", "k": "abc" }] } }), &secret).is_err());
        assert!(JwtAuth::build(&json!({ "issuer": "i" }), &secret).is_err());
        assert!(JwtAuth::build(&json!({ "issuer": "i", "secret": { "$env": "X" }, "algorithms": ["HS256"] }), &|_| Err("unset".into())).is_err());
    }

    #[test]
    fn rsa_and_ed25519_keys_verify() {
        let rsa = Rsa::generate(2048).unwrap();
        let jwk = json!({ "kty": "RSA", "n": URL_SAFE_NO_PAD.encode(rsa.n().to_vec()), "e": URL_SAFE_NO_PAD.encode(rsa.e().to_vec()) });
        let public = parse_jwk(&jwk).unwrap().key;
        let private = PKey::from_rsa(rsa).unwrap();
        for (alg, digest) in [("RS256", MessageDigest::sha256()), ("RS384", MessageDigest::sha384()), ("RS512", MessageDigest::sha512())] {
            let mut signer = Signer::new(digest, &private).unwrap();
            signer.update(b"a.b").unwrap();
            let signature = signer.sign_to_vec().unwrap();
            assert!(signature_valid(alg, &public, b"a.b", &signature), "{alg}");
            assert!(!signature_valid(alg, &public, b"a.c", &signature), "{alg}");
        }
        // An RSA key does not verify an EC algorithm.
        assert!(!signature_valid("ES256", &public, b"a.b", &[0u8; 64]));

        let ed = PKey::generate_ed25519().unwrap();
        let jwk = json!({ "kty": "OKP", "crv": "Ed25519", "x": URL_SAFE_NO_PAD.encode(ed.raw_public_key().unwrap()) });
        let public = parse_jwk(&jwk).unwrap().key;
        let signature = Signer::new_without_digest(&ed).unwrap().sign_oneshot_to_vec(b"a.b").unwrap();
        assert!(signature_valid("EdDSA", &public, b"a.b", &signature));
        assert!(!signature_valid("EdDSA", &public, b"a.x", &signature));
        assert_eq!(parse_jwks(&json!({ "keys": [{ "kty": "oct" }, jwk] })).len(), 1, "unusable keys are skipped");
    }
}
