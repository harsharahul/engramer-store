//! File content, previews and search indexes: uploaded whole or in parts,
//! downloaded whole or by range, kept as versions and checked in place,
//! with the server's shapes, wording and sequence rules. The bytes are
//! ciphertext the client sealed and are stored as they arrive.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::blobs::{blob_key, BlobKind, PutError};
use crate::error::ApiError;
use crate::extract::{blocking, AuthUser};
use crate::server::AppState;
use crate::storage::file_dto;
use crate::store::{next_seq, now_ms, storage_used};
use crate::validate::SecretBox;

fn not_found(message: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, message)
}

fn quota_exceeded() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "storage quota exceeded")
}

fn conflict() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "the file changed while saving; retry")
}

fn sealed(value: &SecretBox) -> String {
    serde_json::to_string(value).expect("a sealed box serializes")
}

/// The columns of a live (not deleted) file the content routes read.
#[derive(Debug, Clone)]
struct ContentFile {
    generation: i64,
    uploaded: bool,
    size: i64,
    thumb_size: i64,
    index_size: i64,
}

fn own_file(conn: &Connection, id: &str, uid: i64) -> rusqlite::Result<Option<ContentFile>> {
    conn.query_row(
        "SELECT generation, uploaded, size, thumb_size, index_size
         FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0",
        params![id, uid],
        |r| {
            Ok(ContentFile {
                generation: r.get(0)?,
                uploaded: r.get::<_, i64>(1)? == 1,
                size: r.get(2)?,
                thumb_size: r.get(3)?,
                index_size: r.get(4)?,
            })
        },
    )
    .optional()
}

/// Bytes the account may still store: its quota (its own, or the vault's
/// default) less what it holds, with `reclaimable` (what this write
/// replaces) given back first.
fn quota_room(
    conn: &Connection,
    uid: i64,
    default_quota: u64,
    reclaimable: i64,
) -> rusqlite::Result<i64> {
    let quota: Option<i64> = conn.query_row(
        "SELECT quota_bytes FROM users WHERE id = ?1",
        params![uid],
        |r| r.get(0),
    )?;
    let quota = quota.unwrap_or(default_quota as i64);
    Ok(quota - (storage_used(conn, uid)? - reclaimable))
}

/// `Content-Length`, or 0 when absent or unreadable, as the server reads it.
fn content_length(headers: &HeaderMap) -> u64 {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

/// Metadata riding a content save: `x-encrypted-meta` carries a sealed
/// box as standard base64 JSON. Anything else is the server's opaque 400.
fn sealed_meta_header(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get("x-encrypted-meta") else {
        return Ok(None);
    };
    let text = value.to_str().map_err(|_| ApiError::invalid_request())?;
    let bytes = engram_core::b64::from_b64std(text).map_err(|_| ApiError::invalid_request())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid_request())?;
    let sealed_box: SecretBox =
        serde_json::from_value(value).map_err(|_| ApiError::invalid_request())?;
    Ok(Some(sealed(&sealed_box)))
}

fn put_error(err: PutError) -> ApiError {
    match err {
        PutError::TooLarge => quota_exceeded(),
        PutError::Body => ApiError::invalid_request(),
        PutError::Io(err) => {
            eprintln!("engram-local: cannot store a blob: {err}");
            ApiError::internal()
        }
    }
}

fn io_error(err: std::io::Error) -> ApiError {
    eprintln!("engram-local: cannot read a blob: {err}");
    ApiError::internal()
}

// ----- uploads -----

pub async fn put_data(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    upload(state, auth, id, req, BlobKind::Data).await
}

pub async fn put_thumbnail(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    upload(state, auth, id, req, BlobKind::Thumb).await
}

pub async fn put_index(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    upload(state, auth, id, req, BlobKind::Index).await
}

