//! Connect a server: copies the vault on this device to a server through
//! the server's public API, checks the copy, and reports every step so the
//! client can follow it in Activity and offer the switch once the copy is
//! verified.
//!
//! The job runs here rather than in the web client because the client's
//! page is served from a loopback origin a server does not list among its
//! allowed origins; this backend speaks to the server directly, as the
//! shell's own probes do. Everything travels as it is stored: ciphertext,
//! wrapped keys and sealed metadata. The passphrase never leaves the
//! client; the login key it derives is what the server would receive from
//! the client's own sign-in.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::Json;
use reqwest::Method;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

use crate::blobs::{blob_key, BlobKind};
use crate::content::VERIFY_MAX;
use crate::error::ApiError;
use crate::extract::{blocking, AuthUser, JsonBody};
use crate::server::AppState;

/// The copy's bookkeeping between runs, so a stopped copy resumes where it
/// was instead of creating a second of everything.
pub const PLAN_FILE: &str = "connect.json";

/// Content above this goes up in parts, as the web client sends it; one
/// request per part keeps every request short.
const PART_THRESHOLD: u64 = 12 * 1024 * 1024;
const PART_BYTES: u64 = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// Where the copy stands; the client turns each into a sentence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    Reaching,
    Account,
    Folders,
    Files,
    Settings,
    Verifying,
    Done,
    Failed,
}

/// What the server holds once the copy is checked.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub folders: u64,
    pub files: u64,
    pub bytes: u64,
    /// Files the server read back and found intact.
    pub checked: u64,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub running: bool,
    pub server: Option<String>,
    pub host: Option<String>,
    pub email: Option<String>,
    pub step: Option<Step>,
    pub folders_done: u64,
    pub folders_total: u64,
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub verified: Option<Verified>,
    pub error: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct FilePlan {
    /// The server's id for the file.
    id: String,
    #[serde(default)]
    data: bool,
    #[serde(default)]
    thumb: bool,
    #[serde(default)]
    index: bool,
    #[serde(default)]
    trashed: bool,
}

/// The ids the server gave to what was copied so far, keyed by the ids on
/// this device; written after every step that created something there.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Plan {
    server: String,
    email: String,
    #[serde(default)]
    folders: HashMap<String, String>,
    #[serde(default)]
    files: HashMap<String, FilePlan>,
    #[serde(default)]
    settings: bool,
}

impl Plan {
    fn is_empty(&self) -> bool {
        self.folders.is_empty() && self.files.is_empty() && !self.settings
    }
}

pub struct Connect {
    plan_path: PathBuf,
    progress: Mutex<Progress>,
    cancel: AtomicBool,
    client: reqwest::Client,
}

impl Connect {
    pub fn open(data_dir: &Path) -> Result<Connect, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|err| format!("cannot build the HTTP client: {err}"))?;
        Ok(Connect {
            plan_path: data_dir.join(PLAN_FILE),
            progress: Mutex::new(Progress::default()),
            cancel: AtomicBool::new(false),
            client,
        })
    }

    pub fn status(&self) -> Value {
        json!(self.progress.lock().unwrap().clone())
    }

    fn update(&self, change: impl FnOnce(&mut Progress)) {
        let mut progress = self.progress.lock().unwrap();
        change(&mut progress);
    }

    /// Claims the one job slot; `false` when a copy is already running.
    fn try_begin(&self, origin: &str, email: &str) -> bool {
        let mut progress = self.progress.lock().unwrap();
        if progress.running {
            return false;
        }
        *progress = Progress {
            running: true,
            server: Some(origin.to_string()),
            host: Some(host_of(origin)),
            email: Some(email.to_string()),
            step: Some(Step::Reaching),
            ..Progress::default()
        };
        self.cancel.store(false, Ordering::SeqCst);
        true
    }

    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("stopped".to_string())
        } else {
            Ok(())
        }
    }

    /// The bookkeeping of an earlier run against the same server and
    /// address; anything else starts fresh.
    fn load_plan(&self, origin: &str, email: &str) -> Plan {
        let stored = std::fs::read(&self.plan_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Plan>(&bytes).ok());
        match stored {
            Some(plan) if plan.server == origin && plan.email == email => plan,
            _ => Plan {
                server: origin.to_string(),
                email: email.to_string(),
                ..Plan::default()
            },
        }
    }

    fn save_plan(&self, plan: &Plan) -> Result<(), String> {
        let bytes = serde_json::to_vec(plan).map_err(|err| err.to_string())?;
        let part = self.plan_path.with_extension("json.part");
        std::fs::write(&part, bytes)
            .and_then(|()| std::fs::rename(&part, &self.plan_path))
            .map_err(|err| format!("cannot keep the copy's bookkeeping: {err}"))
    }

    pub fn forget_plan(&self) {
        let _ = std::fs::remove_file(&self.plan_path);
    }
}

/// The server as the person typed it, as an origin: a bare host gets
/// https, a port is kept, and nothing else may ride on it.
pub fn server_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("type the server's address".to_string());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let wrong = || format!("{trimmed} is not a server address");
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| wrong())?;
    let plain_path = url.path().is_empty() || url.path() == "/";
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !plain_path
    {
        return Err(wrong());
    }
    Ok(url.origin().ascii_serialization())
}

