//! The one place libsodium is called. Everything else in the crate goes
//! through these safe wrappers, so swapping the backing library (should
//! the C build ever refuse a target) is a change to this file alone; the
//! fixture tests judge any replacement byte for byte.

use crate::CryptoError;
use libsodium_sys as ffi;
use std::sync::Once;

pub const KEY_BYTES: usize = 32; // crypto_secretbox_KEYBYTES
pub const NONCE_BYTES: usize = 24; // crypto_secretbox_NONCEBYTES
pub const MAC_BYTES: usize = 16; // crypto_secretbox_MACBYTES
pub const SALT_BYTES: usize = 16; // crypto_pwhash_SALTBYTES
pub const STREAM_HEADER_BYTES: usize = 24; // crypto_secretstream_..._HEADERBYTES
pub const STREAM_A_BYTES: usize = 17; // crypto_secretstream_..._ABYTES
pub const BOX_PUBLIC_BYTES: usize = 32;
pub const BOX_SECRET_BYTES: usize = 32;
pub const BOX_SEAL_BYTES: usize = 48; // crypto_box_SEALBYTES

static INIT: Once = Once::new();

/// Must succeed before any other call; safe to call any number of times.
pub fn init() {
    INIT.call_once(|| {
        // -1 means already initialized, which is fine; only a hard failure
        // (no secure randomness source) panics, and nothing cryptographic
        // may proceed past that.
        let rc = unsafe { ffi::sodium_init() };
        assert!(rc >= 0, "libsodium failed to initialize");
    });
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    init();
    let mut out = vec![0u8; n];
    unsafe { ffi::randombytes_buf(out.as_mut_ptr().cast(), n) };
    out
}

pub fn secretbox_seal(plaintext: &[u8], nonce: &[u8; NONCE_BYTES], key: &[u8; KEY_BYTES]) -> Vec<u8> {
    init();
    let mut out = vec![0u8; plaintext.len() + MAC_BYTES];
    let rc = unsafe {
        ffi::crypto_secretbox_easy(
            out.as_mut_ptr(),
            plaintext.as_ptr(),
            plaintext.len() as u64,
            nonce.as_ptr(),
            key.as_ptr(),
        )
    };
    assert_eq!(rc, 0, "crypto_secretbox_easy cannot fail on valid lengths");
    out
}

