//! The current network path, from Network.framework's monitor. The web
//! view can only see online or offline, so "Wi-Fi only" was a checkbox
//! with no way to keep its word; the interface type lives here. One
//! monitor runs for the app's lifetime and remembers the latest path;
//! the first query waits briefly for the initial update and then
//! answers honestly with `known: false` rather than blocking a caller
//! on a radio that is not answering.

/// What the monitor last saw. `known` is false until the first update
/// lands; consumers decide their own fallback (the web app fails open,
/// because backup quietly never running is the dishonest failure).
#[derive(serde::Serialize, Clone, Copy, Default)]
pub struct NetworkStatus {
    pub known: bool,
    pub online: bool,
    pub wifi: bool,
    pub wired: bool,
    pub cellular: bool,
    pub expensive: bool,
    pub constrained: bool,
}

/// The monitor's answer for in-process callers: offline only when it
/// has actually said so; an unanswered first query fails open, the
/// same stance the web layer takes.
#[cfg(target_os = "macos")]
pub(crate) fn currently_online() -> bool {
    let status = apple::current();
    !status.known || status.online
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use super::NetworkStatus;
    use std::ffi::c_void;
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::time::Duration;

    // Network.framework's C interface; no objc2 binding crate covers it,
    // so the four calls used are declared here directly.
    #[link(name = "Network", kind = "framework")]
    extern "C" {
        fn nw_path_monitor_create() -> *mut c_void;
        fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
        fn nw_path_monitor_set_update_handler(
            monitor: *mut c_void,
            handler: &block2::Block<dyn Fn(*mut c_void)>,
        );
        fn nw_path_monitor_start(monitor: *mut c_void);
        fn nw_path_get_status(path: *mut c_void) -> i32;
        fn nw_path_uses_interface_type(path: *mut c_void, interface_type: i32) -> bool;
        fn nw_path_is_expensive(path: *mut c_void) -> bool;
        fn nw_path_is_constrained(path: *mut c_void) -> bool;
    }
    extern "C" {
        fn dispatch_queue_create(
            label: *const std::os::raw::c_char,
            attr: *const c_void,
        ) -> *mut c_void;
    }

    /// `nw_path_status_satisfied`.
    const STATUS_SATISFIED: i32 = 1;
    /// `nw_interface_type_{wifi, cellular, wired}`.
    const INTERFACE_WIFI: i32 = 1;
    const INTERFACE_CELLULAR: i32 = 2;
    const INTERFACE_WIRED: i32 = 3;

    /// How long the very first query may wait for the monitor's initial
    /// update. The monitor reports within milliseconds in practice; the
    /// cap exists because nothing here is allowed to block unbounded.
    const FIRST_UPDATE_MS: u64 = 700;

    static STATE: OnceLock<&'static (Mutex<NetworkStatus>, Condvar)> = OnceLock::new();

    fn state() -> &'static (Mutex<NetworkStatus>, Condvar) {
        STATE.get_or_init(|| {
            let pair: &'static (Mutex<NetworkStatus>, Condvar) =
                Box::leak(Box::new((Mutex::new(NetworkStatus::default()), Condvar::new())));
            start_monitor(pair);
            pair
        })
    }

    fn start_monitor(pair: &'static (Mutex<NetworkStatus>, Condvar)) {
        unsafe {
            let monitor = nw_path_monitor_create();
            let queue = dispatch_queue_create(
                b"com.harsharahul.engramstore.network\0".as_ptr().cast(),
                std::ptr::null(),
            );
            let handler: block2::RcBlock<dyn Fn(*mut c_void)> =
                block2::RcBlock::new(move |path: *mut c_void| {
                    let report = NetworkStatus {
                        known: true,
                        online: nw_path_get_status(path) == STATUS_SATISFIED,
                        wifi: nw_path_uses_interface_type(path, INTERFACE_WIFI),
                        wired: nw_path_uses_interface_type(path, INTERFACE_WIRED),
                        cellular: nw_path_uses_interface_type(path, INTERFACE_CELLULAR),
                        expensive: nw_path_is_expensive(path),
                        constrained: nw_path_is_constrained(path),
                    };
                    *pair.0.lock().unwrap() = report;
                    pair.1.notify_all();
                });
            nw_path_monitor_set_queue(monitor, queue);
            // The framework copies the handler; ours may drop after this.
            nw_path_monitor_set_update_handler(monitor, &handler);
            nw_path_monitor_start(monitor);
            // The monitor deliberately lives as long as the app does.
        }
    }

    pub fn current() -> NetworkStatus {
        let (lock, cvar) = state();
        let guard = lock.lock().unwrap();
        if guard.known {
            return *guard;
        }
        let (guard, _lapsed) = cvar
            .wait_timeout(guard, Duration::from_millis(FIRST_UPDATE_MS))
            .unwrap();
        *guard
    }
}

#[tauri::command]
pub async fn network_status() -> Result<NetworkStatus, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return tauri::async_runtime::spawn_blocking(apple::current)
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Err("no network monitor on this platform".into())
    }
}
