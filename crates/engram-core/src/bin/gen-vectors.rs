//! Writes the Rust half of the cross-language vectors; the mirror of
//! `packages/crypto/scripts/gen-vectors.mjs`, same two-file split:
//! deterministic `vectors.json` (regenerated, diffed in CI) and
//! `sealed.json` plus binary sidecars (written once, opened by the
//! TypeScript side).

use engram_core::{b64, chunked, digest, keys, metadata, secretbox, sealedbox, stream};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn pattern(n: usize, mul: usize, add: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * mul + add) % 256) as u8).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sizes() -> Vec<Value> {
    [0u64, 1, 100, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9_000_000]
        .iter()
        .map(|n| {
            json!({ "plain": n, "chunked": chunked::ciphertext_size(*n),
                     "stream": stream::ciphertext_size(*n) })
        })
        .collect()
}

fn main() {
    engram_core::init();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/crypto/test/vectors/rs");
    fs::create_dir_all(&dir).expect("vectors dir");

    let key: [u8; 32] = pattern(32, 13, 5).try_into().unwrap();
    let salt16: [u8; 16] = pattern(16, 11, 2).try_into().unwrap();
    let secret = pattern(48, 7, 3);
    let nonce: [u8; 24] = pattern(24, 19, 6).try_into().unwrap();

    // ---- deterministic ----
    let kek_floor = keys::derive_kek("correct horse battery staple", &salt16, 2, 19 * 1024 * 1024)
        .expect("argon2id floor");
    let kek_mid =
        keys::derive_kek("pässwörd — unicode", &salt16, 3, 64 * 1024 * 1024).expect("argon2id mid");
    let login_key = keys::derive_login_key(&kek_floor);

    let egc_plain = pattern(4 * 1024 * 1024 + 3, 29, 3);
    let egc_blob = chunked::encrypt(&egc_plain, &key, &salt16);

    let incremental = {
        let mut d = digest::Digester::new();
        d.update(&pattern(10, 1, 0));
        d.update(&pattern(20, 5, 9));
        d.finish()
    };

    let vectors = json!({
        "b64url": [
            { "hexIn": "", "out": b64::to_b64url(&[]) },
            { "hexIn": "00", "out": b64::to_b64url(&[0]) },
            { "hexIn": "0001", "out": b64::to_b64url(&[0, 1]) },
            { "hexIn": "fbff7e", "out": b64::to_b64url(&[0xfb, 0xff, 0x7e]) },
            { "hexIn": hex(&key), "out": b64::to_b64url(&key) },
        ],
        "b64std": { "hexIn": "fbff7e00", "out": b64::to_b64std(&[0xfb, 0xff, 0x7e, 0]) },
        "digest": [
            { "hexIn": "", "out": digest::digest(&[]) },
            { "hexIn": hex(&pattern(100, 3, 1)), "out": digest::digest(&pattern(100, 3, 1)) },
            { "incremental": [hex(&pattern(10, 1, 0)), hex(&pattern(20, 5, 9))], "out": incremental },
        ],
        "argon2id": [
            { "password": "correct horse battery staple", "salt": b64::to_b64url(&salt16),
              "opsLimit": 2, "memLimit": 19 * 1024 * 1024, "kek": b64::to_b64url(&kek_floor) },
            { "password": "pässwörd — unicode", "salt": b64::to_b64url(&salt16),
              "opsLimit": 3, "memLimit": 64 * 1024 * 1024, "kek": b64::to_b64url(&kek_mid) },
        ],
        "kdf": {
            "kek": b64::to_b64url(&kek_floor),
            "loginKey": b64::to_b64url(&login_key),
            "loginKeyDigest": b64::to_b64url(&keys::login_key_digest(&login_key)),
            "unlockSecretHex": hex(&secret),
            "unlockKey": b64::to_b64url(&keys::derive_unlock_key(&secret)),
            "shareSubkey1": b64::to_b64url(&keys::share_subkey(&kek_floor, 1)),
            "shareSubkey2": b64::to_b64url(&keys::share_subkey(&kek_floor, 2)),
        },
        "secretbox": {
            "keyHex": hex(&key), "nonceHex": hex(&nonce), "plainHex": hex(&pattern(64, 9, 4)),
            "box": secretbox::seal_with_nonce(&pattern(64, 9, 4), &key, &nonce),
        },
        "egc1": { "keyHex": hex(&key), "saltHex": hex(&salt16), "plainMul": 29, "plainAdd": 3,
                   "plainLen": egc_plain.len(), "file": "egc1.bin" },
        "sizes": sizes(),
    });
    fs::write(dir.join("vectors.json"), serde_json::to_string_pretty(&vectors).unwrap())
        .expect("write vectors.json");
    fs::write(dir.join("egc1.bin"), &egc_blob).expect("write egc1.bin");
    println!("vectors.json + egc1.bin written");

    // ---- sealed (write once) ----
    let sealed_path = dir.join("sealed.json");
    if sealed_path.exists() {
        println!("sealed.json already present, kept as committed");
        return;
    }
    // The TypeScript side committed a keypair; seal to its public key so
    // its consumer test can open with the matching secret.
    let ts_sealed: Value = serde_json::from_str(
        &fs::read_to_string(dir.parent().unwrap().join("ts/sealed.json"))
            .expect("ts/sealed.json exists (run the TypeScript generator first)"),
    )
    .unwrap();
    let ts_public = ts_sealed["sealedbox"]["publicKey"].as_str().unwrap();

    let stream_plain = pattern(100_000, 23, 15);
    let stream_blob = stream::encrypt_bytes(&stream_plain, &key);

    let meta = metadata::FileMetadata {
        name: "rust née fixture.pdf".into(),
        mime: "application/pdf".into(),
        size: 4242,
        mtime: 1_754_600_000_000,
        tags: Some(vec!["album:fixtures".into(), "rusty".into()]),
        favorite: Some(false),
        digest: Some(digest::digest(&stream_plain)),
        source_id: Some("asset-0001".into()),
        ..Default::default()
    };

    let sealed = json!({
        "keyHex": hex(&key),
        "stream": { "plainMul": 23, "plainAdd": 15, "plainLen": stream_plain.len(), "file": "stream.bin" },
        "sealedbox": {
            "toPublicKey": ts_public,
            "message": "sealed from rust",
            "sealed": sealedbox::seal_to_public_key(b"sealed from rust", ts_public).unwrap(),
        },
        "metadata": { "value": meta, "box": metadata::encrypt_file_metadata(&meta, &key) },
    });
    fs::write(sealed_path, serde_json::to_string_pretty(&sealed).unwrap()).expect("write sealed.json");
    fs::write(dir.join("stream.bin"), &stream_blob).expect("write stream.bin");
    println!("sealed.json + stream.bin written");
}
