//! Account routes with the server's shapes and wording: register, the
//! pre-login key attributes (with the server's decoy for unknown emails),
//! login, session renewal, the account itself, and its key attributes.
//! Two-factor, recovery, password change and invites need a server.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use engram_core::b64::{from_b64url, to_b64url};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::extract::{blocking, disabled, AuthUser, JsonBody};
use crate::server::AppState;
use crate::store::{now_ms, storage_used};
use crate::token::now_secs;
use crate::validate::{self, js_len, js_trim, KeyAttributes};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterBody {
    email: String,
    login_key: String,
    key_attributes: KeyAttributes,
    #[serde(default)]
    invite_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginBody {
    email: String,
    login_key: String,
}

/// The only authentication material kept: BLAKE2b-256 of the login key,
/// base64url, as `loginKeyDigest` in packages/crypto computes it.
pub fn login_key_digest(login_key: &str) -> Result<String, ApiError> {
    let bytes = from_b64url(login_key).map_err(|_| ApiError::invalid_request())?;
    Ok(to_b64url(&engram_core::backend::generichash(32, &bytes)))
}

/// Constant-time comparison of two digests.
fn digests_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Key-derivation parameters for an email with no account: indistinguishable
/// from a real account's, stable across calls, derived so no state is kept.
pub fn decoy_kdf(email: &str, secret: &str) -> Value {
    let digest = Sha256::digest(format!("engram-decoy-kdf|{secret}|{email}").as_bytes());
    json!({ "salt": to_b64url(&digest[..16]), "opsLimit": 3, "memLimit": 268435456 })
}

fn invalid_login() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid email or password")
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    JsonBody(body): JsonBody<RegisterBody>,
) -> Result<Response, ApiError> {
    let email = validate::email(&body.email)?;
    validate::login_key(&body.login_key)?;
    body.key_attributes.check()?;
    if matches!(&body.invite_token, Some(token) if token.is_empty()) {
        return Err(ApiError::invalid_request());
    }
    let digest = login_key_digest(&body.login_key)?;
    let attributes =
        serde_json::to_string(&body.key_attributes).map_err(|_| ApiError::internal())?;
    let uid = blocking(&state, move |store| {
        let conn = store.conn();
        let taken = conn
            .query_row("SELECT id FROM users WHERE email = ?1", params![email], |r| {
                r.get::<_, i64>(0)
            })
            .optional()?;
        if taken.is_some() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "an account with this email already exists",
            ));
        }
        Ok(conn.query_row(
            "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id",
            params![email, digest, attributes, now_ms()],
            |r| r.get::<_, i64>(0),
        )?)
    })
    .await?;
    let token = state.tokens.sign(uid, 0, now_secs());
    Ok((StatusCode::CREATED, Json(json!({ "token": token }))).into_response())
}

