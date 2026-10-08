//! File content, previews and search indexes: uploaded whole or in parts,
//! downloaded whole or by range, kept as versions and checked in place,
//! with the server's shapes, wording and sequence rules. The bytes are
//! ciphertext the client sealed and are stored as they arrive.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::blobs::{blob_key, sha256_file, BlobKind, BlobStore, PutError};
use crate::dto::FileDto;
use crate::error::ApiError;
use crate::extract::{blocking, AuthUser, JsonBody};
use crate::server::AppState;
use crate::storage::{file_dto, uuid_v4};
use crate::store::{next_seq, now_ms, storage_used};
use crate::validate::{self, SecretBox};

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
    trashed: bool,
    encrypted_meta: String,
    updated_at: i64,
}

fn own_file(conn: &Connection, id: &str, uid: i64) -> rusqlite::Result<Option<ContentFile>> {
    conn.query_row(
        "SELECT generation, uploaded, size, thumb_size, index_size, trashed, encrypted_meta, updated_at
         FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0",
        params![id, uid],
        |r| {
            Ok(ContentFile {
                generation: r.get(0)?,
                uploaded: r.get::<_, i64>(1)? == 1,
                size: r.get(2)?,
                thumb_size: r.get(3)?,
                index_size: r.get(4)?,
                trashed: r.get::<_, i64>(5)? == 1,
                encrypted_meta: r.get(6)?,
                updated_at: r.get(7)?,
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

/// The generation new content lands in: one past the highest the file has
/// ever had, whether current, kept as a version, or handed to a writer on
/// a server, so a save after a restore never reuses a kept version's blob
/// name. The first content is generation 1; generation 0 is a file with
/// no content yet, or a row from before versioning shipped.
fn next_generation(conn: &Connection, id: &str, file: &ContentFile) -> rusqlite::Result<i64> {
    let (minted, newest): (i64, Option<i64>) = conn.query_row(
        "SELECT minted_generation, (SELECT MAX(generation) FROM file_versions WHERE file_id = files.id)
         FROM files WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(file.generation.max(minted).max(newest.unwrap_or(0)) + 1)
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
    let (file, max_bytes, next_gen) = blocking(&state, move |store| {
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
        let next_gen = match kind {
            BlobKind::Data => next_generation(&conn, &file_id, &file)?,
            _ => 0,
        };
        Ok((file, room.min(max_blob), next_gen))
    })
    .await?;
    if max_bytes <= 0 || declared > max_bytes as u64 {
        return Err(quota_exceeded());
    }
    let key = blob_key(&id, kind, next_gen);
    match kind {
        BlobKind::Data => {
            // The bytes wait under a staging name; the commit renames them
            // into place only once the generation check has passed.
            let staged = state
                .blobs
                .stage(&key, body.into_data_stream(), max_bytes as u64)
                .await
                .map_err(put_error)?;
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
                staged.path,
                staged.written.bytes as i64,
                Some(staged.written.sha256),
                meta_update,
                None,
            )
            .await
        }
        derived => {
            let written = state
                .blobs
                .put(&key, body.into_data_stream(), max_bytes as u64)
                .await
                .map_err(put_error)?;
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
/// transaction. The staged bytes are renamed into place inside that
/// transaction, after the generation check, so overlapping writers never
/// rename onto one key; a generation conflict discards the staged bytes
/// and answers 409, and the row never moves. Displaced blobs are removed
/// only after the commit, and best-effort: a leftover is garbage, never
/// corruption.
#[allow(clippy::too_many_arguments)]
async fn commit_data(
    state: &Arc<AppState>,
    auth: AuthUser,
    id: String,
    base: Base,
    next_gen: i64,
    key: String,
    staged: PathBuf,
    written: i64,
    content_hash: Option<String>,
    meta_update: Option<String>,
    session: Option<String>,
) -> Result<Response, ApiError> {
    let keeps_versions = state.config.max_versions > 0;
    let max_versions = state.config.max_versions;
    let with_file = meta_update.is_some();
    let file_id = id.clone();
    let app = Arc::clone(state);
    let staged_path = staged.clone();
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
            // The staged bytes become the blob only now, inside the commit.
            app.blobs
                .commit_staged(&staged_path, &key)
                .map_err(|err| CommitError::Api(io_error(err)))?;
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
            // The row records the generation it handed out, as a server does.
            tx.execute(
                "UPDATE files SET size = ?1, generation = ?2, minted_generation = ?2, uploaded = 1,
                   content_hash = ?3, thumb_size = ?4, encrypted_meta = COALESCE(?5, encrypted_meta),
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
    .await;
    // A failed commit (a database error before or at the rename) leaves no
    // staged file behind either.
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(err) => {
            state.blobs.discard(&staged);
            return Err(err);
        }
    };
    let Some((seq, stale, file)) = outcome else {
        state.blobs.discard(&staged);
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

// ----- parts: large content in bounded requests -----

/// Numbered parts one session may hold, as on the server.
pub const MAX_PARTS: i64 = 10_000;
/// A parts session nobody finished within a day is swept.
pub const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Files one verify request may check.
pub const VERIFY_MAX: usize = 50;

#[derive(Debug, Clone)]
struct UploadSession {
    id: String,
    blob_key: String,
    handle: String,
    declared_bytes: i64,
    base_generation: i64,
    base_uploaded: bool,
}

fn session_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<UploadSession> {
    Ok(UploadSession {
        id: r.get("id")?,
        blob_key: r.get("blob_key")?,
        handle: r.get("handle")?,
        declared_bytes: r.get("declared_bytes")?,
        base_generation: r.get("base_generation")?,
        base_uploaded: r.get::<_, i64>("base_uploaded")? == 1,
    })
}

fn own_session(
    conn: &Connection,
    session: &str,
    file_id: &str,
    uid: i64,
) -> rusqlite::Result<Option<UploadSession>> {
    conn.query_row(
        "SELECT * FROM upload_sessions WHERE id = ?1 AND file_id = ?2 AND user_id = ?3",
        params![session, file_id, uid],
        session_from,
    )
    .optional()
}

/// Forgets a session: its parts on disk and its rows.
fn drop_session(
    conn: &Connection,
    blobs: &BlobStore,
    session: &UploadSession,
) -> rusqlite::Result<()> {
    blobs.abort_parts(&session.blob_key, &session.handle);
    conn.execute(
        "DELETE FROM upload_parts WHERE session_id = ?1",
        params![session.id],
    )?;
    conn.execute(
        "DELETE FROM upload_sessions WHERE id = ?1",
        params![session.id],
    )?;
    Ok(())
}

fn sessions_where(
    conn: &Connection,
    sql: &str,
    p: impl rusqlite::Params,
) -> rusqlite::Result<Vec<UploadSession>> {
    conn.prepare(sql)?.query_map(p, session_from)?.collect()
}

/// `POST /api/files/:id/data/parts`: opens a session for content of the
/// declared size. One session per file: a fresh begin supersedes a stale
/// one, and sessions abandoned for a day are swept on the way.
pub async fn begin_parts(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<Value>,
) -> Result<Response, ApiError> {
    let body = validate::object(&body)?;
    let size = validate::positive_int(body, "size")?;
    let keeps_versions = state.config.max_versions > 0;
    let max_blob = state.config.max_blob_bytes as i64;
    let default_quota = state.config.quota_bytes;
    let app = Arc::clone(&state);
    let session = blocking(&state, move |store| {
        let conn = store.conn();
        let file = own_file(&conn, &id, auth.uid)?.ok_or_else(|| not_found("file not found"))?;
        let replaces = file.uploaded;
        let reclaimable = if replaces && !keeps_versions { file.size } else { 0 };
        let room = quota_room(&conn, auth.uid, default_quota, reclaimable)?;
        if room.min(max_blob) <= 0 || size > room.min(max_blob) {
            return Err(quota_exceeded());
        }
        let stale = sessions_where(
            &conn,
            "SELECT * FROM upload_sessions WHERE file_id = ?1",
            params![id],
        )?;
        let abandoned = sessions_where(
            &conn,
            "SELECT * FROM upload_sessions WHERE created_at < ?1",
            params![now_ms() - SESSION_TTL_MS],
        )?;
        for session in stale.iter().chain(abandoned.iter()) {
            drop_session(&conn, &app.blobs, session)?;
        }
        let next_gen = next_generation(&conn, &id, &file)?;
        let session = uuid_v4();
        conn.execute(
            "INSERT INTO upload_sessions (id, user_id, file_id, blob_key, handle, declared_bytes, base_generation, base_uploaded, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                session,
                auth.uid,
                id,
                blob_key(&id, BlobKind::Data, next_gen),
                BlobStore::new_handle(),
                size,
                file.generation,
                i64::from(file.uploaded),
                now_ms()
            ],
        )?;
        Ok(session)
    })
    .await?;
    Ok((StatusCode::CREATED, Json(json!({ "session": session }))).into_response())
}

/// `PUT /api/files/:id/data/parts/:session/:part`: one numbered part,
/// exactly as long as its `Content-Length` says; a retry replaces it.
pub async fn put_part(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((id, session, part)): Path<(String, String, String)>,
    req: Request,
) -> Result<Json<Value>, ApiError> {
    let (parts, body) = req.into_parts();
    let row = blocking(&state, move |store| {
        Ok(own_session(&store.conn(), &session, &id, auth.uid)?)
    })
    .await?
    .ok_or_else(|| not_found("upload session not found"))?;
    let part_no: i64 = match part.parse() {
        Ok(n) if (1..=MAX_PARTS).contains(&n) => n,
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid part number",
            ))
        }
    };
    let length = content_length(&parts.headers);
    if length == 0 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "content-length required",
        ));
    }
    let session_id = row.id.clone();
    let others = blocking(&state, move |store| {
        Ok(store.conn().query_row(
            "SELECT COALESCE(SUM(bytes), 0) FROM upload_parts WHERE session_id = ?1 AND part_no != ?2",
            params![session_id, part_no],
            |r| r.get::<_, i64>(0),
        )?)
    })
    .await?;
    if others + length as i64 > row.declared_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "parts exceed the declared size",
        ));
    }
    let written = state
        .blobs
        .put_part(
            &row.blob_key,
            &row.handle,
            part_no,
            body.into_data_stream(),
            length,
        )
        .await
        .map_err(|err| match err {
            PutError::TooLarge => ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "part exceeds its declared length",
            ),
            other => put_error(other),
        })?;
    let session_id = row.id.clone();
    blocking(&state, move |store| {
        store.conn().execute(
            "INSERT INTO upload_parts (session_id, part_no, etag, bytes) VALUES (?1, ?2, NULL, ?3)
             ON CONFLICT (session_id, part_no) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes",
            params![session_id, part_no, written as i64],
        )?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "part": part_no, "size": written })))
}

