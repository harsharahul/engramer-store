//! Native shell for the Engram Store web client. The webview loads the
//! hosted app; every cryptographic operation stays inside it, exactly as in
//! a browser. Native code adds only what a browser cannot. On desktop that
//! is a tray presence that survives the window closing, launch at login,
//! watched folders, and an unlock secret kept in the Keychain behind Touch
//! ID; on iOS it is the decrypting media path, with the rest arriving as
//! the mobile shell grows into them.

mod chrome;
mod egc1;
mod filesprovider;
mod handoff;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod keychain;
mod media;
mod network;
mod outbox;
mod photolib;
mod photos;
mod pickedstream;
mod ranges;
mod serverurl;
mod unlock;
mod watched;

use std::sync::{Arc, Mutex};
#[cfg(desktop)]
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
#[cfg(desktop)]
use tauri::WindowEvent;
#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    // Regular first: an accessory app owns no menu bar, and the window
    // needs one for the standard Edit shortcuts to reach the web view.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Parks the app in the tray: window hidden, and on macOS the Dock icon
/// goes too, the way the other drives on this machine behave. The tray
/// stays; Open undoes all of it.
#[cfg(desktop)]
fn hide_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// The tray menu, the desktop app's resting state. iOS has no tray; there
/// the app simply lives on the home screen.
#[cfg(desktop)]
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let open_item = MenuItem::with_id(app, "open", "Open Engram Store", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "Hide to tray", true, None::<&str>)?;
    let refresh_item = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Engram Store", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &hide_item,
            &refresh_item,
            &PredefinedMenuItem::separator(app)?,
            &autostart_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;
    // A template glyph, not the app tile: the menu bar tints template
    // icons to match light and dark, the way every neighbor up there
    // behaves; a full-color tile reads as a sore thumb.
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "hide" => hide_main(app),
            "refresh" => {
                // Reload picks up a freshly deployed frontend and clears
                // any in-page state without losing the session.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
                show_main(app);
            }
            "autostart" => {
                let launcher = app.autolaunch();
                let now_on = launcher.is_enabled().unwrap_or(false);
                let _ = if now_on {
                    launcher.disable()
                } else {
                    launcher.enable()
                };
                let _ = autostart_item.set_checked(!now_on);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        None,
    ));
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage::<watched::SharedWatchState>(Arc::new(Mutex::new(Default::default())))
        .manage(media::MediaState::default())
        .register_asynchronous_uri_scheme_protocol("stream", media::handle)
        .register_asynchronous_uri_scheme_protocol("picked", pickedstream::handle)
        .invoke_handler(tauri::generate_handler![
            photos::pick_photos,
            photos::pick_photos_with_ids,
            photos::picked_file_read,
            photos::picked_probe,
            photos::picked_file_stat,
            photos::picked_file_read_range,
            photos::picked_file_delete,
            photos::picked_sweep,
            unlock::native_unlock_available,
            unlock::unlock_secret_store,
            unlock::unlock_secret_get,
            unlock::unlock_secret_delete,
            watched::watched_folders,
            watched::watched_add,
            watched::watched_remove,
            watched::watched_scan,
            watched::watched_file_read,
            watched::watched_file_stat,
            watched::watched_file_read_range,
            media::media_register,
            media::media_clear,
            handoff::handoff_available,
            handoff::handoff_store,
            handoff::handoff_get,
            handoff::handoff_probe,
            handoff::handoff_clear,
            filesprovider::files_provider_available,
            filesprovider::files_provider_enable,
            filesprovider::files_provider_signal,
            filesprovider::files_provider_disable,
            outbox::outbox_drain,
            photolib::photos_available,
            photolib::photos_authorize,
            photolib::photos_list,
            photolib::photos_export,
            serverurl::server_url_get,
            serverurl::server_url_set,
            serverurl::server_url_clear,
            network::network_status,
        ])
        .setup(|app| {
            watched::rebuild_watchers(app.handle());
            // The window's first URL is "home": the bundled picker in a
            // generic build, the baked deployment otherwise. Clearing the
            // server override returns to it.
            let home = app.get_webview_window("main").and_then(|w| w.url().ok());
            app.manage(serverurl::HomeUrl(home));
            serverurl::apply_stored(app.handle());
            #[cfg(target_os = "ios")]
            if let Some(window) = app.get_webview_window("main") {
                chrome::extend_under_safe_area(&window);
            }
            #[cfg(desktop)]
            install_tray(app)?;
            Ok(())
        })
        // Closing the window parks the app in the tray; Quit lives there.
        // iOS windows never close, they background, so only desktop hooks in.
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_main(&window.app_handle());
            }
            // Rotation can hand the scroll view a fresh inset; re-assert.
            #[cfg(target_os = "ios")]
            if let tauri::WindowEvent::Resized(_) = event {
                if let Some(webview) = window.app_handle().get_webview_window("main") {
                    chrome::extend_under_safe_area(&webview);
                }
            }
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the dock icon after the window was closed reopens it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
