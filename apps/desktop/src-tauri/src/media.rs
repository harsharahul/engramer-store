//! Native media path: the webview registers a file's key and token, and the
//! stream:// protocol answers the player's byte-range requests locally,
//! decrypting chunks that a pooled HTTP client fetched ahead in large
//! spans. The per-request round trips that make service-worker streaming
//! stutter in WKWebView never happen here. Keys live only in memory and
//! are cleared when the vault locks.

use crate::egc1;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State, UriSchemeContext, UriSchemeResponder};

/// How many plain chunks each source keeps (24 x 4 MiB = 96 MiB ceiling).
const CACHE_CHUNKS: usize = 24;
/// Extra chunks fetched beyond a miss, so the next bites are already local.
const PREFETCH_CHUNKS: u64 = 8;
/// Largest plain span answered for an open-ended range request.
const MAX_ANSWER_BYTES: u64 = 16 * 1024 * 1024;

struct ChunkCache {
    chunks: HashMap<u64, Arc<Vec<u8>>>,
    order: VecDeque<u64>,
}

impl ChunkCache {
    fn get(&mut self, index: u64) -> Option<Arc<Vec<u8>>> {
        self.chunks.get(&index).cloned()
    }

    fn put(&mut self, index: u64, plain: Arc<Vec<u8>>) {
        if self.chunks.insert(index, plain).is_none() {
            self.order.push_back(index);
        }
        while self.order.len() > CACHE_CHUNKS {
            if let Some(evict) = self.order.pop_front() {
                self.chunks.remove(&evict);
            }
        }
    }
}

