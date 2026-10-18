//! Local mode: the vault lives on this device. The shell runs the
//! on-device backend on a loopback origin it creates itself and points
//! the window at it, so the web client works unchanged, exactly as it
//! does against a server. The choice is remembered in the app's
//! configuration directory next to the server override, along with the
//! port, because the origin is the key to the client's per-origin state
//! (the service worker registration, drafts, the upload journal).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use engram_local::server::{self, AppState, Bound, ServerConfig};
use tauri::{AppHandle, Manager};

/// Remembers that this install keeps its vault on the device.
pub const MODE_FILE: &str = "local-mode";
/// The loopback port chosen on the first run and reused forever after.
pub const PORT_FILE: &str = "local-port";
/// The vault's directory under the app's data directory (the app group
/// container on iOS, so a provider can reach it later).
pub const VAULT_DIR: &str = "vault";
/// Where the bundle's resources carry the web client's core bundle.
const WEBDIST_DIR: &str = "webdist";
/// A dev override for the core bundle's location, when it is not the
/// bundled one.
const WEBDIST_ENV: &str = "ENGRAM_LOCAL_WEB_DIST";
/// The device's disk is the limit, and a full disk answers with a
/// sentence; the quota is set far above any disk so it never refuses.
const QUOTA_BYTES: u64 = 1 << 50;
const MAX_VERSIONS: usize = 10;
const MAX_BLOB_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const EVENTS_HEARTBEAT_MS: u64 = 25_000;
const PACK_READ_TIMEOUT_MS: u64 = 60_000;
/// How long a stop waits for in-flight requests before the shell moves on.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// The running backend, held by the app for as long as the process lives.
#[derive(Default)]
pub struct LocalMode(Mutex<Option<Running>>);

struct Running {
    state: Arc<AppState>,
    bound: Option<Bound>,
    port: u16,
}

pub fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Whether an origin is the vault on this device, on any port.
pub(crate) fn is_loopback_origin(origin: &str) -> bool {
    origin.starts_with("http://127.0.0.1:")
}

fn config_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(name))
        .map_err(|err| err.to_string())
}

/// Whether this install keeps its vault on the device.
pub fn enabled(app: &AppHandle) -> bool {
    config_path(app, MODE_FILE)
        .map(|path| path.is_file())
        .unwrap_or(false)
}

