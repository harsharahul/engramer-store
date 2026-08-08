//! The whole surface Swift sees, kept deliberately small: an extension
//! hands over a plaintext file and the master key, and receives every
//! sealed artifact the upload API needs. All format knowledge stays in
//! `engram-core`; all networking stays in Swift, because only a Swift
//! background URLSession survives the extension's death.

use engram_core::{digest::Digester, metadata, secretbox, stream};
use std::fs::File;
use std::io::{Read, Write};

uniffi::setup_scaffolding!();

#[derive(Debug, uniffi::Error)]
pub enum FfiError {
    Failed { reason: String },
}

impl std::fmt::Display for FfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FfiError::Failed { reason } => write!(f, "{reason}"),
        }
    }
}

impl std::error::Error for FfiError {}

fn fail<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> FfiError + '_ {
    move |err| FfiError::Failed {
        reason: format!("{what}: {err}"),
    }
}

/// Everything the upload API needs for one new file, produced in one
/// pass over the plaintext.
#[derive(uniffi::Record)]
pub struct UploadEnvelope {
    /// The per-file key wrapped under the master key, as the JSON the
    /// server stores ({"ciphertext","nonce"}, base64url values).
    pub encrypted_key_json: String,
    /// The encrypted metadata JSON in the same shape.
    pub encrypted_meta_json: String,
    /// BLAKE2b-256 of the plaintext, as carried inside the metadata too.
    pub digest: String,
    /// Ciphertext size in bytes, what lands in the blob store.
    pub ciphertext_size: u64,
}

