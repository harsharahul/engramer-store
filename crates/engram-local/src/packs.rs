//! Optional feature packs: the office editor tree and the on-device
//! intelligence runtimes. The app bundles a manifest naming each pack's
//! archive and every file in it with sizes and digests; a pack is
//! downloaded on an explicit request, resumed if interrupted, verified
//! against the manifest and installed whole or not at all.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as PathParam, State};
use axum::http::{header, StatusCode};
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::blobs::{hex, sha256_file, storage_sentence};
use crate::error::ApiError;
use crate::extract::AuthUser;
use crate::server::AppState;

/// Where installed packs live under the data directory: `packs/<name>/`.
pub const PACKS_DIR: &str = "packs";
/// The manifest the web build writes next to the core bundle.
pub const MANIFEST_FILE: &str = "packs.json";
const DOWNLOAD_DIR: &str = ".download";

/// `packs.json`, schema 1: every pack's archive and files.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub packs: BTreeMap<String, PackSpec>,
    #[serde(skip)]
    owner_of: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackSpec {
    pub archive: String,
    #[serde(rename = "archiveBytes")]
    pub archive_bytes: u64,
    #[serde(rename = "archiveSha256")]
    pub archive_sha256: String,
    #[serde(rename = "installedBytes")]
    pub installed_bytes: u64,
    pub files: Vec<FileSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileSpec {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

impl Manifest {
    /// Reads and checks a manifest: schema 1, archive names that are plain
    /// file names, and file paths that stay inside the pack, so a manifest
    /// can never make the server read or write outside its directories.
    pub fn read(path: &Path) -> Result<Manifest, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
        Manifest::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Manifest, String> {
        let mut manifest: Manifest =
            serde_json::from_str(text).map_err(|err| format!("packs.json: {err}"))?;
        if manifest.schema != 1 {
            return Err(format!(
                "packs.json: unsupported schema {}",
                manifest.schema
            ));
        }
        let mut owner_of = HashMap::new();
        for (name, pack) in &manifest.packs {
            if !is_plain_name(name) || !is_plain_name(&pack.archive) {
                return Err(format!("packs.json: pack {name} has an unsafe name"));
            }
            for file in &pack.files {
                if clean_relative(Path::new(&file.path)).as_deref() != Some(file.path.as_str()) {
                    return Err(format!("packs.json: unsafe path {}", file.path));
                }
                if owner_of.insert(file.path.clone(), name.clone()).is_some() {
                    return Err(format!("packs.json: {} is listed twice", file.path));
                }
            }
        }
        manifest.owner_of = owner_of;
        Ok(manifest)
    }

    /// The pack a served path belongs to, if any.
    pub fn pack_of(&self, rel: &str) -> Option<&str> {
        self.owner_of.get(rel).map(String::as_str)
    }

    /// Where a pack's archive is downloaded from.
    pub fn archive_url(&self, pack: &PackSpec) -> String {
        format!("{}{}", self.base_url, pack.archive)
    }
}

fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// `path` as a clean relative path with `/` separators: only normal
/// components, no `.`, `..`, root or prefix, valid UTF-8. `None` otherwise.
pub fn clean_relative(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_str()?;
                if part.is_empty() || part.contains('\\') || part.contains('\0') {
                    return None;
                }
                parts.push(part);
            }
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackState {
    Installed,
    Missing,
    Downloading,
}

impl PackState {
    pub fn as_str(self) -> &'static str {
        match self {
            PackState::Installed => "installed",
            PackState::Missing => "missing",
            PackState::Downloading => "downloading",
        }
    }
}

#[derive(Debug, Default, Clone)]
struct Progress {
    downloading: bool,
    downloaded: u64,
    /// Why the last attempt did not install the pack, until the next one.
    error: Option<String>,
}

/// The packs directory and what is happening in it.
pub struct Packs {
    dir: PathBuf,
    manifest: Option<Manifest>,
    client: reqwest::Client,
    progress: Mutex<HashMap<String, Progress>>,
}

impl Packs {
    /// Opens `dir`, creating it and removing the leftovers of an
    /// installation a crash cut short (a partial archive is kept: the next
    /// request resumes it).
    pub fn open(dir: PathBuf, manifest: Option<Manifest>) -> Result<Packs, String> {
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".staging-") || name.starts_with(".removing-") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        let client = reqwest::Client::builder()
            .build()
            .map_err(|err| format!("cannot create the download client: {err}"))?;
        Ok(Packs {
            dir,
            manifest,
            client,
            progress: Mutex::new(HashMap::new()),
        })
    }

    pub fn manifest(&self) -> Option<&Manifest> {
        self.manifest.as_ref()
    }

    /// Where an installed pack's files live.
    pub fn install_dir(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn staging_dir(&self, name: &str) -> PathBuf {
        self.dir.join(format!(".staging-{name}"))
    }

    fn part_path(&self, pack: &PackSpec) -> PathBuf {
        self.dir
            .join(DOWNLOAD_DIR)
            .join(format!("{}.part", pack.archive))
    }

    pub fn installed(&self, name: &str) -> bool {
        self.install_dir(name).is_dir()
    }

    fn progress_of(&self, name: &str) -> Progress {
        self.progress
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .unwrap_or_default()
    }

    fn update<F: FnOnce(&mut Progress)>(&self, name: &str, f: F) {
        let mut all = self.progress.lock().unwrap();
        f(all.entry(name.to_string()).or_default());
    }

    pub fn state(&self, name: &str) -> PackState {
        if self.progress_of(name).downloading {
            PackState::Downloading
        } else if self.installed(name) {
            PackState::Installed
        } else {
            PackState::Missing
        }
    }

    /// `{ "<name>": "<state>" }` for every pack the manifest names.
    pub fn summary(&self) -> Value {
        let mut out = serde_json::Map::new();
        if let Some(manifest) = &self.manifest {
            for name in manifest.packs.keys() {
                out.insert(name.clone(), json!(self.state(name).as_str()));
            }
        }
        Value::Object(out)
    }

    /// Every pack with its state, sizes, progress and the last failure.
    pub fn status(&self) -> Value {
        let mut packs = serde_json::Map::new();
        if let Some(manifest) = &self.manifest {
            for (name, spec) in &manifest.packs {
                let progress = self.progress_of(name);
                packs.insert(
                    name.clone(),
                    json!({
                        "state": self.state(name).as_str(),
                        "archiveBytes": spec.archive_bytes,
                        "installedBytes": spec.installed_bytes,
                        "downloadedBytes": progress.downloaded,
                        "error": progress.error,
                    }),
                );
            }
        }
        json!({ "packs": packs })
    }

    fn spec(&self, name: &str) -> Result<(&Manifest, &PackSpec), ApiError> {
        self.manifest
            .as_ref()
            .and_then(|m| m.packs.get(name).map(|spec| (m, spec)))
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "unknown pack"))
    }

    /// Starts (or resumes) a pack's download unless it is installed or
    /// already downloading. Returns whether a download was started.
    pub fn start(state: &Arc<AppState>, name: &str) -> Result<bool, ApiError> {
        let packs = &state.packs;
        packs.spec(name)?;
        if packs.state(name) != PackState::Missing {
            return Ok(false);
        }
        packs.update(name, |p| {
            p.downloading = true;
            p.downloaded = 0;
            p.error = None;
        });
        let state = Arc::clone(state);
        let name = name.to_string();
        tokio::spawn(async move {
            let outcome = state.packs.install(&name).await;
            state.packs.update(&name, |p| {
                p.downloading = false;
                if let Err(message) = &outcome {
                    eprintln!("engram-local: pack {name}: {message}");
                    p.error = Some(message.clone());
                }
            });
        });
        Ok(true)
    }

    async fn install(&self, name: &str) -> Result<(), String> {
        let (manifest, spec) = self.spec(name).map_err(|err| err.message)?;
        let part = self.part_path(spec);
        self.download(name, &manifest.archive_url(spec), &part, spec.archive_bytes)
            .await?;
        let digest_path = part.clone();
        let digest = tokio::task::spawn_blocking(move || sha256_file(&digest_path))
            .await
            .map_err(|_| "the download could not be checked".to_string())?
            .map_err(|err| io_sentence(&err))?;
        if digest != spec.archive_sha256 {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("the download did not match its checksum; it was discarded".to_string());
        }
        let staging = self.staging_dir(name);
        let install = self.install_dir(name);
        let spec = spec.clone();
        let archive = part.clone();
        let extracted = tokio::task::spawn_blocking(move || {
            let result = extract(&archive, &spec, &staging);
            if result.is_err() {
                let _ = std::fs::remove_dir_all(&staging);
                return result;
            }
            match std::fs::rename(&staging, &install) {
                Ok(()) => Ok(()),
                // Installed by someone else meanwhile: ours is a duplicate.
                Err(_) if install.is_dir() => {
                    let _ = std::fs::remove_dir_all(&staging);
                    Ok(())
                }
                Err(err) => {
                    let _ = std::fs::remove_dir_all(&staging);
                    Err(io_sentence(&err))
                }
            }
        })
        .await
        .map_err(|_| "the pack could not be installed".to_string())?;
        // A verified archive that would not extract is bad for good; one
        // that installed is spent.
        let _ = tokio::fs::remove_file(&part).await;
        extracted
    }

    /// Downloads `url` into `part`, resuming from what an earlier attempt
    /// left, until the file holds `expected` bytes.
    async fn download(
        &self,
        name: &str,
        url: &str,
        part: &Path,
        expected: u64,
    ) -> Result<(), String> {
        if let Some(parent) = part.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| io_sentence(&err))?;
        }
        let mut have = tokio::fs::metadata(part)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if have > expected {
            let _ = tokio::fs::remove_file(part).await;
            have = 0;
        }
        self.update(name, |p| p.downloaded = have);
        if have == expected {
            return Ok(());
        }
        let mut request = self.client.get(url);
        if have > 0 {
            request = request.header(header::RANGE, format!("bytes={have}-"));
        }
        let response = request
            .send()
            .await
            .map_err(|_| "could not reach the download host".to_string())?;
        let status = response.status().as_u16();
        let (mut file, mut written) = match status {
            206 if have > 0 => (
                tokio::fs::OpenOptions::new()
                    .append(true)
                    .open(part)
                    .await
                    .map_err(|err| io_sentence(&err))?,
                have,
            ),
            200 => (
                tokio::fs::File::create(part)
                    .await
                    .map_err(|err| io_sentence(&err))?,
                0,
            ),
            416 if have > 0 => {
                let _ = tokio::fs::remove_file(part).await;
                return Err("the download host did not accept the resume; try again".to_string());
            }
            _ => return Err(format!("the download failed (HTTP {status})")),
        };
        self.update(name, |p| p.downloaded = written);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "the download was interrupted; try again".to_string())?;
            if written + chunk.len() as u64 > expected {
                drop(file);
                let _ = tokio::fs::remove_file(part).await;
                return Err(
                    "the download host sent more than the manifest lists; it was discarded"
                        .to_string(),
                );
            }
            file.write_all(&chunk)
                .await
                .map_err(|err| io_sentence(&err))?;
            written += chunk.len() as u64;
            self.update(name, |p| p.downloaded = written);
        }
        file.flush().await.map_err(|err| io_sentence(&err))?;
        if written != expected {
            return Err("the download ended early; try again".to_string());
        }
        Ok(())
    }

    /// Removes an installed pack; refused while it is downloading.
    pub fn remove(&self, name: &str) -> Result<(), ApiError> {
        self.spec(name)?;
        if self.state(name) == PackState::Downloading {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "the pack is still downloading",
            ));
        }
        let install = self.install_dir(name);
        if install.is_dir() {
            let removing = self.dir.join(format!(".removing-{name}"));
            std::fs::rename(&install, &removing).map_err(|err| {
                eprintln!("engram-local: cannot remove pack {name}: {err}");
                ApiError::internal()
            })?;
            let _ = std::fs::remove_dir_all(&removing);
        }
        self.update(name, |p| {
            p.downloaded = 0;
            p.error = None;
        });
        Ok(())
    }
}

