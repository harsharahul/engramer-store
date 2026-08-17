//! The handoff record: what an app extension needs to act for the account
//! with no web view running. The web layer builds the payload (master key,
//! token, origin, account keys) and owns every cryptographic decision;
//! this module only moves the sealed envelope in and out of the shared
//! keychain item, device-unlock protected, this-device-only, never in
//! iCloud. Written only after the owner turns on "Extensions on this
//! device"; removed on sign-out, kept through a lock on purpose (the
//! whole point is working while the app is closed).

use tauri::async_runtime::spawn_blocking;

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) const SERVICE: &str = "com.harsharahul.engramstore.handoff";

#[tauri::command]
pub fn handoff_available() -> bool {
    cfg!(any(target_os = "macos", target_os = "ios"))
}

#[tauri::command]
pub async fn handoff_store(email: String, payload: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return spawn_blocking(move || {
            // One record, ever: the extensions read "the record" with no
            // account, so a different account's leftover must not survive
            // a new sign-in as a second, ambiguous item.
            if let Ok(Some(existing)) = crate::keychain::read_any(SERVICE) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&existing) {
                    if let Some(prior) = value.get("email").and_then(|v| v.as_str()) {
                        if prior != email {
                            let _ = crate::keychain::delete_shared(SERVICE, prior);
                        }
                    }
                }
            }
            crate::keychain::store_shared(SERVICE, &email, payload.as_bytes())
        })
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (email, payload);
        Err("no shared keychain on this platform".into())
    }
}

#[tauri::command]
pub async fn handoff_get(email: String) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let found = spawn_blocking(move || crate::keychain::get_shared(SERVICE, &email))
            .await
            .map_err(|e| e.to_string())??;
        return match found {
            None => Ok(None),
            Some(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "handoff record is not utf8".to_string()),
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = email;
        Ok(None)
    }
}

/// Runs the same query shape the extensions use (service and access
/// group, no account) and reports what it finds: the stored record's
/// byte count, `None` when nothing is stored, or the keychain's refusal.
/// This is the in-app connection check for the Extensions setting.
#[tauri::command]
pub async fn handoff_probe() -> Result<Option<usize>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return spawn_blocking(|| crate::keychain::probe(SERVICE))
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub async fn handoff_clear(email: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return spawn_blocking(move || crate::keychain::delete_shared(SERVICE, &email))
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = email;
        Ok(())
    }
}
