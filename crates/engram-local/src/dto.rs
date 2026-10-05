//! The server's JSON shapes for folder and file rows (its `folderToDto`
//! and `fileToDto`), read straight from SQLite rows.

use rusqlite::Row;
use serde::Serialize;
use serde_json::Value;

/// Selects files with the server's `has_collaborators` column.
pub const FILES_WITH_COLLABORATORS: &str = "SELECT files.*, EXISTS(
   SELECT 1 FROM file_collaborators c WHERE c.file_id = files.id AND c.revoked = 0
 ) AS has_collaborators FROM files";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub encrypted_key: Value,
    pub encrypted_meta: Value,
    pub deleted: bool,
    pub update_seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `hasCollaborators` appears only when the query computed it, as on the
/// server: sync, PATCH and batch answers carry it; a new file does not.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDto {
    pub id: String,
    pub folder_id: Option<String>,
    pub encrypted_key: Value,
    pub encrypted_meta: Value,
    pub key_epoch: i64,
    pub generation: i64,
    pub size: i64,
    pub thumb_size: i64,
    pub index_size: i64,
    pub uploaded: bool,
    pub trashed: bool,
    pub deleted: bool,
    pub update_seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_collaborators: Option<bool>,
}

fn parse_json(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

pub fn folder_from(row: &Row<'_>) -> rusqlite::Result<FolderDto> {
    Ok(FolderDto {
        id: row.get("id")?,
        parent_id: row.get("parent_id")?,
        encrypted_key: parse_json(row.get("encrypted_key")?),
        encrypted_meta: parse_json(row.get("encrypted_meta")?),
        deleted: row.get::<_, i64>("deleted")? == 1,
        update_seq: row.get("update_seq")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// A file row; `collaborators` reads the `has_collaborators` column that
/// `FILES_WITH_COLLABORATORS` adds.
pub fn file_from(row: &Row<'_>, collaborators: bool) -> rusqlite::Result<FileDto> {
    Ok(FileDto {
        id: row.get("id")?,
        folder_id: row.get("folder_id")?,
        encrypted_key: parse_json(row.get("encrypted_key")?),
        encrypted_meta: parse_json(row.get("encrypted_meta")?),
        key_epoch: row.get("key_epoch")?,
        generation: row.get("generation")?,
        size: row.get("size")?,
        thumb_size: row.get("thumb_size")?,
        index_size: row.get("index_size")?,
        uploaded: row.get::<_, i64>("uploaded")? == 1,
        trashed: row.get::<_, i64>("trashed")? == 1,
        deleted: row.get::<_, i64>("deleted")? == 1,
        update_seq: row.get("update_seq")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        has_collaborators: if collaborators {
            Some(row.get::<_, i64>("has_collaborators")? != 0)
        } else {
            None
        },
    })
}
