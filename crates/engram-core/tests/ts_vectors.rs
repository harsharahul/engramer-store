//! Consumes the vectors the TypeScript side generated: every deterministic
//! value must reproduce here byte for byte, and every sealed artifact must
//! open. This test failing means the two implementations disagree about a
//! byte, which is the one bug this codebase treats as unforgivable.

use engram_core::{b64, chunked, digest, keys, metadata, secretbox, sealedbox, stream};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn ts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/crypto/test/vectors/ts")
}

fn load(name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(ts_dir().join(name)).expect(name)).expect("json")
}

fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

fn pattern(n: usize, mul: usize, add: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * mul + add) % 256) as u8).collect()
}

#[test]
fn b64url_matches() {
    for case in load("vectors.json")["b64url"].as_array().unwrap() {
        let bytes = from_hex(case["hexIn"].as_str().unwrap());
        let expected = case["out"].as_str().unwrap();
        assert_eq!(b64::to_b64url(&bytes), expected, "encode {}", case["hexIn"]);
        assert_eq!(b64::from_b64url(expected).unwrap(), bytes, "decode {}", case["hexIn"]);
    }
}

#[test]
fn digests_match() {
    for case in load("vectors.json")["digest"].as_array().unwrap() {
        let expected = case["out"].as_str().unwrap();
        if let Some(parts) = case["incremental"].as_array() {
            let mut d = digest::Digester::new();
            for part in parts {
                d.update(&from_hex(part.as_str().unwrap()));
            }
            assert_eq!(d.finish(), expected);
        } else {
            assert_eq!(digest::digest(&from_hex(case["hexIn"].as_str().unwrap())), expected);
        }
    }
}

#[test]
fn argon2id_matches() {
    for case in load("vectors.json")["argon2id"].as_array().unwrap() {
        let salt: [u8; 16] = b64::from_b64url(case["salt"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let kek = keys::derive_kek(
            case["password"].as_str().unwrap(),
            &salt,
            case["opsLimit"].as_u64().unwrap(),
            case["memLimit"].as_u64().unwrap() as usize,
        )
        .unwrap();
        assert_eq!(b64::to_b64url(&kek), case["kek"].as_str().unwrap());
    }
}

#[test]
fn kdf_chain_matches() {
    let v = load("vectors.json");
    let kdf = &v["kdf"];
    let kek: [u8; 32] = b64::from_b64url(kdf["kek"].as_str().unwrap()).unwrap().try_into().unwrap();
    let login = keys::derive_login_key(&kek);
    assert_eq!(b64::to_b64url(&login), kdf["loginKey"].as_str().unwrap());
    assert_eq!(
        b64::to_b64url(&keys::login_key_digest(&login)),
        kdf["loginKeyDigest"].as_str().unwrap()
    );
    let secret = from_hex(kdf["unlockSecretHex"].as_str().unwrap());
    assert_eq!(
        b64::to_b64url(&keys::derive_unlock_key(&secret)),
        kdf["unlockKey"].as_str().unwrap()
    );
}

#[test]
fn sizes_match() {
    for case in load("vectors.json")["sizes"].as_array().unwrap() {
        let plain = case["plain"].as_u64().unwrap();
        assert_eq!(chunked::ciphertext_size(plain), case["chunked"].as_u64().unwrap(), "chunked {plain}");
        assert_eq!(stream::ciphertext_size(plain), case["stream"].as_u64().unwrap(), "stream {plain}");
        assert_eq!(case["streamBack"].as_u64().unwrap(), plain, "round trip {plain}");
    }
}

#[test]
fn opens_typescript_secretbox() {
    let sealed = load("sealed.json");
    let key: [u8; 32] = from_hex(sealed["keyHex"].as_str().unwrap()).try_into().unwrap();
    let case = &sealed["secretbox"];
    let sbox: secretbox::SecretBox = serde_json::from_value(case["box"].clone()).unwrap();
    assert_eq!(
        secretbox::open(&sbox, &key).unwrap(),
        from_hex(case["plainHex"].as_str().unwrap())
    );
}

#[test]
fn opens_typescript_stream_and_rejects_truncation() {
    let sealed = load("sealed.json");
    let key: [u8; 32] = from_hex(sealed["keyHex"].as_str().unwrap()).try_into().unwrap();
    let blob = fs::read(ts_dir().join("stream.bin")).unwrap();
    let case = &sealed["stream"];
    let expected = pattern(
        case["plainLen"].as_u64().unwrap() as usize,
        case["plainMul"].as_u64().unwrap() as usize,
        case["plainAdd"].as_u64().unwrap() as usize,
    );
    assert_eq!(stream::decrypt_bytes(&blob, &key).unwrap(), expected);
    assert!(stream::decrypt_bytes(&blob[..blob.len() - 10], &key).is_err(), "truncation must fail");
    let mut evil = blob.clone();
    evil[40] ^= 1;
    assert!(stream::decrypt_bytes(&evil, &key).is_err(), "tampering must fail");
}

#[test]
fn opens_typescript_egc1_and_rejects_tampering() {
    let sealed = load("sealed.json");
    let key: [u8; 32] = from_hex(sealed["keyHex"].as_str().unwrap()).try_into().unwrap();
    let blob = fs::read(ts_dir().join("egc1.bin")).unwrap();
    let case = &sealed["egc1"];
    let expected = pattern(
        case["plainLen"].as_u64().unwrap() as usize,
        case["plainMul"].as_u64().unwrap() as usize,
        case["plainAdd"].as_u64().unwrap() as usize,
    );
    assert_eq!(chunked::decrypt(&blob, &key).unwrap(), expected);
    let mut evil = blob.clone();
    let last = evil.len() - 1;
    evil[last] ^= 1;
    assert!(chunked::decrypt(&evil, &key).is_err(), "tampering must fail");
}

#[test]
fn opens_typescript_sealed_box() {
    let sealed = load("sealed.json");
    let case = &sealed["sealedbox"];
    let pair = sealedbox::KeyPair {
        public: b64::from_b64url(case["publicKey"].as_str().unwrap()).unwrap().try_into().unwrap(),
        secret: b64::from_b64url(case["privateKey"].as_str().unwrap()).unwrap().try_into().unwrap(),
    };
    let opened = sealedbox::open_sealed(case["sealed"].as_str().unwrap(), &pair).unwrap();
    assert_eq!(opened, case["message"].as_str().unwrap().as_bytes());
}

#[test]
fn opens_typescript_metadata_preserving_unknown_fields() {
    let sealed = load("sealed.json");
    let key: [u8; 32] = from_hex(sealed["keyHex"].as_str().unwrap()).try_into().unwrap();
    let case = &sealed["metadata"];
    let sbox: secretbox::SecretBox = serde_json::from_value(case["box"].clone()).unwrap();
    let meta = metadata::decrypt_file_metadata(&sbox, &key).unwrap();
    assert_eq!(meta.name, case["value"]["name"].as_str().unwrap());
    assert_eq!(meta.mime, "image/heic");
    assert_eq!(meta.tags.as_deref().unwrap(), ["album:fixtures", "sunny"]);
    assert_eq!(meta.favorite, Some(true));
    // The field this crate does not model must survive a round trip.
    assert_eq!(meta.extra["futureField"]["keep"], "me");
    let resealed = metadata::encrypt_file_metadata(&meta, &key);
    let again = metadata::decrypt_file_metadata(&resealed, &key).unwrap();
    assert_eq!(again, meta);
}