/// `https://vault.example.com:8443` as `vault.example.com:8443`.
pub fn host_of(origin: &str) -> String {
    origin.split("://").nth(1).unwrap_or(origin).to_string()
}

fn transport_sentence(host: &str, err: &reqwest::Error) -> String {
    if err.is_timeout() {
        format!("{host} did not answer in time")
    } else if err.is_connect() {
        format!("could not reach {host}")
    } else {
        format!("the connection to {host} failed")
    }
}

/// The server's own sentence, framed; the status when it gave none.
fn refusal(host: &str, status: StatusCode, body: &Value, what: &str) -> String {
    let said = body.get("error").and_then(Value::as_str).unwrap_or("");
    if said.is_empty() {
        format!("{host} could not {what} (HTTP {})", status.as_u16())
    } else {
        format!("{host} could not {what}: {said}")
    }
}

struct Remote<'a> {
    client: &'a reqwest::Client,
    origin: String,
    host: String,
    token: Option<String>,
}

impl Remote<'_> {
    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.origin, path));
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        request
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<(StatusCode, Value), String> {
        let response = request
            .send()
            .await
            .map_err(|err| transport_sentence(&self.host, &err))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| transport_sentence(&self.host, &err))?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(StatusCode, Value), String> {
        let mut request = self.request(method, path);
        if let Some(body) = body {
            let bytes = serde_json::to_vec(&body).map_err(|err| err.to_string())?;
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(bytes);
        }
        self.send(request).await
    }

    /// A call that must succeed; anything else becomes a sentence.
    async fn expect(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        what: &str,
    ) -> Result<Value, String> {
        let (status, answer) = self.json(method, path, body).await?;
        if status.is_success() {
            Ok(answer)
        } else {
            Err(refusal(&self.host, status, &answer, what))
        }
    }

    /// Streams a blob from disk with its length declared, so the server
    /// can check the quota first and the bytes land as one request.
    async fn put_blob(&self, path: &str, file: &Path, size: u64, what: &str) -> Result<(), String> {
        let handle = tokio::fs::File::open(file)
            .await
            .map_err(|err| format!("cannot read {what} on this device: {err}"))?;
        let request = self
            .request(Method::PUT, path)
            .header(header::CONTENT_LENGTH, size)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(reqwest::Body::wrap_stream(ReaderStream::new(handle)));
        let (status, answer) = self.send(request).await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(refusal(
                &self.host,
                status,
                &answer,
                &format!("store {what}"),
            ))
        }
    }

    /// Large content in numbered parts, finished with one call, as the
    /// web client uploads media.
    async fn put_parts(&self, file_id: &str, file: &Path, size: u64) -> Result<(), String> {
        let begun = self
            .expect(
                Method::POST,
                &format!("/api/files/{file_id}/data/parts"),
                Some(json!({ "size": size })),
                "begin a large upload",
            )
            .await?;
        let session = begun
            .get("session")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{} answered a large upload without a session", self.host))?
            .to_string();
        let mut handle = tokio::fs::File::open(file)
            .await
            .map_err(|err| format!("cannot read a file on this device: {err}"))?;
        let mut sent = 0u64;
        let mut number = 1u64;
        while sent < size {
            let want = (size - sent).min(PART_BYTES) as usize;
            let mut chunk = vec![0u8; want];
            handle
                .read_exact(&mut chunk)
                .await
                .map_err(|err| format!("cannot read a file on this device: {err}"))?;
            let request = self
                .request(
                    Method::PUT,
                    &format!("/api/files/{file_id}/data/parts/{session}/{number}"),
                )
                .header(header::CONTENT_LENGTH, want)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(chunk);
            let (status, answer) = self.send(request).await?;
            if !status.is_success() {
                let _ = self
                    .json(
                        Method::DELETE,
                        &format!("/api/files/{file_id}/data/parts/{session}"),
                        None,
                    )
                    .await;
                return Err(refusal(
                    &self.host,
                    status,
                    &answer,
                    "store a part of a file",
                ));
            }
            sent += want as u64;
            number += 1;
        }
        self.expect(
            Method::POST,
            &format!("/api/files/{file_id}/data/parts/{session}/complete"),
            None,
            "finish a large upload",
        )
        .await?;
        Ok(())
    }

    /// Everything the account holds: live folders and uploaded files,
    /// paged the way every client reads the change feed.
    async fn library(&self) -> Result<Library, String> {
        let mut folders: HashMap<String, Value> = HashMap::new();
        let mut files: HashMap<String, Value> = HashMap::new();
        let mut cursor = 0i64;
        loop {
            let page = self
                .expect(
                    Method::GET,
                    &format!("/api/sync?since={cursor}"),
                    None,
                    "list the account",
                )
                .await?;
            let mut rows = 0usize;
            for row in page["folders"].as_array().into_iter().flatten() {
                if let Some(id) = row["id"].as_str() {
                    folders.insert(id.to_string(), row.clone());
                    rows += 1;
                }
            }
            for row in page["files"].as_array().into_iter().flatten() {
                if let Some(id) = row["id"].as_str() {
                    files.insert(id.to_string(), row.clone());
                    rows += 1;
                }
            }
            let seq = page["seq"].as_i64().unwrap_or(0);
            if rows == 0 || seq <= cursor {
                break;
            }
            cursor = seq;
        }
        let live_folders = folders
            .values()
            .filter(|row| row["deleted"].as_bool() != Some(true))
            .count() as u64;
        let live_files: Vec<&Value> = files
            .values()
            .filter(|row| {
                row["deleted"].as_bool() != Some(true) && row["uploaded"].as_bool() == Some(true)
            })
            .collect();
        let bytes = live_files
            .iter()
            .map(|row| {
                row["size"].as_u64().unwrap_or(0)
                    + row["thumbSize"].as_u64().unwrap_or(0)
                    + row["indexSize"].as_u64().unwrap_or(0)
            })
            .sum();
        Ok(Library {
            folders: live_folders,
            files: live_files.len() as u64,
            bytes,
        })
    }
}