/// One upload, streamed to disk under the generation it will become,
/// then committed: content through `commit_data`, a preview or index by
/// its size column. A replaced preview or index only ever frees space;
/// replaced content frees space only when history is off.
async fn upload(
    state: Arc<AppState>,
    auth: AuthUser,
    id: String,
    req: Request,
    kind: BlobKind,
) -> Result<Response, ApiError> {
    let (parts, body) = req.into_parts();
    let meta_update = match kind {
        BlobKind::Data => sealed_meta_header(&parts.headers)?,
        _ => None,
    };
    let declared = content_length(&parts.headers);
    let keeps_versions = state.config.max_versions > 0;
    let max_blob = state.config.max_blob_bytes as i64;
    let default_quota = state.config.quota_bytes;
    let file_id = id.clone();
    let (file, max_bytes) = blocking(&state, move |store| {
        let conn = store.conn();
        let file =
            own_file(&conn, &file_id, auth.uid)?.ok_or_else(|| not_found("file not found"))?;
        let replaces = kind == BlobKind::Data && file.uploaded;
        let reclaimable = match kind {
            BlobKind::Thumb => file.thumb_size,
            BlobKind::Index => file.index_size,
            BlobKind::Data if replaces && !keeps_versions => file.size,
            BlobKind::Data => 0,
        };
        let room = quota_room(&conn, auth.uid, default_quota, reclaimable)?;
        Ok((file, room.min(max_blob)))
    })
    .await?;
    if max_bytes <= 0 || declared > max_bytes as u64 {
        return Err(quota_exceeded());
    }
    let replaces = kind == BlobKind::Data && file.uploaded;
    let next_gen = if replaces {
        file.generation + 1
    } else {
        file.generation
    };
    let key = match kind {
        BlobKind::Data => blob_key(&id, BlobKind::Data, next_gen),
        other => blob_key(&id, other, 0),
    };
    let written = state
        .blobs
        .put(&key, body.into_data_stream(), max_bytes as u64)
        .await
        .map_err(put_error)?;
    match kind {
        BlobKind::Data => {
            commit_data(
                &state,
                auth,
                id,
                Base {
                    generation: file.generation,
                    uploaded: file.uploaded,
                },
                next_gen,
                key,
                written.bytes as i64,
                Some(written.sha256),
                meta_update,
                None,
            )
            .await
        }
        derived => {
            let column = if derived == BlobKind::Thumb {
                "thumb_size"
            } else {
                "index_size"
            };
            let size = written.bytes as i64;
            let seq = blocking(&state, move |store| {
                store.tx(|tx| {
                    let seq = next_seq(tx, auth.uid)?;
                    tx.execute(
                        &format!(
                            "UPDATE files SET {column} = ?1, update_seq = ?2, updated_at = ?3 WHERE id = ?4"
                        ),
                        params![size, seq, now_ms(), id],
                    )?;
                    Ok::<i64, ApiError>(seq)
                })
            })
            .await?;
            state.events.note(auth.uid, seq);
            Ok(Json(json!({ "size": written.bytes })).into_response())
        }
    }
}

/// The generation a write began against; the commit refuses to land on
/// any other.
#[derive(Debug, Clone, Copy)]
struct Base {
    generation: i64,
    uploaded: bool,
}

enum CommitError {
    Conflict,
    Api(ApiError),
}

impl From<rusqlite::Error> for CommitError {
    fn from(err: rusqlite::Error) -> CommitError {
        CommitError::Api(err.into())
    }
}

