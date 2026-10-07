//! The change feed, as the server serves it: `GET /api/events` streams a
//! content-free `data: {"seq":N}` poke whenever the account's data moves,
//! starting with the current sequence. Pokes are noted only after a write
//! commits, coalesced per account over 150 ms, and an account keeps at
//! most 16 streams (a 17th ends the oldest). A heartbeat comment keeps
//! proxies from idling the line out and ends the stream once the session
//! is revoked or the account disabled.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use rusqlite::{params, OptionalExtension};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::error::ApiError;
use crate::extract::{blocking, AuthUser};
use crate::server::AppState;

/// Pokes for one account within this window collapse into one.
pub const FLUSH_MS: u64 = 150;
/// Streams an account may hold at once.
pub const STREAMS_PER_USER: usize = 16;

struct Sink {
    id: u64,
    tx: mpsc::UnboundedSender<Bytes>,
}

#[derive(Default)]
struct Inner {
    sinks: HashMap<i64, Vec<Sink>>,
    pending: HashMap<i64, i64>,
    flush_armed: bool,
    next_id: u64,
    /// Set while the server stops: new streams end at once.
    closed: bool,
}

/// The per-process poke hub.
#[derive(Default)]
pub struct SeqEvents {
    inner: Mutex<Inner>,
}

/// A stream's registration; dropping it unsubscribes and stops the
/// stream's heartbeat, so nothing outlives the stream it served.
pub struct Subscription {
    hub: Arc<SeqEvents>,
    user: i64,
    id: u64,
    heartbeat: Option<AbortHandle>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
        self.hub.remove(self.user, self.id);
    }
}

impl SeqEvents {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records that `user`'s data reached `seq`; the poke goes out at the
    /// next flush, carrying the highest sequence noted meanwhile.
    pub fn note(self: &Arc<Self>, user: i64, seq: i64) {
        let arm = {
            let mut inner = self.lock();
            if matches!(inner.pending.get(&user), Some(&held) if held >= seq) {
                return;
            }
            inner.pending.insert(user, seq);
            let arm = !inner.flush_armed;
            inner.flush_armed = true;
            arm
        };
        if arm {
            let hub = Arc::clone(self);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(FLUSH_MS)).await;
                hub.deliver();
            });
        }
    }

    /// A new stream for `user`, ending the oldest when the account already
    /// holds the maximum. While the hub is closed the stream ends at once.
    pub fn subscribe(
        self: &Arc<Self>,
        user: i64,
    ) -> (Subscription, mpsc::UnboundedReceiver<Bytes>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut inner = self.lock();
        inner.next_id += 1;
        let id = inner.next_id;
        if !inner.closed {
            let sinks = inner.sinks.entry(user).or_default();
            while sinks.len() >= STREAMS_PER_USER {
                // Dropping the sender ends that stream.
                sinks.remove(0);
            }
            sinks.push(Sink { id, tx });
        }
        let subscription = Subscription {
            hub: Arc::clone(self),
            user,
            id,
            heartbeat: None,
        };
        (subscription, rx)
    }

    /// Streams currently open for `user`.
    pub fn streams(&self, user: i64) -> usize {
        self.lock().sinks.get(&user).map_or(0, Vec::len)
    }

    /// Ends every stream and refuses new ones until `reopen`, so a stopping
    /// server is held open neither by its streams nor by a request that
    /// subscribes while it stops.
    pub fn close_all(&self) {
        let mut inner = self.lock();
        inner.closed = true;
        inner.pending.clear();
        inner.sinks.clear();
    }

    /// Accepts streams again; a server calls it when it starts.
    pub fn reopen(&self) {
        self.lock().closed = false;
    }

    fn remove(&self, user: i64, id: u64) {
        let mut inner = self.lock();
        if let Some(sinks) = inner.sinks.get_mut(&user) {
            sinks.retain(|sink| sink.id != id);
            if sinks.is_empty() {
                inner.sinks.remove(&user);
            }
        }
    }

    fn deliver(&self) {
        let mut inner = self.lock();
        inner.flush_armed = false;
        let batch: Vec<(i64, i64)> = inner.pending.drain().collect();
        for (user, seq) in batch {
            if let Some(sinks) = inner.sinks.get_mut(&user) {
                let poke = Bytes::from(format!("data: {{\"seq\":{seq}}}\n\n"));
                sinks.retain(|sink| sink.tx.send(poke.clone()).is_ok());
            }
        }
    }
}

/// The account's current sequence.
pub fn last_seq(conn: &rusqlite::Connection, user: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT last_seq FROM users WHERE id = ?1",
        params![user],
        |r| r.get(0),
    )
}