/// Unpacks a verified archive into `staging`, confined to it: only regular
/// files, only clean relative paths, only files the manifest lists, each
/// with its listed size and digest, and every listed file present.
fn extract(archive: &Path, spec: &PackSpec, staging: &Path) -> Result<(), String> {
    let expected: HashMap<&str, &FileSpec> =
        spec.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let _ = std::fs::remove_dir_all(staging);
    std::fs::create_dir_all(staging).map_err(|err| io_sentence(&err))?;
    let file = std::fs::File::open(archive).map_err(|err| io_sentence(&err))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(io::BufReader::new(file)));
    let entries = tar
        .entries()
        .map_err(|_| "the pack archive could not be read; it was discarded".to_string())?;
    let mut seen: HashSet<String> = HashSet::new();
    for entry in entries {
        let mut entry = entry
            .map_err(|_| "the pack archive could not be read; it was discarded".to_string())?;
        if entry.header().entry_type() != tar::EntryType::Regular {
            return Err(
                "the pack archive holds an entry that is not a regular file; it was discarded"
                    .to_string(),
            );
        }
        let path = entry
            .path()
            .map_err(|_| {
                "the pack archive holds an entry with an unsafe path; it was discarded".to_string()
            })?
            .into_owned();
        let rel = clean_relative(&path).ok_or_else(|| {
            "the pack archive holds an entry with an unsafe path; it was discarded".to_string()
        })?;
        let want = expected.get(rel.as_str()).ok_or_else(|| {
            "the pack archive holds a file the manifest does not list; it was discarded".to_string()
        })?;
        if !seen.insert(rel.clone()) {
            return Err("the pack archive holds a file twice; it was discarded".to_string());
        }
        let destination = staging.join(&rel);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|err| io_sentence(&err))?;
        }
        let mut out = std::fs::File::create(&destination).map_err(|err| io_sentence(&err))?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buf)
                .map_err(|_| "the pack archive could not be read; it was discarded".to_string())?;
            if read == 0 {
                break;
            }
            written += read as u64;
            if written > want.bytes {
                return Err(
                    "a file in the pack archive did not match the manifest; it was discarded"
                        .to_string(),
                );
            }
            hasher.update(&buf[..read]);
            out.write_all(&buf[..read])
                .map_err(|err| io_sentence(&err))?;
        }
        if written != want.bytes || hex(&hasher.finalize()) != want.sha256 {
            return Err(
                "a file in the pack archive did not match the manifest; it was discarded"
                    .to_string(),
            );
        }
    }
    if seen.len() != expected.len() {
        return Err(
            "the pack archive is missing files the manifest lists; it was discarded".to_string(),
        );
    }
    Ok(())
}

