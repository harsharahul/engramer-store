//! File and folder metadata, the JSON sealed under each object's own key.
//! Mirrors `packages/crypto/src/metadata.ts`. Unknown fields survive a
//! round trip untouched (`extra`), because this crate must never destroy
//! a field a newer web client wrote.

use crate::secretbox::{open, seal, SecretBox};
use crate::CryptoError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub mtime: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blur: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// The photo-library identifier a backed-up asset came from; lets a
    /// reinstall rebuild its ledger from synced metadata alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Every field this version does not model, preserved byte-faithfully.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderMetadata {
    pub name: String,
}

pub fn encrypt_file_metadata(meta: &FileMetadata, key: &[u8; 32]) -> SecretBox {
    seal(
        serde_json::to_string(meta)
            .expect("metadata serializes")
            .as_bytes(),
        key,
    )
}

pub fn decrypt_file_metadata(
    sealed: &SecretBox,
    key: &[u8; 32],
) -> Result<FileMetadata, CryptoError> {
    let plain = open(sealed, key)?;
    serde_json::from_slice(&plain).map_err(|_| CryptoError::Malformed("file metadata JSON"))
}

pub fn decrypt_folder_metadata(
    sealed: &SecretBox,
    key: &[u8; 32],
) -> Result<FolderMetadata, CryptoError> {
    let plain = open(sealed, key)?;
    serde_json::from_slice(&plain).map_err(|_| CryptoError::Malformed("folder metadata JSON"))
}
