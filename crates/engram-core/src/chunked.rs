//! The chunked media format (EGC1), byte-compatible with
//! `packages/crypto/src/chunked.ts`: 4-byte magic, 16-byte random salt,
//! LE64 plaintext size, then XSalsa20-Poly1305 chunks whose nonces are
//! BLAKE2b-192 digests of the whole header and the chunk index. Any chunk
//! decrypts standalone, which is what lets HTTP range requests seek
//! through encrypted video. This module supersedes the desktop shell's
//! decrypt-only `egc1.rs` and adds the encrypt direction for extensions.

use crate::backend::{self, KEY_BYTES, MAC_BYTES, NONCE_BYTES};
use crate::CryptoError;

pub const HEADER_BYTES: usize = 28;
pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;
pub const TAG_BYTES: usize = MAC_BYTES;
pub const SALT_BYTES: usize = 16;
const MAGIC: &[u8; 4] = b"EGC1";

#[derive(Clone)]
pub struct Header {
    pub plain_size: u64,
    pub bytes: [u8; HEADER_BYTES],
}

impl Header {
    /// A fresh header for `plain_size` bytes with the salt supplied, so
    /// tests and vectors can reproduce output exactly; production callers
    /// pass `backend::random_bytes`.
    pub fn create(plain_size: u64, salt: &[u8; SALT_BYTES]) -> Self {
        let mut bytes = [0u8; HEADER_BYTES];
        bytes[..4].copy_from_slice(MAGIC);
        bytes[4..20].copy_from_slice(salt);
        bytes[20..28].copy_from_slice(&plain_size.to_le_bytes());
        Self { plain_size, bytes }
    }
}

pub fn read_header(bytes: &[u8]) -> Result<Header, CryptoError> {
    if bytes.len() < HEADER_BYTES || &bytes[..4] != MAGIC {
        return Err(CryptoError::Malformed("not a chunked media blob"));
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

pub fn ciphertext_size(plain_size: u64) -> u64 {
    HEADER_BYTES as u64 + plain_size + chunk_count(plain_size) * TAG_BYTES as u64
}

fn chunk_nonce(header: &Header, index: u64) -> [u8; NONCE_BYTES] {
    let mut message = Vec::with_capacity(HEADER_BYTES + 8);
    message.extend_from_slice(&header.bytes);
    message.extend_from_slice(&index.to_le_bytes());
    backend::generichash(NONCE_BYTES, &message)
        .try_into()
        .unwrap()
}

pub fn encrypt_chunk(header: &Header, key: &[u8; KEY_BYTES], index: u64, plain: &[u8]) -> Vec<u8> {
    backend::secretbox_seal(plain, &chunk_nonce(header, index), key)
}

pub fn decrypt_chunk(
    header: &Header,
    key: &[u8; KEY_BYTES],
    index: u64,
    sealed: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    backend::secretbox_open(sealed, &chunk_nonce(header, index), key)
        .map_err(|_| CryptoError::Rejected("media chunk failed authentication"))
}

/// Whole-buffer encryption with the salt supplied (see `Header::create`).
pub fn encrypt(plain: &[u8], key: &[u8; KEY_BYTES], salt: &[u8; SALT_BYTES]) -> Vec<u8> {
    let header = Header::create(plain.len() as u64, salt);
    let mut out = Vec::with_capacity(ciphertext_size(plain.len() as u64) as usize);
    out.extend_from_slice(&header.bytes);
    let count = chunk_count(header.plain_size);
    for index in 0..count {
        let start = (index as usize) * CHUNK_SIZE;
        let end = plain.len().min(start + CHUNK_SIZE);
        out.extend(encrypt_chunk(&header, key, index, &plain[start..end]));
    }
    out
}

pub fn decrypt(blob: &[u8], key: &[u8; KEY_BYTES]) -> Result<Vec<u8>, CryptoError> {
    let header = read_header(blob)?;
    if (blob.len() as u64) < ciphertext_size(header.plain_size) {
        return Err(CryptoError::Malformed("chunked blob is truncated"));
    }
    let count = chunk_count(header.plain_size);
    let mut plain = Vec::with_capacity(header.plain_size as usize);
    for index in 0..count {
        let start = chunk_offset(index) as usize;
        let sealed = &blob[start..start + sealed_chunk_len(&header, index)];
        plain.extend(decrypt_chunk(&header, key, index, sealed)?);
    }
    Ok(plain)
}
