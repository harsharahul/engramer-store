//! The account's sealed settings blob and the change feed's read side,
//! `GET /api/sync`, with the server's cursor rule: the account's sequence
//! is read first and every query is bounded by it, so a write committing
//! mid-request can never move a client past a row it did not receive.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::extract::{blocking, AuthUser, JsonBody};
use crate::server::AppState;
use crate::store::{next_seq, now_ms};
use crate::validate::js_len;

/// The largest settings blob the server accepts, in JavaScript characters.
pub const SETTINGS_MAX: usize = 16_384;
/// The largest sync page the server serves.
pub const SYNC_PAGE_MAX: i64 = 2000;

#[derive(Deserialize)]
pub struct SettingsBody {
    blob: String,
}

pub async fn get_settings(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let (blob, updated) = blocking(&state, move |store| {
        Ok(store.conn().query_row(
            "SELECT settings_blob, settings_updated_ms FROM users WHERE id = ?1",
            params![auth.uid],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<i64>>(1)?)),
        )?)
    })
    .await?;
    Ok(Json(
        json!({ "blob": blob, "updatedAt": updated.unwrap_or(0) }),
    ))
}

/// Stores the blob and advances the account's change sequence, so other
/// devices are poked to pull.
pub async fn put_settings(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    JsonBody(body): JsonBody<SettingsBody>,
) -> Result<Json<Value>, ApiError> {
    if js_len(&body.blob) > SETTINGS_MAX {
        return Err(ApiError::invalid_request());
    }
    let updated = now_ms();
    blocking(&state, move |store| {
        store.tx(|tx| {
            tx.execute(
                "UPDATE users SET settings_blob = ?1, settings_updated_ms = ?2 WHERE id = ?3",
                params![body.blob, updated, auth.uid],
            )?;
            next_seq(tx, auth.uid)?;
            Ok::<(), ApiError>(())
        })
    })
    .await?;
    Ok(Json(json!({ "updatedAt": updated })))
}

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
    pub has_collaborators: bool,
}

fn parse_json(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

fn folder_from(row: &Row<'_>) -> rusqlite::Result<FolderDto> {
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

fn file_from(row: &Row<'_>) -> rusqlite::Result<FileDto> {
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
        has_collaborators: row.get::<_, i64>("has_collaborators")? != 0,
    })
}

/// `Number(text)` for the query parameters: absent or unreadable is 0.
fn query_number(query: &HashMap<String, String>, name: &str) -> f64 {
    query
        .get(name)
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

/// One sync page: everything with `since < update_seq <= cursor`, where
/// the cursor is the account's sequence read first; with `limit`, at most
/// `limit` rows per collection and a cursor lowered to the last row of any
/// collection that overflowed, so every collection's window is complete.
pub fn sync_page(conn: &Connection, uid: i64, since: i64, limit: i64) -> rusqlite::Result<Value> {
    let up_to: i64 = conn.query_row(
        "SELECT last_seq FROM users WHERE id = ?1",
        params![uid],
        |r| r.get(0),
    )?;
    let probe = if limit > 0 {
        format!(" LIMIT {}", limit + 1)
    } else {
        String::new()
    };
    let mut folders = conn
        .prepare(&format!(
            "SELECT * FROM folders WHERE user_id = ?1 AND update_seq > ?2 AND update_seq <= ?3 ORDER BY update_seq{probe}"
        ))?
        .query_map(params![uid, since, up_to], folder_from)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut files = conn
        .prepare(&format!(
            "SELECT files.*, EXISTS(
               SELECT 1 FROM file_collaborators c WHERE c.file_id = files.id AND c.revoked = 0
             ) AS has_collaborators
             FROM files WHERE user_id = ?1 AND update_seq > ?2 AND update_seq <= ?3 ORDER BY update_seq{probe}"
        ))?
        .query_map(params![uid, since, up_to], file_from)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut seq = up_to;
    if limit > 0 {
        let cap = limit as usize;
        if folders.len() > cap {
            seq = seq.min(folders[cap - 1].update_seq);
        }
        if files.len() > cap {
            seq = seq.min(files[cap - 1].update_seq);
        }
        folders.retain(|f| f.update_seq <= seq);
        files.retain(|f| f.update_seq <= seq);
    }
    Ok(json!({ "seq": seq, "folders": folders, "files": files, "shared": [] }))
}

