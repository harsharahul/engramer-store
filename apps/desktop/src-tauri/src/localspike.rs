//! Local-first spike: a loopback HTTP listener inside the shell that serves
//! the web client and the few API routes the first paint needs. Throwaway;
//! compiled only with the `local-spike` cargo feature. Findings are recorded
//! in docs/local-first.local.md.

pub mod csp;

use std::net::TcpListener as StdListener;
use std::path::{Path, PathBuf};

use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use tokio::sync::oneshot;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/// The port the shell tries first; any free port when it is taken.
pub const DEFAULT_PORT: u16 = 38765;
/// The file next to the vault that remembers the port between launches.
pub const PORT_FILE: &str = "local-port";

/// A running listener. Dropping it does not stop the task; call `stop`.
pub struct Bound {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<()>,
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

/// Binds the loopback address synchronously so the socket exists before the
/// webview's first request; falls back to any free port when `preferred` is
/// taken.
pub fn bind(preferred: u16) -> std::io::Result<StdListener> {
    match StdListener::bind(("127.0.0.1", preferred)) {
        Ok(listener) => Ok(listener),
        Err(_) if preferred != 0 => StdListener::bind(("127.0.0.1", 0)),
        Err(err) => Err(err),
    }
}

/// Hands the bound socket to axum on the shell's async runtime and serves
/// `dist` from it.
pub fn serve(listener: StdListener, dist: PathBuf) -> std::io::Result<Bound> {
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let host = format!("127.0.0.1:{port}");
    let index = std::fs::read_to_string(dist.join("index.html")).unwrap_or_default();
    let policy = csp::csp_for(&host, &csp::inline_script_hashes(&index));
    let router = router(dist, host, policy);
    let (tx, rx) = oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("local spike: listener handoff failed: {err}");
                return;
            }
        };
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(err) = server.await {
            eprintln!("local spike: listener ended: {err}");
        }
    });
    Ok(Bound { port, shutdown: Some(tx), task })
}

fn router(dist: PathBuf, host: String, policy: String) -> Router {
    let files = ServeDir::new(&dist).fallback(ServeFile::new(dist.join("index.html")));
    let csp_value = HeaderValue::from_str(&policy).expect("csp is ascii");
    Router::new()
        .route("/api/health", get(health))
        .route("/api/ready", get(health))
        .route("/api/auth/registration", get(registration))
        .route("/api/spike/report", post(spike_report))
        .route("/api/{*rest}", any(api_not_found))
        .fallback_service(files)
        .layer(SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, csp_value))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(middleware::from_fn(move |req, next| host_guard(host.clone(), req, next)))
        .layer(middleware::from_fn(log_requests))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn registration() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "mode": "open" }))
}

async fn api_not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response()
}

/// The in-page probe (spike-probe.js, injected into the served copy of
/// index.html by Task 4) posts what only the page can observe: the IPC
/// bridge, the service worker controller, CSP violations. Logged so a shell
/// run is checkable from stderr alone.
async fn spike_report(Json(report): Json<serde_json::Value>) -> StatusCode {
    eprintln!("local spike: report {report}");
    StatusCode::NO_CONTENT
}

/// Refuses anything not addressed to this listener's own host:port, so a
/// page on another origin cannot reach it through a DNS name that resolves
/// to loopback.
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
    next.run(req).await
}

/// One line per request on stderr; a service worker script fetch is
/// flagged because it is the spike's proof that registration happened.
async fn log_requests(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let sw = req.headers().contains_key("service-worker");
    let res = next.run(req).await;
    eprintln!(
        "local spike: {method} {path} -> {}{}",
        res.status().as_u16(),
        if sw { "  [service worker script fetch]" } else { "" }
    );
    res
}

pub fn read_port(dir: &Path) -> Option<u16> {
    std::fs::read_to_string(dir.join(PORT_FILE)).ok()?.trim().parse().ok()
}

pub fn write_port(dir: &Path, port: u16) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(PORT_FILE), format!("{port}\n"))
}

/// Opens (or creates) a SQLite file in `dir`, records this start, returns
/// how many starts the file has seen. Proves rusqlite links and runs on
/// the target.
pub fn sqlite_probe(dir: &Path) -> Result<i64, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let conn = rusqlite::Connection::open(dir.join("local-spike.db")).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS starts (at INTEGER NOT NULL)")
        .map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute("INSERT INTO starts (at) VALUES (?1)", [now]).map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM starts", [], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

/// Held by the app so the listener lives as long as the process.
pub struct SpikeState(pub Bound);

