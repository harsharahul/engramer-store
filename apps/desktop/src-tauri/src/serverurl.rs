//! A runtime server override: one binary, many servers.
//!
//! The build bakes a default vault address, but the person holding the
//! app decides where their vault actually lives. The override is stored
//! beside the app's other configuration and applied at startup, and the
//! login screen offers it, so a device pointed at the wrong server can be
//! repointed without a rebuild, and a self-hoster can use the stock app.

use std::fs;
use tauri::{AppHandle, Manager};

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("server-url.txt"))
        .map_err(|err| err.to_string())
}

fn parse_origin(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "not a valid URL".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("the server address must be http(s)".to_string());
    }
    Ok(parsed)
}

fn navigate_main(app: &AppHandle, url: url::Url) -> Result<(), String> {
    let mut window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window.navigate(url).map_err(|err| err.to_string())
}

/// Applied during setup, before the baked page has meaningfully loaded.
pub fn apply_stored(app: &AppHandle) {
    let Ok(path) = store_path(app) else { return };
    let Ok(stored) = fs::read_to_string(&path) else { return };
    if let Ok(url) = parse_origin(&stored) {
        let _ = navigate_main(app, url);
    }
}

/// The stored override, if any; the login screen shows it.
#[tauri::command]
pub fn server_url_get(app: AppHandle) -> Option<String> {
    let path = store_path(&app).ok()?;
    let stored = fs::read_to_string(path).ok()?;
    let trimmed = stored.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Persists the override and navigates to it immediately.
#[tauri::command]
pub fn server_url_set(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = parse_origin(&url)?;
    let origin = parsed.origin().ascii_serialization();
    let path = store_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&path, &origin).map_err(|err| err.to_string())?;
    navigate_main(&app, parse_origin(&origin)?)
}

/// Removes the override and returns to the build's own default.
#[tauri::command]
pub fn server_url_clear(app: AppHandle) -> Result<(), String> {
    let path = store_path(&app)?;
    let _ = fs::remove_file(path);
    let default = app
        .config()
        .app
        .windows
        .first()
        .map(|w| w.url.to_string())
        .ok_or_else(|| "no configured window".to_string())?;
    navigate_main(&app, parse_origin(&default)?)
}
