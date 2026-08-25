//! Native device unlock: an opaque secret in the keychain, released only
//! after a LocalAuthentication check. On a Mac that is Touch ID or the
//! login password; on an iPhone it is Face ID or the passcode, through the
//! same two frameworks. The secret means nothing on its own; the web layer
//! wraps the vault keys under a key derived from it, so neither side alone
//! can open anything.

/// One secret per server and account: the keychain account attribute
/// carries the origin, so the same email on two vaults can never hand one
/// server the other's secret.
fn scoped_account(origin: &str, email: &str) -> String {
    format!("{origin}|{email}")
}

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

    pub fn store(origin: &str, email: &str, secret: &str) -> Result<(), String> {
        authenticate("set up device unlock for your vault")?;
        // Through keychain.rs so the item carries an explicit
        // when-unlocked-this-device-only class; the old helper stored it
        // with the default class, which restores onto other devices via
        // encrypted backup.
        crate::keychain::store(SERVICE, &super::scoped_account(origin, email), secret.as_bytes())
    }

    pub fn get(origin: &str, email: &str) -> Result<String, String> {
        authenticate("unlock your vault")?;
        let scoped = super::scoped_account(origin, email);
        if let Some(bytes) = crate::keychain::get(SERVICE, &scoped)? {
            return String::from_utf8(bytes).map_err(|_| "stored secret is corrupt".to_string());
        }
        // Migrations, adopt-by-move. A pre-scoping item (account = bare
        // email) can only be reached here by the origin whose enrollment
        // predates the scoping: any later enrollment wrote a scoped item
        // and returns above before ever falling through. Moving the item
        // (rewrite scoped, drop the bare copy) makes the adoption
        // one-time and unambiguous.
        if let Some(bytes) = crate::keychain::get(SERVICE, email)? {
            crate::keychain::store(SERVICE, &scoped, &bytes)?;
            let _ = crate::keychain::delete(SERVICE, email);
            return String::from_utf8(bytes).map_err(|_| "stored secret is corrupt".to_string());
        }
        // Oldest generation: stored by the password helper with the
        // default accessibility class.
        let legacy = passwords::get_generic_password(SERVICE, email)
            .map_err(|err| format!("keychain has no unlock secret: {err}"))?;
        crate::keychain::store(SERVICE, &scoped, &legacy)?;
        let _ = passwords::delete_generic_password(SERVICE, email);
        String::from_utf8(legacy).map_err(|_| "stored secret is corrupt".to_string())
    }

    pub fn delete(origin: &str, email: &str) -> Result<(), String> {
        // Only this origin's item. The bare-email generations are NOT
        // ours to destroy: with the same address registered on two
        // servers they may belong to the other server's enrollment,
        // and a sign-out here must not break Touch ID there. A truly
        // legacy item left behind is inert without its web record and
        // is adopted or replaced by the migration path in get().
        crate::keychain::delete(SERVICE, &super::scoped_account(origin, email))
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
pub async fn unlock_secret_store(
    app: tauri::AppHandle,
    email: String,
    secret: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let origin = crate::serverurl::current_origin(&app);
        tauri::async_runtime::spawn_blocking(move || apple::store(&origin, &email, &secret))
            .await
            .map_err(|err| err.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (app, email, secret);
        Err("not supported on this platform".to_string())
    }
}

#[tauri::command]
pub async fn unlock_secret_get(app: tauri::AppHandle, email: String) -> Result<String, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let origin = crate::serverurl::current_origin(&app);
        tauri::async_runtime::spawn_blocking(move || apple::get(&origin, &email))
            .await
            .map_err(|err| err.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (app, email);
        Err("not supported on this platform".to_string())
    }
}

#[tauri::command]
pub async fn unlock_secret_delete(app: tauri::AppHandle, email: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let origin = crate::serverurl::current_origin(&app);
        tauri::async_runtime::spawn_blocking(move || apple::delete(&origin, &email))
            .await
            .map_err(|err| err.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (app, email);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::scoped_account;

    #[test]
    fn the_scoped_account_carries_the_origin() {
        assert_eq!(
            scoped_account("https://vault.example.com", "a@example.com"),
            "https://vault.example.com|a@example.com"
        );
        assert_ne!(
            scoped_account("https://one.example.com", "a@example.com"),
            scoped_account("https://two.example.com", "a@example.com"),
        );
    }
}
