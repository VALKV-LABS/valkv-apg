//! Consumers and their credentials, indexed for the request path (spec §10).
//!
//! Nodes hold hashes only (spec CON-4). Looking a presented key up is one
//! hash-map hit on its SHA-256 (spec CON-3).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::resources::Resources;

/// An identified caller.
#[derive(Debug, Clone, PartialEq)]
pub struct Consumer {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    /// The external identity, for example a JWT `sub`.
    pub custom_id: Option<String>,
    pub groups: Vec<String>,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct ConsumerSpec {
    name: String,
    #[serde(default)]
    custom_id: Option<String>,
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
}

fn d_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct CredentialSpec {
    #[serde(rename = "type")]
    kind: String,
    consumer_id: String,
    #[serde(default)]
    key_hash: Option<String>,
    #[serde(default)]
    username: Option<String>,
    /// An argon2id hash, as the control plane stores it.
    #[serde(default)]
    password_hash: Option<String>,
    /// SHA-256 of the password: what the file loader derives from a password written in the file.
    #[serde(default)]
    password_sha256: Option<String>,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default = "d_true")]
    enabled: bool,
    #[serde(default)]
    expires_at: Option<String>,
}

/// How a `basic` credential's password is checked.
#[derive(Debug, Clone, PartialEq)]
pub enum PasswordHash {
    Argon2(String),
    Sha256(String),
}

/// One `basic` credential.
#[derive(Debug, Clone)]
pub struct BasicCredential {
    pub consumer: Arc<Consumer>,
    pub password: PasswordHash,
    expires_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct Held {
    consumer: Arc<Consumer>,
    expires_at: Option<i64>,
}

/// Every consumer and credential.
#[derive(Debug, Default)]
pub struct ConsumerIndex {
    by_id: HashMap<String, Arc<Consumer>>,
    /// Workspace id and name.
    by_name: HashMap<(String, String), Arc<Consumer>>,
    /// Workspace id and custom id.
    by_custom_id: HashMap<(String, String), Arc<Consumer>>,
    keys: HashMap<String, Vec<Held>>,
    basic: HashMap<String, Vec<BasicCredential>>,
    mtls: HashMap<String, Vec<Held>>,
}

/// Lower-case hex SHA-256.
pub fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

/// Seconds since the epoch for an RFC 3339 timestamp such as
/// `2026-01-31T12:00:00Z` or `2026-01-31T12:00:00.5+02:00`.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| s.get(from..to)?.parse::<i64>().ok();
    let (y, m, d, h, mi, sec) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut rest = &s[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        rest = fraction.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let (oh, om) = rest[1..].split_once(':')?;
            sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60)
        }
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

/// Whether a credential of `consumer` may be used on a route (spec CON-1).
fn usable(consumer: &Consumer, route_workspace: &str, system_route: bool) -> bool {
    system_route || consumer.workspace_id == route_workspace
}

impl ConsumerIndex {
    /// Builds the index. Returns it with the number of resources that could not be decoded.
    pub fn build(resources: &Resources) -> (Self, usize) {
        let mut index = Self::default();
        let mut undecodable = 0;
        for (id, stored) in resources.kind("consumer") {
            let (Ok(spec), Some(ws)) = (serde_json::from_value::<ConsumerSpec>(stored.data.clone()), &stored.workspace_id) else {
                undecodable += 1;
                continue;
            };
            let consumer = Arc::new(Consumer { id: id.clone(), workspace_id: ws.clone(), name: spec.name, custom_id: spec.custom_id, groups: spec.groups, labels: spec.labels.unwrap_or_default() });
            index.by_name.insert((ws.clone(), consumer.name.clone()), consumer.clone());
            if let Some(custom) = &consumer.custom_id {
                index.by_custom_id.insert((ws.clone(), custom.clone()), consumer.clone());
            }
            index.by_id.insert(id.clone(), consumer);
        }
        for (_, stored) in resources.kind("credential") {
            let Ok(spec) = serde_json::from_value::<CredentialSpec>(stored.data.clone()) else {
                undecodable += 1;
                continue;
            };
            // A credential whose consumer is gone, or that is switched off, opens nothing.
            let Some(consumer) = index.by_id.get(&spec.consumer_id).cloned() else { continue };
            if !spec.enabled {
                continue;
            }
            // An expiry that cannot be read is treated as already passed.
            let expires_at = spec.expires_at.as_deref().map(|text| parse_rfc3339(text).unwrap_or(0));
            let held = Held { consumer: consumer.clone(), expires_at };
            match (spec.kind.as_str(), spec.key_hash, spec.username, spec.identity) {
                ("key", Some(hash), _, _) => index.keys.entry(hash.to_ascii_lowercase()).or_default().push(held),
                ("basic", _, Some(username), _) => {
                    let password = match (spec.password_hash, spec.password_sha256) {
                        (Some(h), _) => PasswordHash::Argon2(h),
                        (None, Some(h)) => PasswordHash::Sha256(h.to_ascii_lowercase()),
                        (None, None) => continue,
                    };
                    index.basic.entry(username).or_default().push(BasicCredential { consumer, password, expires_at });
                }
                ("mtls", _, _, Some(identity)) => index.mtls.entry(identity).or_default().push(held),
                _ => undecodable += 1,
            }
        }
        (index, undecodable)
    }

