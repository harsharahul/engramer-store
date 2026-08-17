//! A runtime server override: one binary, many servers.
//!
//! The build bakes a default vault address, but the person holding the
//! app decides where their vault actually lives. The override is stored
//! beside the app's other configuration and applied at startup, and the
//! login screen offers it, so a device pointed at the wrong server can be
//! repointed without a rebuild, and a self-hoster can use the stock app.
//! A generic build bakes no server at all: its window opens a bundled
//! picker page, and everything below is what makes that page work.

use std::fs;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The window's very first URL, captured at setup: the bundled picker page
/// in a generic build, the baked deployment otherwise. Clearing the
/// override returns here.
pub struct HomeUrl(pub Option<url::Url>);

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("server-url.txt"))
        .map_err(|err| err.to_string())
}

/// Accepts what a person actually types: a bare hostname gets https://
/// assumed, and the rest of the URL is dropped with the origin later.
/// Plain http is honored only for localhost, because the shell's IPC
/// allowance is https-only and an http vault would "work" with Touch ID,
/// the drive, and handoff all silently missing.
fn parse_input(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("enter your server address".to_string());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&candidate).map_err(|_| "not a valid URL".to_string())?;
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" => {
            let local = match parsed.host() {
                Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            };
            if local {
                Ok(parsed)
            } else {
                Err("plain http is only supported for localhost; use https".to_string())
            }
        }
        _ => Err("the server address must be http(s)".to_string()),
    }
}

fn host_of(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| origin.to_string())
}

/// Asks the address to prove it is an Engram Store server before the shell
/// commits to it. Redirects are followed and the final origin is what gets
/// adopted, so the stored server is where the vault actually answers.
fn probe_health(origin: &str) -> Result<String, String> {
    let host = host_of(origin);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client.get(format!("{origin}/api/health")).send().map_err(|err| {
        if err.is_timeout() {
            format!("{host} took too long to answer")
        } else {
            format!("could not reach {host}")
        }
    })?;
    let final_origin = response.url().origin().ascii_serialization();
    let looks_wrong = format!("{host} answered, but it does not look like an Engram Store server");
    if !response.status().is_success() {
        return Err(looks_wrong);
    }
    let body = response.text().unwrap_or_default();
    if body.contains("\"status\":\"ok\"") {
        Ok(final_origin)
    } else {
        Err(looks_wrong)
    }
}

/// The origin the main window is actually on; the unlock items are scoped
/// by it. The local picker page has an opaque origin that serializes as
/// "null", which is fine: nothing on it touches secrets.
pub fn current_origin(app: &AppHandle) -> String {
    app.get_webview_window("main")
        .and_then(|window| window.url().ok())
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|| "null".to_string())
}

/// What a server switch must tear down first: the extension record and
/// everything hanging off it. `None` when there is no record or it
/// already belongs to the target origin.
fn switch_teardown_needed(record: &[u8], new_origin: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_slice(record).ok()?;
    let origin = value.get("origin")?.as_str()?.to_string();
    let email = value.get("email")?.as_str()?.to_string();
    (origin != new_origin).then_some((origin, email))
}

/// A switch removes real things from this device, so it says which, and
/// asks, before anything happens.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn confirm_switch(app: &AppHandle, new_origin: &str, old_origin: &str) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let message = format!(
        "Switch this app to {}?\n\nThe drive and extension access for {} will be removed from this device. Files on that server are not affected.",
        host_of(new_origin),
        host_of(old_origin)
    );
    let dialog = app
        .dialog()
        .message(message)
        .title("Switch server")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Switch".to_string(),
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

/// Best effort, ordered so a crash midway leaves honest state: the
/// extension key goes first (a keyless drive says "not signed in" rather
/// than serving the old vault), then the drive itself, then the
/// in-process registries and staged uploads.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn teardown_previous(app: &AppHandle, email: String) {
    let record_email = email.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        crate::keychain::delete_shared(crate::handoff::SERVICE, &record_email)
    })
    .await;
    let _ = crate::filesprovider::files_provider_disable(email).await;
    crate::media::clear_all(app);
    let _ = tauri::async_runtime::spawn_blocking(crate::outbox::clear_staging).await;
}

