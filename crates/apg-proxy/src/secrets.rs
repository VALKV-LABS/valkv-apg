//! Opening and sealing secret values (spec SEC-1).
//!
//! Private keys reach a node as ciphertext sealed by the control plane with
//! AES-256-GCM under `APG_SECRET_KEY`. The associated data names the resource
//! the value belongs to, so a ciphertext copied onto another resource does not
//! open. The format is the admin's (`admin/src/crypto.ts`):
//! `v1:<nonce>:<ciphertext>:<tag>`, each part base64.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use openssl::symm::{Cipher, decrypt_aead, encrypt_aead};

const VERSION: &str = "v1";

pub struct SecretBox {
    current: [u8; 32],
    /// Accepted for opening while a key rotation is in progress (spec SEC-2).
    previous: Option<[u8; 32]>,
}

// Never print key material, not even in debug output.
impl std::fmt::Debug for SecretBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretBox(..)")
    }
}

fn parse_key(base64_key: &str, name: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = STANDARD.decode(base64_key.trim()).map_err(|_| anyhow::anyhow!("{name} is not valid base64"))?;
    bytes.as_slice().try_into().map_err(|_| anyhow::anyhow!("{name} must be 32 random bytes, base64-encoded (got {} bytes)", bytes.len()))
}

impl SecretBox {
    pub fn from_base64(current: &str, previous: Option<&str>) -> anyhow::Result<Self> {
        Ok(Self { current: parse_key(current, "APG_SECRET_KEY")?, previous: previous.map(|p| parse_key(p, "APG_SECRET_KEY_PREVIOUS")).transpose()? })
    }

    /// Encrypts `plaintext` for the resource named by `aad`.
    pub fn seal(&self, plaintext: &[u8], aad: &str) -> String {
        let mut nonce = [0u8; 12];
        openssl::rand::rand_bytes(&mut nonce).expect("the system random source works");
        let mut tag = [0u8; 16];
        let body = encrypt_aead(Cipher::aes_256_gcm(), &self.current, Some(&nonce), aad.as_bytes(), plaintext, &mut tag).expect("AES-256-GCM with a 32-byte key and 12-byte nonce");
        format!("{VERSION}:{}:{}:{}", STANDARD.encode(nonce), STANDARD.encode(body), STANDARD.encode(tag))
    }

    /// Decrypts a value sealed for `aad`: the current key first, then the
    /// previous one. The error never includes any part of the value.
    pub fn open(&self, ciphertext: &str, aad: &str) -> Result<Vec<u8>, String> {
        let parts: Vec<&str> = ciphertext.split(':').collect();
        let [version, nonce, body, tag] = parts.as_slice() else { return Err("unrecognised ciphertext format".into()) };
        if *version != VERSION {
            return Err("unrecognised ciphertext format".into());
        }
        let decode = |part: &str| STANDARD.decode(part).map_err(|_| "unrecognised ciphertext format".to_string());
        let (nonce, body, tag) = (decode(nonce)?, decode(body)?, decode(tag)?);
        if nonce.len() != 12 || tag.len() != 16 {
            return Err("unrecognised ciphertext format".into());
        }
        for key in std::iter::once(&self.current).chain(self.previous.as_ref()) {
            if let Ok(plain) = decrypt_aead(Cipher::aes_256_gcm(), key, Some(&nonce), aad.as_bytes(), &body, &tag) {
                return Ok(plain);
            }
        }
        Err("the value could not be decrypted with the configured keys (is APG_SECRET_KEY the control plane's?)".into())
    }
}

