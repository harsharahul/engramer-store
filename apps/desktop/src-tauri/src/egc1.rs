//! Native reader for the chunked media format (EGC1), byte-compatible with
//! packages/crypto/src/chunked.ts: 4-byte magic, 16-byte salt, LE64
//! plaintext size, then XSalsa20-Poly1305 chunks whose nonces are BLAKE2b
//! digests of the header and the chunk index. Decrypt-only on purpose; the
//! web layer remains the sole writer.

use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use crypto_secretbox::aead::{Aead, KeyInit};
use crypto_secretbox::{Nonce, XSalsa20Poly1305};

pub const HEADER_BYTES: usize = 28;
pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;
pub const TAG_BYTES: usize = 16;
const MAGIC: &[u8; 4] = b"EGC1";

#[derive(Clone)]
pub struct Header {
    pub plain_size: u64,
    pub bytes: [u8; HEADER_BYTES],
}

pub fn read_header(bytes: &[u8]) -> Result<Header, String> {
    if bytes.len() < HEADER_BYTES || &bytes[..4] != MAGIC {
        return Err("not a chunked media blob".to_string());
    }
    let mut fixed = [0u8; HEADER_BYTES];
    fixed.copy_from_slice(&bytes[..HEADER_BYTES]);
    let plain_size = u64::from_le_bytes(fixed[20..28].try_into().unwrap());
    Ok(Header {
        plain_size,
        bytes: fixed,
    })
}

pub fn chunk_count(plain_size: u64) -> u64 {
    if plain_size == 0 {
        1
    } else {
        plain_size.div_ceil(CHUNK_SIZE as u64)
    }
}

pub fn sealed_chunk_len(header: &Header, index: u64) -> usize {
    let count = chunk_count(header.plain_size);
    let plain = if index < count - 1 {
        CHUNK_SIZE as u64
    } else {
        header.plain_size - (count - 1) * CHUNK_SIZE as u64
    };
    plain as usize + TAG_BYTES
}

/// Ciphertext offset of a chunk within the blob, header included.
pub fn chunk_offset(index: u64) -> u64 {
    HEADER_BYTES as u64 + index * (CHUNK_SIZE + TAG_BYTES) as u64
}

fn chunk_nonce(header: &Header, index: u64) -> Nonce {
    let mut hasher = Blake2bVar::new(24).expect("blake2b-192");
    hasher.update(&header.bytes);
    hasher.update(&index.to_le_bytes());
    let mut out = [0u8; 24];
    hasher.finalize_variable(&mut out).expect("digest");
    Nonce::clone_from_slice(&out)
}

pub fn decrypt_chunk(
    header: &Header,
    key: &[u8; 32],
    index: u64,
    sealed: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = XSalsa20Poly1305::new(key.into());
    cipher
        .decrypt(&chunk_nonce(header, index), sealed)
        .map_err(|_| format!("chunk {index} failed authentication"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden fixture produced by packages/crypto (the TypeScript writer):
    /// scripts/egc1-fixture.mjs encrypts a known pattern under a known key.
    #[test]
    fn decrypts_typescript_fixture() {
        let blob = include_bytes!("../tests/egc1-fixture.bin");
        let key: [u8; 32] = *include_bytes!("../tests/egc1-fixture.key");
        let header = read_header(blob).expect("header");
        assert_eq!(header.plain_size, 5 * 1024 * 1024);
        let count = chunk_count(header.plain_size);
        assert_eq!(count, 2);
        let mut plain = Vec::new();
        for index in 0..count {
            let start = chunk_offset(index) as usize;
            let sealed = &blob[start..start + sealed_chunk_len(&header, index)];
            plain.extend(decrypt_chunk(&header, &key, index, sealed).expect("decrypt"));
        }
        assert_eq!(plain.len() as u64, header.plain_size);
        // The fixture plaintext is bytes (i * 31 + 7) % 256.
        for (i, byte) in plain.iter().enumerate().step_by(4093) {
            assert_eq!(*byte, ((i * 31 + 7) % 256) as u8, "byte {i}");
        }
        // Tampering must fail loudly.
        let start = chunk_offset(0) as usize;
        let mut evil = blob[start..start + sealed_chunk_len(&header, 0)].to_vec();
        evil[100] ^= 1;
        assert!(decrypt_chunk(&header, &key, 0, &evil).is_err());
    }
}
