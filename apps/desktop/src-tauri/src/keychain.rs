//! Raw keychain items with an explicit accessibility class and, on iOS, a
//! shared access group.
//!
//! The `security-framework` crate's password helpers cannot set
//! `kSecAttrAccessible`, and an item stored without one defaults to
//! "when unlocked", which restores onto a different device through an
//! encrypted backup. Everything this app persists is
//! when-unlocked-THIS-DEVICE-only and never synchronizable, so the raw
//! `SecItem` calls are made here directly, in one reviewed place.

#![cfg(any(target_os = "macos", target_os = "ios"))]

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use security_framework_sys::base::errSecItemNotFound;
use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecReturnData,
    kSecValueData,
};
use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};
use std::ffi::c_void;

// Public Security.framework symbols the sys crate does not re-export.
extern "C" {
    static kSecAttrAccessible: *const c_void;
    static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: *const c_void;
    static kSecAttrSynchronizable: *const c_void;
    #[cfg(target_os = "ios")]
    static kSecAttrAccessGroup: *const c_void;
}

/// The keychain access group shared by the app and its extensions:
/// `<team id>.<bundle id>`. Only meaningful on iOS; macOS items stay
/// app-private.
#[cfg(target_os = "ios")]
const ACCESS_GROUP: &str = "5MD7MFXN8S.com.harsharahul.engramstore";

fn cf_str(sym: *const c_void) -> CFString {
    unsafe { CFString::wrap_under_get_rule(sym.cast()) }
}

fn base_pairs(service: &str, account: &str) -> Vec<(CFString, CFType)> {
    let mut pairs: Vec<(CFString, CFType)> = vec![
        (
            cf_str(unsafe { kSecClass.cast() }),
            cf_str(unsafe { kSecClassGenericPassword.cast() }).as_CFType(),
        ),
        (
            cf_str(unsafe { kSecAttrService.cast() }),
            CFString::new(service).as_CFType(),
        ),
        (
            cf_str(unsafe { kSecAttrAccount.cast() }),
            CFString::new(account).as_CFType(),
        ),
    ];
    #[cfg(target_os = "ios")]
    pairs.push((
        cf_str(unsafe { kSecAttrAccessGroup }),
        CFString::new(ACCESS_GROUP).as_CFType(),
    ));
    pairs
}

fn as_query(pairs: Vec<(CFString, CFType)>) -> CFDictionary<CFString, CFType> {
    CFDictionary::from_CFType_pairs(&pairs)
}

pub fn store(service: &str, account: &str, value: &[u8]) -> Result<(), String> {
    // Replace-then-add keeps this idempotent; an update dance buys nothing.
    let _ = delete(service, account);
    let mut pairs = base_pairs(service, account);
    pairs.push((
        cf_str(unsafe { kSecValueData.cast() }),
        CFData::from_buffer(value).as_CFType(),
    ));
    pairs.push((
        cf_str(unsafe { kSecAttrAccessible }),
        cf_str(unsafe { kSecAttrAccessibleWhenUnlockedThisDeviceOnly }).as_CFType(),
    ));
    pairs.push((
        cf_str(unsafe { kSecAttrSynchronizable }),
        CFBoolean::false_value().as_CFType(),
    ));
    let status = unsafe { SecItemAdd(as_query(pairs).as_concrete_TypeRef(), std::ptr::null_mut()) };
    if status != 0 {
        return Err(format!("keychain add failed ({status})"));
    }
    Ok(())
}

pub fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
    let mut pairs = base_pairs(service, account);
    pairs.push((
        cf_str(unsafe { kSecReturnData.cast() }),
        CFBoolean::true_value().as_CFType(),
    ));
    let mut result: *const c_void = std::ptr::null();
    let status = unsafe {
        SecItemCopyMatching(
            as_query(pairs).as_concrete_TypeRef(),
            &mut result as *mut *const c_void as *mut _,
        )
    };
    if status == errSecItemNotFound {
        return Ok(None);
    }
    if status != 0 {
        return Err(format!("keychain read failed ({status})"));
    }
    let data = unsafe { CFData::wrap_under_create_rule(result.cast()) };
    Ok(Some(data.bytes().to_vec()))
}

/// The extensions' own lookup shape: service and access group, no
/// account. Run inside the app, this tells whether the shared item is
/// visible the way the extensions ask for it; the answer separates "the
/// record was never stored" from "the group itself is refused".
pub fn probe(service: &str) -> Result<Option<usize>, String> {
    Ok(read_any(service)?.map(|data| data.len()))
}

/// The record itself through the same account-less lookup, for app code
/// that acts on the extensions' behalf (draining their staged uploads).
pub fn read_any(service: &str) -> Result<Option<Vec<u8>>, String> {
    let mut pairs: Vec<(CFString, CFType)> = vec![
        (
            cf_str(unsafe { kSecClass.cast() }),
            cf_str(unsafe { kSecClassGenericPassword.cast() }).as_CFType(),
        ),
        (
            cf_str(unsafe { kSecAttrService.cast() }),
            CFString::new(service).as_CFType(),
        ),
        (
            cf_str(unsafe { kSecReturnData.cast() }),
            CFBoolean::true_value().as_CFType(),
        ),
    ];
    #[cfg(target_os = "ios")]
    pairs.push((
        cf_str(unsafe { kSecAttrAccessGroup }),
        CFString::new(ACCESS_GROUP).as_CFType(),
    ));
    let mut result: *const c_void = std::ptr::null();
    let status = unsafe {
        SecItemCopyMatching(
            as_query(pairs).as_concrete_TypeRef(),
            &mut result as *mut *const c_void as *mut _,
        )
    };
    if status == errSecItemNotFound {
        return Ok(None);
    }
    if status != 0 {
        return Err(format!("keychain probe failed ({status})"));
    }
    let data = unsafe { CFData::wrap_under_create_rule(result.cast()) };
    Ok(Some(data.bytes().to_vec()))
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    let status =
        unsafe { SecItemDelete(as_query(base_pairs(service, account)).as_concrete_TypeRef()) };
    if status != 0 && status != errSecItemNotFound {
        return Err(format!("keychain delete failed ({status})"));
    }
    Ok(())
}