/// `GET /api/events`: subscribed before the current sequence is read, so
/// a write committing in between is never missed.
pub async fn stream(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Response, ApiError> {
    let (mut subscription, rx) = state.events.subscribe(auth.uid);
    let seq = blocking(&state, move |store| Ok(last_seq(&store.conn(), auth.uid)?)).await?;
    subscription.heartbeat = Some(spawn_heartbeat(Arc::clone(&state), auth, subscription.id));
    let first = Bytes::from(format!("retry: 5000\ndata: {{\"seq\":{seq}}}\n\n"));
    // The subscription lives in the stream's state: when the client goes
    // away the body is dropped and the account's stream count falls.
    let pokes =
        futures_util::stream::unfold((rx, subscription), |(mut rx, subscription)| async move {
            rx.recv()
                .await
                .map(|bytes| (Ok::<_, Infallible>(bytes), (rx, subscription)))
        });
    let body = futures_util::StreamExt::chain(
        futures_util::stream::once(async move { Ok::<_, Infallible>(first) }),
        pokes,
    );
    let mut response = Response::new(Body::from_stream(body));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

/// Every heartbeat interval: end the stream if the session was revoked or
/// the account disabled, otherwise write a comment line. The stream's
/// subscription aborts the task when the stream ends.
fn spawn_heartbeat(state: Arc<AppState>, auth: AuthUser, id: u64) -> AbortHandle {
    let period = Duration::from_millis(state.config.events_heartbeat_ms.max(10));
    let hub = Arc::clone(&state.events);
    let task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(period);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let Some(tx) = hub.sender(auth.uid, id) else {
                return;
            };
            let uid = auth.uid;
            let row = blocking(&state, move |store| {
                Ok(store
                    .conn()
                    .query_row(
                        "SELECT disabled, token_epoch FROM users WHERE id = ?1",
                        params![uid],
                        |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
                    )
                    .optional()?)
            })
            .await;
            let revoked = match row {
                Ok(Some((disabled, epoch))) => disabled == Some(1) || epoch.unwrap_or(0) != auth.ep,
                _ => true,
            };
            if revoked || tx.send(Bytes::from_static(b": hb\n\n")).is_err() {
                hub.remove(auth.uid, id);
                return;
            }
        }
    });
    task.abort_handle()
}

impl SeqEvents {
    fn sender(&self, user: i64, id: u64) -> Option<mpsc::UnboundedSender<Bytes>> {
        self.lock()
            .sinks
            .get(&user)?
            .iter()
            .find(|sink| sink.id == id)
            .map(|sink| sink.tx.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn coalesces_a_burst_into_one_poke_with_the_highest_seq() {
        runtime().block_on(async {
            let hub = Arc::new(SeqEvents::default());
            let (_sub, mut rx) = hub.subscribe(1);
            for seq in [3, 5, 4] {
                hub.note(1, seq);
            }
            let poke = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&poke[..], b"data: {\"seq\":5}\n\n");
            tokio::time::sleep(Duration::from_millis(FLUSH_MS + 50)).await;
            assert!(rx.try_recv().is_err(), "one poke only");
        });
    }

    #[test]
    fn pokes_only_the_account_whose_data_moved() {
        runtime().block_on(async {
            let hub = Arc::new(SeqEvents::default());
            let (_a, mut a) = hub.subscribe(1);
            let (_b, mut b) = hub.subscribe(2);
            hub.note(1, 7);
            tokio::time::sleep(Duration::from_millis(FLUSH_MS + 50)).await;
            assert!(a.try_recv().is_ok());
            assert!(b.try_recv().is_err());
        });
    }

    #[test]
    fn a_seventeenth_stream_ends_the_oldest() {
        runtime().block_on(async {
            let hub = Arc::new(SeqEvents::default());
            let (first_sub, mut first) = hub.subscribe(1);
            let mut rest = Vec::new();
            for _ in 0..STREAMS_PER_USER {
                rest.push(hub.subscribe(1));
            }
            assert_eq!(hub.streams(1), STREAMS_PER_USER);
            assert!(first.recv().await.is_none(), "the oldest stream ended");
            drop(first_sub);
            assert_eq!(hub.streams(1), STREAMS_PER_USER);
        });
    }

    #[test]
    fn dropping_a_subscription_unsubscribes_and_close_all_ends_every_stream() {
        runtime().block_on(async {
            let hub = Arc::new(SeqEvents::default());
            let (sub, _rx) = hub.subscribe(1);
            assert_eq!(hub.streams(1), 1);
            drop(sub);
            assert_eq!(hub.streams(1), 0);
            let (_keep, mut rx) = hub.subscribe(2);
            hub.close_all();
            assert!(rx.recv().await.is_none());
        });
    }

    #[test]
    fn a_closed_hub_ends_new_streams_at_once_until_reopened() {
        // A feed request already past authentication when the server stops
        // subscribes after close_all; it must not keep the server open.
        runtime().block_on(async {
            let hub = Arc::new(SeqEvents::default());
            hub.close_all();
            let (_late, mut late) = hub.subscribe(1);
            let ended = tokio::time::timeout(Duration::from_millis(500), late.recv()).await;
            assert!(matches!(ended, Ok(None)), "a closed hub keeps no stream");
            assert_eq!(hub.streams(1), 0);
            hub.reopen();
            let (_sub, mut rx) = hub.subscribe(1);
            hub.note(1, 3);
            let poke = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&poke[..], b"data: {\"seq\":3}\n\n");
        });
    }