fn io_sentence(err: &io::Error) -> String {
    storage_sentence(err)
        .map(str::to_string)
        .unwrap_or_else(|| format!("the pack could not be written ({})", err.kind()))
}

/// `GET /api/local/packs`: every pack's state, sizes and progress.
pub async fn list(State(state): State<Arc<AppState>>, _auth: AuthUser) -> Json<Value> {
    Json(state.packs.status())
}

/// `POST /api/local/packs/{name}`: starts or resumes the download. 202
/// when a download started, 200 when the pack is installed or already
/// downloading; the body is the status either way.
pub async fn start_download(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    PathParam(name): PathParam<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let started = Packs::start(&state, &name)?;
    let status = if started {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(state.packs.status())))
}

/// `DELETE /api/local/packs/{name}`: removes an installed pack.
pub async fn remove_pack(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    PathParam(name): PathParam<String>,
) -> Result<Json<Value>, ApiError> {
    let packs = Arc::clone(&state);
    tokio::task::spawn_blocking(move || packs.packs.remove(&name))
        .await
        .map_err(|_| ApiError::internal())??;
    Ok(Json(state.packs.status()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::tests::{raw_with, signed_in, Running};
    use crate::web::tests::{
        archive, core_bundle, intelligence_fixture, office_fixture, sha, PackFixture,
    };
    use axum::body::{Body, Bytes};
    use axum::extract::State as HostState;
    use axum::http::HeaderMap;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::Router;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    /// A release host for one archive, with the faults a real download
    /// meets: a connection cut after some bytes, a slow link, and a record
    /// of every Range header it was asked for.
    struct Host {
        bytes: Mutex<Vec<u8>>,
        cut_after: Mutex<Option<usize>>,
        slow: AtomicBool,
        ranges: Mutex<Vec<String>>,
    }

    async fn serve_archive(HostState(host): HostState<Arc<Host>>, headers: HeaderMap) -> Response {
        let bytes = host.bytes.lock().unwrap().clone();
        let range = headers
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Some(range) = &range {
            host.ranges.lock().unwrap().push(range.clone());
        }
        let start = range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.strip_suffix('-'))
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
        if start >= bytes.len() {
            return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        }
        let cut = *host.cut_after.lock().unwrap();
        let slow = host.slow.load(Ordering::Relaxed);
        let total = bytes.len();
        let slice = bytes[start..].to_vec();
        let mut chunks: Vec<Result<Bytes, io::Error>> = Vec::new();
        let mut sent = 0usize;
        for chunk in slice.chunks(256) {
            if let Some(cut) = cut {
                if sent + chunk.len() > cut {
                    chunks.push(Err(io::Error::other("cut")));
                    break;
                }
            }
            sent += chunk.len();
            chunks.push(Ok(Bytes::copy_from_slice(chunk)));
        }
        let body = Body::from_stream(futures_util::stream::iter(chunks).then(
            move |chunk| async move {
                if slow {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                chunk
            },
        ));
        let mut response = Response::new(body);
        if range.is_some() {
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes {start}-{}/{total}", total - 1)
                    .parse()
                    .unwrap(),
            );
        }
        response
    }

    /// Serves `bytes` as any archive name; returns the host, its base URL
    /// and the runtime that keeps it alive.
    fn release_host(bytes: Vec<u8>) -> (Arc<Host>, String, tokio::runtime::Runtime) {
        let host = Arc::new(Host {
            bytes: Mutex::new(bytes),
            cut_after: Mutex::new(None),
            slow: AtomicBool::new(false),
            ranges: Mutex::new(Vec::new()),
        });
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let app = Router::new()
            .route("/{name}", get(serve_archive))
            .with_state(Arc::clone(&host));
        rt.spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let _ = axum::serve(listener, app).await;
        });
        (host, format!("http://127.0.0.1:{port}/"), rt)
    }

    struct Rig {
        server: Running,
        host: Arc<Host>,
        token: String,
        _host_rt: tokio::runtime::Runtime,
    }

    /// A serving vault whose office pack is hosted as `office` describes it.
    fn rig(office: &PackFixture) -> Rig {
        let (host, base_url, host_rt) = release_host(office.archive.clone());
        let dist = core_bundle(&base_url, office, &intelligence_fixture());
        let server = Running::with(move |config| config.web_dist = Some(dist));
        let token = signed_in(server.port, "packs@example.com");
        Rig {
            server,
            host,
            token,
            _host_rt: host_rt,
        }
    }

    impl Rig {
        fn call(&self, method: &str, path: &str) -> (u16, Value) {
            let (status, _, body) = raw_with(
                self.server.port,
                method,
                path,
                &format!("127.0.0.1:{}", self.server.port),
                None,
                &[("Authorization", &format!("Bearer {}", self.token))],
            );
            let value = serde_json::from_str(&body).unwrap_or(Value::Null);
            (status, value)
        }

        fn office(&self) -> Value {
            self.call("GET", "/api/local/packs").1["packs"]["office"].clone()
        }

        /// Waits until the office pack is no longer downloading.
        fn settled(&self) -> Value {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let office = self.office();
                if office["state"] != "downloading" {
                    return office;
                }
                assert!(
                    Instant::now() < deadline,
                    "the download never settled: {office}"
                );
                std::thread::sleep(Duration::from_millis(25));
            }
        }

        fn install_dir(&self) -> PathBuf {
            self.server.dir.join(PACKS_DIR).join("office")
        }

        fn part_file(&self) -> PathBuf {
            self.server
                .dir
                .join(PACKS_DIR)
                .join(DOWNLOAD_DIR)
                .join("engram-pack-office-0.0.1.tar.gz.part")
        }

        fn page(&self, path: &str) -> (u16, String) {
            let (status, head, _) = raw_with(
                self.server.port,
                "GET",
                path,
                &format!("127.0.0.1:{}", self.server.port),
                None,
                &[],
            );
            (status, head)
        }
    }

    #[test]
    fn manifests_are_checked_before_they_are_trusted() {
        let good = r#"{"schema":1,"version":"1","baseUrl":"http://h/","packs":{"office":{"archive":"a.tar.gz","archiveBytes":1,"archiveSha256":"x","installedBytes":1,"files":[{"path":"office/a.js","bytes":1,"sha256":"y"}]}}}"#;
        let manifest = Manifest::parse(good).unwrap();
        assert_eq!(manifest.pack_of("office/a.js"), Some("office"));
        assert_eq!(manifest.pack_of("office/b.js"), None);
        assert_eq!(
            manifest.archive_url(&manifest.packs["office"]),
            "http://h/a.tar.gz"
        );
        for (bad, why) in [
            (
                good.replace("\"schema\":1", "\"schema\":2"),
                "unsupported schema",
            ),
            (good.replace("office/a.js", "../a.js"), "unsafe path"),
            (good.replace("office/a.js", "/etc/passwd"), "unsafe path"),
            (good.replace("a.tar.gz", "../a.tar.gz"), "unsafe name"),
            (good.replace("\"office\":{", "\"../x\":{"), "unsafe name"),
        ] {
            let err = Manifest::parse(&bad).err().unwrap();
            assert!(err.contains(why), "{err}");
        }
        let twice = good.replace(
            "[{\"path\":\"office/a.js\",\"bytes\":1,\"sha256\":\"y\"}]",
            "[{\"path\":\"office/a.js\",\"bytes\":1,\"sha256\":\"y\"},{\"path\":\"office/a.js\",\"bytes\":1,\"sha256\":\"y\"}]",
        );
        assert!(Manifest::parse(&twice)
            .err()
            .unwrap()
            .contains("listed twice"));
    }

    #[test]
    fn a_pack_downloads_verifies_and_installs() {
        let office = office_fixture();
        let rig = rig(&office);
        assert_eq!(rig.office()["state"], "missing");
        assert_eq!(rig.office()["archiveBytes"], json!(office.archive.len()));
        assert_eq!(rig.page("/office/a.js").0, 404);
        let (status, value) = rig.call("POST", "/api/local/packs/office");
        assert_eq!(status, 202);
        assert_eq!(value["packs"]["office"]["state"], "downloading");
        let settled = rig.settled();
        assert_eq!(settled["state"], "installed", "{settled}");
        assert_eq!(settled["error"], Value::Null);
        assert_eq!(settled["downloadedBytes"], json!(office.archive.len()));
        for (path, bytes) in &office.files {
            assert_eq!(
                std::fs::read(rig.install_dir().join(path)).unwrap(),
                *bytes,
                "{path}"
            );
        }
        assert!(
            !rig.part_file().exists(),
            "the archive was kept after installing"
        );
        assert_eq!(rig.page("/office/a.js").0, 200);
        let (status, value) = rig.call("POST", "/api/local/packs/office");
        assert_eq!(status, 200, "an installed pack is not downloaded again");
        assert_eq!(value["packs"]["office"]["state"], "installed");
        let (_, user) = rig.call("GET", "/api/user");
        assert_eq!(user["local"]["packs"]["office"], "installed");
    }

    #[test]
    fn a_tampered_archive_is_discarded() {
        let office = office_fixture();
        let rig = rig(&office);
        rig.host.bytes.lock().unwrap()[10] ^= 0xff;
        rig.call("POST", "/api/local/packs/office");
        let settled = rig.settled();
        assert_eq!(settled["state"], "missing");
        assert_eq!(
            settled["error"],
            "the download did not match its checksum; it was discarded"
        );
        assert!(!rig.part_file().exists());
        assert!(!rig.install_dir().exists());
    }

    #[test]
    fn an_archive_with_a_file_the_manifest_does_not_list_is_rejected() {
        let mut office = office_fixture();
        office.archive = archive(&[
            ("office/a.js", b"console.log('office')"),
            ("office/a.js.br", b"br-bytes"),
            ("office/web-apps/x/index.html", b"<title>editor</title>"),
            ("office/extra.js", b"surprise"),
        ]);
        let rig = rig(&office);
        rig.call("POST", "/api/local/packs/office");
        let settled = rig.settled();
        assert_eq!(settled["state"], "missing");
        assert_eq!(
            settled["error"],
            "the pack archive holds a file the manifest does not list; it was discarded"
        );
        assert!(!rig.install_dir().exists());
        assert!(!rig
            .server
            .dir
            .join(PACKS_DIR)
            .join(".staging-office")
            .exists());
    }

    #[test]
    fn an_archive_missing_a_listed_file_is_rejected() {
        let mut office = office_fixture();
        office.archive = archive(&[("office/a.js", b"console.log('office')")]);
        let rig = rig(&office);
        rig.call("POST", "/api/local/packs/office");
        let settled = rig.settled();
        assert_eq!(
            settled["error"],
            "the pack archive is missing files the manifest lists; it was discarded"
        );
    }

    #[test]
    fn a_file_whose_bytes_differ_from_the_manifest_is_rejected() {
        let mut office = office_fixture();
        office.archive = archive(&[
            ("office/a.js", b"console.log('OFFICE')"),
            ("office/a.js.br", b"br-bytes"),
            ("office/web-apps/x/index.html", b"<title>editor</title>"),
        ]);
        let rig = rig(&office);
        rig.call("POST", "/api/local/packs/office");
        assert_eq!(
            rig.settled()["error"],
            "a file in the pack archive did not match the manifest; it was discarded"
        );
    }

    /// A raw ustar header, so the archive can carry what the tar builder
    /// refuses to write.
    fn raw_entry(
        tar: &mut tar::Builder<impl Write>,
        name: &[u8],
        kind: tar::EntryType,
        link: &[u8],
        data: &[u8],
    ) {
        let mut header = tar::Header::new_ustar();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(kind);
        let bytes = header.as_mut_bytes();
        bytes[..name.len()].copy_from_slice(name);
        bytes[157..157 + link.len()].copy_from_slice(link);
        header.set_cksum();
        tar.append(&header, data).unwrap();
    }

    fn crafted(
        entry: impl FnOnce(&mut tar::Builder<flate2::write::GzEncoder<Vec<u8>>>),
    ) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(encoder);
        entry(&mut tar);
        tar.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn an_entry_that_would_leave_the_pack_is_rejected() {
        let mut office = office_fixture();
        office.archive =
            crafted(|tar| raw_entry(tar, b"../escape.js", tar::EntryType::Regular, b"", b"x"));
        let rig = rig(&office);
        rig.call("POST", "/api/local/packs/office");
        assert_eq!(
            rig.settled()["error"],
            "the pack archive holds an entry with an unsafe path; it was discarded"
        );
        assert!(!rig.server.dir.join(PACKS_DIR).join("escape.js").exists());
        assert!(!rig.server.dir.join("escape.js").exists());
    }

    #[test]
    fn a_link_entry_is_rejected() {
        let mut office = office_fixture();
        office.archive = crafted(|tar| {
            raw_entry(
                tar,
                b"office/a.js",
                tar::EntryType::Symlink,
                b"/etc/passwd",
                b"",
            )
        });
        let rig = rig(&office);
        rig.call("POST", "/api/local/packs/office");
        assert_eq!(
            rig.settled()["error"],
            "the pack archive holds an entry that is not a regular file; it was discarded"
        );
    }

    #[test]
    fn an_interrupted_download_resumes_where_it_stopped() {
        let big = engram_core::backend::random_bytes(20_000);
        let office = PackFixture::of(&[("office/big.bin", &big[..])]);
        let rig = rig(&office);
        let total = office.archive.len();
        assert!(total > 10_000, "random bytes do not compress: {total}");
        *rig.host.cut_after.lock().unwrap() = Some(total / 2);
        rig.call("POST", "/api/local/packs/office");
        let settled = rig.settled();
        assert_eq!(settled["state"], "missing");
        assert_eq!(settled["error"], "the download was interrupted; try again");
        let kept = std::fs::metadata(rig.part_file()).unwrap().len() as usize;
        assert!(kept > 0 && kept < total, "kept {kept} of {total}");
        assert_eq!(settled["downloadedBytes"], json!(kept));
        *rig.host.cut_after.lock().unwrap() = None;
        rig.call("POST", "/api/local/packs/office");
        let settled = rig.settled();
        assert_eq!(settled["state"], "installed", "{settled}");
        assert_eq!(
            rig.host.ranges.lock().unwrap().as_slice(),
            [format!("bytes={kept}-")]
        );
        assert_eq!(
            std::fs::read(rig.install_dir().join("office/big.bin")).unwrap(),
            big
        );
    }

    #[test]
    fn an_unreachable_host_is_a_sentence_not_a_crash() {
        let office = office_fixture();
        let (_, _, host_rt) = release_host(Vec::new());
        drop(host_rt);
        let dist = core_bundle("http://127.0.0.1:9/", &office, &intelligence_fixture());
        let server = Running::with(move |config| config.web_dist = Some(dist));
        let token = signed_in(server.port, "unreachable@example.com");
        let rig = Rig {
            server,
            host: Arc::new(Host {
                bytes: Mutex::new(Vec::new()),
                cut_after: Mutex::new(None),
                slow: AtomicBool::new(false),
                ranges: Mutex::new(Vec::new()),
            }),
            token,
            _host_rt: tokio::runtime::Runtime::new().unwrap(),
        };
        rig.call("POST", "/api/local/packs/office");
        assert_eq!(rig.settled()["error"], "could not reach the download host");
    }

    #[test]
    fn a_host_that_answers_an_error_is_reported() {
        let office = office_fixture();
        let rig = rig(&office);
        rig.host.bytes.lock().unwrap().clear();
        rig.call("POST", "/api/local/packs/office");
        assert_eq!(rig.settled()["error"], "the download failed (HTTP 416)");
    }

    #[test]
    fn removing_a_pack_puts_it_back_to_missing() {
        let office = office_fixture();
        let rig = rig(&office);
        rig.call("POST", "/api/local/packs/office");
        assert_eq!(rig.settled()["state"], "installed");
        let (status, value) = rig.call("DELETE", "/api/local/packs/office");
        assert_eq!(status, 200);
        assert_eq!(value["packs"]["office"]["state"], "missing");
        assert!(!rig.install_dir().exists());
        assert_eq!(rig.page("/office/a.js").0, 404);
        let (status, _) = rig.call("DELETE", "/api/local/packs/office");
        assert_eq!(status, 200, "removing a missing pack is not an error");
    }

    #[test]
    fn a_downloading_pack_cannot_be_removed() {
        let big = engram_core::backend::random_bytes(30_000);
        let office = PackFixture::of(&[("office/big.bin", &big[..])]);
        let rig = rig(&office);
        rig.host.slow.store(true, Ordering::Relaxed);
        let (status, _) = rig.call("POST", "/api/local/packs/office");
        assert_eq!(status, 202);
        let (status, value) = rig.call("DELETE", "/api/local/packs/office");
        assert_eq!(status, 409);
        assert_eq!(value["error"], "the pack is still downloading");
        let progress = rig.office();
        assert_eq!(progress["state"], "downloading");
        assert_eq!(rig.settled()["state"], "installed");
    }

    #[test]
    fn unknown_packs_and_anonymous_calls_are_refused() {
        let rig = rig(&office_fixture());
        let (status, value) = rig.call("POST", "/api/local/packs/fonts");
        assert_eq!(status, 404);
        assert_eq!(value["error"], "unknown pack");
        let (status, _) = rig.call("DELETE", "/api/local/packs/fonts");
        assert_eq!(status, 404);
        let (status, _, body) = raw_with(
            rig.server.port,
            "GET",
            "/api/local/packs",
            &format!("127.0.0.1:{}", rig.server.port),
            None,
            &[],
        );
        assert_eq!(status, 401);
        assert_eq!(body, r#"{"error":"authentication required"}"#);
    }

    #[test]
    fn leftover_staging_folders_are_removed_at_open() {
        let dir = crate::server::tests::temp_dir("packs");
        std::fs::create_dir_all(dir.join(".staging-office").join("office")).unwrap();
        std::fs::create_dir_all(dir.join(".removing-office")).unwrap();
        std::fs::create_dir_all(dir.join(DOWNLOAD_DIR)).unwrap();
        std::fs::write(dir.join(DOWNLOAD_DIR).join("a.part"), "half").unwrap();
        std::fs::create_dir_all(dir.join("intelligence")).unwrap();
        let packs = Packs::open(dir.clone(), None).unwrap();
        assert!(!dir.join(".staging-office").exists());
        assert!(!dir.join(".removing-office").exists());
        assert!(
            dir.join(DOWNLOAD_DIR).join("a.part").exists(),
            "a partial download is kept for resuming"
        );
        assert!(packs.installed("intelligence"));
        assert_eq!(packs.summary(), json!({}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_archive_digest_is_the_manifests() {
        let office = office_fixture();
        assert_eq!(sha(&office.archive).len(), 64);
    }
}
