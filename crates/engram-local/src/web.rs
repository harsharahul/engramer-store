//! The web client's core bundle and its installed packs, served from disk
//! with the server's content types and policies and the stricter caching
//! a loopback origin that lives across upgrades needs: the page, the
//! service worker and the manifest are always revalidated, hashed assets
//! are immutable, and a missing file under a hashed or vendored prefix is
//! a 404, never the page.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::error::ApiError;
use crate::packs::{Manifest, Packs, MANIFEST_FILE};
use crate::server::AppState;

/// A built web client: the directory, the inline script hashes its page
/// needs in the policy, and the pack manifest it was built with.
pub struct WebDist {
    pub dir: PathBuf,
    pub script_hashes: Vec<String>,
    pub manifest: Option<Manifest>,
}

impl WebDist {
    pub fn open(dir: PathBuf) -> Result<WebDist, String> {
        let index = std::fs::read_to_string(dir.join("index.html"))
            .map_err(|err| format!("no index.html under {}: {err}", dir.display()))?;
        let manifest_path = dir.join(MANIFEST_FILE);
        let manifest = if manifest_path.is_file() {
            Some(Manifest::read(&manifest_path)?)
        } else {
            None
        };
        Ok(WebDist {
            dir,
            script_hashes: inline_script_hashes(&index),
            manifest,
        })
    }
}

/// sha256 source expressions for every inline `<script>` body in the
/// page, in document order, skipping scripts with a `src` attribute and
/// empty bodies, exactly as the server computes them at startup.
pub fn inline_script_hashes(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(start) = lower[from..].find("<script") {
        let tag_start = from + start;
        let Some(tag_end_rel) = lower[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + tag_end_rel;
        let tag = &lower[tag_start..tag_end];
        let Some(close_rel) = lower[tag_end + 1..].find("</script>") else {
            break;
        };
        let close = tag_end + 1 + close_rel;
        let has_src = tag.split_whitespace().any(|attr| attr.starts_with("src="));
        if !has_src {
            let body = &html[tag_end + 1..close];
            if !body.trim().is_empty() {
                let digest = Sha256::digest(body.as_bytes());
                out.push(format!("sha256-{}", engram_core::b64::to_b64std(&digest)));
            }
        }
        from = close + "</script>".len();
    }
    out
}

/// The request path as a clean relative file path, or `None` for anything
/// that could name a file outside the served directories. Encoded
/// characters are refused outright: no served file needs them.
pub fn clean_request_path(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.contains(['%', '\\', '\0']) {
        return None;
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" => {}
            "." | ".." => return None,
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// Paths whose files carry a version in their name or directory and
/// never change in place.
fn is_immutable(rel: &str) -> bool {
    rel.starts_with("assets/")
        || ["ort/", "ocr/", "zxing/", "gliner-ort/"]
            .iter()
            .any(|base| rel.starts_with(base))
}

/// Prefixes under which a missing file is a 404, never the page.
fn is_file_only(rel: &str) -> bool {
    is_immutable(rel) || rel.starts_with("office/") || rel.starts_with("models/")
}

fn cache_control(rel: &str) -> &'static str {
    if is_immutable(rel) {
        "public, max-age=31536000, immutable"
    } else if rel.starts_with("office/") {
        "public, max-age=0, must-revalidate"
    } else {
        "no-cache"
    }
}

enum Resolved {
    File(PathBuf, String),
    Index,
    MissingPack(String),
    NotFound,
}

fn resolve(web: &WebDist, packs: &Packs, rel: &str) -> Resolved {
    if rel.is_empty() || rel == "index.html" {
        return Resolved::Index;
    }
    if let Some(name) = web.manifest.as_ref().and_then(|m| m.pack_of(rel)) {
        if !packs.installed(name) {
            return Resolved::MissingPack(name.to_string());
        }
        let path = packs.install_dir(name).join(rel);
        return if path.is_file() {
            Resolved::File(path, rel.to_string())
        } else {
            Resolved::NotFound
        };
    }
    let path = web.dir.join(rel);
    if path.is_file() {
        return Resolved::File(path, rel.to_string());
    }
    if is_file_only(rel) {
        return Resolved::NotFound;
    }
    Resolved::Index
}

fn plain_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, "no-store")],
        "not found",
    )
        .into_response()
}