struct Library {
    folders: u64,
    files: u64,
    bytes: u64,
}

struct LocalFolder {
    id: String,
    parent: Option<String>,
    key: Value,
    meta: Value,
}

struct LocalFile {
    id: String,
    folder: Option<String>,
    key: Value,
    meta: Value,
    size: i64,
    thumb: i64,
    index: i64,
    trashed: bool,
    generation: i64,
    seekable: bool,
}

struct Account {
    attributes: Value,
    settings: Option<String>,
    display_name: Option<String>,
}

fn parse_json(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

/// Parents before children: a breadth-first walk from the roots, so every
/// folder's parent has its server id by the time the folder is created.
fn in_creation_order(folders: Vec<LocalFolder>) -> Vec<LocalFolder> {
    let ids: HashSet<String> = folders.iter().map(|f| f.id.clone()).collect();
    let mut by_parent: HashMap<Option<String>, Vec<LocalFolder>> = HashMap::new();
    for folder in folders {
        let parent = folder.parent.clone().filter(|p| ids.contains(p));
        by_parent.entry(parent).or_default().push(folder);
    }
    let mut ordered = Vec::with_capacity(ids.len());
    let mut queue: VecDeque<Option<String>> = VecDeque::from([None]);
    while let Some(parent) = queue.pop_front() {
        if let Some(children) = by_parent.remove(&parent) {
            for child in children {
                queue.push_back(Some(child.id.clone()));
                ordered.push(child);
            }
        }
    }
    ordered
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBody {
    pub server: String,
    pub email: String,
    pub login_key: String,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub invite_token: Option<String>,
}

/// `GET /api/local/connect`: where the copy stands.
pub async fn status(State(state): State<Arc<AppState>>, _auth: AuthUser) -> Json<Value> {
    Json(state.connect.status())
}

/// `POST /api/local/connect`: starts or resumes the copy. 202 with the
/// status; 409 while one runs; 400 for an address that is not a server's.
pub async fn start(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    JsonBody(body): JsonBody<StartBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let origin = server_origin(&body.server)
        .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, message))?;
    let email = crate::validate::email(&body.email)?;
    crate::validate::login_key(&body.login_key)?;
    if !state.connect.try_begin(&origin, &email) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "a copy is already running",
        ));
    }
    let body = StartBody { email, ..body };
    let owner = Arc::clone(&state);
    tokio::spawn(async move {
        // The copy runs as its own task so that even a panic in it settles
        // the status instead of leaving it running.
        let worker = Arc::clone(&owner);
        let outcome =
            match tokio::spawn(async move { run(worker, auth.uid, origin, body).await }).await {
                Ok(outcome) => outcome,
                Err(_) => Err("the copy stopped unexpectedly".to_string()),
            };
        owner.connect.update(|progress| {
            progress.running = false;
            match outcome {
                Ok(()) => progress.step = Some(Step::Done),
                Err(message) => {
                    eprintln!("engram-local: connect: {message}");
                    progress.step = Some(Step::Failed);
                    progress.error = Some(message);
                }
            }
        });
    });
    Ok((StatusCode::ACCEPTED, Json(state.connect.status())))
}

/// `DELETE /api/local/connect`: stops a running copy (its bookkeeping
/// stays, so the next start resumes), or forgets a finished one.
pub async fn cancel(State(state): State<Arc<AppState>>, _auth: AuthUser) -> Json<Value> {
    let running = state.connect.progress.lock().unwrap().running;
    if running {
        state.connect.cancel.store(true, Ordering::SeqCst);
    } else {
        state.connect.forget_plan();
        state
            .connect
            .update(|progress| *progress = Progress::default());
    }
    Json(state.connect.status())
}