fn set_enabled(app: &AppHandle, on: bool) -> Result<(), String> {
    let path = config_path(app, MODE_FILE)?;
    if on {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        std::fs::write(&path, "local\n").map_err(|err| err.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// The port remembered from an earlier run, if any.
pub fn read_port(app: &AppHandle) -> Option<u16> {
    let path = config_path(app, PORT_FILE).ok()?;
    parse_port(&std::fs::read_to_string(path).ok()?)
}

fn parse_port(text: &str) -> Option<u16> {
    text.trim().parse().ok().filter(|port| *port != 0)
}

fn write_port(app: &AppHandle, port: u16) -> Result<(), String> {
    let path = config_path(app, PORT_FILE)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&path, format!("{port}\n")).map_err(|err| err.to_string())
}

/// Where the vault lives: the app group container on iOS (shared with the
/// extensions), the app's data directory elsewhere.
pub fn vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    if let Some(container) = crate::outbox::group_container_dir() {
        return Ok(container.join(VAULT_DIR));
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(VAULT_DIR))
        .map_err(|err| err.to_string())
}

/// The web client's core bundle: the dev override, else the bundled copy.
fn web_dist(app: &AppHandle) -> Result<PathBuf, String> {
    let dist = match std::env::var(WEBDIST_ENV) {
        Ok(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
        _ => app
            .path()
            .resource_dir()
            .map_err(|err| err.to_string())?
            .join(WEBDIST_DIR),
    };
    if !dist.join("index.html").is_file() {
        return Err(format!(
            "this build carries no web client for local mode (no index.html under {})",
            dist.display()
        ));
    }
    Ok(dist)
}

/// The capability that lets the page on the loopback origin call the
/// shell's commands: this one origin, exactly, and nothing else on
/// loopback. The same permissions as the main window's capability.
pub fn capability_json(port: u16) -> String {
    serde_json::json!({
        "identifier": format!("local-origin-{port}"),
        "description": "The vault on this device, served on a loopback origin the shell chose at runtime.",
        "windows": ["main", "main-*"],
        "remote": { "urls": [origin(port)] },
        "permissions": [
            "core:default",
            "core:window:allow-start-dragging",
            "dialog:allow-open",
            "shell-commands",
            "local-commands",
            "notification:default"
        ]
    })
    .to_string()
}

fn grant_ipc(app: &AppHandle, port: u16) -> Result<(), String> {
    app.add_capability(capability_json(port))
        .map_err(|err| format!("cannot grant the loopback origin its commands: {err}"))
}

/// Marks a directory in or out of the device's backups. The vault itself
/// is backed up with the device: it is the only copy, and it is ciphertext
/// (an earlier build excluded it, so the flag is cleared explicitly).
/// Downloaded packs stay out: they come again from the release host.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn mark_backup_exclusion(dir: &std::path::Path, excluded: bool) {
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};
    let _ = std::fs::create_dir_all(dir);
    let url = NSURL::fileURLWithPath(&NSString::from_str(&dir.to_string_lossy()));
    let value = NSNumber::new_bool(excluded);
    // SAFETY: a file URL for an existing directory, a boolean resource value
    // and the framework's own key; the call only reads them.
    let outcome =
        unsafe { url.setResourceValue_forKey_error(Some(&value), NSURLIsExcludedFromBackupKey) };
    if outcome.is_err() {
        eprintln!(
            "local mode: could not mark {} as {} the device's backups",
            dir.display(),
            if excluded { "out of" } else { "part of" }
        );
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn mark_backup_exclusion(_dir: &std::path::Path, _excluded: bool) {}

fn open_state(app: &AppHandle) -> Result<Arc<AppState>, String> {
    let dist = web_dist(app)?;
    let vault = vault_dir(app)?;
    mark_backup_exclusion(&vault, false);
    mark_backup_exclusion(&vault.join(engram_local::packs::PACKS_DIR), true);
    let state = AppState::open(ServerConfig {
        data_dir: vault,
        quota_bytes: QUOTA_BYTES,
        events_heartbeat_ms: EVENTS_HEARTBEAT_MS,
        max_versions: MAX_VERSIONS,
        max_blob_bytes: MAX_BLOB_BYTES,
        web_dist: Some(dist),
        pack_read_timeout_ms: PACK_READ_TIMEOUT_MS,
    })?;
    Ok(Arc::new(state))
}

/// Binds the remembered port (any free port the first time, or when it is
/// taken) and serves `state` on it.
async fn serve(app: &AppHandle, state: Arc<AppState>) -> Result<Bound, String> {
    let remembered = read_port(app);
    let listener = server::bind(remembered.unwrap_or(0))
        .map_err(|err| format!("cannot bind a loopback port: {err}"))?;
    let bound = server::start(listener, state)
        .await
        .map_err(|err| format!("cannot serve the vault: {err}"))?;
    match remembered {
        Some(port) if port != bound.port => eprintln!(
            "local mode: port {port} was taken, now on {}; the client's per-origin state starts over",
            bound.port
        ),
        None => eprintln!("local mode: chose port {}", bound.port),
        _ => {}
    }
    if remembered != Some(bound.port) {
        // A port that cannot be remembered is not served: a running
        // backend nobody can reach again would only hold the vault open.
        if let Err(err) = write_port(app, bound.port) {
            bound.stop().await;
            return Err(format!("cannot remember the port: {err}"));
        }
    }
    Ok(bound)
}

/// Starts the backend and points the window at it. Called at startup when
/// local mode is on, and when the picker chooses it.
pub async fn boot(app: &AppHandle) -> Result<String, String> {
    let state = open_state(app)?;
    let bound = serve(app, Arc::clone(&state)).await?;
    let port = bound.port;
    grant_ipc(app, port)?;
    eprintln!(
        "local mode: serving {} at {} (vault {})",
        state
            .config
            .web_dist
            .as_deref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        origin(port),
        state.config.data_dir.display()
    );
    *app.state::<LocalMode>().0.lock().unwrap() = Some(Running {
        state,
        bound: Some(bound),
        port,
    });
    let url = url::Url::parse(&format!("{}/", origin(port))).map_err(|err| err.to_string())?;
    crate::serverurl::navigate_main(app, url)?;
    Ok(origin(port))
}

/// The port the backend is serving on, if it is running.
pub fn running_port(app: &AppHandle) -> Option<u16> {
    app.try_state::<LocalMode>()
        .and_then(|mode| mode.0.lock().unwrap().as_ref().map(|running| running.port))
}

/// Stops the backend if it runs, waiting a bounded time for requests in
/// flight. Keeps the vault and the remembered port.
pub async fn stop(app: &AppHandle) {
    let running = app
        .try_state::<LocalMode>()
        .and_then(|mode| mode.0.lock().unwrap().take());
    if let Some(mut running) = running {
        if let Some(bound) = running.bound.take() {
            if tokio::time::timeout(STOP_TIMEOUT, bound.stop())
                .await
                .is_err()
            {
                eprintln!("local mode: requests still in flight after {STOP_TIMEOUT:?}; moving on");
            }
        }
        eprintln!("local mode: stopped");
    }
}

/// Stops the backend from a thread outside the runtime (app exit).
pub fn stop_blocking(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::block_on(async move { stop(&app).await });
}

/// The listener may not survive a suspension: on foreground the shell asks
/// its own port for `/api/health` and, when nothing answers, rebinds the
/// remembered port and serves the same vault again. A port that had to
/// change is a new origin, so the window is pointed at it.
pub fn resumed(app: &AppHandle) {
    let Some(port) = running_port(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let probe_origin = origin(port);
        let healthy = tauri::async_runtime::spawn_blocking(move || {
            crate::serverurl::probe_health(&probe_origin).is_ok()
        })
        .await
        .unwrap_or(false);
        if healthy {
            return;
        }
        eprintln!(
            "local mode: the listener on port {port} does not answer after foreground; rebinding"
        );
        let state = app
            .state::<LocalMode>()
            .0
            .lock()
            .unwrap()
            .as_ref()
            .map(|running| Arc::clone(&running.state));
        let Some(state) = state else {
            return;
        };
        stop(&app).await;
        match serve(&app, Arc::clone(&state)).await {
            Ok(bound) => {
                let new_port = bound.port;
                *app.state::<LocalMode>().0.lock().unwrap() = Some(Running {
                    state,
                    bound: Some(bound),
                    port: new_port,
                });
                if new_port != port {
                    if let Err(err) = grant_ipc(&app, new_port) {
                        eprintln!("local mode: {err}");
                    }
                    if let Ok(url) = url::Url::parse(&format!("{}/", origin(new_port))) {
                        let _ = crate::serverurl::navigate_main(&app, url);
                    }
                }
            }
            Err(err) => eprintln!("local mode: cannot serve the vault again: {err}"),
        }
    });
}

/// Leaves local mode for a server: stops the backend and forgets the
/// choice. The vault stays on disk until it is deleted.
pub async fn disable(app: &AppHandle) -> Result<(), String> {
    stop(app).await;
    set_enabled(app, false)
}

/// Only the vault's own page, while the backend runs, may remove the vault:
/// the shell's commands also reach the pages of servers this app signs in
/// to, and a vault on this device may be the only copy.
fn may_delete(running: Option<u16>, current_origin: &str) -> Result<(), String> {
    let Some(port) = running else {
        return Err("the vault on this device is not running".to_string());
    };
    if current_origin != origin(port) {
        return Err("only the vault's own page can remove it".to_string());
    }
    Ok(())
}

/// The server whose presence must leave this device before the vault moves
/// here: the extension record's origin and account, unless the record
/// already belongs to a vault on this device.
fn server_record_to_tear_down(record: &[u8]) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_slice(record).ok()?;
    let origin = value.get("origin")?.as_str()?.to_string();
    let email = value.get("email")?.as_str()?.to_string();
    (!origin.starts_with("http://127.0.0.1:")).then_some((origin, email))
}

