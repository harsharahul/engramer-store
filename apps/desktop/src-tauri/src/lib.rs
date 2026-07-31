/// Desktop shell for the Engram Store web client. The webview loads the
/// hosted app; every cryptographic operation stays inside it, exactly as in
/// a browser. Native code adds only what a browser cannot: presence in the
/// tray, and (in later phases) folder watching and Keychain unlock.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