pub fn secretbox_open(
    ciphertext: &[u8],
    nonce: &[u8; NONCE_BYTES],
    key: &[u8; KEY_BYTES],
) -> Result<Vec<u8>, CryptoError> {
    init();
    if ciphertext.len() < MAC_BYTES {
        return Err(CryptoError::Malformed("secretbox ciphertext shorter than its tag"));
    }
    let mut out = vec![0u8; ciphertext.len() - MAC_BYTES];
    let rc = unsafe {
        ffi::crypto_secretbox_open_easy(
            out.as_mut_ptr(),
            ciphertext.as_ptr(),
            ciphertext.len() as u64,
            nonce.as_ptr(),
            key.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(CryptoError::Rejected("secretbox authentication failed"));
    }
    Ok(out)
}

/// Keyless BLAKE2b at an arbitrary output length (16..=64).
pub fn generichash(out_len: usize, message: &[u8]) -> Vec<u8> {
    init();
    let mut out = vec![0u8; out_len];
    let rc = unsafe {
        ffi::crypto_generichash(
            out.as_mut_ptr(),
            out_len,
            message.as_ptr(),
            message.len() as u64,
            std::ptr::null(),
            0,
        )
    };
    assert_eq!(rc, 0, "crypto_generichash cannot fail on valid lengths");
    out
}

pub struct Hasher(ffi::crypto_generichash_state, usize);

impl Hasher {
    pub fn new(out_len: usize) -> Self {
        init();
        let mut state = std::mem::MaybeUninit::<ffi::crypto_generichash_state>::uninit();
        let rc = unsafe {
            ffi::crypto_generichash_init(state.as_mut_ptr(), std::ptr::null(), 0, out_len)
        };
        assert_eq!(rc, 0);
        Self(unsafe { state.assume_init() }, out_len)
    }

    pub fn update(&mut self, chunk: &[u8]) {
        let rc = unsafe {
            ffi::crypto_generichash_update(&mut self.0, chunk.as_ptr(), chunk.len() as u64)
        };
        assert_eq!(rc, 0);
    }

    pub fn finish(mut self) -> Vec<u8> {
        let mut out = vec![0u8; self.1];
        let rc = unsafe { ffi::crypto_generichash_final(&mut self.0, out.as_mut_ptr(), self.1) };
        assert_eq!(rc, 0);
        out
    }
}

/// `crypto_kdf_derive_from_key`: BLAKE2b with the context as personal and
/// the id as salt. The context must be exactly 8 bytes.
pub fn kdf_derive(out_len: usize, subkey_id: u64, context: &[u8; 8], key: &[u8; KEY_BYTES]) -> Vec<u8> {
    init();
    let mut out = vec![0u8; out_len];
    let rc = unsafe {
        ffi::crypto_kdf_derive_from_key(
            out.as_mut_ptr(),
            out_len,
            subkey_id,
            context.as_ptr().cast(),
            key.as_ptr(),
        )
    };
    assert_eq!(rc, 0, "crypto_kdf_derive_from_key rejects only bad lengths");
    out
}

/// Argon2id, the same algorithm id libsodium-wrappers uses. `mem_limit`
/// is in BYTES, exactly as the TypeScript side passes it; the popular
/// KiB convention elsewhere is precisely the mismatch the fixtures exist
/// to catch.
pub fn pwhash_argon2id(
    out_len: usize,
    password: &[u8],
    salt: &[u8; SALT_BYTES],
    ops_limit: u64,
    mem_limit: usize,
) -> Result<Vec<u8>, CryptoError> {
    init();
    let mut out = vec![0u8; out_len];
    let rc = unsafe {
        ffi::crypto_pwhash(
            out.as_mut_ptr(),
            out_len as u64,
            password.as_ptr().cast(),
            password.len() as u64,
            salt.as_ptr(),
            ops_limit,
            mem_limit,
            ffi::crypto_pwhash_ALG_ARGON2ID13 as i32,
        )
    };
    if rc != 0 {
        return Err(CryptoError::Rejected("argon2id ran out of memory"));
    }
    Ok(out)
}

pub struct StreamPush(ffi::crypto_secretstream_xchacha20poly1305_state);

impl StreamPush {
    pub fn new(key: &[u8; KEY_BYTES]) -> (Self, [u8; STREAM_HEADER_BYTES]) {
        init();
        let mut state = std::mem::MaybeUninit::uninit();
        let mut header = [0u8; STREAM_HEADER_BYTES];
        let rc = unsafe {
            ffi::crypto_secretstream_xchacha20poly1305_init_push(
                state.as_mut_ptr(),
                header.as_mut_ptr(),
                key.as_ptr(),
            )
        };
        assert_eq!(rc, 0);
        (Self(unsafe { state.assume_init() }), header)
    }

    pub fn push(&mut self, plaintext: &[u8], final_chunk: bool) -> Vec<u8> {
        let tag = if final_chunk {
            unsafe { ffi::crypto_secretstream_xchacha20poly1305_tag_final() }
        } else {
            unsafe { ffi::crypto_secretstream_xchacha20poly1305_tag_message() }
        };
        let mut out = vec![0u8; plaintext.len() + STREAM_A_BYTES];
        let rc = unsafe {
            ffi::crypto_secretstream_xchacha20poly1305_push(
                &mut self.0,
                out.as_mut_ptr(),
                std::ptr::null_mut(),
                plaintext.as_ptr(),
                plaintext.len() as u64,
                std::ptr::null(),
                0,
                tag,
            )
        };
        assert_eq!(rc, 0);
        out
    }
}

pub struct StreamPull(ffi::crypto_secretstream_xchacha20poly1305_state);

impl StreamPull {
    pub fn new(header: &[u8; STREAM_HEADER_BYTES], key: &[u8; KEY_BYTES]) -> Result<Self, CryptoError> {
        init();
        let mut state = std::mem::MaybeUninit::uninit();
        let rc = unsafe {
            ffi::crypto_secretstream_xchacha20poly1305_init_pull(
                state.as_mut_ptr(),
                header.as_ptr(),
                key.as_ptr(),
            )
        };
        if rc != 0 {
            return Err(CryptoError::Malformed("secretstream header"));
        }
        Ok(Self(unsafe { state.assume_init() }))
    }

    /// Returns the plaintext and whether this was the final chunk.
    pub fn pull(&mut self, ciphertext: &[u8]) -> Result<(Vec<u8>, bool), CryptoError> {
        if ciphertext.len() < STREAM_A_BYTES {
            return Err(CryptoError::Malformed("secretstream chunk shorter than its tag"));
        }
        let mut out = vec![0u8; ciphertext.len() - STREAM_A_BYTES];
        let mut tag: u8 = 0;
        let rc = unsafe {
            ffi::crypto_secretstream_xchacha20poly1305_pull(
                &mut self.0,
                out.as_mut_ptr(),
                std::ptr::null_mut(),
                &mut tag,
                ciphertext.as_ptr(),
                ciphertext.len() as u64,
                std::ptr::null(),
                0,
            )
        };
        if rc != 0 {
            return Err(CryptoError::Rejected("stream chunk failed authentication"));
        }
        let final_tag = unsafe { ffi::crypto_secretstream_xchacha20poly1305_tag_final() };
        Ok((out, tag == final_tag))
    }
}

pub fn box_seed_keypair(seed: &[u8; KEY_BYTES]) -> ([u8; BOX_PUBLIC_BYTES], [u8; BOX_SECRET_BYTES]) {
    init();
    let mut public = [0u8; BOX_PUBLIC_BYTES];
    let mut secret = [0u8; BOX_SECRET_BYTES];
    let rc = unsafe { ffi::crypto_box_seed_keypair(public.as_mut_ptr(), secret.as_mut_ptr(), seed.as_ptr()) };
    assert_eq!(rc, 0);
    (public, secret)
}

pub fn box_keypair() -> ([u8; BOX_PUBLIC_BYTES], [u8; BOX_SECRET_BYTES]) {
    init();
    let mut public = [0u8; BOX_PUBLIC_BYTES];
    let mut secret = [0u8; BOX_SECRET_BYTES];
    let rc = unsafe { ffi::crypto_box_keypair(public.as_mut_ptr(), secret.as_mut_ptr()) };
    assert_eq!(rc, 0);
    (public, secret)
}

pub fn box_seal(plaintext: &[u8], recipient_public: &[u8; BOX_PUBLIC_BYTES]) -> Vec<u8> {
    init();
    let mut out = vec![0u8; plaintext.len() + BOX_SEAL_BYTES];
    let rc = unsafe {
        ffi::crypto_box_seal(
            out.as_mut_ptr(),
            plaintext.as_ptr(),
            plaintext.len() as u64,
            recipient_public.as_ptr(),
        )
    };
    assert_eq!(rc, 0);
    out
}

pub fn box_seal_open(
    ciphertext: &[u8],
    public: &[u8; BOX_PUBLIC_BYTES],
    secret: &[u8; BOX_SECRET_BYTES],
) -> Result<Vec<u8>, CryptoError> {
    init();
    if ciphertext.len() < BOX_SEAL_BYTES {
        return Err(CryptoError::Malformed("sealed box shorter than its overhead"));
    }
    let mut out = vec![0u8; ciphertext.len() - BOX_SEAL_BYTES];
    let rc = unsafe {
        ffi::crypto_box_seal_open(
            out.as_mut_ptr(),
            ciphertext.as_ptr(),
            ciphertext.len() as u64,
            public.as_ptr(),
            secret.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(CryptoError::Rejected("sealed box did not open"));
    }
    Ok(out)
}
