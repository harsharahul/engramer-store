//! picked:// — serves staged and watched files to media elements by byte
//! range, the way stream:// serves decrypted vault content. A video about
//! to upload gets its poster and meaning frames decoded from disk through
//! this, instead of from a memory-backed copy of the whole file; holding
//! that copy is what used to get the app killed.
//!
//! Two routes, each confined to what the page was already allowed to name
//! over IPC: `picked://localhost/<basename>` reads the picker's staging
//! directory, and `picked://localhost/watched?p=<escaped-path>` reads
//! inside folders the person chose to watch. Responses carry CORS headers
//! because the page lives on its own https origin, and without them every
//! canvas the poster is drawn to would taint.

use tauri::{UriSchemeContext, UriSchemeResponder};

/// Largest span answered for an open-ended or absent range request.
const MAX_ANSWER_BYTES: u64 = 16 * 1024 * 1024;

/// Decodes %XX escapes; None when an escape is malformed.
pub fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The staged file a request path names: a bare basename under the
/// picker's staging directory, nothing else.
pub fn resolve_staged(path: &str) -> Result<std::path::PathBuf, String> {
    let name = percent_decode(path.trim_start_matches('/'))
        .ok_or_else(|| "malformed escape in the request path".to_string())?;
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return Err("staged files are named by basename only".to_string());
    }
    crate::photos::staged_path(&crate::photos::picked_dir().join(name).to_string_lossy())
}

/// The media type a file's name implies; a mirror of the page's own table.
pub fn content_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "heic" => "image/heic",
        "heif" => "image/heif",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "tiff" => "image/tiff",
        "mov" => "video/quicktime",
        "mp4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn respond(responder: UriSchemeResponder, status: u16, headers: &[(&str, String)], body: Vec<u8>) {
    let mut builder = http::Response::builder()
        .status(status)
        // The page's origin is the deployment, not this scheme; without
        // CORS the load works but every canvas capture from it taints.
        .header("access-control-allow-origin", "*");
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
        let range_header = request
            .headers()
            .get("range")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let resolved = if uri.path() == "/watched" {
            let escaped = uri
                .query()
                .and_then(|q| q.strip_prefix("p="))
                .unwrap_or("");
            match percent_decode(escaped) {
                Some(path) if !path.is_empty() => crate::watched::watched_path(&app, &path),
                _ => Err("malformed watched path".to_string()),
            }
        } else {
            resolve_staged(uri.path())
        };
        let path = match resolved {
            Ok(path) => path,
            Err(err) => return respond(responder, 404, &[], err.into_bytes()),
        };
        let size = match std::fs::metadata(&path) {
            Ok(meta) => meta.len(),
            Err(err) => return respond(responder, 404, &[], err.to_string().into_bytes()),
        };
        if size == 0 {
            return respond(responder, 200, &[("content-length", "0".into())], Vec::new());
        }
        let range = crate::ranges::parse_range(range_header.as_deref(), size, MAX_ANSWER_BYTES);
        if range_header.is_some() && range.is_none() {
            return respond(
                responder,
                416,
                &[("content-range", format!("bytes */{size}"))],
                Vec::new(),
            );
        }
        let (start, end) = range.unwrap_or((0, (MAX_ANSWER_BYTES - 1).min(size - 1)));
        let body = {
            let path = path.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::photos::read_range_at(&path, start, end - start + 1)
            })
            .await
            .map_err(|err| err.to_string())
            .and_then(|inner| inner)
        };
        let body = match body {
            Ok(body) => body,
            Err(err) => return respond(responder, 500, &[], err.into_bytes()),
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        respond(
            responder,
            206,
            &[
                ("content-type", content_type(&name).to_string()),
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
    use std::io::Write;

    #[test]
    fn percent_decoding_round_trips_spaces_and_refuses_junk() {
        assert_eq!(percent_decode("clip%20one.mov").as_deref(), Some("clip one.mov"));
        assert_eq!(percent_decode("plain.mov").as_deref(), Some("plain.mov"));
        assert_eq!(percent_decode("bad%2"), None);
        assert_eq!(percent_decode("bad%zz"), None);
    }

    #[test]
    fn staged_resolution_stays_inside_the_staging_dir() {
        let dir = crate::photos::picked_dir();
        std::fs::create_dir_all(&dir).expect("staging dir");
        let path = dir.join("serve-probe.mov");
        let mut file = std::fs::File::create(&path).expect("staged file");
        file.write_all(b"bytes").expect("staged bytes");
        assert!(resolve_staged("/serve-probe.mov").is_ok());
        assert!(resolve_staged("/../etc/hosts").is_err());
        assert!(resolve_staged("/a%2F..%2Fescape").is_err());
        assert!(resolve_staged("/absent-file.mov").is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn content_types_cover_what_a_library_holds() {
        assert_eq!(content_type("IMG_1.HEIC"), "image/heic");
        assert_eq!(content_type("clip.MOV"), "video/quicktime");
        assert_eq!(content_type("mystery.bin"), "application/octet-stream");
    }
}
