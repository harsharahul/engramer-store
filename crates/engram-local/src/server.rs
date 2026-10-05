//! The loopback HTTP server: the part of the Engram Store API an
//! on-device vault serves, on 127.0.0.1 only. Routes a vault cannot serve
//! answer 404 `{ "error": "needs a server" }`.

use std::io;
use std::net::TcpListener as StdListener;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::error::ApiError;
use crate::headers;
use crate::store::{Store, DB_FILE};
use crate::token::Tokens;

/// Server defaults; the binary and the shell set them.
pub struct ServerConfig {
    pub data_dir: PathBuf,
    pub quota_bytes: u64,
}

/// Everything a request handler can reach.
pub struct AppState {
    pub store: Store,
    pub tokens: Tokens,
    pub config: ServerConfig,
}

impl AppState {
    /// Opens the vault in `config.data_dir` (creating the directory, the
    /// database and the session secret on first use).
    pub fn open(config: ServerConfig) -> Result<AppState, String> {
        std::fs::create_dir_all(&config.data_dir)
            .map_err(|err| format!("cannot create {}: {err}", config.data_dir.display()))?;
        engram_core::init();
        let store = Store::open(&config.data_dir.join(DB_FILE))
            .map_err(|err| format!("cannot open the vault: {err}"))?;
        let tokens = Tokens::load_or_create(&config.data_dir)
            .map_err(|err| format!("cannot read the session secret: {err}"))?;
        Ok(AppState {
            store,
            tokens,
            config,
        })
    }
}

/// A running server. Dropping it does not stop it; call `stop`.
pub struct Bound {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl Bound {
    /// Stops accepting connections and waits for in-flight requests.
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.task.await;
    }
}

/// Binds 127.0.0.1:`preferred` synchronously; falls back to any free port
/// when `preferred` is taken. Port 0 asks for any free port.
pub fn bind(preferred: u16) -> io::Result<StdListener> {
    match StdListener::bind(("127.0.0.1", preferred)) {
        Ok(listener) => Ok(listener),
        Err(_) if preferred != 0 => StdListener::bind(("127.0.0.1", 0)),
        Err(err) => Err(err),
    }
}

/// Serves `state` on `listener` from the calling Tokio runtime.
pub async fn start(listener: StdListener, state: Arc<AppState>) -> io::Result<Bound> {
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let app = router(state, format!("127.0.0.1:{port}"));
    let (tx, rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(err) = server.await {
            eprintln!("engram-local: server ended: {err}");
        }
    });
    Ok(Bound {
        port,
        shutdown: Some(tx),
        task,
    })
}

/// The routes, behind the Host guard for `host` ("127.0.0.1:<port>"). A
/// served path called with a method it does not serve answers like any
/// other route a vault cannot serve, never with a bodyless 405.
pub fn router(state: Arc<AppState>, host: String) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/ready", get(ready))
        .route("/api/auth/registration", get(registration))
        .route("/api/{*rest}", any(needs_server))
        .method_not_allowed_fallback(needs_server)
        .fallback(not_found)
        .with_state(state)
        .layer(middleware::from_fn(move |req, next| {
            host_guard(host.clone(), req, next)
        }))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn ready() -> Json<Value> {
    Json(json!({ "status": "ready" }))
}

/// An on-device vault always lets its owner create the vault.
async fn registration() -> Json<Value> {
    Json(json!({ "mode": "open", "macAppUrl": null }))
}

async fn needs_server() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "needs a server")
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not found")
}