pub async fn attributes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let email = validate::email(query.get("email").map(String::as_str).unwrap_or(""))?;
    let lookup = email.clone();
    let stored = blocking(&state, move |store| {
        Ok(store
            .conn()
            .query_row(
                "SELECT key_attributes FROM users WHERE email = ?1",
                params![lookup],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })
    .await?;
    let kdf = match stored {
        Some(text) => {
            let attributes: Value =
                serde_json::from_str(&text).map_err(|_| ApiError::internal())?;
            attributes.get("kdf").cloned().unwrap_or(Value::Null)
        }
        None => decoy_kdf(&email, state.tokens.secret()),
    };
    Ok(Json(json!({ "kdf": kdf })))
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    JsonBody(body): JsonBody<LoginBody>,
) -> Result<Json<Value>, ApiError> {
    let email = validate::email(&body.email)?;
    validate::login_key(&body.login_key)?;
    let digest = login_key_digest(&body.login_key)?;
    let row = blocking(&state, move |store| {
        Ok(store
            .conn()
            .query_row(
                "SELECT id, login_key_digest, key_attributes, disabled, token_epoch FROM users WHERE email = ?1",
                params![email],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                        r.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .optional()?)
    })
    .await?;
    let Some((uid, stored, attributes, disabled_flag, epoch)) = row else {
        return Err(invalid_login());
    };
    if !digests_match(&digest, &stored) {
        return Err(invalid_login());
    }
    if disabled_flag == Some(1) {
        return Err(disabled());
    }
    let key_attributes: Value =
        serde_json::from_str(&attributes).map_err(|_| ApiError::internal())?;
    let token = state.tokens.sign(uid, epoch.unwrap_or(0), now_secs());
    Ok(Json(
        json!({ "token": token, "keyAttributes": key_attributes }),
    ))
}

/// A fresh 30-day token at the account's current epoch; it revokes nothing.
pub async fn refresh(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let epoch = current_epoch(&state, auth.uid).await?;
    Ok(Json(
        json!({ "token": state.tokens.sign(auth.uid, epoch, now_secs()) }),
    ))
}

pub(crate) async fn current_epoch(state: &Arc<AppState>, uid: i64) -> Result<i64, ApiError> {
    blocking(state, move |store| {
        Ok(store
            .conn()
            .query_row(
                "SELECT token_epoch FROM users WHERE id = ?1",
                params![uid],
                |r| r.get::<_, Option<i64>>(0),
            )?
            .unwrap_or(0))
    })
    .await
}

pub async fn user(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let default_quota = state.config.quota_bytes;
    let value = blocking(&state, move |store| {
        let conn = store.conn();
        let (email, created_at, display_name, totp, digests, quota) = conn.query_row(
            "SELECT email, created_at, display_name, totp_enabled, recovery_code_digests, quota_bytes FROM users WHERE id = ?1",
            params![auth.uid],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                ))
            },
        )?;
        let totp_enabled = totp == Some(1);
        let codes_left = if totp_enabled {
            serde_json::from_str::<Vec<Value>>(digests.as_deref().unwrap_or("[]"))
                .map(|codes| codes.len())
                .unwrap_or(0)
        } else {
            0
        };
        Ok(json!({
            "email": email,
            "createdAt": created_at,
            "usedBytes": storage_used(&conn, auth.uid)?,
            "quotaBytes": quota.map_or(default_quota, |q| q as u64),
            "isAdmin": false,
            "displayName": display_name,
            "totpEnabled": totp_enabled,
            "recoveryCodesLeft": codes_left,
            "collab": { "relay": false },
            "events": false,
        }))
    })
    .await?;
    Ok(Json(value))
}

/// `{ displayName: string | null }`: trimmed, at most 64 characters, and
/// an empty name clears it.
pub async fn patch_user(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = match body.get("displayName") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            if js_len(trimmed) > 64 {
                return Err(ApiError::invalid_request());
            }
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        _ => return Err(ApiError::invalid_request()),
    };
    let stored = name.clone();
    blocking(&state, move |store| {
        store.conn().execute(
            "UPDATE users SET display_name = ?1 WHERE id = ?2",
            params![stored, auth.uid],
        )?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "displayName": name })))
}

pub async fn key_attributes(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let text = blocking(&state, move |store| {
        Ok(store.conn().query_row(
            "SELECT key_attributes FROM users WHERE id = ?1",
            params![auth.uid],
            |r| r.get::<_, String>(0),
        )?)
    })
    .await?;
    let attributes: Value = serde_json::from_str(&text).map_err(|_| ApiError::internal())?;
    Ok(Json(json!({ "keyAttributes": attributes })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_digest_matches_packages_crypto() {
        // loginKeyDigest("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") from packages/crypto.
        assert_eq!(
            login_key_digest("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap(),
            "iesNaoppHa4s0V7QNpkxzgqUnsr6XD-T-BIYM2RuFcM"
        );
    }

    #[test]
    fn decoys_are_stable_url_safe_and_per_email() {
        let a = decoy_kdf("nobody@example.com", "secret");
        // The Node server's decoyKdf("nobody@example.com", "secret").
        assert_eq!(a["salt"], "ORBbmbwHbBmW8uHyssibkQ");
        assert_eq!(a, decoy_kdf("nobody@example.com", "secret"));
        assert_ne!(a["salt"], decoy_kdf("other@example.com", "secret")["salt"]);
        let salt = a["salt"].as_str().unwrap();
        assert!(salt
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(a["opsLimit"], 3);
        assert_eq!(a["memLimit"], 268435456);
    }

    #[test]
    fn digests_compare_exactly() {
        assert!(digests_match("abc", "abc"));
        assert!(!digests_match("abc", "abd"));
        assert!(!digests_match("abc", "abcd"));
    }
}
