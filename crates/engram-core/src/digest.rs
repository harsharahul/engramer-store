//! Plaintext integrity digests: BLAKE2b-256, matching
//! `packages/crypto/src/digest.ts`. Computed over content before
//! encryption and carried inside the encrypted metadata, so end-to-end
//! integrity holds independently of any single ciphertext's tag.

use crate::b64::to_b64url;
use crate::backend::{generichash, Hasher};

pub const DIGEST_BYTES: usize = 32;

pub fn digest(content: &[u8]) -> String {
    to_b64url(&generichash(DIGEST_BYTES, content))
}

/// Incremental form for streaming encryption, one pass over the bytes.
pub struct Digester(Hasher);

impl Digester {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self(Hasher::new(DIGEST_BYTES))
    }

    pub fn update(&mut self, chunk: &[u8]) {
        self.0.update(chunk);
    }

    pub fn finish(self) -> String {
        to_b64url(&self.0.finish())
    }
}
