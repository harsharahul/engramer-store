//! Desktop shell for the Engram Store web client. The webview loads the
//! hosted app; every cryptographic operation stays inside it, exactly as in
//! a browser. Native code adds only what a browser cannot: a tray presence
//! that survives the window closing, launch at login, and an unlock secret
//! kept in the Keychain behind Touch ID.

mod unlock;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            unlock::native_unlock_available,
            unlock::unlock_secret_store,
            unlock::unlock_secret_get,
            unlock::unlock_secret_delete,
        ])
        .setup(|app| {
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let open_item = MenuItem::with_id(app, "open", "Open Engram Store", true, None::<&str>)?;
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
                    &PredefinedMenuItem::separator(app)?,
                    &autostart_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
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
        })
        // Closing the window parks the app in the tray; Quit lives there.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the dock icon after the window was closed reopens it.
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
}
