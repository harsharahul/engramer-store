//! Error responses in the server's shape: a status code and a JSON body
//! `{ "error": "<text>" }` with the server's own wording.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            message: message.into(),
        }
    }

    /// The server's answer to a request body or query it cannot accept.
    pub fn invalid_request() -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, "invalid request")
    }

    pub fn internal() -> ApiError {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> ApiError {
        eprintln!("engram-local: database error: {err}");
        ApiError::internal()
    }
}
