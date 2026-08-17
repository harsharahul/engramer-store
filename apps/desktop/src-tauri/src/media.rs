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
}

#[derive(Default)]
pub struct MediaState {
    sources: Mutex<HashMap<String, Arc<MediaSource>>>,
}

fn b64_decode(value: &str) -> Result<Vec<u8>, String> {
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

fn parse_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    let header = header?.trim();
    let rest = header.strip_prefix("bytes=")?;
    let (from, to) = rest.split_once('-')?;
    if from.is_empty() {
        let suffix: u64 = to.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((size.saturating_sub(suffix), size - 1));
    }
    let start: u64 = from.parse().ok()?;
    let end: u64 = if to.is_empty() {
        // Open-ended: answer a bounded window; the player follows up.
        (start + MAX_ANSWER_BYTES - 1).min(size - 1)
    } else {
        to.parse::<u64>().ok()?.min(size - 1)
    };
    if start >= size || start > end {
        return None;
    }
    Some((start, end))
}

async fn fetch_span(
    client: &reqwest::Client,
    source: &MediaSource,
    file_id: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    let url = format!("{}/api/files/{}/data", source.base, file_id);
    let response = client
        .get(url)
        .header("authorization", format!("Bearer {}", source.token))
        .header("range", format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|err| format!("ciphertext fetch failed: {err}"))?;
    if !(response.status() == 206 || response.status() == 200) {
        return Err(format!("ciphertext fetch failed ({})", response.status()));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|err| format!("ciphertext body failed: {err}"))
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
    source: &MediaSource,
    file_id: &str,
    header: &egc1::Header,
    first: u64,
    last: u64,
) -> Result<(), String> {
    let _serial = source.fetching.lock().await;
    let total = egc1::chunk_count(header.plain_size);
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
    Ok(())
}

fn http_client(app: &AppHandle) -> reqwest::Client {
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
        let range = parse_range(range_header.as_deref(), size);
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
