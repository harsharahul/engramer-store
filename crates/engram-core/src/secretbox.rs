//! `SecretBox`, the wire shape every wrapped key and encrypted metadata
//! value uses: XSalsa20-Poly1305 with a random 24-byte nonce, both parts
//! carried as URL-safe unpadded base64. Matches `packages/crypto/src/box.ts`.

use crate::b64::{from_b64url, to_b64url};
use crate::backend::{self, KEY_BYTES, NONCE_BYTES};
use crate::CryptoError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretBox {
    pub ciphertext: String,
    pub nonce: String,
}

pub fn generate_key() -> [u8; KEY_BYTES] {
    backend::random_bytes(KEY_BYTES).try_into().unwrap()
}

/// Seal with the nonce supplied, so vectors reproduce exactly; production
/// callers use `seal`, which draws a random nonce.
pub fn seal_with_nonce(plaintext: &[u8], key: &[u8; KEY_BYTES], nonce: &[u8; NONCE_BYTES]) -> SecretBox {
    SecretBox {
        ciphertext: to_b64url(&backend::secretbox_seal(plaintext, nonce, key)),
        nonce: to_b64url(nonce),
    }
}

pub fn seal(plaintext: &[u8], key: &[u8; KEY_BYTES]) -> SecretBox {
    let nonce: [u8; NONCE_BYTES] = backend::random_bytes(NONCE_BYTES).try_into().unwrap();
    seal_with_nonce(plaintext, key, &nonce)
}

pub fn open(sealed: &SecretBox, key: &[u8; KEY_BYTES]) -> Result<Vec<u8>, CryptoError> {
    let ciphertext = from_b64url(&sealed.ciphertext)?;
    let nonce: [u8; NONCE_BYTES] = from_b64url(&sealed.nonce)?
        .try_into()
        .map_err(|_| CryptoError::Malformed("secretbox nonce length"))?;
    backend::secretbox_open(&ciphertext, &nonce, key)
}
