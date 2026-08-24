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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

static ACTIVE: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// What the holder is actually doing right now, kept queryable so a
/// freshly loaded window can show the truth without waiting for the
/// next transition. "live" covers a stream that is held OR cycling as
/// a long-poll: either way pokes are arriving. The generation keeps a
/// stopped thread that lingers in a blocked read from stamping state
/// over its replacement.
static CURRENT: Mutex<(u64, FeedState)> = Mutex::new((0, FeedState::Off));
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq)]
pub enum FeedState {
    Off,
    Connecting,
    Live,
    Unavailable,
}

impl FeedState {
    pub fn as_str(self) -> &'static str {
        match self {
            FeedState::Off => "off",
            FeedState::Connecting => "connecting",
            FeedState::Live => "live",
            FeedState::Unavailable => "unavailable",
        }
    }
}

/// The state as of this moment, for the query command.
pub fn state() -> &'static str {
    CURRENT.lock().unwrap().1.as_str()
}

/// Records a transition and tells the web layer only when it changed.
/// A stale generation's report is dropped: the newest holder owns the
/// display.
fn set_state(app: &tauri::AppHandle, generation: u64, state: FeedState) {
    let mut current = CURRENT.lock().unwrap();
    if generation < current.0 || (generation == current.0 && current.1 == state) {
        return;
    }
    *current = (generation, state);
    let _ = app.emit("vault-feed-state", serde_json::json!({ "state": state.as_str() }));
}

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
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("engram-pushsync".into())
        .spawn(move || supervise(app, generation, thread_stop));
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

fn supervise(app: tauri::AppHandle, generation: u64, stop: Arc<AtomicBool>) {
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
    set_state(&app, generation, FeedState::Connecting);
    while !stop.load(Ordering::Relaxed) {
        let outcome = if !crate::network::currently_online() {
            Outcome::Offline
        } else if let Some(record) = read_record() {
            let stream_app = app.clone();
            let mut on_open = || set_state(&stream_app, generation, FeedState::Live);
            let mut on_seq = |seq: u64| {
                // The drive first; an error here just means the domain
                // is gone or busy, and the next poke tries again.
                let _ = crate::filesprovider::signal_for(&record.email);
                let _ = app.emit("vault-changed", serde_json::json!({ "seq": seq }));
            };
            attempt(
                &client,
                &record,
                &stop,
                &mut last_seen,
                &mut on_open,
                &mut on_seq,
            )
        } else {
            Outcome::Failed
        };
        let delay = match outcome {
            Outcome::Served => {
                // A stream that served and cycles is a working feed in
                // long-poll clothing; the state stays live.
                failures = 0;
                5 + jitter(5)
            }
            Outcome::Denied => {
                set_state(&app, generation, FeedState::Unavailable);
                1800 + jitter(300)
            }
            Outcome::Failed => {
                set_state(&app, generation, FeedState::Connecting);
                failures = failures.saturating_add(1);
                (5u64 << failures.min(6)).min(300) + jitter(10)
            }
            Outcome::Offline => {
                set_state(&app, generation, FeedState::Connecting);
                10
            }
        };
        if !wait(&stop, delay) {
            break;
        }
    }
    set_state(&app, generation, FeedState::Off);
}

/// One connection: dial, read events, report each fresh sequence.
/// Everything it touches comes in as arguments, so the whole exchange
/// is provable against a plain local socket.
fn attempt(
    client: &reqwest::blocking::Client,
    record: &Record,
    stop: &AtomicBool,
    last_seen: &mut u64,
    on_open: &mut dyn FnMut(),
    on_seq: &mut dyn FnMut(u64),
) -> Outcome {
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
    on_open();
    let mut served = false;
    for line in BufReader::new(response).lines() {
        if stop.load(Ordering::Relaxed) {
            return Outcome::Served;
        }
        let Ok(line) = line else { break };
        served = true;
        if let Some(seq) = parse_seq(&line) {
            if seq > *last_seen {
                *last_seen = seq;
                on_seq(seq);
            }
        }
    }
    if served {
        Outcome::Served
    } else {
        Outcome::Failed
    }
}

