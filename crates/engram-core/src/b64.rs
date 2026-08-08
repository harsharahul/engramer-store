//! Two base64 alphabets, named so no call site can be vague about which
//! one it means. `@engramer/crypto`'s `toB64` is URL-safe without padding
//! (keys, nonces, ciphertext JSON); the desktop media bridge historically
//! receives standard-alphabet base64 from `btoa`. Confusing the two has
//! already cost a debugging session; here they are separate functions.

use crate::CryptoError;

const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode(alphabet: &[u8; 64], pad: bool, bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = u32::from_be_bytes([0, b[0], b[1], b[2]]);
        let chars = [
            alphabet[(n >> 18 & 63) as usize],
            alphabet[(n >> 12 & 63) as usize],
            alphabet[(n >> 6 & 63) as usize],
            alphabet[(n & 63) as usize],
        ];
        let emit = chunk.len() + 1;
        for (i, ch) in chars.iter().enumerate() {
            if i < emit {
                out.push(*ch as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn decode(alphabet: &[u8; 64], text: &str) -> Result<Vec<u8>, CryptoError> {
    let mut lookup = [255u8; 256];
    for (i, ch) in alphabet.iter().enumerate() {
        lookup[*ch as usize] = i as u8;
    }
    let stripped: Vec<u8> = text.bytes().filter(|b| *b != b'=').collect();
    if stripped.len() % 4 == 1 {
        return Err(CryptoError::Malformed("base64 length"));
    }
    let mut out = Vec::with_capacity(stripped.len() * 3 / 4);
    for chunk in stripped.chunks(4) {
        let mut n: u32 = 0;
        for (i, b) in chunk.iter().enumerate() {
            let v = lookup[*b as usize];
            if v == 255 {
                return Err(CryptoError::Malformed("base64 alphabet"));
            }
            n |= (v as u32) << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Ok(out)
}

/// URL-safe, no padding: what `toB64` produces and `fromB64` expects.
pub fn to_b64url(bytes: &[u8]) -> String {
    encode(URL, false, bytes)
}

pub fn from_b64url(text: &str) -> Result<Vec<u8>, CryptoError> {
    decode(URL, text)
}

/// Standard alphabet (what `btoa` produces); padding tolerated on decode.
pub fn to_b64std(bytes: &[u8]) -> String {
    encode(STD, true, bytes)
}

pub fn from_b64std(text: &str) -> Result<Vec<u8>, CryptoError> {
    decode(STD, text)
}
