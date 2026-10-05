//! Folders, files and the trash, with the server's shapes, wording and
//! sequence rules: every change takes the next position in the account's
//! sequence inside its transaction, and the account is poked only after
//! the transaction commits. On a device every file has one owner, so the
//! server's collaborator branches never arise here.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::dto::{file_from, folder_from, FileDto, FolderDto, FILES_WITH_COLLABORATORS};
use crate::error::ApiError;
use crate::extract::{blocking, AuthUser, JsonBody};
use crate::server::AppState;
use crate::store::{next_seq, now_ms};
use crate::validate::{self, SecretBox};

/// The most rows one batch request may name, as on the server.
pub const BATCH_MAX: usize = 500;

fn not_found(message: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, message)
}

fn bad_request(message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message)
}

/// A random version 4 UUID, lowercase and hyphenated like `randomUUID()`.
pub fn uuid_v4() -> String {
    let mut b = engram_core::backend::random_bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn sealed(value: &SecretBox) -> String {
    serde_json::to_string(value).expect("a sealed box serializes")
}

fn own_folder_exists(conn: &Connection, id: &str, uid: i64) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted = 0",
            params![id, uid],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// A live (not deleted) file of the account: its folder and trash state.
struct OwnFile {
    folder_id: Option<String>,
    trashed: bool,
}

fn own_file(conn: &Connection, id: &str, uid: i64) -> rusqlite::Result<Option<OwnFile>> {
    conn.query_row(
        "SELECT folder_id, trashed FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0",
        params![id, uid],
        |r| {
            Ok(OwnFile {
                folder_id: r.get(0)?,
                trashed: r.get::<_, i64>(1)? == 1,
            })
        },
    )
    .optional()
}

/// A folder and every live folder below it, as the server walks them.
fn subtree(conn: &Connection, uid: i64, root: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE subtree(id) AS (
           SELECT id FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted = 0
           UNION ALL
           SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
           WHERE f.user_id = ?2 AND f.deleted = 0
         ) SELECT id FROM subtree",
    )?;
    let ids = stmt
        .query_map(params![root, uid], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

fn folder_dto(conn: &Connection, id: &str) -> rusqlite::Result<FolderDto> {
    conn.query_row(
        "SELECT * FROM folders WHERE id = ?1",
        params![id],
        folder_from,
    )
}

fn file_dto(conn: &Connection, id: &str, collaborators: bool) -> rusqlite::Result<FileDto> {
    if collaborators {
        conn.query_row(
            &format!("{FILES_WITH_COLLABORATORS} WHERE id = ?1"),
            params![id],
            |row| file_from(row, true),
        )
    } else {
        conn.query_row("SELECT * FROM files WHERE id = ?1", params![id], |row| {
            file_from(row, false)
        })
    }
}

pub async fn create_folder(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> Result<Response, ApiError> {
    let body = validate::object(&body)?;
    let parent = validate::nullable_string(body, "parentId")?.flatten();
    let key = validate::secret_box(body, "encryptedKey")?;
    let meta = validate::secret_box(body, "encryptedMeta")?;
    let id = uuid_v4();
    let (dto, seq) = blocking(&state, move |store| {
        let seq = store.tx(|tx| {
            if let Some(parent) = parent.as_deref().filter(|p| !p.is_empty()) {
                if !own_folder_exists(tx, parent, auth.uid)? {
                    return Err(not_found("parent folder not found"));
                }
            }
            let seq = next_seq(tx, auth.uid)?;
            let now = now_ms();
            tx.execute(
                "INSERT INTO folders (id, user_id, parent_id, encrypted_key, encrypted_meta, update_seq, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![id, auth.uid, parent, sealed(&key), sealed(&meta), seq, now],
            )?;
            Ok::<i64, ApiError>(seq)
        })?;
        Ok((folder_dto(&store.conn(), &id)?, seq))
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok((StatusCode::CREATED, Json(dto)).into_response())
}

pub async fn patch_folder(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<Value>,
) -> Result<Json<FolderDto>, ApiError> {
    let body = validate::object(&body)?;
    let parent = validate::nullable_string(body, "parentId")?;
    let meta = validate::optional_secret_box(body, "encryptedMeta")?;
    let (dto, seq) = blocking(&state, move |store| {
        let seq = store.tx(|tx| {
            if !own_folder_exists(tx, &id, auth.uid)? {
                return Err(not_found("folder not found"));
            }
            if let Some(Some(target)) = &parent {
                if target == &id || !own_folder_exists(tx, target, auth.uid)? {
                    return Err(bad_request("invalid destination folder"));
                }
                if subtree(tx, auth.uid, &id)?.contains(target) {
                    return Err(bad_request("cannot move a folder into its own subtree"));
                }
            }
            let seq = next_seq(tx, auth.uid)?;
            tx.execute(
                "UPDATE folders SET
                   parent_id = CASE WHEN ?1 = 1 THEN ?2 ELSE parent_id END,
                   encrypted_meta = COALESCE(?3, encrypted_meta),
                   update_seq = ?4, updated_at = ?5
                 WHERE id = ?6",
                params![
                    i64::from(parent.is_some()),
                    parent.clone().flatten(),
                    meta.as_ref().map(sealed),
                    seq,
                    now_ms(),
                    id
                ],
            )?;
            Ok::<i64, ApiError>(seq)
        })?;
        Ok((folder_dto(&store.conn(), &id)?, seq))
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok(Json(dto))
}

/// Deletes a folder and every folder below it, and moves the files they
/// held to the trash; each row takes its own sequence position.
pub async fn delete_folder(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let seq = blocking(&state, move |store| {
        store.tx(|tx| {
            if !own_folder_exists(tx, &id, auth.uid)? {
                return Err(not_found("folder not found"));
            }
            let now = now_ms();
            let mut last = 0;
            for folder in subtree(tx, auth.uid, &id)? {
                last = next_seq(tx, auth.uid)?;
                tx.execute(
                    "UPDATE folders SET deleted = 1, update_seq = ?1, updated_at = ?2 WHERE id = ?3",
                    params![last, now, folder],
                )?;
                let files = tx
                    .prepare(
                        "SELECT id FROM files WHERE folder_id = ?1 AND user_id = ?2 AND deleted = 0 AND trashed = 0",
                    )?
                    .query_map(params![folder, auth.uid], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for file in files {
                    last = next_seq(tx, auth.uid)?;
                    tx.execute(
                        "UPDATE files SET trashed = 1, update_seq = ?1, updated_at = ?2 WHERE id = ?3",
                        params![last, now, file],
                    )?;
                }
            }
            Ok::<i64, ApiError>(last)
        })
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> Result<Response, ApiError> {
    let body = validate::object(&body)?;
    let folder = validate::nullable_string(body, "folderId")?.flatten();
    let key = validate::secret_box(body, "encryptedKey")?;
    let meta = validate::secret_box(body, "encryptedMeta")?;
    let seekable = validate::optional_bool(body, "seekable")?.unwrap_or(false);
    let id = uuid_v4();
    let (dto, seq) = blocking(&state, move |store| {
        let seq = store.tx(|tx| {
            if let Some(folder) = folder.as_deref().filter(|f| !f.is_empty()) {
                if !own_folder_exists(tx, folder, auth.uid)? {
                    return Err(not_found("folder not found"));
                }
            }
            let seq = next_seq(tx, auth.uid)?;
            let now = now_ms();
            tx.execute(
                "INSERT INTO files (id, user_id, folder_id, encrypted_key, encrypted_meta, seekable, update_seq, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    id,
                    auth.uid,
                    folder,
                    sealed(&key),
                    sealed(&meta),
                    i64::from(seekable),
                    seq,
                    now
                ],
            )?;
            Ok::<i64, ApiError>(seq)
        })?;
        Ok((file_dto(&store.conn(), &id, false)?, seq))
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok((StatusCode::CREATED, Json(dto)).into_response())
}

/// Moves, re-labels or re-keys a file (a new key advances its key epoch).
pub async fn patch_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<Value>,
) -> Result<Json<FileDto>, ApiError> {
    let body = validate::object(&body)?;
    let folder = validate::nullable_string(body, "folderId")?;
    let meta = validate::optional_secret_box(body, "encryptedMeta")?;
    let key = validate::optional_secret_box(body, "encryptedKey")?;
    let (dto, seq) = blocking(&state, move |store| {
        let seq = store.tx(|tx| {
            if own_file(tx, &id, auth.uid)?.is_none() {
                return Err(not_found("file not found"));
            }
            if let Some(Some(target)) = &folder {
                if !own_folder_exists(tx, target, auth.uid)? {
                    return Err(not_found("destination folder not found"));
                }
            }
            let seq = next_seq(tx, auth.uid)?;
            tx.execute(
                "UPDATE files SET
                   folder_id = CASE WHEN ?1 = 1 THEN ?2 ELSE folder_id END,
                   encrypted_meta = COALESCE(?3, encrypted_meta),
                   encrypted_key = COALESCE(?4, encrypted_key),
                   key_epoch = key_epoch + ?5,
                   update_seq = ?6, updated_at = ?7
                 WHERE id = ?8",
                params![
                    i64::from(folder.is_some()),
                    folder.clone().flatten(),
                    meta.as_ref().map(sealed),
                    key.as_ref().map(sealed),
                    i64::from(key.is_some()),
                    seq,
                    now_ms(),
                    id
                ],
            )?;
            Ok::<i64, ApiError>(seq)
        })?;
        Ok((file_dto(&store.conn(), &id, true)?, seq))
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok(Json(dto))
}

/// `DELETE /api/files/:id`: moves the file to the trash.
pub async fn trash_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let seq = blocking(&state, move |store| {
        store.tx(|tx| {
            if own_file(tx, &id, auth.uid)?.is_none() {
                return Err(not_found("file not found"));
            }
            let seq = next_seq(tx, auth.uid)?;
            tx.execute(
                "UPDATE files SET trashed = 1, update_seq = ?1, updated_at = ?2 WHERE id = ?3",
                params![seq, now_ms(), id],
            )?;
            Ok::<i64, ApiError>(seq)
        })
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok(StatusCode::NO_CONTENT)
}

/// Brings a file back from the trash, to its folder if that still
/// exists and to the top level otherwise.
pub async fn restore_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let seq = blocking(&state, move |store| {
        store.tx(|tx| {
            let file = match own_file(tx, &id, auth.uid)? {
                Some(file) if file.trashed => file,
                _ => return Err(not_found("file not found in trash")),
            };
            let folder = restored_folder(tx, file.folder_id, auth.uid)?;
            let seq = next_seq(tx, auth.uid)?;
            tx.execute(
                "UPDATE files SET trashed = 0, folder_id = ?1, update_seq = ?2, updated_at = ?3 WHERE id = ?4",
                params![folder, seq, now_ms(), id],
            )?;
            Ok::<i64, ApiError>(seq)
        })
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok(StatusCode::NO_CONTENT)
}

fn restored_folder(
    conn: &Connection,
    folder: Option<String>,
    uid: i64,
) -> rusqlite::Result<Option<String>> {
    match folder {
        Some(folder) if !folder.is_empty() => {
            Ok(own_folder_exists(conn, &folder, uid)?.then_some(folder))
        }
        other => Ok(other),
    }
}

/// `DELETE /api/trash/:id`: deletes a trashed file for good. Its versions
/// and share links go with it; its stored bytes are released.
pub async fn delete_forever(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let seq = blocking(&state, move |store| {
        store.tx(|tx| {
            match own_file(tx, &id, auth.uid)? {
                Some(file) if file.trashed => {}
                _ => return Err(not_found("file not found in trash")),
            }
            tx.execute("UPDATE file_collaborators SET revoked = 1 WHERE file_id = ?1", params![id])?;
            tx.execute("UPDATE collab_invites SET revoked = 1 WHERE file_id = ?1", params![id])?;
            tx.execute("DELETE FROM shares WHERE file_id = ?1", params![id])?;
            tx.execute("DELETE FROM file_versions WHERE file_id = ?1", params![id])?;
            let seq = next_seq(tx, auth.uid)?;
            tx.execute(
                "UPDATE files SET deleted = 1, size = 0, thumb_size = 0, uploaded = 0, update_seq = ?1, updated_at = ?2 WHERE id = ?3",
                params![seq, now_ms(), id],
            )?;
            Ok::<i64, ApiError>(seq)
        })
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok(StatusCode::NO_CONTENT)
}

/// One planned batch row: the file, and its folder after the change.
struct Planned {
    id: String,
    folder: Option<Option<String>>,
    meta: Option<SecretBox>,
}

enum Action {
    Patch,
    Trash,
    Restore,
}

/// `POST /api/files/batch`: many moves, re-labels, trashings or restores in
/// one request. Every row is judged on its own (`results` says which went
/// through), the passing rows commit together, and the account is poked
/// once, with its final sequence.
pub async fn batch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> Result<Json<Value>, ApiError> {
    let body = validate::object(&body)?;
    let action = match validate::string(body, "action")?.as_str() {
        "patch" => Action::Patch,
        "trash" => Action::Trash,
        "restore" => Action::Restore,
        _ => return Err(ApiError::invalid_request()),
    };
    let mut requested: Vec<Planned> = Vec::new();
    match action {
        Action::Patch => {
            for item in validate::list(body, "items", 1, BATCH_MAX)? {
                let item = validate::object(item)?;
                requested.push(Planned {
                    id: validate::string(item, "id")?,
                    folder: validate::nullable_string(item, "folderId")?,
                    meta: validate::optional_secret_box(item, "encryptedMeta")?,
                });
            }
        }
        Action::Trash | Action::Restore => {
            for id in validate::list(body, "ids", 1, BATCH_MAX)? {
                let id = id.as_str().ok_or_else(ApiError::invalid_request)?;
                requested.push(Planned {
                    id: id.to_string(),
                    folder: None,
                    meta: None,
                });
            }
        }
    }
    let (results, files, touched) = blocking(&state, move |store| {
        let (results, touched) = store.tx(|tx| {
            let mut results = Vec::new();
            let mut plan = Vec::new();
            if let Action::Patch = action {
                let destinations: BTreeSet<&String> =
                    requested.iter().filter_map(|p| p.folder.as_ref()?.as_ref()).collect();
                for folder in destinations {
                    if !own_folder_exists(tx, folder, auth.uid)? {
                        return Err(not_found("destination folder not found"));
                    }
                }
            }
            for item in requested {
                let file = own_file(tx, &item.id, auth.uid)?;
                let refusal = match (&action, &file) {
                    (Action::Restore, Some(file)) if !file.trashed => Some("file not found in trash"),
                    (Action::Restore, None) => Some("file not found in trash"),
                    (_, None) => Some("file not found"),
                    _ => None,
                };
                if let Some(error) = refusal {
                    results.push(json!({ "id": item.id, "ok": false, "status": 404, "error": error }));
                    continue;
                }
                results.push(json!({ "id": item.id, "ok": true }));
                let folder = match (&action, file) {
                    (Action::Restore, Some(file)) => Some(restored_folder(tx, file.folder_id, auth.uid)?),
                    _ => item.folder.clone(),
                };
                plan.push(Planned { folder, ..item });
            }
            let now = now_ms();
            let mut touched = Vec::new();
            for item in plan {
                let seq = next_seq(tx, auth.uid)?;
                match action {
                    Action::Patch => tx.execute(
                        "UPDATE files SET
                           folder_id = CASE WHEN ?1 = 1 THEN ?2 ELSE folder_id END,
                           encrypted_meta = COALESCE(?3, encrypted_meta),
                           update_seq = ?4, updated_at = ?5
                         WHERE id = ?6",
                        params![
                            i64::from(item.folder.is_some()),
                            item.folder.clone().flatten(),
                            item.meta.as_ref().map(sealed),
                            seq,
                            now,
                            item.id
                        ],
                    )?,
                    Action::Trash => tx.execute(
                        "UPDATE files SET trashed = 1, update_seq = ?1, updated_at = ?2 WHERE id = ?3",
                        params![seq, now, item.id],
                    )?,
                    Action::Restore => tx.execute(
                        "UPDATE files SET trashed = 0, folder_id = ?1, update_seq = ?2, updated_at = ?3 WHERE id = ?4",
                        params![item.folder.clone().flatten(), seq, now, item.id],
                    )?,
                };
                touched.push(item.id);
            }
            Ok::<_, ApiError>((results, touched))
        })?;
        let conn = store.conn();
        let files = touched
            .iter()
            .map(|id| file_dto(&conn, id, true))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let seq = crate::events::last_seq(&conn, auth.uid)?;
        Ok((results, files, (!touched.is_empty()).then_some(seq)))
    })
    .await?;
    if let Some(seq) = touched {
        state.events.note(auth.uid, seq);
    }
    Ok(Json(json!({ "results": results, "files": files })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_4_and_unique() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'));
        assert!(matches!(&parts[3][..1], "8" | "9" | "a" | "b"));
        assert!(a
            .chars()
            .all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
