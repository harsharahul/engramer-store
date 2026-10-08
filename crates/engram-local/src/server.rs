//! The loopback HTTP server: the part of the Engram Store API an
//! on-device vault serves, on 127.0.0.1 only. Routes a vault cannot serve
//! answer 404 `{ "error": "needs a server" }`.

use std::io;
use std::net::TcpListener as StdListener;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::blobs::{BlobStore, BLOBS_DIR};
use crate::error::ApiError;
use crate::events::SeqEvents;
use crate::headers::OFFICE_PREFIX;
use crate::packs::{Packs, PACKS_DIR};
use crate::store::{Store, DB_FILE};
use crate::token::Tokens;
use crate::web::WebDist;
use crate::{accounts, content, events, headers, packs, sessions, settings, storage, web};

/// Server defaults; the binary and the shell set them.
pub struct ServerConfig {
    pub data_dir: PathBuf,
    pub quota_bytes: u64,
    /// How often an open change feed is checked and kept warm.
    pub events_heartbeat_ms: u64,
    /// Content versions kept per file; 0 keeps none.
    pub max_versions: usize,
    /// The most bytes one blob may hold.
    pub max_blob_bytes: u64,
    /// The web client's core bundle to serve; `None` serves the API only.
    pub web_dist: Option<PathBuf>,
}

/// Everything a request handler can reach.
pub struct AppState {
    pub store: Store,
    pub tokens: Tokens,
    pub events: Arc<SeqEvents>,
    pub blobs: BlobStore,
    pub web: Option<WebDist>,
    pub packs: Packs,
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
        let blobs = BlobStore::open(config.data_dir.join(BLOBS_DIR))
            .map_err(|err| format!("cannot open the blob directory: {err}"))?;
        let web = match &config.web_dist {
            Some(dir) => Some(WebDist::open(dir.clone())?),
            None => None,
        };
        let packs = Packs::open(
            config.data_dir.join(PACKS_DIR),
            web.as_ref().and_then(|w| w.manifest.clone()),
        )?;
        Ok(AppState {
            store,
            tokens,
            events: Arc::new(SeqEvents::default()),
            blobs,
            web,
            packs,
            config,
        })
    }

    /// What the vault occupies on disk: the database, its journal and
    /// every stored blob. Packs are not counted: they are re-downloadable.
    pub fn vault_bytes(&self) -> u64 {
        let mut total = 0u64;
        for suffix in ["", "-wal", "-shm"] {
            let path = self.config.data_dir.join(format!("{DB_FILE}{suffix}"));
            total += std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        }
        if let Ok(entries) = std::fs::read_dir(self.blobs.dir()) {
            for entry in entries.flatten() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
        total
    }
}

/// A running server. Dropping it does not stop it; call `stop`.
pub struct Bound {
    pub port: u16,
    events: Arc<SeqEvents>,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl Bound {
    /// Ends every open change feed, stops accepting connections and waits
    /// for in-flight requests.
    pub async fn stop(mut self) {
        self.events.close_all();
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
    let events = Arc::clone(&state.events);
    // A state stopped before takes streams again.
    events.reopen();
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
        events,
        shutdown: Some(tx),
        task,
    })
}

/// The routes, behind the Host guard for `host` ("127.0.0.1:<port>"). A
/// served path called with a method it does not serve answers like any
/// other route a vault cannot serve, never with a bodyless 405. Paths
/// outside `/api/` are the web client's.
pub fn router(state: Arc<AppState>, host: String) -> Router {
    let script_hashes: Arc<Vec<String>> = Arc::new(
        state
            .web
            .as_ref()
            .map(|web| web.script_hashes.clone())
            .unwrap_or_default(),
    );
    Router::new()
        .route("/api/health", get(health))
        .route("/api/ready", get(ready))
        .route("/api/auth/registration", get(registration))
        .route("/api/auth/register", post(accounts::register))
        .route("/api/auth/attributes", get(accounts::attributes))
        .route("/api/auth/login", post(accounts::login))
        .route("/api/auth/refresh", post(accounts::refresh))
        .route("/api/auth/session-key", post(sessions::mint))
        .route(
            "/api/auth/session-key/{id}",
            get(sessions::fetch).delete(sessions::remove),
        )
        .route("/api/auth/sessions/revoke-all", post(sessions::revoke_all))
        .route("/api/user", get(accounts::user).patch(accounts::patch_user))
        .route("/api/user/key-attributes", get(accounts::key_attributes))
        .route(
            "/api/settings",
            get(settings::get_settings).put(settings::put_settings),
        )
        .route("/api/sync", get(settings::sync))
        .route("/api/events", get(events::stream))
        .route("/api/local/packs", get(packs::list))
        .route(
            "/api/local/packs/{name}",
            post(packs::start_download).delete(packs::remove_pack),
        )
        .route("/api/folders", post(storage::create_folder))
        .route(
            "/api/folders/{id}",
            axum::routing::patch(storage::patch_folder).delete(storage::delete_folder),
        )
        .route("/api/files", post(storage::create_file))
        .route("/api/files/batch", post(storage::batch))
        .route("/api/files/verify", post(content::verify))
        .route(
            "/api/files/{id}",
            axum::routing::patch(storage::patch_file).delete(storage::trash_file),
        )
        .route(
            "/api/files/{id}/data",
            axum::routing::put(content::put_data).get(content::get_data),
        )
        .route(
            "/api/files/{id}/thumbnail",
            axum::routing::put(content::put_thumbnail).get(content::get_thumbnail),
        )
        .route(
            "/api/files/{id}/index",
            axum::routing::put(content::put_index).get(content::get_index),
        )
        .route("/api/files/{id}/data/parts", post(content::begin_parts))
        .route(
            "/api/files/{id}/data/parts/{session}",
            axum::routing::delete(content::abort_parts),
        )
        .route(
            "/api/files/{id}/data/parts/{session}/complete",
            post(content::complete_parts),
        )
        .route(
            "/api/files/{id}/data/parts/{session}/{part}",
            axum::routing::put(content::put_part),
        )
        .route("/api/files/{id}/versions", get(content::list_versions))
        .route(
            "/api/files/{id}/versions/{gen}/data",
            get(content::version_data),
        )
        .route(
            "/api/files/{id}/versions/{gen}/restore",
            post(content::restore_version),
        )
        .route("/api/trash/{id}/restore", post(storage::restore_file))
        .route(
            "/api/trash/{id}",
            axum::routing::delete(storage::delete_forever),
        )
        .route("/api/{*rest}", any(needs_server))
        .method_not_allowed_fallback(needs_server)
        .fallback(web::serve)
        .with_state(state)
        // The blob routes stream their bodies and bound them by the quota;
        // JSON bodies bound themselves (see `extract::JSON_BODY_LIMIT`).
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn(move |req, next| {
            host_guard(host.clone(), Arc::clone(&script_hashes), req, next)
        }))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn ready() -> Json<Value> {
    Json(json!({ "status": "ready" }))
}