pub struct MediaSource {
    key: [u8; 32],
    token: String,
    base: String,
    mime: String,
    header: tokio::sync::Mutex<Option<egc1::Header>>,
    cache: Mutex<ChunkCache>,
    /// Serializes upstream fetches so parallel player requests for nearby
    /// ranges do not race the same span twice.
    fetching: tokio::sync::Mutex<()>,
    /// The on-disk ciphertext store playback warms and pins live in; None
    /// only where the store's directory cannot exist.
    store: Option<crate::offline::OfflineStore>,
    /// One background warm-up in flight at a time; more would just queue
    /// on the fetch lock and hold buffers for nothing.
    warming: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
pub struct MediaState {
    sources: Mutex<HashMap<String, Arc<MediaSource>>>,
}

pub(crate) fn b64_decode(value: &str) -> Result<Vec<u8>, String> {
    // Standard alphabet with or without padding: the web side sends this
    // key through btoa, NOT through toB64 (which is URL-safe unpadded).
    // Switching the sender to toB64 would break decoding here.
    let cleaned: String = value.trim_end_matches('=').to_string();
    let table: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, b) in table.iter().enumerate() {
        lookup[*b as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for byte in cleaned.bytes() {
        let v = lookup[byte as usize];
        if v == 255 {
            return Err("invalid base64".to_string());
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn media_register(
    app: AppHandle,
    state: State<MediaState>,
    file_id: String,
    key: String,
    token: String,
    base: String,
    mime: String,
) -> Result<(), String> {
    let raw = b64_decode(&key)?;
    let key: [u8; 32] = raw
        .try_into()
        .map_err(|_| "key must be 32 bytes".to_string())?;
    let store = crate::offline::offline_root(&app)
        .and_then(crate::offline::OfflineStore::new)
        .ok();
    let source = Arc::new(MediaSource {
        key,
        token,
        base,
        mime,
        header: tokio::sync::Mutex::new(None),
        cache: Mutex::new(ChunkCache {
            chunks: HashMap::new(),
            order: VecDeque::new(),
        }),
        fetching: tokio::sync::Mutex::new(()),
        store,
        warming: std::sync::atomic::AtomicBool::new(false),
    });
    state
        .sources
        .lock()
        .expect("media state")
        .insert(file_id, source);
    Ok(())
}

/// Locking the vault revokes every registered key.
#[tauri::command]
pub fn media_clear(state: State<MediaState>) {
    state.sources.lock().expect("media state").clear();
}

/// The same revocation from Rust, for the server switch.
pub fn clear_all(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<MediaState>() {
        state.sources.lock().expect("media state").clear();
    }
}

/// One authorized ranged fetch, verified, plus the object's total size
/// when the answer names it (a compliant 206 always does). The offline
/// store learns the size from here.
pub(crate) async fn http_span(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    file_id: &str,
    start: u64,
    end: u64,
) -> Result<(Vec<u8>, Option<u64>), String> {
    let url = format!("{base}/api/files/{file_id}/data");
    let mut response = client
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .header("range", format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|err| format!("ciphertext fetch failed: {err}"))?;
    let status = response.status().as_u16();
    if !(status == 206 || status == 200) {
        return Err(format!("ciphertext fetch failed ({status})"));
    }
    // A compliant partial answer names its window; one starting elsewhere
    // would decrypt as garbage, so it is refused, not decoded. A window
    // SHORTER than asked is legitimate - an aligned request can reach past
    // the end of a file whose size is not known yet, and the server clamps
    // - so the response's own declaration decides how many bytes are owed.
    // Its tail also names the object's size, which the offline store wants.
    let mut total: Option<u64> = None;
    let mut owed = end - start + 1;
    if status == 206 {
        if let Some(content_range) = response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
        {
            if !content_range.trim().starts_with(&format!("bytes {start}-")) {
                return Err(format!("the server answered the wrong window ({content_range})"));
            }
            total = content_range
                .rsplit('/')
                .next()
                .and_then(|size| size.trim().parse::<u64>().ok());
            let declared_end = content_range
                .trim()
                .strip_prefix(&format!("bytes {start}-"))
                .and_then(|rest| rest.split('/').next())
                .and_then(|value| value.trim().parse::<u64>().ok());
            if let Some(declared_end) = declared_end {
                if declared_end > end {
                    return Err(format!("the server answered the wrong window ({content_range})"));
                }
                owed = declared_end - start + 1;
            }
        }
    } else {
        total = response.content_length();
        if let Some(total) = total {
            if start >= total {
                return Err(format!("the span starts past the {total} byte object"));
            }
            owed = owed.min(total - start);
        }
    }
    // A 200 ignored the Range and carries the WHOLE object. The old code
    // buffered that body whole and decrypted it at the span's offsets:
    // wrong bytes from the second span on, and hundreds of megabytes
    // resident per request. Read through to the window instead, holding
    // one network chunk beyond it at most, and stop the body there.
    let expected = owed as usize;
    let mut skip = if status == 200 { start as usize } else { 0 };
    let mut span: Vec<u8> = Vec::with_capacity(expected);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("ciphertext body failed: {err}"))?
    {
        let mut piece: &[u8] = &chunk;
        if skip > 0 {
            let dropped = skip.min(piece.len());
            skip -= dropped;
            piece = &piece[dropped..];
        }
        if piece.is_empty() {
            continue;
        }
        let take = piece.len().min(expected - span.len());
        span.extend_from_slice(&piece[..take]);
        if span.len() == expected {
            break;
        }
    }
    if span.len() != expected {
        return Err(format!("read {} bytes of a {expected} byte span", span.len()));
    }
    Ok((span, total))
}

/// A ciphertext span, served from the offline store where its windows are
/// already local, fetched (and remembered) where they are not. This is
/// what turns playback into a disk-warming pass: replays and seeks stop
/// touching the network, and a pinned file answers with none at all.
async fn fetch_span(
    client: &reqwest::Client,
    source: &MediaSource,
    file_id: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    let Some(store) = source.store.as_ref() else {
        return http_span(client, &source.base, &source.token, file_id, start, end)
            .await
            .map(|(bytes, _)| bytes);
    };
    for _ in 0..8 {
        match store.plan_span(file_id, start, end) {
            crate::offline::SpanPlan::Ready => return store.read_span(file_id, start, end),
            crate::offline::SpanPlan::Fetch { from, to } => {
                let (bytes, total) =
                    http_span(client, &source.base, &source.token, file_id, from, to).await?;
                // The player is served straight from this buffer, stitched
                // with disk only for edges the store already held; the write
                // records the window for next time but never gates the
                // answer behind a read-back of what just arrived.
                let answer = assemble_span(store, file_id, start, end, from, &bytes, total);
                store.store_bytes(file_id, from, &bytes, total)?;
                if let Ok(answer) = answer {
                    return Ok(answer);
                }
                // A clamped answer left part of the span unserved; replan
                // over what actually landed.
            }
        }
    }
    Err("the span kept missing windows after fetching them".to_string())
}

/// [start..=end] out of the window `bytes` beginning at `from`, with any
/// prefix the store already holds read from disk. Refuses when the window
/// stops short of the span's end (a clamped answer): the caller replans.
fn assemble_span(
    store: &crate::offline::OfflineStore,
    file_id: &str,
    start: u64,
    end: u64,
    from: u64,
    bytes: &[u8],
    total: Option<u64>,
) -> Result<Vec<u8>, String> {
    let end = match total {
        Some(total) if total > 0 => end.min(total - 1),
        _ => end,
    };
    let fetched_end = from + bytes.len() as u64;
    if end >= fetched_end {
        return Err("the window stops short of the span".to_string());
    }
    let mut out = Vec::with_capacity((end - start + 1) as usize);
    if start < from {
        out.extend_from_slice(&store.read_span(file_id, start, from - 1)?);
    }
    let lo = start.max(from);
    out.extend_from_slice(&bytes[(lo - from) as usize..=(end - from) as usize]);
    Ok(out)
}

/// Warms [start..=end] into the store: fetches only what the plan says is
/// missing, stores it, reads nothing back. Quiet on every failure;
/// read-ahead is an optimization, never a promise.
async fn read_ahead(
    client: &reqwest::Client,
    source: &MediaSource,
    file_id: &str,
    start: u64,
    end: u64,
) {
    let Some(store) = source.store.as_ref() else {
        return;
    };
    if let crate::offline::SpanPlan::Fetch { from, to } = store.plan_span(file_id, start, end) {
        if let Ok((bytes, total)) =
            http_span(client, &source.base, &source.token, file_id, from, to).await
        {
            let _ = store.store_bytes(file_id, from, &bytes, total);
        }
    }
}

/// While the player consumes the chunks just delivered, the next window
/// downloads in the background: a boundary crossing then finds its bytes
/// on disk instead of stalling the stream on a fresh fetch.
fn spawn_read_ahead(
    client: reqwest::Client,
    source: Arc<MediaSource>,
    file_id: String,
    header: egc1::Header,
    first: u64,
    total_chunks: u64,
) {
    use std::sync::atomic::Ordering;
    if first >= total_chunks || source.store.is_none() {
        return;
    }
    let last = (first + PREFETCH_CHUNKS - 1).min(total_chunks - 1);
    if source.warming.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let byte_start = egc1::chunk_offset(first);
        let byte_end = egc1::chunk_offset(last) + egc1::sealed_chunk_len(&header, last) as u64 - 1;
        let _serial = source.fetching.lock().await;
        read_ahead(&client, &source, &file_id, byte_start, byte_end).await;
        source.warming.store(false, Ordering::SeqCst);
    });
}

async fn ensure_header(
    client: &reqwest::Client,
    source: &MediaSource,
    file_id: &str,
) -> Result<egc1::Header, String> {
    let mut guard = source.header.lock().await;
    if let Some(header) = guard.as_ref() {
        return Ok(header.clone());
    }
    let bytes = fetch_span(client, source, file_id, 0, egc1::HEADER_BYTES as u64 - 1).await?;
    let header = egc1::read_header(&bytes)?;
    *guard = Some(header.clone());
    Ok(header)
}

/// Makes chunks [first..=last] present in the cache, fetching the missing
/// tail plus a read-ahead window in one ranged request.
async fn ensure_chunks(
    client: &reqwest::Client,
    source: &Arc<MediaSource>,
    file_id: &str,
    header: &egc1::Header,
    first: u64,
    last: u64,
) -> Result<(), String> {
    let total = egc1::chunk_count(header.plain_size);
    // The fetch lock is for the NETWORK only. A cache or disk hit serves
    // without it: while a background warm-up downloads the next window,
    // the player keeps getting what is already here, or the warm-up
    // would stall the very stream it exists to smooth.
    let cache_miss = {
        let mut cache = source.cache.lock().expect("chunk cache");
        (first..=last).any(|i| cache.get(i).is_none())
    };
    if !cache_miss {
        spawn_read_ahead(
            client.clone(),
            source.clone(),
            file_id.to_string(),
            header.clone(),
            last + 1,
            total,
        );
        return Ok(());
    }
    if let Some(store) = source.store.as_ref() {
        let byte_start = egc1::chunk_offset(first);
        let byte_end = egc1::chunk_offset(last) + egc1::sealed_chunk_len(header, last) as u64 - 1;
        if matches!(
            store.plan_span(file_id, byte_start, byte_end),
            crate::offline::SpanPlan::Ready
        ) {
            let sealed = store.read_span(file_id, byte_start, byte_end)?;
            let mut offset = 0usize;
            for index in first..=last {
                let len = egc1::sealed_chunk_len(header, index);
                if offset + len > sealed.len() {
                    return Err("short ciphertext read".to_string());
                }
                let plain =
                    egc1::decrypt_chunk(header, &source.key, index, &sealed[offset..offset + len])?;
                source
                    .cache
                    .lock()
                    .expect("chunk cache")
                    .put(index, Arc::new(plain));
                offset += len;
            }
            spawn_read_ahead(
                client.clone(),
                source.clone(),
                file_id.to_string(),
                header.clone(),
                last + 1,
                total,
            );
            return Ok(());
        }
    }
    let _serial = source.fetching.lock().await;
    let missing_from = {
        let mut cache = source.cache.lock().expect("chunk cache");
        (first..=last).find(|i| cache.get(*i).is_none())
    };
    let Some(from) = missing_from else {
        return Ok(());
    };
    let to = (last + PREFETCH_CHUNKS).min(total - 1);
    let byte_start = egc1::chunk_offset(from);
    let byte_end = egc1::chunk_offset(to) + egc1::sealed_chunk_len(header, to) as u64 - 1;
    let sealed = fetch_span(client, source, file_id, byte_start, byte_end).await?;
    let mut offset = 0usize;
    for index in from..=to {
        let len = egc1::sealed_chunk_len(header, index);
        if offset + len > sealed.len() {
            return Err("short ciphertext read".to_string());
        }
        let plain = egc1::decrypt_chunk(header, &source.key, index, &sealed[offset..offset + len])?;
        source
            .cache
            .lock()
            .expect("chunk cache")
            .put(index, Arc::new(plain));
        offset += len;
    }
    spawn_read_ahead(
        client.clone(),
        source.clone(),
        file_id.to_string(),
        header.clone(),
        to + 1,
        total,
    );
    Ok(())
}

pub(crate) fn http_client(app: &AppHandle) -> reqwest::Client {
    // One pooled client per app; connection reuse is half the point.
    struct Pooled(reqwest::Client);
    if app.try_state::<Pooled>().is_none() {
        app.manage(Pooled(reqwest::Client::new()));
    }
    app.state::<Pooled>().0.clone()
}

fn respond(responder: UriSchemeResponder, status: u16, headers: &[(&str, String)], body: Vec<u8>) {
    let mut builder = http::Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(*name, value);
    }
    if let Ok(response) = builder.body(body) {
        responder.respond(response);
    }
}

pub fn handle(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let uri = request.uri().clone();
        let file_id = uri.path().trim_start_matches('/').to_string();
        let range_header = request
            .headers()
            .get("range")
            .and_then(|v| v.to_str().ok())
            .map(String::from);

        let source = {
            let state = app.state::<MediaState>();
            let sources = state.sources.lock().expect("media state");
            sources.get(&file_id).cloned()
        };
        let Some(source) = source else {
            return respond(responder, 404, &[], b"unknown media".to_vec());
        };
        let client = http_client(&app);
        let header = match ensure_header(&client, &source, &file_id).await {
            Ok(header) => header,
            Err(err) => return respond(responder, 502, &[], err.into_bytes()),
        };
        let size = header.plain_size;
        let range = crate::ranges::parse_range(range_header.as_deref(), size, MAX_ANSWER_BYTES);
        if range_header.is_some() && range.is_none() {
            return respond(
                responder,
                416,
                &[("content-range", format!("bytes */{size}"))],
                Vec::new(),
            );
        }
        let (start, end) = range.unwrap_or((0, (MAX_ANSWER_BYTES - 1).min(size.saturating_sub(1))));

        let first = start / egc1::CHUNK_SIZE as u64;
        let last = end / egc1::CHUNK_SIZE as u64;
        if let Err(err) = ensure_chunks(&client, &source, &file_id, &header, first, last).await {
            return respond(responder, 502, &[], err.into_bytes());
        }

        let mut body = Vec::with_capacity((end - start + 1) as usize);
        {
            let mut cache = source.cache.lock().expect("chunk cache");
            for index in first..=last {
                let Some(plain) = cache.get(index) else {
                    return respond(responder, 502, &[], b"chunk evicted mid-read".to_vec());
                };
                let chunk_start = index * egc1::CHUNK_SIZE as u64;
                let from = start.max(chunk_start) - chunk_start;
                let to = end.min(chunk_start + plain.len() as u64 - 1) - chunk_start;
                body.extend_from_slice(&plain[from as usize..=to as usize]);
            }
        }
        respond(
            responder,
            206,
            &[
                ("content-type", source.mime.clone()),
                ("accept-ranges", "bytes".to_string()),
                ("content-length", body.len().to_string()),
                ("content-range", format!("bytes {start}-{end}/{size}")),
            ],
            body,
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn canned_source(port: u16) -> MediaSource {
        MediaSource {
            key: [0; 32],
            token: "t".into(),
            base: format!("http://127.0.0.1:{port}"),
            mime: "video/mp4".into(),
            header: tokio::sync::Mutex::new(None),
            cache: Mutex::new(ChunkCache {
                chunks: HashMap::new(),
                order: VecDeque::new(),
            }),
            fetching: tokio::sync::Mutex::new(()),
            store: None,
            warming: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn pattern(size: usize) -> Vec<u8> {
        (0..size).map(|i| ((i * 31 + 7) % 251) as u8).collect()
    }

    fn serve_bytes(status_line: &str, headers: &str, body: Vec<u8>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let head = format!(
            "{status_line}\r\ncontent-length: {}\r\n{headers}\r\n",
            body.len()
        );
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        port
    }

    fn span(port: u16, start: u64, end: u64) -> Result<Vec<u8>, String> {
        tauri::async_runtime::block_on(async {
            let source = canned_source(port);
            http_span(&reqwest::Client::new(), &source.base, &source.token, "f1", start, end)
                .await
                .map(|(bytes, _)| bytes)
        })
    }

    /// Playback warms the disk store: the same span asked twice reaches
    /// the network once. The canned server accepts a single connection,
    /// so a second fetch attempt would fail loudly.
    #[test]
    fn a_replayed_span_is_served_from_disk_not_the_network() {
        let whole = pattern(4096);
        let port = serve_bytes(
            "HTTP/1.1 206 Partial Content",
            &format!("content-range: bytes 0-4095/{}\r\n", whole.len()),
            whole.clone(),
        );
        let root = std::env::temp_dir().join("engram-media-cache-test");
        let _ = std::fs::remove_dir_all(&root);
        let mut source = canned_source(port);
        source.store = Some(crate::offline::OfflineStore::new(root.clone()).unwrap());
        let got = tauri::async_runtime::block_on(async {
            let client = reqwest::Client::new();
            let first = fetch_span(&client, &source, "f1", 100, 200).await?;
            let second = fetch_span(&client, &source, "f1", 150, 300).await?;
            Ok::<_, String>((first, second))
        })
        .unwrap();
        assert_eq!(got.0, whole[100..=200].to_vec());
        assert_eq!(got.1, whole[150..=300].to_vec());
        let _ = std::fs::remove_dir_all(root);
    }

    /// The playback freeze that ended in a memory kill: a backend that
    /// ignored the Range answered 200 with the whole object, the old code
    /// buffered it whole and decrypted the span's offsets against bytes
    /// that started at zero. Wrong frames, then jetsam.
    #[test]
    fn a_range_blind_full_body_yields_the_right_window_not_the_whole() {
        let whole = pattern(4096);
        let port = serve_bytes("HTTP/1.1 200 OK", "", whole.clone());
        let got = span(port, 1000, 1999).unwrap();
        assert_eq!(got.len(), 1000);
        assert_eq!(got, whole[1000..2000].to_vec());
    }

    #[test]
    fn a_compliant_partial_answer_passes_through() {
        let whole = pattern(4096);
        let window = whole[1000..2000].to_vec();
        let port = serve_bytes(
            "HTTP/1.1 206 Partial Content",
            "content-range: bytes 1000-1999/4096\r\n",
            window.clone(),
        );
        assert_eq!(span(port, 1000, 1999).unwrap(), window);
    }

    #[test]
    fn a_partial_answer_for_the_wrong_window_is_refused() {
        let port = serve_bytes(
            "HTTP/1.1 206 Partial Content",
            "content-range: bytes 0-999/4096\r\n",
            pattern(1000),
        );
        let err = span(port, 1000, 1999).unwrap_err();
        assert!(err.contains("wrong window"), "unexpected: {err}");
    }

    #[test]
    fn a_short_body_is_an_error_not_a_short_span() {
        let port = serve_bytes(
            "HTTP/1.1 206 Partial Content",
            "content-range: bytes 1000-1999/4096\r\n",
            pattern(400),
        );
        let err = span(port, 1000, 1999).unwrap_err();
        assert!(err.contains("400 bytes of a 1000"), "unexpected: {err}");
    }

    /// The player is answered from the buffer the network just filled,
    /// stitched with disk only for edges the store already held. A span
    /// whose head is on disk and whose tail just arrived comes out exactly
    /// right; a clamped (short) answer refuses so the caller replans.
    #[test]
    fn a_span_is_assembled_from_the_fetch_buffer_and_present_edges() {
        use crate::offline::SEGMENT;
        let root = std::env::temp_dir().join("engram-media-assemble-test");
        let _ = std::fs::remove_dir_all(&root);
        let store = crate::offline::OfflineStore::new(root.clone()).unwrap();
        let total = SEGMENT * 2;
        let head = pattern(SEGMENT as usize);
        let tail = pattern((SEGMENT as usize) * 2)[SEGMENT as usize..].to_vec();
        store.store_bytes("f1", 0, &head, Some(total)).unwrap();
        // The tail just arrived from the network; nothing read it back.
        let span_start = SEGMENT - 100;
        let span_end = SEGMENT + 99;
        let got = assemble_span(&store, "f1", span_start, span_end, SEGMENT, &tail, Some(total))
            .unwrap();
        let mut expected = head[(SEGMENT - 100) as usize..].to_vec();
        expected.extend_from_slice(&tail[..100]);
        assert_eq!(got, expected);
        // A clamped answer that stops before the span's end cannot serve it.
        assert!(assemble_span(&store, "f1", span_start, span_end, SEGMENT, &tail[..50], Some(total))
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A background warm-up must never make the player wait: chunks the
    /// memory cache already holds are served while the fetch lock is held
    /// by someone else (a read-ahead mid-download, in real life).
    #[test]
    fn cached_chunks_are_served_while_a_warm_up_holds_the_fetch_lock() {
        let source = std::sync::Arc::new(canned_source(1));
        source
            .cache
            .lock()
            .unwrap()
            .put(0, Arc::new(vec![7u8; 16]));
        let header = egc1::Header {
            plain_size: 16,
            bytes: [0; egc1::HEADER_BYTES],
        };
        tauri::async_runtime::block_on(async {
            let _warming = source.fetching.lock().await;
            let served = tokio::time::timeout(
                std::time::Duration::from_millis(300),
                ensure_chunks(&reqwest::Client::new(), &source, "f1", &header, 0, 0),
            )
            .await;
            assert!(served.is_ok(), "a cache hit waited on the fetch lock");
            assert!(served.unwrap().is_ok());
        });
    }

    /// Chunks the disk store already holds decrypt and serve without the
    /// fetch lock too: only an actual network need queues behind warming.
    #[test]
    fn disk_present_chunks_are_served_while_a_warm_up_holds_the_fetch_lock() {
        let plain = pattern(16 * 1024);
        let cipher = engram_core::chunked::encrypt(&plain, &[0u8; 32], &[1u8; 16]);
        let header = egc1::read_header(&cipher).unwrap();
        let root = std::env::temp_dir().join("engram-media-diskserve-test");
        let _ = std::fs::remove_dir_all(&root);
        let store = crate::offline::OfflineStore::new(root.clone()).unwrap();
        store
            .store_bytes("f1", 0, &cipher, Some(cipher.len() as u64))
            .unwrap();
        let mut source = canned_source(1);
        source.store = Some(crate::offline::OfflineStore::new(root.clone()).unwrap());
        let source = std::sync::Arc::new(source);
        tauri::async_runtime::block_on(async {
            let _warming = source.fetching.lock().await;
            let served = tokio::time::timeout(
                std::time::Duration::from_millis(300),
                ensure_chunks(&reqwest::Client::new(), &source, "f1", &header, 0, 0),
            )
            .await;
            assert!(served.is_ok(), "a disk hit waited on the fetch lock");
            assert!(served.unwrap().is_ok());
        });
        let chunk = source.cache.lock().unwrap().get(0).unwrap();
        assert_eq!(chunk.as_slice(), &plain[..]);
        let _ = std::fs::remove_dir_all(root);
    }

    /// Read-ahead fills the store while the player is busy elsewhere: after
    /// one call, the next window's plan answers Ready with no further
    /// network. The canned server accepts a single connection, so a second
    /// fetch would fail loudly.
    #[test]
    fn read_ahead_lands_the_next_window_in_the_store() {
        use crate::offline::SEGMENT;
        let whole = pattern((SEGMENT * 2) as usize);
        let window = whole[SEGMENT as usize..].to_vec();
        let port = serve_bytes(
            "HTTP/1.1 206 Partial Content",
            &format!("content-range: bytes {}-{}/{}\r\n", SEGMENT, SEGMENT * 2 - 1, SEGMENT * 2),
            window,
        );
        let root = std::env::temp_dir().join("engram-media-readahead-test");
        let _ = std::fs::remove_dir_all(&root);
        let mut source = canned_source(port);
        source.store = Some(crate::offline::OfflineStore::new(root.clone()).unwrap());
        let source = std::sync::Arc::new(source);
        let store = crate::offline::OfflineStore::new(root.clone()).unwrap();
        store
            .store_bytes("f1", 0, &whole[..SEGMENT as usize], Some(SEGMENT * 2))
            .unwrap();
        tauri::async_runtime::block_on(async {
            read_ahead(&reqwest::Client::new(), &source, "f1", SEGMENT, SEGMENT * 2 - 1).await;
        });
        assert!(matches!(
            store.plan_span("f1", SEGMENT, SEGMENT * 2 - 1),
            crate::offline::SpanPlan::Ready
        ));
        // Already-present spans are left alone: no network, no disk churn.
        tauri::async_runtime::block_on(async {
            read_ahead(&reqwest::Client::new(), &source, "f1", 0, SEGMENT - 1).await;
        });
        let _ = std::fs::remove_dir_all(root);
    }
}
