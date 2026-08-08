//! The encryption core, byte-compatible with `packages/crypto`
//! (`@engramer/crypto`). That package is the specification: every format
//! here matches it exactly, and the fixture tests in `tests/` hold both
//! implementations to the same bytes in both directions.
//!
//! Everything cryptographic is libsodium, the same library the TypeScript
//! side uses through libsodium-wrappers. Nothing here invents a
//! construction; this crate only moves where the calls happen, out of the
//! web view and into processes that have no web view at all (app
//! extensions, background tasks).

pub mod b64;
pub mod backend;
pub mod chunked;
pub mod digest;
pub mod keys;
pub mod metadata;
pub mod sealedbox;
pub mod secretbox;
pub mod stream;

pub use backend::init;

/// One error type for the whole crate: every failure a caller can see is
/// either bad input shape or a cryptographic rejection, and the caller's
/// response is the same for both: stop, never emit partial plaintext.
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// Ciphertext, key, or nonce had the wrong length or encoding.
    Malformed(&'static str),
    /// Authentication failed: wrong key or tampered bytes.
    Rejected(&'static str),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::Malformed(what) => write!(f, "malformed input: {what}"),
            CryptoError::Rejected(what) => write!(f, "rejected: {what}"),
        }
    }
}

impl std::error::Error for CryptoError {}