    pub fn get(&self, id: &str) -> Option<&Arc<Consumer>> {
        self.by_id.get(id)
    }

    pub fn by_name(&self, workspace_id: &str, name: &str) -> Option<&Arc<Consumer>> {
        self.by_name.get(&(workspace_id.to_string(), name.to_string()))
    }

    pub fn by_custom_id(&self, workspace_id: &str, custom_id: &str) -> Option<&Arc<Consumer>> {
        self.by_custom_id.get(&(workspace_id.to_string(), custom_id.to_string()))
    }

    fn first<'a>(held: Option<&'a Vec<Held>>, route_workspace: &str, system_route: bool, now: i64) -> Option<&'a Arc<Consumer>> {
        held?.iter().find(|h| h.expires_at.is_none_or(|t| t > now) && usable(&h.consumer, route_workspace, system_route)).map(|h| &h.consumer)
    }

    /// The consumer an API key belongs to, if the key is known, unexpired and
    /// usable on this route.
    pub fn by_key(&self, presented: &str, route_workspace: &str, system_route: bool, now: i64) -> Option<&Arc<Consumer>> {
        Self::first(self.keys.get(&sha256_hex(presented.as_bytes())), route_workspace, system_route, now)
    }

    /// The consumer a client-certificate identity belongs to.
    pub fn by_mtls_identity(&self, identity: &str, route_workspace: &str, system_route: bool, now: i64) -> Option<&Arc<Consumer>> {
        Self::first(self.mtls.get(identity), route_workspace, system_route, now)
    }

    /// The `basic` credentials for a user name that could apply on this route.
    /// The caller checks the password against each.
    pub fn basic(&self, username: &str, route_workspace: &str, system_route: bool, now: i64) -> Vec<&BasicCredential> {
        self.basic
            .get(username)
            .map(|list| list.iter().filter(|c| c.expires_at.is_none_or(|t| t > now) && usable(&c.consumer, route_workspace, system_route)).collect())
            .unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ChangeEvent;
    use serde_json::json;

    fn index() -> ConsumerIndex {
        let mut r = Resources::new();
        let mut put = |kind: &str, id: &str, ws: &str, data: serde_json::Value| {
            r.apply(&ChangeEvent::upsert(kind, id, Some(ws.into()), data));
        };
        put("consumer", "c-app", "acme", json!({ "name": "mobile-app", "custom_id": "client-42", "groups": ["partners"], "labels": { "tier": "gold" } }));
        put("consumer", "c-rival", "rival", json!({ "name": "mobile-app" }));
        put("credential", "k1", "acme", json!({ "type": "key", "consumer_id": "c-app", "key_hash": sha256_hex(b"apg_k_one") }));
        put("credential", "k2", "acme", json!({ "type": "key", "consumer_id": "c-app", "key_hash": sha256_hex(b"apg_k_two") }));
        put("credential", "k-off", "acme", json!({ "type": "key", "consumer_id": "c-app", "key_hash": sha256_hex(b"apg_k_off"), "enabled": false }));
        put("credential", "k-old", "acme", json!({ "type": "key", "consumer_id": "c-app", "key_hash": sha256_hex(b"apg_k_old"), "expires_at": "2020-01-01T00:00:00Z" }));
        put("credential", "k-bad", "acme", json!({ "type": "key", "consumer_id": "c-app", "key_hash": sha256_hex(b"apg_k_bad"), "expires_at": "whenever" }));
        put("credential", "k-orphan", "acme", json!({ "type": "key", "consumer_id": "gone", "key_hash": sha256_hex(b"apg_k_orphan") }));
        put("credential", "b1", "acme", json!({ "type": "basic", "consumer_id": "c-app", "username": "app", "password_hash": "$argon2id$v=19$..." }));
        put("credential", "b2", "rival", json!({ "type": "basic", "consumer_id": "c-rival", "username": "app", "password_sha256": sha256_hex(b"hunter22") }));
        put("credential", "m1", "acme", json!({ "type": "mtls", "consumer_id": "c-app", "identity": "client.acme.test" }));
        let (index, undecodable) = ConsumerIndex::build(&r);
        assert_eq!(undecodable, 0);
        index
    }

    const NOW: i64 = 1_800_000_000;

    // spec CON-2, CON-3
    #[test]
    fn a_key_finds_its_consumer_and_several_keys_can_be_live_at_once() {
        let i = index();
        assert_eq!(i.by_key("apg_k_one", "acme", false, NOW).unwrap().name, "mobile-app");
        assert_eq!(i.by_key("apg_k_two", "acme", false, NOW).unwrap().id, "c-app");
        assert!(i.by_key("apg_k_unknown", "acme", false, NOW).is_none());
        assert!(i.by_key("", "acme", false, NOW).is_none());
    }

    #[test]
    fn disabled_expired_unreadable_and_orphaned_credentials_open_nothing() {
        let i = index();
        for key in ["apg_k_off", "apg_k_old", "apg_k_bad", "apg_k_orphan"] {
            assert!(i.by_key(key, "acme", false, NOW).is_none(), "{key}");
        }
        // An expiry in the future is honoured.
        assert!(i.by_key("apg_k_old", "acme", false, 1_500_000_000).is_some());
    }

    // spec CON-1
    #[test]
    fn a_credential_works_in_its_own_workspace_and_on_system_routes_only() {
        let i = index();
        assert!(i.by_key("apg_k_one", "rival", false, NOW).is_none(), "another tenant's route");
        assert!(i.by_key("apg_k_one", "system", true, NOW).is_some(), "an operator route");
        assert_eq!(i.basic("app", "acme", false, NOW).len(), 1);
        assert_eq!(i.basic("app", "rival", false, NOW)[0].consumer.id, "c-rival");
        assert_eq!(i.basic("app", "system", true, NOW).len(), 2, "on a system route the password decides");
        assert!(i.basic("nobody", "acme", false, NOW).is_empty());
        assert!(matches!(i.basic("app", "rival", false, NOW)[0].password, PasswordHash::Sha256(_)));
        assert!(i.by_mtls_identity("client.acme.test", "acme", false, NOW).is_some());
        assert!(i.by_mtls_identity("client.acme.test", "rival", false, NOW).is_none());
    }

    #[test]
    fn consumers_are_found_by_name_and_external_id_within_a_workspace() {
        let i = index();
        assert_eq!(i.by_name("acme", "mobile-app").unwrap().id, "c-app");
        assert_eq!(i.by_name("rival", "mobile-app").unwrap().id, "c-rival");
        assert_eq!(i.by_custom_id("acme", "client-42").unwrap().groups, ["partners"]);
        assert!(i.by_custom_id("rival", "client-42").is_none());
        assert_eq!(i.get("c-app").unwrap().labels["tier"], "gold");
        assert_eq!(i.len(), 2);
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-10-10T12:30:45Z"), Some(1_791_635_445));
        assert_eq!(parse_rfc3339("2026-10-10T12:30:45.123Z"), Some(1_791_635_445));
        assert_eq!(parse_rfc3339("2026-10-10T14:30:45+02:00"), Some(1_791_635_445));
        assert_eq!(parse_rfc3339("2026-10-10T07:00:45-05:30"), Some(1_791_635_445));
        assert_eq!(parse_rfc3339("2000-02-29T00:00:00Z"), Some(951_782_400));
        for bad in ["", "2026-10-10", "2026-13-10T00:00:00Z", "2026-10-10T25:00:00Z", "2026-10-10T12:30:45", "not a time at all!!"] {
            assert_eq!(parse_rfc3339(bad), None, "{bad}");
        }
    }
}