/// Everything the API router did not claim: a file of the client, a pack
/// file, the page for a client route, or a 404.
pub async fn serve(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let Some(web) = &state.web else {
        return ApiError::new(StatusCode::NOT_FOUND, "not found").into_response();
    };
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return ApiError::new(StatusCode::NOT_FOUND, "not found").into_response();
    }
    let Some(rel) = clean_request_path(req.uri().path()) else {
        return plain_not_found();
    };
    let (file, cache_key) = match resolve(web, &state.packs, &rel) {
        Resolved::File(path, rel) => (path, rel),
        Resolved::Index => (web.dir.join("index.html"), "index.html".to_string()),
        Resolved::MissingPack(name) => {
            let mut response = plain_not_found();
            if let Ok(value) = HeaderValue::from_str(&name) {
                response.headers_mut().insert("x-engram-pack", value);
            }
            return response;
        }
        Resolved::NotFound => return plain_not_found(),
    };
    let served = match ServeFile::new(&file).precompressed_br().oneshot(req).await {
        Ok(response) => response,
        Err(err) => {
            eprintln!("engram-local: cannot serve {}: {err}", file.display());
            return ApiError::internal().into_response();
        }
    };
    let mut response = served.map(Body::new);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control(&cache_key)),
    );
    response
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::blobs::hex;
    use crate::server::tests::{raw_with, signed_in, temp_dir, Running};
    use serde_json::{json, Value};

    /// The inline script of the fixture page; its hash was computed with
    /// Node (`createHash("sha256").update(body, "utf8").digest("base64")`).
    const THEME_SCRIPT: &str = "\n  console.log(\"spike\");\n";
    pub(crate) const THEME_HASH: &str = "sha256-X/EMeFCuUbkCqn3aYYNphvU6LjLsSo2ImHvIPwULSto=";

    pub(crate) fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// A pack archive of regular files, built the way the web build builds
    /// one: a gzipped tar of (path, bytes).
    pub(crate) fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(encoder);
        for (path, bytes) in files {
            let mut header = tar::Header::new_ustar();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, *bytes).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    /// What a pack's manifest entry is built from: the files it lists and
    /// the archive bytes it names (which a test may make disagree).
    pub(crate) struct PackFixture {
        pub files: Vec<(String, Vec<u8>)>,
        pub archive: Vec<u8>,
    }

    impl PackFixture {
        pub(crate) fn of(files: &[(&str, &[u8])]) -> PackFixture {
            PackFixture {
                files: files
                    .iter()
                    .map(|(p, b)| (p.to_string(), b.to_vec()))
                    .collect(),
                archive: archive(files),
            }
        }

        fn manifest_entry(&self, name: &str) -> Value {
            json!({
                "archive": format!("engram-pack-{name}-0.0.1.tar.gz"),
                "archiveBytes": self.archive.len(),
                "archiveSha256": sha(&self.archive),
                "installedBytes": self.files.iter().map(|(_, b)| b.len()).sum::<usize>(),
                "files": self.files.iter().map(|(path, bytes)| json!({
                    "path": path, "bytes": bytes.len(), "sha256": sha(bytes),
                })).collect::<Vec<_>>(),
            })
        }
    }

    pub(crate) fn office_fixture() -> PackFixture {
        PackFixture::of(&[
            ("office/a.js", b"console.log('office')"),
            ("office/a.js.br", b"br-bytes"),
            ("office/web-apps/x/index.html", b"<title>editor</title>"),
        ])
    }

    pub(crate) fn intelligence_fixture() -> PackFixture {
        PackFixture::of(&[("models/m.onnx", b"onnx"), ("ort/1.0/ort.wasm", b"wasm")])
    }

    /// A core bundle on disk with a manifest naming the two packs, whose
    /// archives are downloaded from `base_url`.
    pub(crate) fn core_bundle(
        base_url: &str,
        office: &PackFixture,
        intelligence: &PackFixture,
    ) -> PathBuf {
        let dir = temp_dir("webdist");
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::create_dir_all(dir.join("zxing")).unwrap();
        std::fs::create_dir_all(dir.join("brand")).unwrap();
        std::fs::write(
            dir.join("index.html"),
            format!("<!doctype html><title>core</title><script>{THEME_SCRIPT}</script><script type=\"module\" src=\"/assets/app-abc.js\"></script>"),
        )
        .unwrap();
        std::fs::write(dir.join("sw.js"), "// sw").unwrap();
        std::fs::write(dir.join("registerSW.js"), "// register").unwrap();
        std::fs::write(dir.join("manifest.webmanifest"), "{}").unwrap();
        std::fs::write(dir.join("version.json"), "{\"version\":\"0.0.1\"}").unwrap();
        std::fs::write(dir.join("assets").join("app-abc.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join("zxing").join("reader.wasm"), "zx").unwrap();
        std::fs::write(dir.join("brand").join("mark.svg"), "<svg/>").unwrap();
        let manifest = json!({
            "schema": 1,
            "version": "0.0.1",
            "baseUrl": base_url,
            "packs": {
                "office": office.manifest_entry("office"),
                "intelligence": intelligence.manifest_entry("intelligence"),
            },
        });
        std::fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    pub(crate) fn serving() -> Running {
        let dist = core_bundle(
            "http://127.0.0.1:1/",
            &office_fixture(),
            &intelligence_fixture(),
        );
        Running::with(move |config| config.web_dist = Some(dist))
    }

    fn get(server: &Running, path: &str, headers: &[(&str, &str)]) -> (u16, String, String) {
        raw_with(
            server.port,
            "GET",
            path,
            &format!("127.0.0.1:{}", server.port),
            None,
            headers,
        )
    }

    fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
        head.lines()
            .find_map(|line| line.strip_prefix(&format!("{name}: ")))
            .map(str::trim)
    }

    /// Puts a pack's files on disk as an installation, without a download.
    pub(crate) fn install_by_hand(server: &Running, name: &str, pack: &PackFixture) {
        let dir = server.dir.join(crate::packs::PACKS_DIR).join(name);
        for (path, bytes) in &pack.files {
            let file = dir.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }
    }

    #[test]
    fn inline_script_hashes_match_the_servers() {
        let html = format!("<!doctype html><script>{THEME_SCRIPT}</script><script src=\"/a.js\"></script><SCRIPT type=\"module\">   </SCRIPT>");
        assert_eq!(inline_script_hashes(&html), vec![THEME_HASH.to_string()]);
        assert!(inline_script_hashes("<!doctype html><script src=\"/a.js\"></script>").is_empty());
        assert!(inline_script_hashes("").is_empty());
    }

    #[test]
    fn request_paths_are_cleaned_or_refused() {
        assert_eq!(clean_request_path("/").as_deref(), Some(""));
        assert_eq!(
            clean_request_path("/assets//app.js").as_deref(),
            Some("assets/app.js")
        );
        assert_eq!(
            clean_request_path("/files/some-folder/").as_deref(),
            Some("files/some-folder")
        );
        for bad in [
            "/assets/../x",
            "/./x",
            "/a%2fb",
            "/a\\b",
            "relative",
            "/a\0b",
        ] {
            assert_eq!(clean_request_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_page_is_served_for_the_root_and_client_routes() {
        let server = serving();
        for path in [
            "/",
            "/index.html",
            "/files/some-folder",
            "/profile",
            "/brand",
        ] {
            let (status, head, body) = get(&server, path, &[]);
            assert_eq!(status, 200, "{path}");
            assert!(head.contains("content-type: text/html"), "{path}");
            assert_eq!(header(&head, "cache-control"), Some("no-cache"), "{path}");
            assert!(body.contains("<title>core</title>"), "{path}");
            assert!(
                header(&head, "content-security-policy")
                    .unwrap()
                    .contains(&format!("'{}'", THEME_HASH.to_ascii_lowercase())),
                "{path}"
            );
        }
    }

    #[test]
    fn hashed_assets_are_immutable_and_missing_ones_are_not_the_page() {
        let server = serving();
        let (status, head, body) = get(&server, "/assets/app-abc.js", &[]);
        assert_eq!(status, 200);
        assert!(
            head.contains("content-type: text/javascript")
                || head.contains("content-type: application/javascript")
        );
        assert_eq!(
            header(&head, "cache-control"),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(body, "console.log(1)");
        let (status, head, _) = get(&server, "/zxing/reader.wasm", &[]);
        assert_eq!(status, 200);
        assert_eq!(
            header(&head, "cache-control"),
            Some("public, max-age=31536000, immutable")
        );
        for missing in [
            "/assets/app-old.js",
            "/office/gone.js",
            "/ort/9/x.wasm",
            "/models/none.onnx",
        ] {
            let (status, head, body) = get(&server, missing, &[]);
            assert_eq!(status, 404, "{missing}");
            assert!(!body.contains("<title>"), "{missing} served the page");
            assert_eq!(
                header(&head, "cache-control"),
                Some("no-store"),
                "{missing}"
            );
        }
    }

    #[test]
    fn the_worker_and_manifest_always_revalidate() {
        let server = serving();
        for path in [
            "/sw.js",
            "/registerSW.js",
            "/manifest.webmanifest",
            "/version.json",
            "/brand/mark.svg",
        ] {
            let (status, head, _) = get(&server, path, &[]);
            assert_eq!(status, 200, "{path}");
            assert_eq!(header(&head, "cache-control"), Some("no-cache"), "{path}");
        }
    }

    #[test]
    fn a_missing_pack_answers_404_naming_the_pack() {
        let server = serving();
        let (status, head, body) = get(&server, "/office/a.js", &[]);
        assert_eq!(status, 404);
        assert_eq!(header(&head, "x-engram-pack"), Some("office"));
        assert_eq!(body, "not found");
        let (status, head, _) = get(&server, "/models/m.onnx", &[]);
        assert_eq!(status, 404);
        assert_eq!(header(&head, "x-engram-pack"), Some("intelligence"));
        let (_, head, _) = get(&server, "/assets/app-abc.js", &[]);
        assert_eq!(header(&head, "x-engram-pack"), None);
    }

    #[test]
    fn pack_files_are_served_once_installed() {
        let server = serving();
        install_by_hand(&server, "office", &office_fixture());
        install_by_hand(&server, "intelligence", &intelligence_fixture());
        let (status, head, body) = get(&server, "/office/a.js", &[]);
        assert_eq!(status, 200);
        assert_eq!(body, "console.log('office')");
        assert_eq!(
            header(&head, "cache-control"),
            Some("public, max-age=0, must-revalidate")
        );
        assert_eq!(header(&head, "x-engram-pack"), None);
        let (status, head, body) = get(&server, "/office/a.js", &[("Accept-Encoding", "gzip, br")]);
        assert_eq!(status, 200);
        assert_eq!(header(&head, "content-encoding"), Some("br"));
        assert!(
            head.contains("content-type: text/javascript")
                || head.contains("content-type: application/javascript")
        );
        assert_eq!(body, "br-bytes");
        let (status, head, _) = get(&server, "/ort/1.0/ort.wasm", &[]);
        assert_eq!(status, 200);
        assert_eq!(
            header(&head, "cache-control"),
            Some("public, max-age=31536000, immutable")
        );
        assert!(head.contains("content-type: application/wasm"));
        let (status, _, _) = get(&server, "/office/web-apps/x/missing.html", &[]);
        assert_eq!(status, 404);
    }

    #[test]
    fn the_office_tree_carries_the_relaxed_policy() {
        let server = serving();
        install_by_hand(&server, "office", &office_fixture());
        let (_, head, _) = get(&server, "/office/web-apps/x/index.html", &[]);
        let own = format!("http://127.0.0.1:{}", server.port);
        assert!(header(&head, "content-security-policy")
            .unwrap()
            .starts_with(&format!("default-src {own};")));
        assert_eq!(
            header(&head, "cross-origin-resource-policy"),
            Some("cross-origin")
        );
        assert_eq!(header(&head, "access-control-allow-origin"), Some("*"));
        assert_eq!(header(&head, "x-frame-options"), None);
        let (_, head, _) = get(&server, "/", &[]);
        assert_eq!(header(&head, "x-frame-options"), Some("deny"));
        assert_eq!(
            header(&head, "cross-origin-resource-policy"),
            Some("same-origin")
        );
    }

    #[test]
    fn requests_never_leave_the_served_directories() {
        let server = serving();
        std::fs::write(server.dir.join("secret.txt"), "vault secret").unwrap();
        for path in [
            "/assets/../../secret.txt",
            "/assets/..%2f..%2fsecret.txt",
            "/%2e%2e/secret.txt",
        ] {
            let (status, _, body) = get(&server, path, &[]);
            assert!(status == 404 || status == 200, "{path}: {status}");
            assert!(!body.contains("vault secret"), "{path} left the bundle");
        }
    }

    #[test]
    fn head_requests_are_answered_without_a_body() {
        let server = serving();
        let (status, head, body) = raw_with(
            server.port,
            "HEAD",
            "/assets/app-abc.js",
            &format!("127.0.0.1:{}", server.port),
            None,
            &[],
        );
        assert_eq!(status, 200);
        assert!(head.contains("content-length: 14"));
        assert_eq!(body, "");
    }

    #[test]
    fn other_methods_on_client_paths_are_not_found() {
        let server = serving();
        let (status, _, body) = server.request("POST", "/files/x", Some("{}"));
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"error":"not found"}"#);
    }

    #[test]
    fn without_a_web_dist_only_the_api_is_served() {
        let server = Running::new();
        let (status, _, body) = server.request("GET", "/", None);
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"error":"not found"}"#);
    }

    #[test]
    fn a_bundle_without_a_page_is_refused() {
        let dir = temp_dir("nodist");
        let err = WebDist::open(dir.clone()).err().unwrap();
        assert!(err.contains("no index.html"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_user_record_reports_pack_states_and_the_vault_size() {
        let server = serving();
        install_by_hand(&server, "intelligence", &intelligence_fixture());
        let token = signed_in(server.port, "local@example.com");
        let (status, _, body) = get(
            &server,
            "/api/user",
            &[("Authorization", &format!("Bearer {token}"))],
        );
        assert_eq!(status, 200);
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            value["local"]["packs"],
            json!({ "office": "missing", "intelligence": "installed" })
        );
        assert!(value["local"]["vault"]["bytes"].as_u64().unwrap() > 0);
        assert_eq!(
            value["local"]["vault"]["directory"],
            json!(server.dir.display().to_string())
        );
        let plain = Running::new();
        let token = signed_in(plain.port, "plain@example.com");
        let (_, _, body) = get(
            &plain,
            "/api/user",
            &[("Authorization", &format!("Bearer {token}"))],
        );
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["local"]["packs"], json!({}));
    }
}