/// Encrypts `input_path` to `output_path` as a content secretstream under
/// a fresh file key, computing the plaintext digest in the same read, and
/// returns the sealed key and metadata. Streams in 4 MiB chunks; peak
/// memory stays near one chunk regardless of file size, which is what an
/// extension's memory budget demands.
#[uniffi::export]
pub fn encrypt_for_upload(
    input_path: String,
    output_path: String,
    master_key: Vec<u8>,
    name: String,
    mime: String,
    mtime_ms: u64,
    source_id: Option<String>,
) -> Result<UploadEnvelope, FfiError> {
    engram_core::init();
    let master: [u8; 32] = master_key.try_into().map_err(|_| FfiError::Failed {
        reason: "master key must be 32 bytes".into(),
    })?;

    let mut input = File::open(&input_path).map_err(fail("open input"))?;
    let plain_size = input.metadata().map_err(fail("stat input"))?.len();
    let mut output = File::create(&output_path).map_err(fail("create output"))?;

    let file_key = secretbox::generate_key();
    let mut encryptor = stream::StreamEncryptor::new(&file_key);
    output
        .write_all(&encryptor.header())
        .map_err(fail("write header"))?;

    let mut digester = Digester::new();
    let mut written: u64 = engram_core::backend::STREAM_HEADER_BYTES as u64;
    let mut buffer = vec![0u8; stream::CHUNK_SIZE];
    let mut remaining = plain_size;
    loop {
        let want = buffer.len().min(remaining.max(0) as usize);
        let read = if want == 0 {
            0
        } else {
            read_full(&mut input, &mut buffer[..want])?
        };
        let final_chunk = remaining <= read as u64;
        digester.update(&buffer[..read]);
        let sealed = encryptor.push(&buffer[..read], final_chunk);
        output.write_all(&sealed).map_err(fail("write chunk"))?;
        written += sealed.len() as u64;
        remaining -= read as u64;
        if final_chunk {
            break;
        }
    }
    output.sync_all().map_err(fail("flush output"))?;

    let digest = digester.finish();
    let meta = metadata::FileMetadata {
        name,
        mime,
        size: plain_size,
        mtime: mtime_ms,
        digest: Some(digest.clone()),
        source_id,
        ..Default::default()
    };

    Ok(UploadEnvelope {
        encrypted_key_json: serde_json::to_string(&secretbox::seal(&file_key, &master))
            .map_err(fail("serialize key"))?,
        encrypted_meta_json: serde_json::to_string(&metadata::encrypt_file_metadata(
            &meta, &file_key,
        ))
        .map_err(fail("serialize metadata"))?,
        digest,
        ciphertext_size: written,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole extension flow in miniature: envelope out, bytes back.
    #[test]
    fn round_trips_through_the_envelope() {
        let dir = std::env::temp_dir().join("engram-ffi-test");
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.bin");
        let output = dir.join("out.bin");
        let plain: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&input, &plain).unwrap();
        let master = engram_core::secretbox::generate_key().to_vec();

        let envelope = encrypt_for_upload(
            input.to_string_lossy().into(),
            output.to_string_lossy().into(),
            master.clone(),
            "roundtrip.bin".into(),
            "application/octet-stream".into(),
            1_754_700_000_000,
            Some("asset-42".into()),
        )
        .unwrap();

        let blob = std::fs::read(&output).unwrap();
        assert_eq!(blob.len() as u64, envelope.ciphertext_size);
        let file_key = open_file_key(envelope.encrypted_key_json.clone(), master.clone()).unwrap();
        assert_eq!(decrypt_content(blob, file_key.clone()).unwrap(), plain);
        assert_eq!(envelope.digest, engram_core::digest::digest(&plain));

        let sealed: engram_core::secretbox::SecretBox =
            serde_json::from_str(&envelope.encrypted_meta_json).unwrap();
        let key: [u8; 32] = file_key.try_into().unwrap();
        let meta = engram_core::metadata::decrypt_file_metadata(&sealed, &key).unwrap();
        assert_eq!(meta.name, "roundtrip.bin");
        assert_eq!(meta.size, plain.len() as u64);
        assert_eq!(meta.source_id.as_deref(), Some("asset-42"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The write-side helpers Stage 3B adds: metadata reseal and the
    /// folder envelope, both opened back through the read side.
    #[test]
    fn reseals_metadata_and_builds_folder_envelopes() {
        let master = engram_core::secretbox::generate_key().to_vec();
        let file_key = engram_core::secretbox::generate_key().to_vec();

        let sealed = encrypt_metadata_json(
            r#"{"name":"renamed née doc.txt","mime":"text/plain","size":3,"mtime":1}"#.into(),
            file_key.clone(),
        )
        .unwrap();
        let opened = decrypt_metadata_json(sealed, file_key).unwrap();
        assert!(opened.contains("renamed née doc.txt"));

        let envelope = folder_envelope("Backups".into(), master.clone()).unwrap();
        let folder_key = open_file_key(envelope.encrypted_key_json, master).unwrap();
        let meta = decrypt_metadata_json(envelope.encrypted_meta_json, folder_key).unwrap();
        assert_eq!(meta, r#"{"name":"Backups"}"#);

        let file_key2 = engram_core::secretbox::generate_key().to_vec();
        let replaced = encrypt_content(b"replacement bytes".to_vec(), file_key2.clone()).unwrap();
        assert_eq!(
            decrypt_content(replaced, file_key2).unwrap(),
            b"replacement bytes"
        );
    }
}

fn read_full(input: &mut File, buffer: &mut [u8]) -> Result<usize, FfiError> {
    let mut filled = 0;
    while filled < buffer.len() {
        let n = input
            .read(&mut buffer[filled..])
            .map_err(fail("read input"))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Decrypts a whole content blob; Stage 3's read path, exposed now so the
/// binding surface is stable.
#[uniffi::export]
pub fn decrypt_content(blob: Vec<u8>, file_key: Vec<u8>) -> Result<Vec<u8>, FfiError> {
    engram_core::init();
    let key: [u8; 32] = file_key.try_into().map_err(|_| FfiError::Failed {
        reason: "file key must be 32 bytes".into(),
    })?;
    if blob.len() >= 4 && &blob[..4] == b"EGC1" {
        return engram_core::chunked::decrypt(&blob, &key).map_err(|e| FfiError::Failed {
            reason: e.to_string(),
        });
    }
    stream::decrypt_bytes(&blob, &key).map_err(|e| FfiError::Failed {
        reason: e.to_string(),
    })
}

/// Decrypts an encrypted metadata blob ({"ciphertext","nonce"} JSON)
/// with the object's own key and returns the plaintext JSON for Swift to
/// parse. Serves files and folders alike; the caller knows which fields
/// it wants.
#[uniffi::export]
pub fn decrypt_metadata_json(
    encrypted_meta_json: String,
    object_key: Vec<u8>,
) -> Result<String, FfiError> {
    engram_core::init();
    let key: [u8; 32] = object_key.try_into().map_err(|_| FfiError::Failed {
        reason: "object key must be 32 bytes".into(),
    })?;
    let sealed: secretbox::SecretBox =
        serde_json::from_str(&encrypted_meta_json).map_err(|_| FfiError::Failed {
            reason: "not encrypted metadata".into(),
        })?;
    let plain = secretbox::open(&sealed, &key).map_err(|e| FfiError::Failed {
        reason: e.to_string(),
    })?;
    String::from_utf8(plain).map_err(|_| FfiError::Failed {
        reason: "metadata is not utf8".into(),
    })
}

/// Encrypts replacement content under the file's EXISTING key, as the
/// default stream format: the modify path, where the key must not change
/// because other references (metadata, thumbnails) are sealed under it.
#[uniffi::export]
pub fn encrypt_content(plain: Vec<u8>, file_key: Vec<u8>) -> Result<Vec<u8>, FfiError> {
    engram_core::init();
    let key: [u8; 32] = file_key.try_into().map_err(|_| FfiError::Failed {
        reason: "file key must be 32 bytes".into(),
    })?;
    Ok(stream::encrypt_bytes(&plain, &key))
}

/// Seals plaintext metadata JSON under the object's own key: the write
/// half of `decrypt_metadata_json`, for a rename or a content update that
/// edits fields Swift-side and re-seals the whole object.
#[uniffi::export]
pub fn encrypt_metadata_json(meta_json: String, object_key: Vec<u8>) -> Result<String, FfiError> {
    engram_core::init();
    let key: [u8; 32] = object_key.try_into().map_err(|_| FfiError::Failed {
        reason: "object key must be 32 bytes".into(),
    })?;
    serde_json::to_string(&secretbox::seal(meta_json.as_bytes(), &key)).map_err(|_| {
        FfiError::Failed {
            reason: "could not serialize sealed metadata".into(),
        }
    })
}

/// Everything a new folder needs: a fresh folder key wrapped under the
/// master key, and the `{name}` metadata sealed under the folder key.
#[derive(uniffi::Record)]
pub struct FolderEnvelope {
    pub encrypted_key_json: String,
    pub encrypted_meta_json: String,
}

#[uniffi::export]
pub fn folder_envelope(name: String, master_key: Vec<u8>) -> Result<FolderEnvelope, FfiError> {
    engram_core::init();
    let master: [u8; 32] = master_key.try_into().map_err(|_| FfiError::Failed {
        reason: "master key must be 32 bytes".into(),
    })?;
    let folder_key = secretbox::generate_key();
    let meta = serde_json::json!({ "name": name });
    Ok(FolderEnvelope {
        encrypted_key_json: serde_json::to_string(&secretbox::seal(&folder_key, &master))
            .map_err(fail("serialize folder key"))?,
        encrypted_meta_json: serde_json::to_string(&secretbox::seal(
            meta.to_string().as_bytes(),
            &folder_key,
        ))
        .map_err(fail("serialize folder metadata"))?,
    })
}

/// BLAKE2b-256 of the given bytes, base64url: the digest the metadata
/// carries, so a provider can verify what it materialized.
#[uniffi::export]
pub fn content_digest(bytes: Vec<u8>) -> String {
    engram_core::init();
    engram_core::digest::digest(&bytes)
}

/// Opens a wrapped per-file key ({"ciphertext","nonce"} JSON) with the
/// master key.
#[uniffi::export]
pub fn open_file_key(encrypted_key_json: String, master_key: Vec<u8>) -> Result<Vec<u8>, FfiError> {
    engram_core::init();
    let master: [u8; 32] = master_key.try_into().map_err(|_| FfiError::Failed {
        reason: "master key must be 32 bytes".into(),
    })?;
    let sealed: secretbox::SecretBox =
        serde_json::from_str(&encrypted_key_json).map_err(|_| FfiError::Failed {
            reason: "not a wrapped key".into(),
        })?;
    secretbox::open(&sealed, &master).map_err(|e| FfiError::Failed {
        reason: e.to_string(),
    })
}