async fn run(
    state: Arc<AppState>,
    uid: i64,
    origin: String,
    body: StartBody,
) -> Result<(), String> {
    let connect = &state.connect;
    let host = host_of(&origin);
    let mut remote = Remote {
        client: &connect.client,
        origin: origin.clone(),
        host: host.clone(),
        token: None,
    };

    // 1. A vault server answers at the address.
    let (status, answer) = remote.json(Method::GET, "/api/health", None).await?;
    if !status.is_success() || answer.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(format!("{host} does not answer like a vault server"));
    }

    // 2. The account there: created with this vault's keys, or signed in
    //    and found to hold the same keys and nothing else.
    connect.update(|p| p.step = Some(Step::Account));
    let account = blocking(&state, move |store| {
        let row = store
            .conn()
            .query_row(
                "SELECT key_attributes, settings_blob, display_name FROM users WHERE id = ?1",
                params![uid],
                |r| {
                    Ok(Account {
                        attributes: parse_json(r.get::<_, String>(0)?),
                        settings: r.get(1)?,
                        display_name: r.get(2)?,
                    })
                },
            )
            .optional()?;
        row.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no account on this device"))
    })
    .await
    .map_err(|err| err.message)?;
    sign_in(&mut remote, &body, &account.attributes).await?;
    let mut plan = connect.load_plan(&origin, &body.email);
    if plan.is_empty() {
        let theirs = remote.library().await?;
        if theirs.folders + theirs.files > 0 {
            return Err(format!(
                "the account {} at {host} already holds {} folders and {} files; connect an empty account",
                body.email, theirs.folders, theirs.files
            ));
        }
    }

    // 3. Folders, parents first.
    connect.update(|p| p.step = Some(Step::Folders));
    let folders = blocking(&state, move |store| {
        let conn = store.conn();
        let mut statement = conn.prepare(
            "SELECT id, parent_id, encrypted_key, encrypted_meta FROM folders WHERE user_id = ?1 AND deleted = 0",
        )?;
        let rows = statement
            .query_map(params![uid], |r| {
                Ok(LocalFolder {
                    id: r.get(0)?,
                    parent: r.get(1)?,
                    key: parse_json(r.get::<_, String>(2)?),
                    meta: parse_json(r.get::<_, String>(3)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(in_creation_order(rows))
    })
    .await
    .map_err(|err| err.message)?;
    connect.update(|p| p.folders_total = folders.len() as u64);
    for folder in &folders {
        connect.check_cancel()?;
        if !plan.folders.contains_key(&folder.id) {
            let parent = folder
                .parent
                .as_ref()
                .and_then(|p| plan.folders.get(p))
                .cloned();
            let created = remote
                .expect(
                    Method::POST,
                    "/api/folders",
                    Some(json!({
                        "parentId": parent,
                        "encryptedKey": folder.key,
                        "encryptedMeta": folder.meta,
                    })),
                    "create a folder",
                )
                .await?;
            let id = created
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{host} created a folder without an id"))?;
            plan.folders.insert(folder.id.clone(), id.to_string());
            connect.save_plan(&plan)?;
        }
        connect.update(|p| p.folders_done += 1);
    }

    // 4. Files: the record, then its bytes as they are stored.
    connect.update(|p| p.step = Some(Step::Files));
    let files = blocking(&state, move |store| {
        let conn = store.conn();
        let mut statement = conn.prepare(
            "SELECT id, folder_id, encrypted_key, encrypted_meta, size, thumb_size, index_size, trashed, generation, seekable
             FROM files WHERE user_id = ?1 AND deleted = 0 AND uploaded = 1 ORDER BY created_at, id",
        )?;
        let rows = statement
            .query_map(params![uid], |r| {
                Ok(LocalFile {
                    id: r.get(0)?,
                    folder: r.get(1)?,
                    key: parse_json(r.get::<_, String>(2)?),
                    meta: parse_json(r.get::<_, String>(3)?),
                    size: r.get(4)?,
                    thumb: r.get(5)?,
                    index: r.get(6)?,
                    trashed: r.get::<_, i64>(7)? == 1,
                    generation: r.get(8)?,
                    seekable: r.get::<_, i64>(9)? == 1,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .await
    .map_err(|err| err.message)?;
    let bytes_total: u64 = files
        .iter()
        .map(|f| (f.size + f.thumb + f.index).max(0) as u64)
        .sum();
    connect.update(|p| {
        p.files_total = files.len() as u64;
        p.bytes_total = bytes_total;
    });
    for file in &files {
        connect.check_cancel()?;
        let entry = match plan.files.get(&file.id) {
            Some(entry) => entry.clone(),
            None => {
                let folder = file
                    .folder
                    .as_ref()
                    .and_then(|f| plan.folders.get(f))
                    .cloned();
                let created = remote
                    .expect(
                        Method::POST,
                        "/api/files",
                        Some(json!({
                            "folderId": folder,
                            "encryptedKey": file.key,
                            "encryptedMeta": file.meta,
                            "seekable": file.seekable,
                        })),
                        "create a file",
                    )
                    .await?;
                let id = created
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("{host} created a file without an id"))?;
                let entry = FilePlan {
                    id: id.to_string(),
                    ..FilePlan::default()
                };
                plan.files.insert(file.id.clone(), entry.clone());
                connect.save_plan(&plan)?;
                entry
            }
        };
        let mut entry = entry;
        let sid = entry.id.clone();
        let mut done_bytes = 0u64;
        if !entry.data {
            let path = state
                .blobs
                .path(&blob_key(&file.id, BlobKind::Data, file.generation));
            let size = file.size.max(0) as u64;
            let on_disk = tokio::fs::metadata(&path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            if on_disk != size {
                return Err(format!(
                    "a file on this device does not match its record ({} bytes stored, {size} expected); run Check stored files first",
                    on_disk
                ));
            }
            if size > PART_THRESHOLD {
                remote.put_parts(&sid, &path, size).await?;
            } else {
                remote
                    .put_blob(&format!("/api/files/{sid}/data"), &path, size, "a file")
                    .await?;
            }
            entry.data = true;
            plan.files.insert(file.id.clone(), entry.clone());
            connect.save_plan(&plan)?;
        }
        done_bytes += file.size.max(0) as u64;
        if file.thumb > 0 && !entry.thumb {
            let path = state.blobs.path(&blob_key(&file.id, BlobKind::Thumb, 0));
            remote
                .put_blob(
                    &format!("/api/files/{sid}/thumbnail"),
                    &path,
                    file.thumb as u64,
                    "a preview",
                )
                .await?;
            entry.thumb = true;
            plan.files.insert(file.id.clone(), entry.clone());
            connect.save_plan(&plan)?;
        }
        done_bytes += file.thumb.max(0) as u64;
        if file.index > 0 && !entry.index {
            let path = state.blobs.path(&blob_key(&file.id, BlobKind::Index, 0));
            remote
                .put_blob(
                    &format!("/api/files/{sid}/index"),
                    &path,
                    file.index as u64,
                    "a search index",
                )
                .await?;
            entry.index = true;
            plan.files.insert(file.id.clone(), entry.clone());
            connect.save_plan(&plan)?;
        }
        done_bytes += file.index.max(0) as u64;
        if file.trashed && !entry.trashed {
            remote
                .expect(
                    Method::DELETE,
                    &format!("/api/files/{sid}"),
                    None,
                    "move a file to the trash",
                )
                .await?;
            entry.trashed = true;
            plan.files.insert(file.id.clone(), entry.clone());
            connect.save_plan(&plan)?;
        }
        connect.update(|p| {
            p.files_done += 1;
            p.bytes_done += done_bytes;
        });
    }

    // 5. The account's settings and name travel with it.
    connect.update(|p| p.step = Some(Step::Settings));
    if !plan.settings {
        if let Some(blob) = &account.settings {
            remote
                .expect(
                    Method::PUT,
                    "/api/settings",
                    Some(json!({ "blob": blob })),
                    "store the settings",
                )
                .await?;
        }
        if let Some(name) = &account.display_name {
            remote
                .expect(
                    Method::PATCH,
                    "/api/user",
                    Some(json!({ "displayName": name })),
                    "store the account's name",
                )
                .await?;
        }
        plan.settings = true;
        connect.save_plan(&plan)?;
    }

    // 6. The server reads its copy of every file back, and its listing
    //    is compared with this device's.
    connect.update(|p| p.step = Some(Step::Verifying));
    let mut verified = Verified::default();
    let server_ids: HashMap<String, String> = plan
        .files
        .iter()
        .map(|(local, entry)| (entry.id.clone(), local.clone()))
        .collect();
    let ids: Vec<String> = files
        .iter()
        .filter_map(|f| plan.files.get(&f.id).map(|e| e.id.clone()))
        .collect();
    for chunk in ids.chunks(VERIFY_MAX) {
        connect.check_cancel()?;
        let answer = remote
            .expect(
                Method::POST,
                "/api/files/verify",
                Some(json!({ "ids": chunk })),
                "check its files",
            )
            .await?;
        for result in answer["results"].as_array().into_iter().flatten() {
            let verdict = result["verdict"].as_str().unwrap_or("unknown");
            if matches!(verdict, "intact" | "recorded") {
                verified.checked += 1;
            } else {
                let id = result["id"].as_str().unwrap_or("?");
                let local = server_ids.get(id).map(String::as_str).unwrap_or(id);
                verified.problems.push(format!("{verdict}: {local}"));
            }
        }
    }
    let theirs = remote.library().await?;
    verified.folders = theirs.folders;
    verified.files = theirs.files;
    verified.bytes = theirs.bytes;
    if theirs.folders != folders.len() as u64 {
        verified.problems.push(format!(
            "{host} lists {} folders, this device has {}",
            theirs.folders,
            folders.len()
        ));
    }
    if theirs.files != files.len() as u64 {
        verified.problems.push(format!(
            "{host} lists {} files, this device has {}",
            theirs.files,
            files.len()
        ));
    }
    if theirs.bytes != bytes_total {
        verified.problems.push(format!(
            "{host} holds {} bytes, this device has {bytes_total}",
            theirs.bytes
        ));
    }
    let first_problem = verified.problems.first().cloned();
    connect.update(|p| p.verified = Some(verified));
    match first_problem {
        Some(problem) => Err(format!("the copy on {host} did not check out: {problem}")),
        None => Ok(()),
    }
}

async fn sign_in(
    remote: &mut Remote<'_>,
    body: &StartBody,
    attributes: &Value,
) -> Result<(), String> {
    let host = remote.host.clone();
    let token = if body.create {
        let mut payload = json!({
            "email": body.email,
            "loginKey": body.login_key,
            "keyAttributes": attributes,
        });
        if let Some(invite) = body
            .invite_token
            .as_deref()
            .filter(|t| !t.trim().is_empty())
        {
            payload["inviteToken"] = json!(invite.trim());
        }
        let (status, answer) = remote
            .json(Method::POST, "/api/auth/register", Some(payload))
            .await?;
        if status == StatusCode::CONFLICT {
            return Err(format!(
                "{host} already has an account for {}; sign in to it instead",
                body.email
            ));
        }
        if !status.is_success() {
            return Err(refusal(&host, status, &answer, "create the account"));
        }
        answer
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        let (status, answer) = remote
            .json(
                Method::POST,
                "/api/auth/login",
                Some(json!({ "email": body.email, "loginKey": body.login_key })),
            )
            .await?;
        if status == StatusCode::UNAUTHORIZED {
            return Err(format!(
                "{host} does not know {} with this vault's passphrase",
                body.email
            ));
        }
        if !status.is_success() {
            return Err(refusal(&host, status, &answer, "sign in"));
        }
        if answer.get("twoFactorRequired").and_then(Value::as_bool) == Some(true) {
            return Err(format!(
                "two-factor sign-in is on for {} at {host}; turn it off there first, then connect",
                body.email
            ));
        }
        // Every file's key is wrapped under this vault's master key: an
        // account with keys of its own could never open them.
        let theirs = answer
            .get("keyAttributes")
            .and_then(|a| a.get("encryptedMasterKey"));
        if theirs != attributes.get("encryptedMasterKey") {
            return Err(format!(
                "the account {} at {host} has keys of its own, so this vault's files could not be opened there; create a new account instead",
                body.email
            ));
        }
        answer
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    match token {
        Some(token) => {
            remote.token = Some(token);
            Ok(())
        }
        None => Err(format!("{host} answered without a session")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::tests::{raw_with, signed_in, Running};

    /// The login key `signed_in` registers with.
    const LOGIN_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn host(running: &Running) -> String {
        format!("127.0.0.1:{}", running.port)
    }

    fn call(
        running: &Running,
        method: &str,
        path: &str,
        token: &str,
        body: Option<&str>,
    ) -> (u16, String, String) {
        let bearer = format!("Bearer {token}");
        raw_with(
            running.port,
            method,
            path,
            &host(running),
            body,
            &[
                ("authorization", &bearer),
                ("content-type", "application/json"),
            ],
        )
    }

    fn put(running: &Running, path: &str, token: &str, bytes: &str) -> u16 {
        let bearer = format!("Bearer {token}");
        raw_with(
            running.port,
            "PUT",
            path,
            &host(running),
            Some(bytes),
            &[
                ("authorization", &bearer),
                ("content-type", "application/octet-stream"),
            ],
        )
        .0
    }

    fn field(body: &str, name: &str) -> String {
        let value: Value = serde_json::from_str(body).unwrap();
        value[name].as_str().unwrap().to_string()
    }

    fn secret_box(tag: &str) -> String {
        format!(r#"{{"ciphertext":"{tag}","nonce":"n-{tag}"}}"#)
    }

    fn folder(running: &Running, token: &str, parent: Option<&str>, tag: &str) -> String {
        let parent = parent
            .map(|p| format!("\"{p}\""))
            .unwrap_or("null".to_string());
        let body = format!(
            r#"{{"parentId":{parent},"encryptedKey":{},"encryptedMeta":{}}}"#,
            secret_box(&format!("k-{tag}")),
            secret_box(&format!("m-{tag}"))
        );
        let (status, _, body) = call(running, "POST", "/api/folders", token, Some(&body));
        assert_eq!(status, 201, "{body}");
        field(&body, "id")
    }

    fn file(running: &Running, token: &str, folder: Option<&str>, tag: &str, data: &str) -> String {
        let folder = folder
            .map(|f| format!("\"{f}\""))
            .unwrap_or("null".to_string());
        let body = format!(
            r#"{{"folderId":{folder},"encryptedKey":{},"encryptedMeta":{},"seekable":true}}"#,
            secret_box(&format!("k-{tag}")),
            secret_box(&format!("m-{tag}"))
        );
        let (status, _, body) = call(running, "POST", "/api/files", token, Some(&body));
        assert_eq!(status, 201, "{body}");
        let id = field(&body, "id");
        assert_eq!(
            put(running, &format!("/api/files/{id}/data"), token, data),
            200
        );
        id
    }

    fn connect(vault: &Running, token: &str, server: &Running, create: bool) -> Value {
        let body = format!(
            r#"{{"server":"http://127.0.0.1:{}","email":"alice@example.com","loginKey":"{LOGIN_KEY}","create":{create}}}"#,
            server.port
        );
        let (status, _, answer) = call(vault, "POST", "/api/local/connect", token, Some(&body));
        assert_eq!(status, 202, "{answer}");
        for _ in 0..600 {
            std::thread::sleep(Duration::from_millis(50));
            let (_, _, answer) = call(vault, "GET", "/api/local/connect", token, None);
            let status: Value = serde_json::from_str(&answer).unwrap();
            if status["running"] != true {
                return status;
            }
        }
        panic!("the copy did not finish");
    }

    fn their_session(server: &Running) -> String {
        let body = format!(r#"{{"email":"alice@example.com","loginKey":"{LOGIN_KEY}"}}"#);
        let (status, _, answer) = raw_with(
            server.port,
            "POST",
            "/api/auth/login",
            &host(server),
            Some(&body),
            &[("content-type", "application/json")],
        );
        assert_eq!(status, 200, "{answer}");
        field(&answer, "token")
    }

    fn library(running: &Running, token: &str) -> Value {
        let (status, _, body) = call(running, "GET", "/api/sync?since=0", token, None);
        assert_eq!(status, 200);
        serde_json::from_str(&body).unwrap()
    }

    #[test]
    fn a_server_address_is_an_origin_and_nothing_more() {
        assert_eq!(
            server_origin("vault.example.com").unwrap(),
            "https://vault.example.com"
        );
        assert_eq!(
            server_origin(" vault.example.com:8443/ ").unwrap(),
            "https://vault.example.com:8443"
        );
        assert_eq!(
            server_origin("http://127.0.0.1:8080/").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            host_of("https://vault.example.com:8443"),
            "vault.example.com:8443"
        );
        for wrong in [
            "",
            "ftp://x",
            "https://a:b@host",
            "https://host/path",
            "https://host/?q",
            "host#f",
        ] {
            assert!(server_origin(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn copies_everything_to_an_empty_account_and_checks_it() {
        let vault = Running::new();
        let server = Running::new();
        let token = signed_in(vault.port, "vault@this.device");
        let top = folder(&vault, &token, None, "top");
        let child = folder(&vault, &token, Some(&top), "child");
        let doc = file(&vault, &token, Some(&child), "doc", "hello-data");
        assert_eq!(
            put(
                &vault,
                &format!("/api/files/{doc}/thumbnail"),
                &token,
                "thumb!"
            ),
            200
        );
        assert_eq!(
            put(&vault, &format!("/api/files/{doc}/index"), &token, "idx"),
            200
        );
        let gone = file(&vault, &token, None, "gone", "bye");
        assert_eq!(
            call(
                &vault,
                "DELETE",
                &format!("/api/files/{gone}"),
                &token,
                None
            )
            .0,
            204
        );
        let settings = r#"{"blob":"{\"theme\":\"dark\"}"}"#;
        assert_eq!(
            call(&vault, "PUT", "/api/settings", &token, Some(settings)).0,
            200
        );
        assert_eq!(
            call(
                &vault,
                "PATCH",
                "/api/user",
                &token,
                Some(r#"{"displayName":"This Mac"}"#)
            )
            .0,
            200
        );

        let status = connect(&vault, &token, &server, true);
        assert_eq!(status["step"], "done", "{status}");
        assert_eq!(status["foldersDone"], 2);
        assert_eq!(status["filesDone"], 2);
        assert_eq!(status["bytesDone"], 10 + 6 + 3 + 3);
        let verified = &status["verified"];
        assert_eq!(verified["folders"], 2);
        assert_eq!(verified["files"], 2);
        assert_eq!(verified["bytes"], 10 + 6 + 3 + 3);
        assert_eq!(verified["checked"], 2);
        assert_eq!(verified["problems"], json!([]));

        let theirs = their_session(&server);
        let listing = library(&server, &theirs);
        let folders = listing["folders"].as_array().unwrap();
        assert_eq!(folders.len(), 2);
        let their_top = folders
            .iter()
            .find(|f| f["encryptedKey"]["ciphertext"] == "k-top")
            .unwrap();
        let their_child = folders
            .iter()
            .find(|f| f["encryptedKey"]["ciphertext"] == "k-child")
            .unwrap();
        assert_eq!(their_top["parentId"], Value::Null);
        assert_eq!(their_child["parentId"], their_top["id"]);
        let files = listing["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        let their_doc = files
            .iter()
            .find(|f| f["encryptedKey"]["ciphertext"] == "k-doc")
            .unwrap();
        assert_eq!(their_doc["folderId"], their_child["id"]);
        assert_eq!(their_doc["encryptedMeta"]["ciphertext"], "m-doc");
        assert_eq!(their_doc["size"], 10);
        assert_eq!(their_doc["thumbSize"], 6);
        assert_eq!(their_doc["indexSize"], 3);
        assert_eq!(their_doc["trashed"], false);
        let their_gone = files
            .iter()
            .find(|f| f["encryptedKey"]["ciphertext"] == "k-gone")
            .unwrap();
        assert_eq!(their_gone["trashed"], true);
        let sid = their_doc["id"].as_str().unwrap();
        assert_eq!(
            call(
                &server,
                "GET",
                &format!("/api/files/{sid}/data"),
                &theirs,
                None
            )
            .2,
            "hello-data"
        );
        assert_eq!(
            call(
                &server,
                "GET",
                &format!("/api/files/{sid}/thumbnail"),
                &theirs,
                None
            )
            .2,
            "thumb!"
        );
        let (_, _, blob) = call(&server, "GET", "/api/settings", &theirs, None);
        assert_eq!(field(&blob, "blob"), r#"{"theme":"dark"}"#);
        let (_, _, user) = call(&server, "GET", "/api/user", &theirs, None);
        assert_eq!(field(&user, "displayName"), "This Mac");

        // A second run finds its bookkeeping and creates nothing twice.
        let again = connect(&vault, &token, &server, false);
        assert_eq!(again["step"], "done", "{again}");
        let listing = library(&server, &theirs);
        assert_eq!(listing["folders"].as_array().unwrap().len(), 2);
        assert_eq!(listing["files"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn large_content_goes_up_in_parts() {
        let vault = Running::with(|c| c.quota_bytes = 64 * 1024 * 1024);
        let server = Running::with(|c| c.quota_bytes = 64 * 1024 * 1024);
        let token = signed_in(vault.port, "vault@this.device");
        let big = "b".repeat(13 * 1024 * 1024);
        let id = file(&vault, &token, None, "big", &big);
        let status = connect(&vault, &token, &server, true);
        assert_eq!(status["step"], "done", "{status}");
        assert_eq!(status["verified"]["bytes"], 13 * 1024 * 1024);
        let theirs = their_session(&server);
        let listing = library(&server, &theirs);
        let their = &listing["files"].as_array().unwrap()[0];
        assert_eq!(their["size"], 13 * 1024 * 1024);
        let sid = their["id"].as_str().unwrap();
        let (status, _, body) = call(
            &server,
            "GET",
            &format!("/api/files/{sid}/data"),
            &theirs,
            None,
        );
        assert_eq!(status, 200);
        assert_eq!(body.len(), big.len());
        assert!(body.bytes().all(|b| b == b'b'));
        let _ = id;
    }

    #[test]
    fn refuses_an_account_with_history_and_one_with_other_keys() {
        let vault = Running::new();
        let server = Running::new();
        let token = signed_in(vault.port, "vault@this.device");
        file(&vault, &token, None, "doc", "data");
        // Same keys (signed_in registers the same attributes), one folder of history.
        let alice = signed_in(server.port, "alice@example.com");
        folder(&server, &alice, None, "theirs");
        let status = connect(&vault, &token, &server, false);
        assert_eq!(status["step"], "failed", "{status}");
        let error = status["error"].as_str().unwrap();
        assert!(
            error.contains("already holds 1 folders and 0 files"),
            "{error}"
        );
        assert_eq!(
            library(&server, &alice)["files"].as_array().unwrap().len(),
            0
        );

        // An empty account whose master key is not this vault's.
        let other = Running::new();
        let sb = r#"{"ciphertext":"c","nonce":"n"}"#;
        let attributes = format!(
            r#"{{"kdf":{{"salt":"0123456789abcdef","opsLimit":3,"memLimit":268435456}},"encryptedMasterKey":{},"masterKeyEncryptedWithRecoveryKey":{sb},"recoveryKeyEncryptedWithMasterKey":{sb},"publicKey":"p","encryptedPrivateKey":{sb}}}"#,
            secret_box("other-master")
        );
        let body = format!(
            r#"{{"email":"alice@example.com","loginKey":"{LOGIN_KEY}","keyAttributes":{attributes}}}"#
        );
        let (status, _, answer) = raw_with(
            other.port,
            "POST",
            "/api/auth/register",
            &host(&other),
            Some(&body),
            &[("content-type", "application/json")],
        );
        assert_eq!(status, 201, "{answer}");
        let status = connect(&vault, &token, &other, false);
        assert_eq!(status["step"], "failed", "{status}");
        assert!(
            status["error"]
                .as_str()
                .unwrap()
                .contains("keys of its own"),
            "{status}"
        );
    }

    #[test]
    fn a_wrong_address_or_an_unreachable_server_is_said_plainly() {
        let vault = Running::new();
        let token = signed_in(vault.port, "vault@this.device");
        let body = format!(
            r#"{{"server":"https://a:b@host","email":"alice@example.com","loginKey":"{LOGIN_KEY}","create":true}}"#
        );
        let (status, _, answer) = call(&vault, "POST", "/api/local/connect", &token, Some(&body));
        assert_eq!(status, 400, "{answer}");
        assert!(answer.contains("is not a server address"));
        // A port nothing listens on.
        let dead = Running::new();
        let port = dead.port;
        drop(dead);
        let body = format!(
            r#"{{"server":"http://127.0.0.1:{port}","email":"alice@example.com","loginKey":"{LOGIN_KEY}","create":true}}"#
        );
        let (status, _, answer) = call(&vault, "POST", "/api/local/connect", &token, Some(&body));
        assert_eq!(status, 202, "{answer}");
        let status = loop {
            std::thread::sleep(Duration::from_millis(50));
            let (_, _, answer) = call(&vault, "GET", "/api/local/connect", &token, None);
            let status: Value = serde_json::from_str(&answer).unwrap();
            if status["running"] != true {
                break status;
            }
        };
        assert_eq!(status["step"], "failed", "{status}");
        assert_eq!(status["error"], format!("could not reach 127.0.0.1:{port}"));
        // Forgetting a finished copy clears the status.
        let (_, _, cleared) = call(&vault, "DELETE", "/api/local/connect", &token, None);
        let cleared: Value = serde_json::from_str(&cleared).unwrap();
        assert_eq!(cleared["step"], Value::Null);
    }
}
