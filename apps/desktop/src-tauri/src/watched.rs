//! Watched folders: the reason the desktop app exists. Native code only
//! observes the filesystem and serves bytes; deciding what to upload and
//! every cryptographic step stay in the web layer. The watcher emits an
//! event when a file settles; the webview reads it through a command that
//! refuses any path outside a registered folder.
//!
//! iOS has no arbitrary folders to watch, so there the same commands answer
//! with empty lists and the web layer sees one shell everywhere.

#[cfg(desktop)]
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
#[cfg(desktop)]
use std::time::Duration;
use std::time::UNIX_EPOCH;
#[cfg(desktop)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct WatchState {
    #[cfg(desktop)]
    folders: Vec<PathBuf>,
    #[cfg(desktop)]
    watchers: Vec<notify::RecommendedWatcher>,
}

pub type SharedWatchState = Arc<Mutex<WatchState>>;

#[derive(Serialize, Deserialize, Clone)]
pub struct WatchedFile {
    pub path: String,
    pub name: String,
    /// Directory path relative to the watched root, empty at the root.
    pub rel_dirs: Vec<String>,
    pub size: u64,
    pub mtime: u64,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("watched-folders.json"))
}

fn load_folders(app: &AppHandle) -> Vec<PathBuf> {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Vec<PathBuf>>(&raw).ok())
        .unwrap_or_default()
}

fn save_folders(app: &AppHandle, folders: &[PathBuf]) -> Result<(), String> {
    let path = config_path(app)?;
    std::fs::write(path, serde_json::to_string_pretty(folders).unwrap())
        .map_err(|err| err.to_string())
}

fn file_entry(root: &Path, path: &Path) -> Option<WatchedFile> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let name = path.file_name()?.to_str()?.to_string();
    if name.starts_with('.') {
        return None;
    }
    let rel = path.parent()?.strip_prefix(root).ok()?;
    let rel_dirs = rel
        .components()
        .filter_map(|c| c.as_os_str().to_str().map(String::from))
        .collect();
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(WatchedFile {
        path: path.to_str()?.to_string(),
        name,
        rel_dirs,
        size: meta.len(),
        mtime,
    })
}

fn scan_folder(root: &Path) -> Vec<WatchedFile> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<WatchedFile>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(true);
            if hidden {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out);
            } else if let Some(file) = file_entry(root, &path) {
                out.push(file);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

/// Waits for a file to stop changing size, so a copy in progress is not
/// uploaded half-written. Gives up quietly on files that keep growing.
#[cfg(desktop)]
fn wait_until_stable(path: &Path) -> Option<u64> {
    let mut last = std::fs::metadata(path).ok()?.len();
    for _ in 0..60 {
        std::thread::sleep(Duration::from_millis(1500));
        let now = std::fs::metadata(path).ok()?.len();
        if now == last && now > 0 {
            return Some(now);
        }
        last = now;
    }
    None
}

#[cfg(desktop)]
fn spawn_watcher(app: AppHandle, root: PathBuf) -> Option<notify::RecommendedWatcher> {
    let emit_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        if !matches!(
            event.kind,
            notify::EventKind::Create(_) | notify::EventKind::Modify(_)
        ) {
            return;
        }
        for path in event.paths {
            let app = app.clone();
            let root = emit_root.clone();
            std::thread::spawn(move || {
                if wait_until_stable(&path).is_none() {
                    return;
                }
                if let Some(file) = file_entry(&root, &path) {
                    let _ = app.emit("watch-file", file);
                }
            });
        }
    })
    .ok()?;
    watcher.watch(&root, RecursiveMode::Recursive).ok()?;
    Some(watcher)
}

/// Rebuilds every watcher from the stored folder list; called at startup
/// and after each add or remove.
#[cfg(desktop)]
pub fn rebuild_watchers(app: &AppHandle) {
    let folders = load_folders(app);
    let state: tauri::State<SharedWatchState> = app.state();
    let mut guard = state.lock().expect("watch state");
    guard.watchers.clear();
    guard.folders = folders.clone();
    for folder in folders {
        if let Some(watcher) = spawn_watcher(app.clone(), folder) {
            guard.watchers.push(watcher);
        }
    }
}

/// Nothing to rebuild where nothing can be watched; the call keeps startup
/// identical on every platform.
#[cfg(mobile)]
pub fn rebuild_watchers(_app: &AppHandle) {}

#[tauri::command]
pub fn watched_folders(app: AppHandle) -> Vec<String> {
    load_folders(&app)
        .iter()
        .filter_map(|p| p.to_str().map(String::from))
        .collect()
}

#[tauri::command]
pub fn watched_add(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let folder = PathBuf::from(&path);
    if !folder.is_dir() {
        return Err("that path is not a folder".to_string());
    }
    let mut folders = load_folders(&app);
    if !folders.contains(&folder) {
        folders.push(folder);
        save_folders(&app, &folders)?;
        rebuild_watchers(&app);
    }
    Ok(watched_folders(app))
}

#[tauri::command]
pub fn watched_remove(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let folder = PathBuf::from(&path);
    let mut folders = load_folders(&app);
    folders.retain(|f| f != &folder);
    save_folders(&app, &folders)?;
    rebuild_watchers(&app);
    Ok(watched_folders(app))
}

#[tauri::command]
pub async fn watched_scan(app: AppHandle) -> Vec<WatchedFile> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut grouped: HashMap<String, Vec<WatchedFile>> = HashMap::new();
        for folder in load_folders(&app) {
            let files = scan_folder(&folder);
            if let Some(root) = folder.to_str() {
                grouped.insert(root.to_string(), files);
            }
        }
        grouped.into_values().flatten().collect()
    })
    .await
    .unwrap_or_default()
}

/// Resolves a requested path to a real file inside a watched folder,
/// refusing everything else. The webview may only read inside folders the
/// user explicitly chose; every read command and the picked:// watched
/// route go through this one check.
pub fn watched_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let file = PathBuf::from(path);
    let folders = load_folders(app);
    let canonical = file.canonicalize().map_err(|err| err.to_string())?;
    let allowed = folders.iter().any(|root| {
        root.canonicalize()
            .map(|r| canonical.starts_with(r))
            .unwrap_or(false)
    });
    if !allowed {
        return Err("path is outside every watched folder".to_string());
    }
    Ok(canonical)
}

/// The whole-file read, kept for pages older than the ranged commands;
/// those read bounded windows and leave the file where it lives.
#[tauri::command]
pub async fn watched_file_read(
    app: AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let canonical = watched_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&canonical)
            .map(tauri::ipc::Response::new)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Size and modification time, so the page can build a file handle
/// without moving a single content byte.
#[tauri::command]
pub async fn watched_file_stat(
    app: AppHandle,
    path: String,
) -> Result<crate::photos::PickedStat, String> {
    let canonical = watched_path(&app, &path)?;
    let meta = std::fs::metadata(&canonical).map_err(|err| err.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    Ok(crate::photos::PickedStat {
        size: meta.len(),
        mtime_ms,
    })
}

/// One bounded window of a watched file; the streaming upload's read.
/// Watched files are the person's own documents, so nothing here ever
/// deletes: uploads read, and that is all.
#[tauri::command]
pub async fn watched_file_read_range(
    app: AppHandle,
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    let canonical = watched_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::photos::read_range_at(&canonical, offset, length).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|err| err.to_string())?
}