/// The one line shape that matters: `data: {"seq":N}`. Comments,
/// retry hints, and blanks all fall through.
fn parse_seq(line: &str) -> Option<u64> {
    let payload = line.strip_prefix("data:")?;
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("seq")?
        .as_u64()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Serves one canned HTTP response on a fresh port and returns the
    /// origin; the real blocking client dials it like any server.
    fn serve(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let _ = socket.read(&mut request);
                let _ = socket.write_all(response.as_bytes());
            }
        });
        origin
    }

    fn rig(origin: String) -> (reqwest::blocking::Client, Record, AtomicBool) {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let record = Record {
            email: "owner@example.com".into(),
            origin,
            token: "token".into(),
        };
        (client, record, AtomicBool::new(false))
    }

    #[test]
    fn a_stream_reports_each_fresh_sequence_once() {
        let origin = serve(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\nretry: 5000\ndata: {\"seq\":5}\n\n: hb\n\ndata: {\"seq\":5}\n\ndata: {\"seq\":9}\n\n",
        );
        let (client, record, stop) = rig(origin);
        let mut last_seen = 0u64;
        let mut opened = false;
        let mut seen = Vec::new();
        let outcome = attempt(
            &client,
            &record,
            &stop,
            &mut last_seen,
            &mut || opened = true,
            &mut |seq| seen.push(seq),
        );
        assert!(matches!(outcome, Outcome::Served));
        assert!(opened);
        assert_eq!(seen, vec![5, 9]);
        assert_eq!(last_seen, 9);
    }

    #[test]
    fn a_sequence_already_seen_is_not_redelivered() {
        let origin = serve(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: {\"seq\":7}\n\n",
        );
        let (client, record, stop) = rig(origin);
        let mut last_seen = 10u64;
        let mut seen = Vec::new();
        let outcome = attempt(
            &client,
            &record,
            &stop,
            &mut last_seen,
            &mut || {},
            &mut |seq| seen.push(seq),
        );
        assert!(matches!(outcome, Outcome::Served));
        assert!(seen.is_empty());
        assert_eq!(last_seen, 10);
    }

    #[test]
    fn a_refused_session_waits_instead_of_hammering() {
        let origin = serve("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        let (client, record, stop) = rig(origin);
        let mut opened = false;
        let outcome = attempt(&client, &record, &stop, &mut 0, &mut || opened = true, &mut |_| {});
        assert!(matches!(outcome, Outcome::Denied));
        assert!(!opened);
    }

    #[test]
    fn a_server_without_the_feed_reads_as_denied() {
        let origin = serve("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        let (client, record, stop) = rig(origin);
        let outcome = attempt(&client, &record, &stop, &mut 0, &mut || {}, &mut |_| {});
        assert!(matches!(outcome, Outcome::Denied));
    }

    #[test]
    fn a_server_error_is_a_plain_failure() {
        let origin = serve("HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        let (client, record, stop) = rig(origin);
        let outcome = attempt(&client, &record, &stop, &mut 0, &mut || {}, &mut |_| {});
        assert!(matches!(outcome, Outcome::Failed));
    }

    #[test]
    fn an_unreachable_server_is_a_plain_failure() {
        // Bind then drop, so the port is fresh but nothing listens.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let (client, record, stop) = rig(format!("http://127.0.0.1:{port}"));
        let outcome = attempt(&client, &record, &stop, &mut 0, &mut || {}, &mut |_| {});
        assert!(matches!(outcome, Outcome::Failed));
    }

    #[test]
    fn only_event_lines_parse() {
        assert_eq!(parse_seq("data: {\"seq\":42}"), Some(42));
        assert_eq!(parse_seq("data:{\"seq\":1}"), Some(1));
        assert_eq!(parse_seq(": hb"), None);
        assert_eq!(parse_seq("retry: 5000"), None);
        assert_eq!(parse_seq(""), None);
        assert_eq!(parse_seq("data: not json"), None);
    }
}