/// `POST /api/files/:id/data/parts/:session/complete`: joins the parts
/// and commits them as the file's content through the same commit as a
/// single upload. Joined bytes carry no digest until a check records one.
pub async fn complete_parts(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((id, session)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let app = Arc::clone(&state);
    let file_id = id.clone();
    let (row, file, part_numbers, total, next_gen) = blocking(&state, move |store| {
        let conn = store.conn();
        let row = own_session(&conn, &session, &file_id, auth.uid)?
            .ok_or_else(|| not_found("upload session not found"))?;
        let parts = conn
            .prepare(
                "SELECT part_no, bytes FROM upload_parts WHERE session_id = ?1 ORDER BY part_no",
            )?
            .query_map(params![row.id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let total: i64 = parts.iter().map(|p| p.1).sum();
        let contiguous = parts
            .iter()
            .enumerate()
            .all(|(i, (part_no, _))| *part_no == i as i64 + 1);
        if parts.is_empty() || !contiguous || total != row.declared_bytes {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "upload incomplete"));
        }
        let Some(file) = own_file(&conn, &file_id, auth.uid)? else {
            drop_session(&conn, &app.blobs, &row)?;
            return Err(not_found("file not found"));
        };
        // Another write moved the file meanwhile; the commit re-checks the
        // same condition inside its transaction.
        if file.generation != row.base_generation || file.uploaded != row.base_uploaded {
            drop_session(&conn, &app.blobs, &row)?;
            return Err(conflict());
        }
        // The join must land in the generation the session was opened for;
        // history that moved meanwhile is a conflict too.
        let next_gen = next_generation(&conn, &file_id, &file)?;
        if blob_key(&file_id, BlobKind::Data, next_gen) != row.blob_key {
            drop_session(&conn, &app.blobs, &row)?;
            return Err(conflict());
        }
        let numbers: Vec<i64> = parts.iter().map(|p| p.0).collect();
        Ok((row, file, numbers, total, next_gen))
    })
    .await?;
    let staged = state
        .blobs
        .join_parts(&row.blob_key, &row.handle, &part_numbers)
        .await
        .map_err(io_error)?;
    commit_data(
        &state,
        auth,
        id,
        Base {
            generation: file.generation,
            uploaded: file.uploaded,
        },
        next_gen,
        row.blob_key,
        staged,
        total,
        None,
        None,
        Some(row.id),
    )
    .await
}

/// `DELETE /api/files/:id/data/parts/:session`: forgets the session.
pub async fn abort_parts(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((id, session)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let app = Arc::clone(&state);
    blocking(&state, move |store| {
        let conn = store.conn();
        let row = own_session(&conn, &session, &id, auth.uid)?
            .ok_or_else(|| not_found("upload session not found"))?;
        drop_session(&conn, &app.blobs, &row)?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ----- versions -----

/// `GET /api/files/:id/versions`: history, newest first.
pub async fn list_versions(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let versions = blocking(&state, move |store| {
        let conn = store.conn();
        if own_file(&conn, &id, auth.uid)?.is_none() {
            return Err(not_found("file not found"));
        }
        let rows = conn
            .prepare(
                "SELECT generation, size, encrypted_meta, created_at FROM file_versions
                 WHERE file_id = ?1 AND user_id = ?2 ORDER BY generation DESC",
            )?
            .query_map(params![id, auth.uid], |r| {
                Ok(json!({
                    "generation": r.get::<_, i64>(0)?,
                    "size": r.get::<_, i64>(1)?,
                    "encryptedMeta": serde_json::from_str::<Value>(&r.get::<_, String>(2)?).unwrap_or(Value::Null),
                    "createdAt": r.get::<_, i64>(3)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .await?;
    Ok(Json(json!({ "versions": versions })))
}

/// `GET /api/files/:id/versions/:gen/data`: one version's bytes.
pub async fn version_data(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((id, generation)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let generation: Option<i64> = generation.parse().ok();
    let file_id = id.clone();
    let (generation, size) = blocking(&state, move |store| {
        let conn = store.conn();
        if own_file(&conn, &file_id, auth.uid)?.is_none() {
            return Err(not_found("file not found"));
        }
        let generation = generation.ok_or_else(|| not_found("version not found"))?;
        let size: Option<i64> = conn
            .query_row(
                "SELECT size FROM file_versions WHERE file_id = ?1 AND user_id = ?2 AND generation = ?3",
                params![file_id, auth.uid, generation],
                |r| r.get(0),
            )
            .optional()?;
        let size = size.ok_or_else(|| not_found("version not found"))?;
        Ok((generation, size as u64))
    })
    .await?;
    let body = state
        .blobs
        .get(&blob_key(&id, BlobKind::Data, generation), None)
        .await
        .map_err(io_error)?;
    Ok(octet_stream(StatusCode::OK, size, body))
}

/// `POST /api/files/:id/versions/:gen/restore`: a pointer swap inside one
/// transaction. The displaced current content becomes a version itself,
/// so a restore is undoable, and no content blob is written, moved or
/// removed. The client supplies the merged metadata, and the preview of
/// the displaced bytes is dropped.
pub async fn restore_version(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((id, generation)): Path<(String, String)>,
    JsonBody(body): JsonBody<Value>,
) -> Result<Json<FileDto>, ApiError> {
    let body = validate::object(&body)?;
    let meta = sealed(&validate::secret_box(body, "encryptedMeta")?);
    let generation: Option<i64> = generation.parse().ok();
    let app = Arc::clone(&state);
    let file_id = id.clone();
    let (dto, seq) = blocking(&state, move |store| {
        let (dto, seq, thumb_size) = store.tx(|tx| {
            // As on the server: a file the account owns but cannot restore
            // (no content yet, or in the trash) gets the owner-only refusal.
            let file = match own_file(tx, &file_id, auth.uid)? {
                Some(file) if file.uploaded && !file.trashed => file,
                Some(_) => {
                    return Err(ApiError::new(
                        StatusCode::FORBIDDEN,
                        "only the owner can restore a version",
                    ))
                }
                None => return Err(not_found("file not found")),
            };
            let generation = generation.ok_or_else(|| not_found("version not found"))?;
            let size: Option<i64> = tx
                .query_row(
                    "SELECT size FROM file_versions WHERE file_id = ?1 AND user_id = ?2 AND generation = ?3",
                    params![file_id, auth.uid, generation],
                    |r| r.get(0),
                )
                .optional()?;
            let size = size.ok_or_else(|| not_found("version not found"))?;
            tx.execute(
                "INSERT INTO file_versions (file_id, user_id, generation, size, encrypted_meta, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (file_id, generation) DO UPDATE SET
                   user_id = excluded.user_id, size = excluded.size,
                   encrypted_meta = excluded.encrypted_meta, created_at = excluded.created_at",
                params![file_id, auth.uid, file.generation, file.size, file.encrypted_meta, file.updated_at],
            )?;
            tx.execute(
                "DELETE FROM file_versions WHERE file_id = ?1 AND generation = ?2",
                params![file_id, generation],
            )?;
            let seq = next_seq(tx, auth.uid)?;
            // The preview described the displaced bytes; a zero size turns
            // the client's preview backfill back on. The recorded digest
            // described them too, so it goes: the next storage check records
            // the restored bytes instead of calling them changed.
            tx.execute(
                "UPDATE files SET generation = ?1, size = ?2, encrypted_meta = ?3, thumb_size = 0,
                   content_hash = NULL, update_seq = ?4, updated_at = ?5 WHERE id = ?6",
                params![generation, size, meta, seq, now_ms(), file_id],
            )?;
            Ok::<_, ApiError>((file_dto(tx, &file_id, false)?, seq, file.thumb_size))
        })?;
        if thumb_size > 0 {
            app.blobs.remove(&blob_key(&file_id, BlobKind::Thumb, 0));
        }
        Ok((dto, seq))
    })
    .await?;
    state.events.note(auth.uid, seq);
    Ok(Json(dto))
}

// ----- verify -----

/// `POST /api/files/verify`: checks stored content against the digest
/// recorded when it was written, without reading a byte to the client.
/// Content with no digest yet (parts uploads) gets one recorded, and the
/// answer says so rather than calling it verified.
pub async fn verify(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> Result<Json<Value>, ApiError> {
    let body = validate::object(&body)?;
    let ids = validate::string_list(body, "ids", 1, VERIFY_MAX)?;
    let app = Arc::clone(&state);
    let results = blocking(&state, move |store| {
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let row: Option<(i64, bool, Option<String>)> = store
                .conn()
                .query_row(
                    "SELECT generation, uploaded, content_hash FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0",
                    params![id, auth.uid],
                    |r| Ok((r.get(0)?, r.get::<_, i64>(1)? == 1, r.get(2)?)),
                )
                .optional()?;
            let Some((generation, true, recorded)) = row else {
                results.push(json!({ "id": id, "verdict": "missing" }));
                continue;
            };
            // The connection is not held while the bytes are read.
            let path = app.blobs.path(&blob_key(&id, BlobKind::Data, generation));
            let Ok(actual) = sha256_file(&path) else {
                results.push(json!({ "id": id, "verdict": "unreadable" }));
                continue;
            };
            let verdict = match recorded {
                None => {
                    store.conn().execute(
                        "UPDATE files SET content_hash = ?1 WHERE id = ?2",
                        params![actual, id],
                    )?;
                    "recorded"
                }
                Some(recorded) if recorded == actual => "intact",
                Some(_) => "changed",
            };
            results.push(json!({ "id": id, "verdict": verdict }));
        }
        Ok(results)
    })
    .await?;
    Ok(Json(json!({ "results": results })))
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

    use crate::server::tests::{raw_with, signed_in, Running};
    use std::time::{Duration, Instant};

    /// A sealed box as a client sends one; the backend never reads it.
    const SEALED: &str = r#"{"ciphertext":"c","nonce":"n"}"#;

    /// A running vault with one signed-in account.
    struct Vault {
        server: Running,
        token: String,
        host: String,
    }

    impl Vault {
        fn new(email: &str) -> Vault {
            let server = Running::new();
            let token = signed_in(server.port, email);
            let host = format!("127.0.0.1:{}", server.port);
            Vault {
                server,
                token,
                host,
            }
        }

        fn call(&self, method: &str, path: &str, body: Option<&str>) -> (u16, String, String) {
            let auth = format!("Bearer {}", self.token);
            raw_with(
                self.server.port,
                method,
                path,
                &self.host,
                body,
                &[("Authorization", &auth)],
            )
        }

        fn create_file(&self) -> String {
            let body =
                format!(r#"{{"folderId":null,"encryptedKey":{SEALED},"encryptedMeta":{SEALED}}}"#);
            let (status, _, answer) = self.call("POST", "/api/files", Some(&body));
            assert_eq!(status, 201);
            let value: Value = serde_json::from_str(&answer).unwrap();
            value["id"].as_str().unwrap().to_string()
        }

        fn save(&self, id: &str, text: &str) -> u16 {
            self.call("PUT", &format!("/api/files/{id}/data"), Some(text))
                .0
        }

        fn content(&self, id: &str) -> (u16, String) {
            let (status, _, body) = self.call("GET", &format!("/api/files/{id}/data"), None);
            (status, body)
        }

        fn restore(&self, id: &str, generation: i64) -> u16 {
            let body = format!(r#"{{"encryptedMeta":{SEALED}}}"#);
            self.call(
                "POST",
                &format!("/api/files/{id}/versions/{generation}/restore"),
                Some(&body),
            )
            .0
        }

        fn blob_names(&self, id: &str) -> Vec<String> {
            let mut names: Vec<String> =
                std::fs::read_dir(self.server.dir.join(crate::blobs::BLOBS_DIR))
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .filter(|name| name.starts_with(id))
                    .collect();
            names.sort();
            names
        }
    }

    #[test]
    fn two_overlapping_saves_keep_the_winners_bytes() {
        use std::io::{Read, Write};
        let vault = Vault::new("overlap@example.com");
        let id = vault.create_file();
        // Writer A opens a save and sends half of its bytes.
        let mut a = std::net::TcpStream::connect(("127.0.0.1", vault.server.port)).unwrap();
        a.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(
            a,
            "PUT /api/files/{id}/data HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/octet-stream\r\nContent-Length: 10\r\nConnection: close\r\n\r\nAAAAA",
            vault.host, vault.token
        )
        .unwrap();
        // A is admitted once its bytes start landing on disk.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !vault.blob_names(&id).iter().any(|n| n.contains(".upload-")) {
            assert!(Instant::now() < deadline, "writer A was not admitted");
            std::thread::sleep(Duration::from_millis(20));
        }
        // Writer B saves whole and wins.
        assert_eq!(vault.save(&id, "BBBBBBBB"), 200);
        // A finishes and must lose without touching B's bytes.
        write!(a, "AAAAA").unwrap();
        let mut answer = Vec::new();
        a.read_to_end(&mut answer).unwrap();
        let text = String::from_utf8_lossy(&answer);
        assert!(text.starts_with("HTTP/1.1 409"), "{text}");
        let (status, body) = vault.content(&id);
        assert_eq!(status, 200);
        assert_eq!(body, "BBBBBBBB");
        assert_eq!(
            vault.blob_names(&id),
            vec![format!("{id}.g1")],
            "no staged file remains"
        );
    }

    #[test]
    fn a_restored_file_verifies_clean() {
        let vault = Vault::new("restore-check@example.com");
        let id = vault.create_file();
        assert_eq!(vault.save(&id, "one"), 200);
        assert_eq!(vault.save(&id, "two"), 200);
        assert_eq!(vault.restore(&id, 1), 200);
        let verdict = || {
            let body = format!(r#"{{"ids":["{id}"]}}"#);
            let (status, _, answer) = vault.call("POST", "/api/files/verify", Some(&body));
            assert_eq!(status, 200);
            let value: Value = serde_json::from_str(&answer).unwrap();
            value["results"][0]["verdict"].as_str().unwrap().to_string()
        };
        // The restored bytes carry no digest of their own yet; the check
        // records one rather than comparing against the displaced content.
        assert_eq!(verdict(), "recorded");
        assert_eq!(verdict(), "intact");
    }

    #[test]
    fn a_save_after_a_restore_keeps_every_version() {
        let vault = Vault::new("history@example.com");
        let id = vault.create_file();
        for text in ["v1", "v2", "v3"] {
            assert_eq!(vault.save(&id, text), 200);
        }
        assert_eq!(vault.restore(&id, 1), 200);
        assert_eq!(vault.save(&id, "v4"), 200);
        // Every kept version still serves its own bytes.
        for (generation, text) in [(1, "v1"), (2, "v2"), (3, "v3")] {
            let (status, _, body) = vault.call(
                "GET",
                &format!("/api/files/{id}/versions/{generation}/data"),
                None,
            );
            assert_eq!(status, 200, "generation {generation}");
            assert_eq!(body, text, "generation {generation}");
        }
        let (_, _, listed) = vault.call("GET", &format!("/api/files/{id}/versions"), None);
        let value: Value = serde_json::from_str(&listed).unwrap();
        let mut generations: Vec<i64> = value["versions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["generation"].as_i64().unwrap())
            .collect();
        generations.sort();
        assert_eq!(generations, vec![1, 2, 3]);
        assert_eq!(vault.content(&id), (200, "v4".to_string()));
        assert!(vault.blob_names(&id).contains(&format!("{id}.g4")));
    }

    #[test]
    fn the_first_content_is_generation_one_under_its_own_name() {
        let vault = Vault::new("first@example.com");
        let id = vault.create_file();
        let (status, _, body) = vault.call("PUT", &format!("/api/files/{id}/data"), Some("one"));
        assert_eq!(status, 200);
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["generation"], 1);
        assert_eq!(vault.blob_names(&id), vec![format!("{id}.g1")]);
        let minted: i64 = rusqlite::Connection::open(vault.server.dir.join(crate::store::DB_FILE))
            .unwrap()
            .query_row(
                "SELECT minted_generation FROM files WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(minted, 1, "the row records the generation it handed out");
    }
}