/// Keeping the vault here removes real things for a server this device
/// was signed in to, so it says which, and asks, before anything happens.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn confirm_keep_local(app: &AppHandle, old_origin: &str) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let host = url::Url::parse(old_origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| old_origin.to_string());
    let message = format!(
        "Keep the vault on this device?\n\nThe drive, extension access, and watched folders for {host} will be removed from this device. Files on that server are not affected."
    );
    let dialog = app
        .dialog()
        .message(message)
        .title("Keep it on this device")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Keep it here".to_string(),
            "Cancel".to_string(),
        ));
    let confirmed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .map_err(|err| err.to_string())?;
    if confirmed {
        Ok(())
    } else {
        Err("kept the current server".to_string())
    }
}

/// A server this device was signed in to leaves it before the vault moves
/// here, exactly as a server switch does: confirmed, then the extension
/// record, the drive, offline files and watched folders go.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn leave_server_for_local(app: &AppHandle) -> Result<(), String> {
    let record =
        tauri::async_runtime::spawn_blocking(|| crate::keychain::read_any(crate::handoff::SERVICE))
            .await
            .map_err(|err| err.to_string())?;
    match record {
        Ok(Some(bytes)) => {
            if let Some((old_origin, old_email)) = server_record_to_tear_down(&bytes) {
                confirm_keep_local(app, &old_origin).await?;
                #[cfg(target_os = "macos")]
                crate::pushsync::stop();
                crate::serverurl::teardown_previous(app, old_email).await;
            }
        }
        Ok(None) => {}
        Err(err) => eprintln!("local mode: extension record unreadable ({err}); continuing"),
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
async fn leave_server_for_local(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    enabled: bool,
    port: Option<u16>,
    origin: Option<String>,
    vault_dir: String,
}

/// What the client shows under "This device".
#[tauri::command]
pub fn local_mode_status(app: AppHandle) -> LocalStatus {
    let port = running_port(&app);
    LocalStatus {
        enabled: enabled(&app),
        port,
        origin: port.map(origin),
        vault_dir: vault_dir(&app)
            .map(|dir| dir.display().to_string())
            .unwrap_or_default(),
    }
}

/// "Keep it on this device": remembers the choice, starts the backend and
/// navigates. A failure forgets the choice again, so the next launch is
/// not stuck on a backend that cannot start.
#[tauri::command]
pub async fn local_mode_enable(app: AppHandle) -> Result<String, String> {
    if let Some(port) = running_port(&app) {
        let url = url::Url::parse(&format!("{}/", origin(port))).map_err(|err| err.to_string())?;
        crate::serverurl::navigate_main(&app, url)?;
        return Ok(origin(port));
    }
    leave_server_for_local(&app).await?;
    set_enabled(&app, true)?;
    match boot(&app).await {
        Ok(origin) => Ok(origin),
        Err(err) => {
            let _ = set_enabled(&app, false);
            Err(err)
        }
    }
}

/// Removes the vault from this device: stops the backend, deletes the
/// database and the blobs, the extension record and the unlock secret for
/// `email`, forgets the choice and the port, and returns to the picker.
/// Only the vault's own page may call it, while the backend runs.
#[tauri::command]
pub async fn local_vault_delete(app: AppHandle, email: String) -> Result<(), String> {
    may_delete(running_port(&app), &crate::serverurl::current_origin(&app))?;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // The unlock secret is scoped to the origin the window shows, which
        // the check above made the vault's loopback origin.
        let _ = crate::unlock::unlock_secret_delete(app.clone(), email.clone()).await;
    }
    stop(&app).await;
    #[cfg(target_os = "macos")]
    crate::pushsync::stop();
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    crate::serverurl::teardown_previous(&app, email.clone()).await;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let _ = email;
    let vault = vault_dir(&app)?;
    if vault.is_dir() {
        std::fs::remove_dir_all(&vault).map_err(|err| format!("cannot remove the vault: {err}"))?;
    }
    set_enabled(&app, false)?;
    if let Ok(port_file) = config_path(&app, PORT_FILE) {
        let _ = std::fs::remove_file(port_file);
    }
    eprintln!("local mode: vault removed from {}", vault.display());
    crate::serverurl::go_home(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_origin_is_the_loopback_literal() {
        assert_eq!(origin(38765), "http://127.0.0.1:38765");
    }

    #[test]
    fn the_port_file_holds_one_number() {
        assert_eq!(parse_port("38765\n"), Some(38765));
        assert_eq!(parse_port(" 1 "), Some(1));
        assert_eq!(parse_port("0"), None);
        assert_eq!(parse_port(""), None);
        assert_eq!(parse_port("port"), None);
        assert_eq!(parse_port("70000"), None);
    }

    #[test]
    fn the_capability_names_exactly_one_origin() {
        let value: serde_json::Value = serde_json::from_str(&capability_json(38766)).unwrap();
        assert_eq!(value["identifier"], "local-origin-38766");
        assert_eq!(
            value["remote"]["urls"],
            serde_json::json!(["http://127.0.0.1:38766"])
        );
        assert_eq!(value["windows"], serde_json::json!(["main", "main-*"]));
        let text = capability_json(38766);
        assert!(
            !text.contains('*') || text.matches('*').count() == 1,
            "no wildcard origin: {text}"
        );
        assert!(text.contains("\"shell-commands\""));
    }

    #[test]
    fn the_capability_grants_the_main_windows_permissions() {
        // The loopback page gets exactly what the main window's static
        // capability grants, local commands included; a permission added to
        // one and not the other would leave the vault's page without it.
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let local: serde_json::Value = serde_json::from_str(&capability_json(1)).unwrap();
        assert_eq!(local["permissions"], main["permissions"]);
        assert!(main["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "local-commands"));
    }

    #[test]
    fn vault_removal_needs_the_vaults_own_page() {
        assert!(may_delete(None, "http://127.0.0.1:38765").is_err());
        assert!(may_delete(Some(38765), "https://vault.example.com").is_err());
        assert!(may_delete(Some(38765), "http://127.0.0.1:38766").is_err());
        assert!(may_delete(Some(38765), "http://127.0.0.1:38765").is_ok());
    }

    #[test]
    fn a_server_record_means_a_switch_before_local_mode() {
        let server =
            br#"{"origin":"https://vault.example.com","email":"a@example.com","token":"t"}"#;
        assert_eq!(
            server_record_to_tear_down(server),
            Some((
                "https://vault.example.com".to_string(),
                "a@example.com".to_string()
            ))
        );
        let local = br#"{"origin":"http://127.0.0.1:38765","email":"a@example.com","token":"t"}"#;
        assert_eq!(server_record_to_tear_down(local), None);
        assert_eq!(server_record_to_tear_down(b"not json"), None);
    }
}