fn navigate_main(app: &AppHandle, url: url::Url) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window.navigate(url).map_err(|err| err.to_string())
}

/// A generic build's window starts on a bundled page instead of a baked
/// deployment; that difference is read from the configuration itself so it
/// can never drift from what was actually built.
fn generic_build(app: &AppHandle) -> bool {
    app.config()
        .app
        .windows
        .first()
        .map(|window| matches!(&window.url, tauri::WebviewUrl::App(_)))
        .unwrap_or(false)
}

/// Returns to the bundled picker page with the failure spelled out, so an
/// unreachable server is an honest state instead of a blank window. Only
/// meaningful while the window still shows the local page.
fn back_to_picker(app: &AppHandle, error: &str, origin: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(mut home) = window.url() else { return };
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("error", error)
        .append_pair("origin", origin)
        .finish();
    home.set_query(Some(&query));
    let _ = navigate_main(app, home);
}

/// Applied during setup, before the baked page has meaningfully loaded. A
/// baked build navigates immediately, exactly as it always has. A generic
/// build first asks the stored server to answer, off the main thread, and
/// lands back on the picker with the reason when it will not: there is no
/// baked page behind it to fall back to.
pub fn apply_stored(app: &AppHandle) {
    let Ok(path) = store_path(app) else { return };
    let Ok(stored) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(url) = parse_input(&stored) else { return };
    if !generic_build(app) {
        let _ = navigate_main(app, url);
        return;
    }
    let origin = url.origin().ascii_serialization();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let probe_origin = origin.clone();
        let outcome =
            tauri::async_runtime::spawn_blocking(move || probe_health(&probe_origin)).await;
        match outcome {
            Ok(Ok(final_origin)) => {
                if let Ok(target) = url::Url::parse(&final_origin) {
                    let _ = navigate_main(&handle, target);
                }
            }
            Ok(Err(message)) => back_to_picker(&handle, &message, &origin),
            Err(err) => back_to_picker(&handle, &err.to_string(), &origin),
        }
    });
}

/// The stored override, if any; the login screen and the picker show it.
#[tauri::command]
pub fn server_url_get(app: AppHandle) -> Option<String> {
    let path = store_path(&app).ok()?;
    let stored = fs::read_to_string(path).ok()?;
    let trimmed = stored.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Verifies, persists and navigates to the override. The probe runs before
/// anything is written, so a typo never becomes the stored server.
#[tauri::command]
pub async fn server_url_set(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = parse_input(&url)?;
    let origin = parsed.origin().ascii_serialization();
    let final_origin = tauri::async_runtime::spawn_blocking(move || probe_health(&origin))
        .await
        .map_err(|err| err.to_string())??;
    // Pointing at a different vault than the one the extensions hold a
    // key for is a real switch: confirm it, then take the old server's
    // presence off this device before the new one is written.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let record = tauri::async_runtime::spawn_blocking(|| {
            crate::keychain::read_any(crate::handoff::SERVICE)
        })
        .await
        .map_err(|err| err.to_string())?
        .unwrap_or_default();
        if let Some(bytes) = record {
            if let Some((old_origin, old_email)) = switch_teardown_needed(&bytes, &final_origin) {
                confirm_switch(&app, &final_origin, &old_origin).await?;
                teardown_previous(&app, old_email).await;
            }
        }
    }
    let path = store_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&path, &final_origin).map_err(|err| err.to_string())?;
    let target = url::Url::parse(&final_origin).map_err(|err| err.to_string())?;
    navigate_main(&app, target)
}

