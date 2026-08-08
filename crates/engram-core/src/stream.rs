//! The default file-content format: an XChaCha20-Poly1305 secretstream of
//! 4 MiB chunks, final chunk tagged terminal. Matches
//! `packages/crypto/src/stream.ts` including its refusal to return
//! anything for a truncated blob.

use crate::backend::{StreamPull, StreamPush, KEY_BYTES, STREAM_A_BYTES, STREAM_HEADER_BYTES};
use crate::CryptoError;

pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;

/// Streaming encryptor mirroring the TypeScript `StreamEncryptor`: take
/// the header first, then push chunks in order, marking the last.
pub struct StreamEncryptor {
    push: StreamPush,
    header: [u8; STREAM_HEADER_BYTES],
}

impl StreamEncryptor {
    pub fn new(key: &[u8; KEY_BYTES]) -> Self {
        let (push, header) = StreamPush::new(key);
        Self { push, header }
    }

    pub fn header(&self) -> [u8; STREAM_HEADER_BYTES] {
        self.header
    }

    pub fn push(&mut self, plaintext: &[u8], final_chunk: bool) -> Vec<u8> {
        self.push.push(plaintext, final_chunk)
    }
}

pub fn ciphertext_size(plain_size: u64) -> u64 {
    let chunks = if plain_size == 0 {
        1
    } else {
        plain_size.div_ceil(CHUNK_SIZE as u64)
    };
    STREAM_HEADER_BYTES as u64 + plain_size + chunks * STREAM_A_BYTES as u64
}

/// Whole-buffer convenience, the shape most extension writes take.
pub fn encrypt_bytes(plain: &[u8], key: &[u8; KEY_BYTES]) -> Vec<u8> {
    let mut enc = StreamEncryptor::new(key);
    let mut out = Vec::with_capacity(ciphertext_size(plain.len() as u64) as usize);
    out.extend_from_slice(&enc.header());
    if plain.is_empty() {
        out.extend(enc.push(&[], true));
        return out;
    }
    let chunks: Vec<&[u8]> = plain.chunks(CHUNK_SIZE).collect();
    for (i, chunk) in chunks.iter().enumerate() {
        out.extend(enc.push(chunk, i == chunks.len() - 1));
    }
    out
}

pub fn decrypt_bytes(blob: &[u8], key: &[u8; KEY_BYTES]) -> Result<Vec<u8>, CryptoError> {
    if blob.len() < STREAM_HEADER_BYTES {
        return Err(CryptoError::Malformed(
            "encrypted blob shorter than its header",
        ));
    }
    let header: [u8; STREAM_HEADER_BYTES] = blob[..STREAM_HEADER_BYTES].try_into().unwrap();
    let mut pull = StreamPull::new(&header, key)?;
    let mut plain = Vec::new();
    let mut offset = STREAM_HEADER_BYTES;
    loop {
        if offset >= blob.len() {
            // The final tag never arrived: the blob was cut short and the
            // bytes so far must not be trusted as the whole file.
            return Err(CryptoError::Rejected("encrypted blob is truncated"));
        }
        let end = blob.len().min(offset + CHUNK_SIZE + STREAM_A_BYTES);
        let (chunk, done) = pull.pull(&blob[offset..end])?;
        plain.extend(chunk);
        offset = end;
        if done {
            if offset != blob.len() {
                return Err(CryptoError::Malformed(
                    "trailing bytes after the final chunk",
                ));
            }
            return Ok(plain);
        }
    }
}
