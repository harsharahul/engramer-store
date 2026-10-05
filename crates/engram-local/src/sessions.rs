//! Session keys (the random key a tab seals its reload record under, handed
//! only to the live session that minted it) and signing out everywhere.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use engram_core::b64::to_b64url;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::accounts::current_epoch;
use crate::error::ApiError;
use crate::extract::{blocking, AuthUser};
use crate::server::AppState;
use crate::store::now_ms;
use crate::token::now_secs;

/// Keys older than this are pruned on the next mint.
pub const SESSION_KEY_TTL_MS: i64 = 30 * 24 * 60 * 60_000;
/// Only the newest keys per account are kept.
pub const SESSION_KEYS_PER_USER: i64 = 50;

pub async fn mint(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Response, ApiError> {
    let id = to_b64url(&engram_core::backend::random_bytes(16));
    let key = to_b64url(&engram_core::backend::random_bytes(32));
    let (row_id, row_key) = (id.clone(), key.clone());
    blocking(&state, move |store| {
        store.tx(|tx| {
            let now = now_ms();
            tx.execute(
                "DELETE FROM session_keys WHERE user_id = ?1 AND created_at < ?2",
                params![auth.uid, now - SESSION_KEY_TTL_MS],
            )?;
            tx.execute(
                "INSERT INTO session_keys (id, user_id, key, token_epoch, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![row_id, auth.uid, row_key, auth.ep, now],
            )?;
            tx.execute(
                "DELETE FROM session_keys WHERE user_id = ?1 AND id NOT IN (
                   SELECT id FROM session_keys WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2
                 )",
                params![auth.uid, SESSION_KEYS_PER_USER],
            )?;
            Ok::<(), ApiError>(())
        })
    })
    .await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id, "key": key }))).into_response())
}

pub async fn fetch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let row = blocking(&state, move |store| {
        Ok(store
            .conn()
            .query_row(
                "SELECT key, token_epoch FROM session_keys WHERE id = ?1 AND user_id = ?2",
                params![id, auth.uid],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)),
            )
            .optional()?)
    })
    .await?;
    match row {
        Some((key, epoch)) if epoch.unwrap_or(0) == auth.ep => Ok(Json(json!({ "key": key }))),
        _ => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "session key not found",
        )),
    }
}

pub async fn remove(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    blocking(&state, move |store| {
        store.conn().execute(
            "DELETE FROM session_keys WHERE id = ?1 AND user_id = ?2",
            params![id, auth.uid],
        )?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Advances the token epoch (every earlier token stops working) and deletes
/// every session key, then hands the caller a token at the new epoch.
pub async fn revoke_all(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    blocking(&state, move |store| {
        store.tx(|tx| {
            tx.execute(
                "UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?1",
                params![auth.uid],
            )?;
            tx.execute(
                "DELETE FROM session_keys WHERE user_id = ?1",
                params![auth.uid],
            )?;
            Ok::<(), ApiError>(())
        })
    })
    .await?;
    let epoch = current_epoch(&state, auth.uid).await?;
    Ok(Json(
        json!({ "token": state.tokens.sign(auth.uid, epoch, now_secs()) }),
    ))
}