/// Refuses any request not addressed to this listener's own host:port,
/// so a page elsewhere cannot reach it through a DNS name that resolves
/// to loopback, and gives every answer the server's response headers.
async fn host_guard(expected: String, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|h| h == expected)
        .unwrap_or(false);
    if !ok {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let mut response = next.run(req).await;
    headers::apply(response.headers_mut(), &expected);
    response
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    /// A fresh directory per call. The counter keeps parallel tests apart
    /// when the clock (microseconds on macOS) gives two of them one value.
    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "engram-local-{tag}-{}-{n}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A server on a fresh vault, with its own runtime. Dropping it stops
    /// the server and removes the vault's directory.
    pub(crate) struct Running {
        pub rt: tokio::runtime::Runtime,
        pub bound: Option<Bound>,
        pub port: u16,
        pub dir: PathBuf,
    }

    impl Running {
        pub(crate) fn new() -> Running {
            let dir = temp_dir("server");
            let state = Arc::new(
                AppState::open(ServerConfig {
                    data_dir: dir.clone(),
                    quota_bytes: 512 * 1024,
                })
                .unwrap(),
            );
            let rt = tokio::runtime::Runtime::new().unwrap();
            let bound = rt.block_on(start(bind(0).unwrap(), state)).unwrap();
            let port = bound.port;
            Running {
                rt,
                bound: Some(bound),
                port,
                dir,
            }
        }

        /// One raw HTTP/1.1 request: (status, lowercased head, body).
        pub(crate) fn request(
            &self,
            method: &str,
            path: &str,
            body: Option<&str>,
        ) -> (u16, String, String) {
            raw(
                self.port,
                method,
                path,
                &format!("127.0.0.1:{}", self.port),
                body,
            )
        }
    }

    impl Drop for Running {
        fn drop(&mut self) {
            if let Some(bound) = self.bound.take() {
                self.rt.block_on(bound.stop());
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    pub(crate) fn raw(
        port: u16,
        method: &str,
        path: &str,
        host: &str,
        body: Option<&str>,
    ) -> (u16, String, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let body = body.unwrap_or("");
        let content = if body.is_empty() {
            String::new()
        } else {
            "Content-Type: application/json\r\n".to_string()
        };
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{content}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, head.to_ascii_lowercase(), rest.to_string())
    }

    #[test]
    fn health_ready_and_registration_answer_like_the_server() {
        let server = Running::new();
        let (status, head, body) = server.request("GET", "/api/health", None);
        assert_eq!(status, 200);
        assert!(head.contains("content-type: application/json"));
        assert_eq!(body, r#"{"status":"ok"}"#);
        let (status, _, body) = server.request("GET", "/api/ready", None);
        assert_eq!(status, 200);
        assert_eq!(body, r#"{"status":"ready"}"#);
        let (status, _, body) = server.request("GET", "/api/auth/registration", None);
        assert_eq!(status, 200);
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value, json!({ "mode": "open", "macAppUrl": null }));
    }

    #[test]
    fn api_routes_a_vault_cannot_serve_say_so() {
        let server = Running::new();
        let (status, _, body) = server.request("POST", "/api/admin/users", Some("{}"));
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"error":"needs a server"}"#);
    }

    #[test]
    fn a_served_path_called_with_another_method_needs_a_server() {
        let server = Running::new();
        let (status, _, body) = server.request("POST", "/api/health", Some("{}"));
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"error":"needs a server"}"#);
    }

    #[test]
    fn other_paths_are_not_found() {
        let server = Running::new();
        let (status, _, body) = server.request("GET", "/nothing-here", None);
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"error":"not found"}"#);
    }

    #[test]
    fn a_foreign_host_header_is_refused() {
        let server = Running::new();
        let (status, _, _) = raw(server.port, "GET", "/api/health", "evil.example:80", None);
        assert_eq!(status, 421);
        let (status, _, _) = raw(
            server.port,
            "GET",
            "/api/health",
            &format!("localhost:{}", server.port),
            None,
        );
        assert_eq!(status, 421);
    }

    #[test]
    fn a_taken_port_falls_back_to_a_free_one() {
        let first = bind(0).unwrap();
        let taken = first.local_addr().unwrap().port();
        let second = bind(taken).unwrap();
        assert_ne!(second.local_addr().unwrap().port(), taken);
    }
}
