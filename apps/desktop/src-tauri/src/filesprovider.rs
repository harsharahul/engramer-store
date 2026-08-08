//! Registers and removes the File Provider domain, the vault's presence
//! in the Files app. Only the containing app may do this; the extension
//! cannot register itself. Called when the owner turns the extension
//! handoff on or off (and on sign-out), so the drive appears exactly
//! when there is a key to read it with.
//!
//! FileProvider.framework has no objc2 binding in the pinned family, so
//! the two calls are made through the runtime directly. The framework is
//! linked here rather than through the Xcode project's framework list, to
//! keep the generated project untouched.

#[cfg(target_os = "ios")]
#[link(name = "FileProvider", kind = "framework")]
extern "C" {}

/// A stable, opaque domain id: base64url of BLAKE2b-256 of the email, so
/// the address never lands in a system-visible path. The display name is
/// the visible part.
#[cfg(target_os = "ios")]
fn domain_identifier(email: &str) -> String {
    engram_core::b64::to_b64url(&engram_core::backend::generichash(32, email.as_bytes()))
}

#[tauri::command]
pub async fn files_provider_available() -> bool {
    cfg!(target_os = "ios")
}

#[tauri::command]
pub async fn files_provider_enable(email: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        return apple::add_domain(&domain_identifier(&email), "Engram Store");
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = email;
        Err("File Provider is iOS only".into())
    }
}

/// Nudges the Files app to re-enumerate the domain. Called after the
/// handoff record is (re)written, so a provider instance that came up
/// before the key existed stops showing "not signed in" the moment the
/// app has reconnected it.
#[tauri::command]
pub async fn files_provider_signal(email: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        return apple::signal_domain(&domain_identifier(&email));
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = email;
        Ok(())
    }
}

#[tauri::command]
pub async fn files_provider_disable(email: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        return apple::remove_domain(&domain_identifier(&email));
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = email;
        Ok(())
    }
}

#[cfg(target_os = "ios")]
mod apple {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObject};
    use objc2::{msg_send, ClassType};
    use objc2_foundation::NSString;
    use std::sync::mpsc;

    /// Builds NSFileProviderDomain(identifier:displayName:).
    unsafe fn make_domain(identifier: &str, display_name: &str) -> Option<Retained<NSObject>> {
        let class = AnyClass::get(c"NSFileProviderDomain")?;
        let id_str = NSString::from_str(identifier);
        let name_str = NSString::from_str(display_name);
        let alloc: *mut AnyObject = msg_send![class, alloc];
        let domain: *mut NSObject = msg_send![
            alloc,
            initWithIdentifier: &*id_str,
            displayName: &*name_str,
        ];
        Retained::from_raw(domain)
    }

    /// The NSFileProviderManager add/remove calls share this completion
    /// bridge: an optional NSError back over a channel, so the async Tauri
    /// command can report a real result rather than fire-and-forget.
    unsafe fn run(selector_add: bool, domain: &NSObject) -> Result<(), String> {
        let manager = AnyClass::get(c"NSFileProviderManager")
            .ok_or_else(|| "NSFileProviderManager unavailable".to_string())?;
        let (tx, rx) = mpsc::channel::<Option<String>>();
        let handler = RcBlock::new(move |error: *mut AnyObject| {
            let message = if error.is_null() {
                None
            } else {
                let desc: *const NSString = msg_send![error, localizedDescription];
                Some(
                    desc.as_ref()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "unknown error".into()),
                )
            };
            let _ = tx.send(message);
        });
        if selector_add {
            let _: () = msg_send![manager, addDomain: domain, completionHandler: &*handler];
        } else {
            let _: () = msg_send![manager, removeDomain: domain, completionHandler: &*handler];
        }
        match rx.recv() {
            Ok(None) => Ok(()),
            Ok(Some(message)) => Err(message),
            Err(_) => Err("File Provider call did not complete".into()),
        }
    }

    pub fn add_domain(identifier: &str, display_name: &str) -> Result<(), String> {
        unsafe {
            let domain = make_domain(identifier, display_name)
                .ok_or_else(|| "could not build the File Provider domain".to_string())?;
            run(true, &domain)
        }
    }

    pub fn remove_domain(identifier: &str) -> Result<(), String> {
        unsafe {
            // Remove only needs an identifier-shaped domain; the display
            // name is ignored by removeDomain.
            let domain = make_domain(identifier, "Engram Store")
                .ok_or_else(|| "could not build the File Provider domain".to_string())?;
            run(false, &domain)
        }
    }

    // NSFileProviderItemIdentifier constants (NSString under the typedef).
    extern "C" {
        static NSFileProviderRootContainerItemIdentifier: &'static NSString;
        static NSFileProviderWorkingSetContainerItemIdentifier: &'static NSString;
    }

    /// Asks the system to re-enumerate the domain's root and working set.
    /// Both are signaled; an error from one container (typically "no one
    /// is enumerating it right now") does not veto the other.
    pub fn signal_domain(identifier: &str) -> Result<(), String> {
        unsafe {
            let domain = make_domain(identifier, "Engram Store")
                .ok_or_else(|| "could not build the File Provider domain".to_string())?;
            let class = AnyClass::get(c"NSFileProviderManager")
                .ok_or_else(|| "NSFileProviderManager unavailable".to_string())?;
            let manager: *mut AnyObject = msg_send![class, managerForDomain: &*domain];
            if manager.is_null() {
                return Err("no manager for the File Provider domain".into());
            }
            let mut errors: Vec<String> = Vec::new();
            for container in [
                NSFileProviderRootContainerItemIdentifier,
                NSFileProviderWorkingSetContainerItemIdentifier,
            ] {
                let (tx, rx) = mpsc::channel::<Option<String>>();
                let handler = RcBlock::new(move |error: *mut AnyObject| {
                    let message = if error.is_null() {
                        None
                    } else {
                        let desc: *const NSString = msg_send![error, localizedDescription];
                        Some(
                            desc.as_ref()
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| "unknown error".into()),
                        )
                    };
                    let _ = tx.send(message);
                });
                let _: () = msg_send![
                    manager,
                    signalEnumeratorForContainerItemIdentifier: container,
                    completionHandler: &*handler,
                ];
                match rx.recv() {
                    Ok(None) => {}
                    Ok(Some(message)) => errors.push(message),
                    Err(_) => errors.push("signal did not complete".into()),
                }
            }
            if errors.len() == 2 {
                return Err(errors.join("; "));
            }
            Ok(())
        }
    }
}