    /// Registers an account over HTTP and returns its session token.
    fn signed_in(port: u16, email: &str) -> String {
        let sb = r#"{"ciphertext":"c","nonce":"n"}"#;
        let attributes = format!(
            r#"{{"kdf":{{"salt":"0123456789abcdef","opsLimit":3,"memLimit":268435456}},"encryptedMasterKey":{sb},"masterKeyEncryptedWithRecoveryKey":{sb},"recoveryKeyEncryptedWithMasterKey":{sb},"publicKey":"p","encryptedPrivateKey":{sb}}}"#
        );
        let body = format!(
            r#"{{"email":"{email}","loginKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","keyAttributes":{attributes}}}"#
        );
        let host = format!("127.0.0.1:{port}");
        let (status, _, body) =
            crate::server::tests::raw(port, "POST", "/api/auth/register", &host, Some(&body));
        assert_eq!(status, 201);
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        value["token"].as_str().unwrap().to_string()
    }

    /// Opens the change feed over a raw connection and reads its first event.
    fn open_feed(port: u16, token: &str) -> std::net::TcpStream {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n"
        )
        .unwrap();
        let mut seen = Vec::new();
        let mut chunk = [0u8; 1024];
        while !String::from_utf8_lossy(&seen).contains("data: {\"seq\":") {
            let n = stream.read(&mut chunk).unwrap();
            assert!(n > 0, "the feed closed before its first event");
            seen.extend_from_slice(&chunk[..n]);
        }
        stream
    }

    #[test]
    fn stopping_the_server_ends_a_held_feed_promptly() {
        use std::io::Read;
        let mut server = crate::server::tests::Running::new();
        let token = signed_in(server.port, "held@example.com");
        let mut stream = open_feed(server.port, &token);
        let bound = server.bound.take().unwrap();
        let started = std::time::Instant::now();
        server
            .rt
            .block_on(async { tokio::time::timeout(Duration::from_secs(3), bound.stop()).await })
            .expect("stop waited on the held feed");
        assert!(started.elapsed() < Duration::from_secs(3));
        let mut rest = Vec::new();
        stream
            .read_to_end(&mut rest)
            .expect("the client sees the feed end");
    }

    #[test]
    fn stopping_the_server_releases_the_vault_promptly() {
        // Nothing may hold the vault once the server has stopped: the shell
        // may delete or replace the vault's files right after.
        let dir = crate::server::tests::temp_dir("release");
        let state = Arc::new(
            AppState::open(crate::server::ServerConfig {
                data_dir: dir.clone(),
                quota_bytes: 512 * 1024,
                events_heartbeat_ms: 25_000,
                max_versions: 10,
                max_blob_bytes: 20 * 1024 * 1024 * 1024,
            })
            .unwrap(),
        );
        let rt = tokio::runtime::Runtime::new().unwrap();
        let bound = rt
            .block_on(crate::server::start(
                crate::server::bind(0).unwrap(),
                Arc::clone(&state),
            ))
            .unwrap();
        let token = signed_in(bound.port, "release@example.com");
        let stream = open_feed(bound.port, &token);
        rt.block_on(bound.stop());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while Arc::strong_count(&state) > 1 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let holders = Arc::strong_count(&state);
        drop(stream);
        drop(state);
        drop(rt);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(holders, 1, "a task still holds the vault after stop");
    }

    #[test]
    fn a_server_started_again_on_the_same_vault_keeps_its_feeds() {
        let dir = crate::server::tests::temp_dir("restart");
        let state = Arc::new(
            AppState::open(crate::server::ServerConfig {
                data_dir: dir.clone(),
                quota_bytes: 512 * 1024,
                events_heartbeat_ms: 25_000,
                max_versions: 10,
                max_blob_bytes: 20 * 1024 * 1024 * 1024,
            })
            .unwrap(),
        );
        let rt = tokio::runtime::Runtime::new().unwrap();
        let start = |state: &Arc<AppState>| {
            rt.block_on(crate::server::start(
                crate::server::bind(0).unwrap(),
                Arc::clone(state),
            ))
            .unwrap()
        };
        let first = start(&state);
        let token = signed_in(first.port, "again@example.com");
        rt.block_on(first.stop());
        let second = start(&state);
        let stream = open_feed(second.port, &token);
        let open = state.events.streams(1);
        drop(stream);
        rt.block_on(second.stop());
        drop(state);
        drop(rt);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(open, 1, "the restarted server keeps the feed open");
    }
}