/// Resolves the dist and data directories now that the app exists, records
/// the start in SQLite, hands the pre-bound socket to axum, remembers the
/// port, and points the main window at the loopback origin.
pub fn boot(app: &tauri::AppHandle, listener: StdListener) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir()?.join("local-spike");
    let dist = match std::env::var("ENGRAM_LOCAL_SPIKE_DIST") {
        Ok(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
        _ => app.path().resource_dir()?.join("webdist"),
    };
    if !dist.join("index.html").is_file() {
        return Err(format!("local spike: no index.html under {}", dist.display()).into());
    }
    let starts = sqlite_probe(&data_dir)?;
    let bound = serve(listener, dist.clone())?;
    write_port(&data_dir, bound.port)?;
    let origin = format!("http://127.0.0.1:{}/", bound.port);
    eprintln!(
        "local spike: serving {} at {origin} (sqlite ok, start #{starts}, data {})",
        dist.display(),
        data_dir.display()
    );
    let url = url::Url::parse(&origin)?;
    app.manage(SpikeState(bound));
    crate::serverurl::navigate_main(app, url)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;

    fn dist() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "engram-spike-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(
            dir.join("index.html"),
            "<!doctype html><title>spike</title><script>\n  console.log(\"spike\");\n</script>",
        )
        .unwrap();
        std::fs::write(dir.join("sw.js"), "// sw").unwrap();
        std::fs::write(dir.join("assets").join("app.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join("local-port"), "1\n").unwrap();
        dir
    }

    /// One raw HTTP/1.1 request; returns (status, lowercased headers, body).
    fn raw(port: u16, path: &str, host: &str) -> (u16, String, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, head.to_ascii_lowercase(), body.to_string())
    }

    fn up() -> Bound {
        let listener = bind(0).unwrap();
        serve(listener, dist()).unwrap()
    }

    fn own(port: u16) -> String {
        format!("127.0.0.1:{port}")
    }

    /// One raw POST with a JSON body; returns (status, lowercased headers).
    fn raw_post(port: u16, path: &str, host: &str, body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let head = text.split("\r\n\r\n").next().unwrap().to_string();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, head.to_ascii_lowercase())
    }

    #[test]
    fn the_report_route_accepts_json_and_answers_204() {
        let bound = up();
        let (status, _) = raw_post(
            bound.port,
            "/api/spike/report",
            &own(bound.port),
            "{\"phase\":\"load\",\"tauri\":\"object\"}",
        );
        assert_eq!(status, 204);
        let (status, _) = raw_post(bound.port, "/api/spike/report", &own(bound.port), "not json");
        assert_eq!(status, 400);
        tauri::async_runtime::block_on(bound.stop());
    }

    #[test]
    fn health_answers_the_probe_body() {
        let bound = up();
        let (status, head, body) = raw(bound.port, "/api/health", &own(bound.port));
        assert_eq!(status, 200);
        assert!(head.contains("content-type: application/json"));
        assert!(body.contains("\"status\":\"ok\""));
        tauri::async_runtime::block_on(bound.stop());
    }

    #[test]
    fn deep_routes_fall_back_to_index() {
        let bound = up();
        let (status, head, body) = raw(bound.port, "/files/some-folder", &own(bound.port));
        assert_eq!(status, 200);
        assert!(head.contains("content-type: text/html"));
        assert!(body.contains("<title>spike</title>"));
        tauri::async_runtime::block_on(bound.stop());
    }

    #[test]
    fn api_paths_never_fall_back_to_index() {
        let bound = up();
        let (status, _, body) = raw(bound.port, "/api/nope", &own(bound.port));
        assert_eq!(status, 404);
        assert!(body.contains("\"error\":\"not found\""));
        tauri::async_runtime::block_on(bound.stop());
    }

    #[test]
    fn a_foreign_host_header_is_refused() {
        let bound = up();
        let (status, _, _) = raw(bound.port, "/api/health", "evil.example:80");
        assert_eq!(status, 421);
        let (status, _, _) = raw(bound.port, "/api/health", &format!("localhost:{}", bound.port));
        assert_eq!(status, 421);
        tauri::async_runtime::block_on(bound.stop());
    }

    #[test]
    fn every_response_carries_the_csp_with_the_inline_hash() {
        let bound = up();
        let (_, head, _) = raw(bound.port, "/", &own(bound.port));
        assert!(head.contains("content-security-policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-x/emefcuubkcqn3ayynphvu6ljlsso2imhvipwulsto='"));
        assert!(head.contains(&format!("connect-src 'self' ws://127.0.0.1:{}", bound.port)));
        assert!(head.contains("x-content-type-options: nosniff"));
        let (_, head, _) = raw(bound.port, "/assets/app.js", &own(bound.port));
        assert!(head.contains("content-security-policy:"));
        tauri::async_runtime::block_on(bound.stop());
    }

    #[test]
    fn traversal_never_leaves_the_dist() {
        let bound = up();
        let (status, _, body) = raw(bound.port, "/assets/../local-port", &own(bound.port));
        assert!(status == 200 || status == 404, "status {status}");
        assert!(!body.trim().starts_with('1'), "a file outside assets/ was served");
        let (status, _, _) = raw(bound.port, "/assets/..%2f..%2fCargo.toml", &own(bound.port));
        assert_ne!(status, 500);
        tauri::async_runtime::block_on(bound.stop());
    }

    #[test]
    fn a_taken_port_falls_back_to_a_free_one() {
        let first = bind(0).unwrap();
        let taken = first.local_addr().unwrap().port();
        let second = bind(taken).unwrap();
        assert_ne!(second.local_addr().unwrap().port(), taken);
    }

    #[test]
    fn the_port_file_round_trips() {
        let dir = dist().join("data");
        assert_eq!(read_port(&dir), None);
        write_port(&dir, 38765).unwrap();
        assert_eq!(read_port(&dir), Some(38765));
    }

    #[test]
    fn sqlite_counts_starts() {
        let dir = dist().join("data");
        assert_eq!(sqlite_probe(&dir).unwrap(), 1);
        assert_eq!(sqlite_probe(&dir).unwrap(), 2);
        assert!(dir.join("local-spike.db").is_file());
    }
}