/// The single commit point for content bytes, whether they arrived whole
/// or as parts: the displaced generation becomes a version (or is removed
/// when history is off), a preview of the displaced bytes is dropped, the
/// pointer advances, history is pruned to the retention window, and a
/// parts session that produced the bytes is forgotten in the same
/// transaction. A generation conflict removes the fresh blob and answers
/// 409; the row never moves. Displaced blobs are removed only after the
/// commit, and best-effort: a leftover is garbage, never corruption.
#[allow(clippy::too_many_arguments)]
async fn commit_data(
    state: &Arc<AppState>,
    auth: AuthUser,
    id: String,
    base: Base,
    next_gen: i64,
    key: String,
    written: i64,
    content_hash: Option<String>,
    meta_update: Option<String>,
    session: Option<String>,
) -> Result<Response, ApiError> {
    let keeps_versions = state.config.max_versions > 0;
    let max_versions = state.config.max_versions;
    let with_file = meta_update.is_some();
    let file_id = id.clone();
    let outcome = blocking(state, move |store| {
        let committed = store.tx(|tx| {
            let (cur_gen, cur_size, cur_meta, cur_updated, cur_uploaded, cur_thumb) = tx
                .query_row(
                    "SELECT generation, size, encrypted_meta, updated_at, uploaded, thumb_size FROM files WHERE id = ?1",
                    params![file_id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, i64>(4)? == 1,
                            r.get::<_, i64>(5)?,
                        ))
                    },
                )?;
            if cur_gen != base.generation || cur_uploaded != base.uploaded {
                return Err(CommitError::Conflict);
            }
            let mut stale = Vec::new();
            let replaces = base.uploaded;
            if replaces {
                if keeps_versions {
                    // Upsert: a restore moves the generation backward and a
                    // later save re-mints a number whose history row exists.
                    tx.execute(
                        "INSERT INTO file_versions (file_id, user_id, generation, size, encrypted_meta, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT (file_id, generation) DO UPDATE SET
                           user_id = excluded.user_id, size = excluded.size,
                           encrypted_meta = excluded.encrypted_meta, created_at = excluded.created_at",
                        params![file_id, auth.uid, cur_gen, cur_size, cur_meta, cur_updated],
                    )?;
                } else {
                    stale.push(blob_key(&file_id, BlobKind::Data, cur_gen));
                }
                if cur_thumb > 0 {
                    stale.push(blob_key(&file_id, BlobKind::Thumb, 0));
                }
            }
            let seq = next_seq(tx, auth.uid)?;
            tx.execute(
                "UPDATE files SET size = ?1, generation = ?2, uploaded = 1, content_hash = ?3,
                   thumb_size = ?4, encrypted_meta = COALESCE(?5, encrypted_meta),
                   update_seq = ?6, updated_at = ?7
                 WHERE id = ?8",
                params![
                    written,
                    next_gen,
                    content_hash,
                    if replaces { 0 } else { cur_thumb },
                    meta_update,
                    seq,
                    now_ms(),
                    file_id
                ],
            )?;
            stale.extend(prune_versions(tx, &file_id, auth.uid, max_versions)?);
            if let Some(session) = &session {
                tx.execute(
                    "DELETE FROM upload_parts WHERE session_id = ?1",
                    params![session],
                )?;
                tx.execute("DELETE FROM upload_sessions WHERE id = ?1", params![session])?;
            }
            Ok::<_, CommitError>((seq, stale))
        });
        match committed {
            Err(CommitError::Conflict) => Ok(None),
            Err(CommitError::Api(err)) => Err(err),
            Ok((seq, stale)) => {
                let file = if with_file {
                    Some(file_dto(&store.conn(), &file_id, true)?)
                } else {
                    None
                };
                Ok(Some((seq, stale, file)))
            }
        }
    })
    .await?;
    let Some((seq, stale, file)) = outcome else {
        state.blobs.remove(&key);
        return Err(conflict());
    };
    for stale_key in stale {
        state.blobs.remove(&stale_key);
    }
    state.events.note(auth.uid, seq);
    let mut body = json!({ "size": written, "generation": next_gen });
    if let Some(file) = file {
        body["file"] = serde_json::to_value(file).map_err(|_| ApiError::internal())?;
    }
    Ok(Json(body).into_response())
}

/// Drops version rows beyond the retention window; returns their blob keys.
fn prune_versions(
    tx: &Transaction<'_>,
    file_id: &str,
    uid: i64,
    max_versions: usize,
) -> rusqlite::Result<Vec<String>> {
    let generations = tx
        .prepare(
            "SELECT generation FROM file_versions WHERE file_id = ?1 AND user_id = ?2 ORDER BY generation DESC",
        )?
        .query_map(params![file_id, uid], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stale = Vec::new();
    for generation in generations.into_iter().skip(max_versions) {
        tx.execute(
            "DELETE FROM file_versions WHERE file_id = ?1 AND generation = ?2",
            params![file_id, generation],
        )?;
        stale.push(blob_key(file_id, BlobKind::Data, generation));
    }
    Ok(stale)
}

// ----- downloads -----

pub async fn get_data(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    download(state, auth, id, headers, BlobKind::Data).await
}

pub async fn get_thumbnail(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    download(state, auth, id, HeaderMap::new(), BlobKind::Thumb).await
}

pub async fn get_index(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    download(state, auth, id, HeaderMap::new(), BlobKind::Index).await
}

/// A single `bytes=` range against a known size, as the server reads it:
/// an open end runs to the last byte, an overlong end is clamped, a
/// suffix names the last N bytes, and a start past the end satisfies
/// nothing.
pub fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (first, last) = spec.split_once('-')?;
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if !digits(first) || !digits(last) || (first.is_empty() && last.is_empty()) {
        return None;
    }
    let number = |s: &str| s.parse::<u64>().unwrap_or(u64::MAX);
    let end_of_blob = size.checked_sub(1)?;
    let (start, end) = if first.is_empty() {
        let suffix = number(last);
        if suffix == 0 {
            return None;
        }
        (size.saturating_sub(suffix), end_of_blob)
    } else {
        let start = number(first);
        let end = if last.is_empty() {
            end_of_blob
        } else {
            number(last).min(end_of_blob)
        };
        (start, end)
    };
    if start >= size || start > end {
        return None;
    }
    Some((start, end))
}