/// Reads a secret-typed configuration value (spec §9.6): `{ "$env": NAME }`
/// from this node's environment, `{ "$file": PATH }` from a file, or
/// `{ "$secret_ciphertext": … }` as sealed by the control plane for the
/// resource named by `aad`.
pub fn resolve(value: &serde_json::Value, aad: &str, secrets: Option<&SecretBox>) -> Result<String, String> {
    let text = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
    if let Some(name) = text("$env") {
        if !name.starts_with("APG_SECRET_") {
            return Err(format!("only variables named APG_SECRET_* may be read; got {name}"));
        }
        return std::env::var(name).ok().filter(|v| !v.is_empty()).ok_or_else(|| format!("environment variable {name} is not set on this node"));
    }
    if let Some(path) = text("$file") {
        return std::fs::read_to_string(path).map(|s| s.trim_end_matches(['\r', '\n']).to_string()).map_err(|e| format!("cannot read '{path}': {e}"));
    }
    if let Some(sealed) = text("$secret_ciphertext") {
        let secrets = secrets.ok_or("APG_SECRET_KEY is not set on this node, so the sealed value cannot be opened")?;
        return String::from_utf8(secrets.open(sealed, aad)?).map_err(|_| "the sealed value is not text".to_string());
    }
    Err("a secret value must be given as $env or $file, or sealed by a control plane".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_values_are_read_from_a_file_or_opened_and_never_from_arbitrary_variables() {
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        std::fs::write(&path, "from-a-file\n").unwrap();
        assert_eq!(resolve(&json!({ "$file": path.to_str().unwrap() }), "x", None).unwrap(), "from-a-file");
        assert!(resolve(&json!({ "$file": "/no/such/file" }), "x", None).is_err());

        let secrets = SecretBox::from_base64("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", None).unwrap();
        let sealed = json!({ "$secret_ciphertext": secrets.seal(b"sealed-value", "plugin:p1") });
        assert_eq!(resolve(&sealed, "plugin:p1", Some(&secrets)).unwrap(), "sealed-value");
        assert!(resolve(&sealed, "plugin:p2", Some(&secrets)).is_err(), "bound to its plugin");
        assert!(resolve(&sealed, "plugin:p1", None).unwrap_err().contains("APG_SECRET_KEY"));

        // PATH and friends are not secrets a configuration may read.
        assert!(resolve(&json!({ "$env": "PATH" }), "x", None).unwrap_err().contains("APG_SECRET_"));
        assert!(resolve(&json!({ "$env": "APG_SECRET_SURELY_NOT_SET_ANYWHERE" }), "x", None).unwrap_err().contains("not set"));
        assert!(resolve(&json!({ "$secret": "clear" }), "x", None).is_err(), "a clear value never reaches a node from a control plane");
        assert!(resolve(&json!("bare string"), "x", None).is_err());
    }

    const KEY_A: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const KEY_B: &str = "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=";

    #[test]
    fn a_sealed_value_opens_only_for_its_resource_and_key() {
        let a = SecretBox::from_base64(KEY_A, None).unwrap();
        let sealed = a.seal(b"-----BEGIN PRIVATE KEY-----", "certificate:c1");
        assert!(sealed.starts_with("v1:") && !sealed.contains("PRIVATE"));
        assert_eq!(a.open(&sealed, "certificate:c1").unwrap(), b"-----BEGIN PRIVATE KEY-----");
        // Moved to another resource, or opened with another key: refused.
        assert!(a.open(&sealed, "certificate:c2").is_err());
        assert!(SecretBox::from_base64(KEY_B, None).unwrap().open(&sealed, "certificate:c1").is_err());
        // Two seals of one value differ (a fresh nonce each time).
        assert_ne!(sealed, a.seal(b"-----BEGIN PRIVATE KEY-----", "certificate:c1"));
    }

    // spec SEC-2
    #[test]
    fn the_previous_key_still_opens_during_rotation() {
        let old = SecretBox::from_base64(KEY_A, None).unwrap();
        let sealed = old.seal(b"secret", "x:1");
        let rotated = SecretBox::from_base64(KEY_B, Some(KEY_A)).unwrap();
        assert_eq!(rotated.open(&sealed, "x:1").unwrap(), b"secret");
        assert!(rotated.seal(b"secret", "x:1") != sealed);
    }

    #[test]
    fn malformed_values_and_keys_are_refused_without_echoing_them() {
        let a = SecretBox::from_base64(KEY_A, None).unwrap();
        for bad in ["", "v2:a:b:c", "v1:only:three", "v1:!!!:AAAA:AAAA", "v1:AAAA:AAAA:AAAA"] {
            let err = a.open(bad, "x").unwrap_err();
            assert!(!err.contains("AAAA"), "{err}");
        }
        assert!(SecretBox::from_base64("c2hvcnQ=", None).unwrap_err().to_string().contains("32 random bytes"));
        assert!(SecretBox::from_base64("not base64!", None).is_err());
        assert!(SecretBox::from_base64(KEY_A, Some("c2hvcnQ=")).unwrap_err().to_string().contains("APG_SECRET_KEY_PREVIOUS"));
    }
}