/// An on-device vault always lets its owner create the vault, and says
/// it is one: the sign-in screen reads `local` before any account exists.
async fn registration() -> Json<Value> {
    Json(json!({ "mode": "open", "macAppUrl": null, "local": true }))
}

async fn needs_server() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "needs a server")
}

/// Refuses any request not addressed to this listener's own host:port,
/// so a page elsewhere cannot reach it through a DNS name that resolves
/// to loopback, and gives every answer the server's response headers:
/// the strict set, or the office editor's relaxed set under its prefix.
async fn host_guard(
    expected: String,
    script_hashes: Arc<Vec<String>>,
    req: Request,
    next: Next,
) -> Response {
    let ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|h| h == expected)
        .unwrap_or(false);
    if !ok {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let office = req.uri().path().starts_with(OFFICE_PREFIX);
    let mut response = next.run(req).await;
    if office {
        headers::apply_office(response.headers_mut(), &expected);
    } else {
        headers::apply(response.headers_mut(), &expected, &script_hashes);
    }
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
            Running::with(|_| {})
        }

        /// A server whose configuration `adjust` may change first.
        pub(crate) fn with(adjust: impl FnOnce(&mut ServerConfig)) -> Running {
            let dir = temp_dir("server");
            let mut config = ServerConfig {
                data_dir: dir.clone(),
                quota_bytes: 512 * 1024,
                events_heartbeat_ms: 25_000,
                max_versions: 10,
                max_blob_bytes: 20 * 1024 * 1024 * 1024,
                web_dist: None,
            };
            adjust(&mut config);
            let state = Arc::new(AppState::open(config).unwrap());
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
        raw_with(port, method, path, host, body, &[])
    }

    /// One raw HTTP/1.1 request with extra headers: (status, lowercased
    /// head, body).
    pub(crate) fn raw_with(
        port: u16,
        method: &str,
        path: &str,
        host: &str,
        body: Option<&str>,
        headers: &[(&str, &str)],
    ) -> (u16, String, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let body = body.unwrap_or("");
        let mut content = if body.is_empty() {
            String::new()
        } else {
            "Content-Type: application/json\r\n".to_string()
        };
        for (name, value) in headers {
            content.push_str(&format!("{name}: {value}\r\n"));
        }
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

    /// Registers an account over HTTP and returns its session token.
    pub(crate) fn signed_in(port: u16, email: &str) -> String {
        let sb = r#"{"ciphertext":"c","nonce":"n"}"#;
        let attributes = format!(
            r#"{{"kdf":{{"salt":"0123456789abcdef","opsLimit":3,"memLimit":268435456}},"encryptedMasterKey":{sb},"masterKeyEncryptedWithRecoveryKey":{sb},"recoveryKeyEncryptedWithMasterKey":{sb},"publicKey":"p","encryptedPrivateKey":{sb}}}"#
        );
        let body = format!(
            r#"{{"email":"{email}","loginKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","keyAttributes":{attributes}}}"#
        );
        let host = format!("127.0.0.1:{port}");
        let (status, _, body) = raw(port, "POST", "/api/auth/register", &host, Some(&body));
        assert_eq!(status, 201);
        let value: Value = serde_json::from_str(&body).unwrap();
        value["token"].as_str().unwrap().to_string()
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
        assert_eq!(
            value,
            json!({ "mode": "open", "macAppUrl": null, "local": true })
        );
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
