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

#[cfg(test)]
mod tests {
    use super::*;

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
