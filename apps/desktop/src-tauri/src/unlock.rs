//! Native device unlock: an opaque secret in the keychain, released only
//! after a LocalAuthentication check. On a Mac that is Touch ID or the
//! login password; on an iPhone it is Face ID or the passcode, through the
//! same two frameworks. The secret means nothing on its own; the web layer
//! wraps the vault keys under a key derived from it, so neither side alone
//! can open anything.

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use block2::RcBlock;
    use objc2_foundation::NSString;
    use objc2_local_authentication::{LAContext, LAPolicy};
    use security_framework::passwords;
    use std::sync::mpsc;

    const SERVICE: &str = "com.harsharahul.engramstore.unlock";

    pub fn available() -> bool {
        unsafe {
            let context = LAContext::new();
            context
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
                .is_ok()
        }
    }

    /// Runs the system authentication prompt and blocks until it settles.
    fn authenticate(reason: &str) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        unsafe {
            let context = LAContext::new();
            let reason = NSString::from_str(reason);
            let reply = RcBlock::new(
                move |ok: objc2::runtime::Bool, _error: *mut objc2_foundation::NSError| {
                    let _ = tx.send(if ok.as_bool() {
                        Ok(())
                    } else {
                        Err("authentication cancelled".to_string())
                    });
                },
            );
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &reason,
                &reply,
            );
        }
        rx.recv()
            .map_err(|_| "authentication interrupted".to_string())?
    }

    pub fn store(email: &str, secret: &str) -> Result<(), String> {
        authenticate("set up device unlock for your vault")?;
        // Through keychain.rs so the item carries an explicit
        // when-unlocked-this-device-only class; the old helper stored it
        // with the default class, which restores onto other devices via
        // encrypted backup.
        crate::keychain::store(SERVICE, email, secret.as_bytes())
    }

    pub fn get(email: &str) -> Result<String, String> {
        authenticate("unlock your vault")?;
        if let Some(bytes) = crate::keychain::get(SERVICE, email)? {
            return String::from_utf8(bytes).map_err(|_| "stored secret is corrupt".to_string());
        }
        // Migration: an item stored by the old helper (default
        // accessibility) is read once, rewritten with the strict class,
        // and the legacy copy dropped.
        let legacy = passwords::get_generic_password(SERVICE, email)
            .map_err(|err| format!("keychain has no unlock secret: {err}"))?;
        crate::keychain::store(SERVICE, email, &legacy)?;
        String::from_utf8(legacy).map_err(|_| "stored secret is corrupt".to_string())
    }

    pub fn delete(email: &str) -> Result<(), String> {
        // Both generations of the item; either may exist.
        let _ = passwords::delete_generic_password(SERVICE, email);
        crate::keychain::delete(SERVICE, email)
    }
}

#[tauri::command]
pub fn native_unlock_available() -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        apple::available()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        false
    }
}

#[tauri::command]
pub async fn unlock_secret_store(email: String, secret: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        tauri::async_runtime::spawn_blocking(move || apple::store(&email, &secret))
            .await
            .map_err(|err| err.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (email, secret);
        Err("not supported on this platform".to_string())
    }
}

#[tauri::command]
pub async fn unlock_secret_get(email: String) -> Result<String, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        tauri::async_runtime::spawn_blocking(move || apple::get(&email))
            .await
            .map_err(|err| err.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = email;
        Err("not supported on this platform".to_string())
    }
}

#[tauri::command]
pub async fn unlock_secret_delete(email: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        tauri::async_runtime::spawn_blocking(move || apple::delete(&email))
            .await
            .map_err(|err| err.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = email;
        Ok(())
    }
}
