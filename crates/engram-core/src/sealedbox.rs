//! X25519 sealed boxes, the sharing primitive: anyone can seal to a
//! public key, only the holder of the private key opens, and nothing
//! identifies the sender. Matches `packages/crypto/src/box.ts`.

use crate::b64::{from_b64url, to_b64url};
use crate::backend::{self, BOX_PUBLIC_BYTES, BOX_SECRET_BYTES, KEY_BYTES};
use crate::CryptoError;

pub struct KeyPair {
    pub public: [u8; BOX_PUBLIC_BYTES],
    pub secret: [u8; BOX_SECRET_BYTES],
}

pub fn generate_keypair() -> KeyPair {
    let (public, secret) = backend::box_keypair();
    KeyPair { public, secret }
}

/// Deterministic keypair from a seed; exists for the fixture matrix.
pub fn keypair_from_seed(seed: &[u8; KEY_BYTES]) -> KeyPair {
    let (public, secret) = backend::box_seed_keypair(seed);
    KeyPair { public, secret }
}

/// Seals to a base64url public key, returning base64url ciphertext, the
/// exact strings the server relays.
pub fn seal_to_public_key(plaintext: &[u8], public_b64: &str) -> Result<String, CryptoError> {
    let public: [u8; BOX_PUBLIC_BYTES] = from_b64url(public_b64)?
        .try_into()
        .map_err(|_| CryptoError::Malformed("public key length"))?;
    Ok(to_b64url(&backend::box_seal(plaintext, &public)))
}

pub fn open_sealed(sealed_b64: &str, pair: &KeyPair) -> Result<Vec<u8>, CryptoError> {
    let sealed = from_b64url(sealed_b64)?;
    backend::box_seal_open(&sealed, &pair.public, &pair.secret)
}
