//! Holds the server's change feed so the Finder drive stays fresh while
//! the window is hidden or closed. The web layer's own refresh runs only
//! while its view is visible, and Finder asks the extension rarely; this
//! thread is the piece that hears "your account moved" from the server
//! and passes it on: a signal to the File Provider domain, and an event
//! into the web view for whenever it is watching.
//!
//! It authenticates exactly as the extension does, from the shared
//! handoff record, reread before every connection so a token the app
//! refreshed is picked up. The feed itself carries only sequence
//! numbers; everything of substance still arrives through the same
//! sync pull every client already runs.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

static ACTIVE: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Starts the holder if it is not already running. Called from the
/// drive's enable and signal commands, which the web layer invokes on
/// every launch and sign-in, so the thread exists whenever the drive
/// does without anyone owning a startup step.
pub fn ensure_running(app: &tauri::AppHandle) {
    let mut active = ACTIVE.lock().unwrap();
    if active.is_some() {
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("engram-pushsync".into())
        .spawn(move || supervise(app, thread_stop));
    if spawned.is_ok() {
        *active = Some(stop);
    }
}

/// Ends the holder; the thread notices within one read timeout. Called
/// when the drive is disabled and when the handoff record is cleared.
pub fn stop() {
    if let Some(flag) = ACTIVE.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

struct Record {
    email: String,
    origin: String,
    token: String,
}

enum Outcome {
    /// The stream served lines before ending; reconnect promptly.
    Served,
    /// The server refused the session or has no feed; only a fresh
    /// token or an upgraded server changes that, so wait long.
    Denied,
    /// Could not connect or the stream died silently.
    Failed,
    /// No network; not the server's fault, poll again shortly.
    Offline,
}

fn supervise(app: tauri::AppHandle, stop: Arc<AtomicBool>) {
    // One deadline covers connecting AND each body read: the blocking
    // client applies it per read, so a silent connection dies within
    // ~three missed server heartbeats and the loop reconnects.
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
    else {
        return;
    };
    let mut last_seen: u64 = 0;
    let mut failures: u32 = 0;
    while !stop.load(Ordering::Relaxed) {
        let delay = match attempt(&app, &client, &stop, &mut last_seen) {
            Outcome::Served => {
                failures = 0;
                5 + jitter(5)
            }
            Outcome::Denied => 1800 + jitter(300),
            Outcome::Failed => {
                failures = failures.saturating_add(1);
                (5u64 << failures.min(6)).min(300) + jitter(10)
            }
            Outcome::Offline => 10,
        };
        if !wait(&stop, delay) {
            return;
        }
    }
}

fn attempt(
    app: &tauri::AppHandle,
    client: &reqwest::blocking::Client,
    stop: &AtomicBool,
    last_seen: &mut u64,
) -> Outcome {
    if !crate::network::currently_online() {
        return Outcome::Offline;
    }
    let Some(record) = read_record() else {
        return Outcome::Failed;
    };
    let response = client
        .get(format!("{}/api/events", record.origin))
        .header("authorization", format!("Bearer {}", record.token))
        .header("accept", "text/event-stream")
        .send();
    let response = match response {
        Ok(response) => response,
        Err(_) => return Outcome::Failed,
    };
    match response.status().as_u16() {
        200 => {}
        401 | 403 | 404 => return Outcome::Denied,
        _ => return Outcome::Failed,
    }
    let mut served = false;
    for line in BufReader::new(response).lines() {
        if stop.load(Ordering::Relaxed) {
            return Outcome::Served;
        }
        let Ok(line) = line else { break };
        served = true;
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };
        let Some(seq) = value.get("seq").and_then(|v| v.as_u64()) else {
            continue;
        };
        if seq > *last_seen {
            *last_seen = seq;
            // The drive first; an error here just means the domain is
            // gone or busy, and the next poke tries again.
            let _ = crate::filesprovider::signal_for(&record.email);
            let _ = app.emit("vault-changed", serde_json::json!({ "seq": seq }));
        }
    }
    if served {
        Outcome::Served
    } else {
        Outcome::Failed
    }
}

/// The same record the extension reads, by the same account-less query.
fn read_record() -> Option<Record> {
    let bytes = crate::keychain::read_any(crate::handoff::SERVICE).ok()??;
    let value = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
    let field = |name: &str| value.get(name)?.as_str().map(str::to_owned);
    let record = Record {
        email: field("email")?,
        origin: field("origin")?,
        token: field("token")?,
    };
    if !record.origin.starts_with("http") {
        return None;
    }
    Some(record)
}

/// Sleeps in one-second steps so a stop is honored promptly. Returns
/// false when stopped.
fn wait(stop: &AtomicBool, seconds: u64) -> bool {
    for _ in 0..seconds {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    !stop.load(Ordering::Relaxed)
}

/// Spreads reconnections out without a randomness dependency.
fn jitter(max: u64) -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    nanos % max.max(1)
}
