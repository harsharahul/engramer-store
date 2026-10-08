//! Request extractors with the server's semantics: the signed-in account
//! behind a bearer token, and a JSON body whose every failure is the
//! server's opaque 400. Store calls run on the blocking pool, so SQLite
//! never stalls the async runtime.

use std::sync::Arc;

use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, StatusCode};
use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;

use crate::error::ApiError;
use crate::server::AppState;
use crate::store::Store;
use crate::token::now_secs;

/// Runs `f` against the store on the blocking pool.
pub async fn blocking<T, F>(state: &Arc<AppState>, f: F) -> Result<T, ApiError>
where
    F: FnOnce(&Store) -> Result<T, ApiError> + Send + 'static,
    T: Send + 'static,
{
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || f(&state.store))
        .await
        .map_err(|_| ApiError::internal())?
}

pub fn unauthenticated() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "authentication required")
}

pub fn disabled() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "this account is disabled")
}

/// The signed-in account, checked as the server's `authenticate` hook
/// checks it: a valid token that is not a two-factor pending token, an
/// account that exists and is not disabled, and the account's current
/// token epoch.
#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub uid: i64,
    pub ep: i64,
}

impl FromRequestParts<Arc<AppState>> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<AuthUser, ApiError> {
        let token = bearer(&parts.headers).ok_or_else(unauthenticated)?;
        let claims = state
            .tokens
            .verify(token, now_secs())
            .ok_or_else(unauthenticated)?;
        if claims.pending == Some(true) {
            return Err(unauthenticated());
        }
        let (uid, ep) = (claims.uid, claims.ep.unwrap_or(0));
        let row = blocking(state, move |store| {
            Ok(store
                .conn()
                .query_row(
                    "SELECT disabled, token_epoch FROM users WHERE id = ?1",
                    params![uid],
                    |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
                )
                .optional()?)
        })
        .await?;
        match row {
            None => Err(disabled()),
            Some((Some(1), _)) => Err(disabled()),
            Some((_, epoch)) if epoch.unwrap_or(0) != ep => Err(unauthenticated()),
            Some(_) => Ok(AuthUser { uid, ep }),
        }
    }
}

/// `Authorization: Bearer <token>`, the scheme matched case-insensitively.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && !token.contains(' ') {
        Some(token)
    } else {
        None
    }
}

/// The most a JSON body may hold, as on the server. Blob routes read the
/// request body themselves and bound it by the quota instead.
pub const JSON_BODY_LIMIT: usize = 16 * 1024 * 1024;

/// A JSON body; anything unreadable or of the wrong shape is the server's
/// `400 {"error":"invalid request"}`.
pub struct JsonBody<T>(pub T);

impl<S, T> FromRequest<S> for JsonBody<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, _state: &S) -> Result<JsonBody<T>, ApiError> {
        let bytes = axum::body::to_bytes(req.into_body(), JSON_BODY_LIMIT)
            .await
            .map_err(|_| ApiError::invalid_request())?;
        serde_json::from_slice(&bytes)
            .map(JsonBody)
            .map_err(|_| ApiError::invalid_request())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn with_auth(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn reads_a_bearer_token() {
        assert_eq!(bearer(&with_auth("Bearer abc")), Some("abc"));
        assert_eq!(bearer(&with_auth("bearer abc")), Some("abc"));
        assert_eq!(bearer(&with_auth("Basic abc")), None);
        assert_eq!(bearer(&with_auth("Bearer")), None);
        assert_eq!(bearer(&with_auth("Bearer a b")), None);
        assert_eq!(bearer(&HeaderMap::new()), None);
    }
}