pub async fn sync(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let since = query_number(&query, "since") as i64;
    let raw_limit = query_number(&query, "limit");
    let limit = if raw_limit > 0.0 {
        (raw_limit.floor() as i64).min(SYNC_PAGE_MAX)
    } else {
        0
    };
    let page = blocking(&state, move |store| {
        Ok(sync_page(&store.conn(), auth.uid, since, limit)?)
    })
    .await?;
    Ok(Json(page))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Store, DB_FILE};

    struct Vault {
        dir: std::path::PathBuf,
        store: Store,
        uid: i64,
    }

    impl Drop for Vault {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn vault() -> Vault {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "engram-local-sync-{}-{n}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join(DB_FILE)).unwrap();
        let uid = store
            .conn()
            .query_row(
                "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES ('a@example.com', 'd', '{}', 0) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        Vault { dir, store, uid }
    }

    fn add_folder(conn: &Connection, uid: i64, id: &str) {
        let seq = next_seq(conn, uid).unwrap();
        conn.execute(
            "INSERT INTO folders (id, user_id, parent_id, encrypted_key, encrypted_meta, update_seq, created_at, updated_at) VALUES (?1, ?2, NULL, '{\"ciphertext\":\"k\",\"nonce\":\"n\"}', '{\"ciphertext\":\"m\",\"nonce\":\"n\"}', ?3, 1, 2)",
            params![id, uid, seq],
        )
        .unwrap();
    }

    fn add_file(conn: &Connection, uid: i64, id: &str) {
        let seq = next_seq(conn, uid).unwrap();
        conn.execute(
            "INSERT INTO files (id, user_id, folder_id, encrypted_key, encrypted_meta, update_seq, created_at, updated_at) VALUES (?1, ?2, NULL, '{\"ciphertext\":\"k\",\"nonce\":\"n\"}', '{\"ciphertext\":\"m\",\"nonce\":\"n\"}', ?3, 1, 2)",
            params![id, uid, seq],
        )
        .unwrap();
    }

    #[test]
    fn an_empty_account_syncs_to_its_sequence() {
        let v = vault();
        let page = sync_page(&v.store.conn(), v.uid, 0, 0).unwrap();
        assert_eq!(
            page,
            json!({ "seq": 0, "folders": [], "files": [], "shared": [] })
        );
    }

    #[test]
    fn rows_carry_the_servers_fields() {
        let v = vault();
        let conn = v.store.conn();
        add_folder(&conn, v.uid, "folder-1");
        add_file(&conn, v.uid, "file-1");
        let page = sync_page(&conn, v.uid, 0, 0).unwrap();
        assert_eq!(page["seq"], 2);
        assert_eq!(
            page["folders"][0],
            json!({
                "id": "folder-1", "parentId": null,
                "encryptedKey": { "ciphertext": "k", "nonce": "n" },
                "encryptedMeta": { "ciphertext": "m", "nonce": "n" },
                "deleted": false, "updateSeq": 1, "createdAt": 1, "updatedAt": 2
            })
        );
        assert_eq!(
            page["files"][0],
            json!({
                "id": "file-1", "folderId": null,
                "encryptedKey": { "ciphertext": "k", "nonce": "n" },
                "encryptedMeta": { "ciphertext": "m", "nonce": "n" },
                "keyEpoch": 0, "generation": 0, "size": 0, "thumbSize": 0, "indexSize": 0,
                "uploaded": false, "trashed": false, "deleted": false,
                "updateSeq": 2, "createdAt": 1, "updatedAt": 2, "hasCollaborators": false
            })
        );
        let later = sync_page(&conn, v.uid, 1, 0).unwrap();
        assert_eq!(later["folders"], json!([]));
        assert_eq!(later["files"][0]["id"], "file-1");
    }

    #[test]
    fn a_limited_page_moves_every_collection_together() {
        let v = vault();
        let conn = v.store.conn();
        // seq 1..=3 folders, 4..=5 files.
        for id in ["f1", "f2", "f3"] {
            add_folder(&conn, v.uid, id);
        }
        for id in ["x1", "x2"] {
            add_file(&conn, v.uid, id);
        }
        let first = sync_page(&conn, v.uid, 0, 2).unwrap();
        assert_eq!(first["seq"], 2);
        assert_eq!(first["folders"].as_array().unwrap().len(), 2);
        assert_eq!(first["files"], json!([]));
        // Neither collection overflows the second page, so it runs to the head.
        let second = sync_page(&conn, v.uid, 2, 2).unwrap();
        assert_eq!(second["seq"], 5);
        assert_eq!(second["folders"][0]["id"], "f3");
        assert_eq!(second["files"].as_array().unwrap().len(), 2);
        // An overflowing files collection lowers the cursor to its last row.
        let narrow = sync_page(&conn, v.uid, 3, 1).unwrap();
        assert_eq!(narrow["seq"], 4);
        assert_eq!(narrow["files"][0]["id"], "x1");
        assert_eq!(narrow["files"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn query_numbers_read_like_javascript() {
        let mut q = HashMap::new();
        assert_eq!(query_number(&q, "since"), 0.0);
        q.insert("since".to_string(), "12".to_string());
        assert_eq!(query_number(&q, "since"), 12.0);
        q.insert("since".to_string(), "abc".to_string());
        assert_eq!(query_number(&q, "since"), 0.0);
    }
}
