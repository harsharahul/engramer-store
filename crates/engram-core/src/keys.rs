//! Key derivation, matching `packages/crypto/src/keys.ts`. Extensions
//! never derive the KEK themselves (they read the master key from the
//! keychain), but every derivation lives here anyway so the fixture
//! matrix can hold both implementations to the same bytes.

use crate::backend::{self, KEY_BYTES, SALT_BYTES};
use crate::CryptoError;

/// The contexts `crypto_kdf_derive_from_key` is used with. Eight bytes
/// exactly, as libsodium requires.
pub const CTX_LOGIN: &[u8; 8] = b"es-login";
pub const CTX_UNLOCK: &[u8; 8] = b"es-unlck";
pub const CTX_SHARE: &[u8; 8] = b"es-share";

/// Argon2id KEK derivation. `mem_limit` is in bytes, matching the
/// TypeScript side and libsodium itself.
pub fn derive_kek(
    password: &str,
    salt: &[u8; SALT_BYTES],
    ops_limit: u64,
    mem_limit: usize,
) -> Result<[u8; KEY_BYTES], CryptoError> {
    Ok(backend::pwhash_argon2id(KEY_BYTES, password.as_bytes(), salt, ops_limit, mem_limit)?
        .try_into()
        .unwrap())
}

/// What is sent to the server in place of the password.
pub fn derive_login_key(kek: &[u8; KEY_BYTES]) -> [u8; KEY_BYTES] {
    backend::kdf_derive(KEY_BYTES, 1, CTX_LOGIN, kek).try_into().unwrap()
}

/// What the server stores: BLAKE2b of the login key.
pub fn login_key_digest(login_key: &[u8; KEY_BYTES]) -> [u8; KEY_BYTES] {
    backend::generichash(KEY_BYTES, login_key).try_into().unwrap()
}

/// The key that wraps the master key for device unlock: derived from an
/// opaque secret via BLAKE2b then the kdf, exactly as `deriveUnlockKey`.
pub fn derive_unlock_key(secret: &[u8]) -> [u8; KEY_BYTES] {
    let hashed: [u8; KEY_BYTES] = backend::generichash(KEY_BYTES, secret).try_into().unwrap();
    backend::kdf_derive(KEY_BYTES, 1, CTX_UNLOCK, &hashed).try_into().unwrap()
}

/// Share-link subkeys: id 1 proves password knowledge to the server, id 2
/// wraps the file key locally and never leaves the client.
pub fn share_subkey(link_kek: &[u8; KEY_BYTES], id: u64) -> [u8; KEY_BYTES] {
    backend::kdf_derive(KEY_BYTES, id, CTX_SHARE, link_kek).try_into().unwrap()
}