/// Removes the override and returns to the build's own starting page: the
/// baked deployment, or the bundled picker in a generic build.
#[tauri::command]
pub fn server_url_clear(app: AppHandle) -> Result<(), String> {
    let path = store_path(&app)?;
    let _ = fs::remove_file(path);
    if let Some(home) = app.try_state::<HomeUrl>().and_then(|state| state.0.clone()) {
        return navigate_main(&app, home);
    }
    let default = app
        .config()
        .app
        .windows
        .first()
        .map(|window| window.url.to_string())
        .ok_or_else(|| "no configured window".to_string())?;
    let target = url::Url::parse(&default).map_err(|_| "no usable default page".to_string())?;
    navigate_main(&app, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn a_bare_hostname_is_assumed_https() {
        let parsed = parse_input("vault.example.com").unwrap();
        assert_eq!(parsed.origin().ascii_serialization(), "https://vault.example.com");
    }

    #[test]
    fn paths_and_case_collapse_to_the_origin() {
        let parsed = parse_input("  https://Vault.Example.com:8443/some/path?q=1 ").unwrap();
        assert_eq!(
            parsed.origin().ascii_serialization(),
            "https://vault.example.com:8443"
        );
    }

    #[test]
    fn http_is_only_for_localhost() {
        assert!(parse_input("http://localhost:3080").is_ok());
        assert!(parse_input("http://127.0.0.1:3080").is_ok());
        assert!(parse_input("http://[::1]:3080").is_ok());
        let refused = parse_input("http://vault.example.com").unwrap_err();
        assert!(refused.contains("https"), "{refused}");
        assert!(parse_input("http://192.168.1.20:3080").is_err());
    }

    #[test]
    fn a_switch_is_only_a_switch_when_the_origin_changes() {
        let record = br#"{"v":1,"email":"a@example.com","origin":"https://one.example.com"}"#;
        assert_eq!(
            switch_teardown_needed(record, "https://two.example.com"),
            Some(("https://one.example.com".into(), "a@example.com".into()))
        );
        assert_eq!(switch_teardown_needed(record, "https://one.example.com"), None);
    }

    #[test]
    fn an_unreadable_record_never_triggers_teardown() {
        assert_eq!(switch_teardown_needed(b"not json", "https://x.example.com"), None);
        assert_eq!(switch_teardown_needed(br#"{"v":1}"#, "https://x.example.com"), None);
    }

    #[test]
    fn junk_is_refused_plainly() {
        assert!(parse_input("").is_err());
        assert!(parse_input("   ").is_err());
        assert!(parse_input("ftp://vault.example.com").is_err());
        assert!(parse_input("https://").is_err());
    }

    fn serve_once(response: String) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    fn http_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn the_probe_accepts_a_real_health_answer() {
        let port = serve_once(http_response("200 OK", "{\"status\":\"ok\"}"));
        let origin = format!("http://127.0.0.1:{port}");
        assert_eq!(probe_health(&origin).unwrap(), origin);
    }

    #[test]
    fn the_probe_rejects_a_page_that_is_not_a_vault() {
        let port = serve_once(http_response("200 OK", "<html>welcome</html>"));
        let refused = probe_health(&format!("http://127.0.0.1:{port}")).unwrap_err();
        assert!(refused.contains("does not look like"), "{refused}");
    }

    #[test]
    fn the_probe_rejects_an_http_error() {
        let port = serve_once(http_response("404 Not Found", "{}"));
        let refused = probe_health(&format!("http://127.0.0.1:{port}")).unwrap_err();
        assert!(refused.contains("does not look like"), "{refused}");
    }

    #[test]
    fn the_probe_reports_an_unreachable_host() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let refused = probe_health(&format!("http://127.0.0.1:{port}")).unwrap_err();
        assert!(refused.contains("could not reach"), "{refused}");
    }

    #[test]
    fn the_probe_follows_redirects_and_adopts_the_final_origin() {
        let destination = serve_once(http_response("200 OK", "{\"status\":\"ok\"}"));
        let hop = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let location = format!("http://127.0.0.1:{destination}/api/health");
            thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf);
                    let response = format!(
                        "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            port
        };
        let adopted = probe_health(&format!("http://127.0.0.1:{hop}")).unwrap();
        assert_eq!(adopted, format!("http://127.0.0.1:{destination}"));
    }
}