fn octet_stream(status: StatusCode, length: u64, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    response
}

async fn download(
    state: Arc<AppState>,
    auth: AuthUser,
    id: String,
    headers: HeaderMap,
    kind: BlobKind,
) -> Result<Response, ApiError> {
    let file_id = id.clone();
    let file = blocking(&state, move |store| {
        Ok(own_file(&store.conn(), &file_id, auth.uid)?)
    })
    .await?;
    let (size, generation) = match (&file, kind) {
        (Some(file), BlobKind::Data) if file.uploaded => (file.size as u64, file.generation),
        (Some(file), BlobKind::Thumb) if file.thumb_size > 0 => (file.thumb_size as u64, 0),
        (Some(file), BlobKind::Index) if file.index_size > 0 => (file.index_size as u64, 0),
        _ => return Err(not_found("blob not found")),
    };
    let key = blob_key(&id, kind, generation);
    if kind != BlobKind::Data {
        let body = state.blobs.get(&key, None).await.map_err(io_error)?;
        return Ok(octet_stream(StatusCode::OK, size, body));
    }
    // Which generation these bytes are, so a client can pair them with its
    // own markers, and ranges, so media players can seek in the chunked
    // ciphertext.
    let name_generation = |response: &mut Response| {
        response
            .headers_mut()
            .insert("x-generation", HeaderValue::from(generation));
        response
            .headers_mut()
            .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty());
    if let Some(range) = range {
        let Some((start, end)) = parse_range(range, size) else {
            let mut response =
                ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable")
                    .into_response();
            name_generation(&mut response);
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{size}"))
                    .map_err(|_| ApiError::internal())?,
            );
            return Ok(response);
        };
        let body = state
            .blobs
            .get(&key, Some((start, end)))
            .await
            .map_err(io_error)?;
        let mut response = octet_stream(StatusCode::PARTIAL_CONTENT, end - start + 1, body);
        name_generation(&mut response);
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))
                .map_err(|_| ApiError::internal())?,
        );
        return Ok(response);
    }
    let body = state.blobs.get(&key, None).await.map_err(io_error)?;
    let mut response = octet_stream(StatusCode::OK, size, body);
    name_generation(&mut response);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_read_like_the_server() {
        assert_eq!(parse_range("bytes=100-299", 1000), Some((100, 299)));
        assert_eq!(parse_range(" bytes=950- ", 1000), Some((950, 999)));
        assert_eq!(parse_range("bytes=-32", 1000), Some((968, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=-", 1000), None);
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("bytes=a-b", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("bytes=-5", 3), Some((0, 2)));
    }

    #[test]
    fn the_metadata_header_is_standard_base64_json() {
        let mut headers = HeaderMap::new();
        assert_eq!(sealed_meta_header(&headers).unwrap(), None);
        let sealed_box = r#"{"ciphertext":"c","nonce":"n","extra":1}"#;
        headers.insert(
            "x-encrypted-meta",
            HeaderValue::from_str(&engram_core::b64::to_b64std(sealed_box.as_bytes())).unwrap(),
        );
        assert_eq!(
            sealed_meta_header(&headers).unwrap().as_deref(),
            Some(r#"{"ciphertext":"c","nonce":"n"}"#)
        );
        for bad in [
            "not base64 json at all",
            "e30=",
            &engram_core::b64::to_b64std(b"[1]"),
        ] {
            headers.insert("x-encrypted-meta", HeaderValue::from_str(bad).unwrap());
            assert!(sealed_meta_header(&headers).is_err(), "{bad}");
        }
    }
}
