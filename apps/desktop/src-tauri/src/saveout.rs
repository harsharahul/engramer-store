//! Saving a vault file onto the device, streamed the whole way.
//!
//! The web layer's download decrypts the entire file into the page's
//! memory plus a copy for the save anchor; on a phone that is a
//! content-process kill for large files, and the page silently reloads.
//! This path never holds more than one network chunk: ciphertext streams
//! to a staging file, the proven file-to-file decryptor (the same one
//! the Files drive trusts, digest verified in-pass) turns it into the
//! plaintext, and the result lands in the app's Documents/Downloads,
//! which the Files app shows under On My iPhone once the app declares
//! its documents browsable.

use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

/// How often download progress reaches the page; every chunk would be
/// noise, and a stalled radio still reports within this many bytes.
const PROGRESS_STRIDE: u64 = 1024 * 1024;

/// Streams one authorized GET into `dest`, reporting progress. Holds one
/// network chunk in memory at any moment, whatever the file's size.
pub(crate) async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    dest: &Path,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    let mut response = client
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|err| format!("download failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed ({})", response.status()));
    }
    let total = response.content_length();
    let mut out = std::fs::File::create(dest).map_err(|err| err.to_string())?;
    let mut done: u64 = 0;
    let mut reported: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("download body failed: {err}"))?
    {
        out.write_all(&chunk).map_err(|err| err.to_string())?;
        done += chunk.len() as u64;
        if done - reported >= PROGRESS_STRIDE {
            reported = done;
            on_progress(done, total);
        }
    }
    out.flush().map_err(|err| err.to_string())?;
    on_progress(done, total);
    // The size the server named and the bytes that arrived must agree.
    if let Some(expected) = total {
        if done != expected {
            return Err(format!("read {done} bytes of a {expected} byte download"));
        }
    }
    Ok(())
}

/// Downloads and decrypts one file, staging beside `plain_path`; the
/// command wraps this with app paths and progress events, and the tests
/// drive it against a canned server.
pub(crate) async fn fetch_and_decrypt(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    cipher_path: &Path,
    plain_path: &Path,
    key: Vec<u8>,
    expected_digest: Option<String>,
    mut on_progress: impl FnMut(&str, u64, Option<u64>),
) -> Result<(), String> {
    let downloaded = download_to_file(client, url, token, cipher_path, |done, total| {
        on_progress("download", done, total)
    })
    .await;
    if let Err(err) = downloaded {
        let _ = std::fs::remove_file(cipher_path);
        return Err(err);
    }
    on_progress("decrypt", 0, None);
    let cipher = cipher_path.to_path_buf();
    let plain = plain_path.to_path_buf();
    let result = tauri::async_runtime::spawn_blocking(move || {
        engram_ffi::decrypt_file_contents(
            cipher.to_string_lossy().into_owned(),
            plain.to_string_lossy().into_owned(),
            key,
            expected_digest,
        )
    })
    .await
    .map_err(|err| err.to_string())?;
    let _ = std::fs::remove_file(cipher_path);
    match result {
        Ok(_) => Ok(()),
        Err(err) => {
            // The decryptor already removed a partial output.
            Err(format!("{err:?}"))
        }
    }
}

/// The first name in `dir` that nothing holds yet: the name itself, then
/// "name 2.ext" and up, the way desktops resolve the same collision.
pub(crate) fn unique_destination(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), Some(ext.to_string())),
        _ => (name.to_string(), None),
    };
    for counter in 2.. {
        let candidate = match &ext {
            Some(ext) => dir.join(format!("{stem} {counter}.{ext}")),
            None => dir.join(format!("{stem} {counter}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("some counter is free");
}

/// Saves one vault file into Documents/Downloads, streamed and verified.
/// Returns the file name it landed under.
#[tauri::command]
pub async fn file_save_download(
    app: tauri::AppHandle,
    file_id: String,
    key: String,
    token: String,
    base: String,
    name: String,
    digest: Option<String>,
) -> Result<String, String> {
    let key = crate::media::b64_decode(&key)?;
    if key.len() != 32 {
        return Err("file key must be 32 bytes".to_string());
    }
    let documents = app
        .path()
        .document_dir()
        .map_err(|err| format!("no documents directory: {err}"))?;
    let downloads = documents.join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|err| err.to_string())?;
    let staging = documents.join(".staging");
    std::fs::create_dir_all(&staging).map_err(|err| err.to_string())?;
    let cipher_path = staging.join(format!("{file_id}.cipher"));
    let plain_path = staging.join(format!("{file_id}.plain"));
    let url = format!("{base}/api/files/{file_id}/data");
    let client = crate::media::http_client(&app);
    let progress_app = app.clone();
    let progress_id = file_id.clone();
    let result = fetch_and_decrypt(
        &client,
        &url,
        &token,
        &cipher_path,
        &plain_path,
        key,
        digest,
        move |phase, done, total| {
            let _ = progress_app.emit(
                "save-progress",
                serde_json::json!({
                    "fileId": progress_id,
                    "phase": phase,
                    "done": done,
                    "total": total,
                }),
            );
        },
    )
    .await;
    result?;
    let destination = unique_destination(&downloads, &name);
    std::fs::rename(&plain_path, &destination).map_err(|err| err.to_string())?;
    Ok(destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

    fn pattern(size: usize) -> Vec<u8> {
        (0..size).map(|i| ((i * 31 + 7) % 251) as u8).collect()
    }

    fn serve_bytes(body: Vec<u8>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
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

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("engram-saveout-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The whole promise in one round trip: ciphertext streams down,
    /// decrypts file to file, and the plaintext is byte-identical with
    /// its digest verified in-pass. Never more than a chunk in memory.
    #[test]
    fn a_download_round_trips_streamed_and_verified() {
        let dir = temp_dir("roundtrip");
        let plain = pattern(5 * 1024 * 1024 + 17);
        let key = vec![7u8; 32];
        let cipher = engram_ffi::encrypt_content(plain.clone(), key.clone()).unwrap();
        let digest = engram_ffi::content_digest(plain.clone());
        let port = serve_bytes(cipher);
        let cipher_path = dir.join("f.cipher");
        let plain_path = dir.join("f.plain");
        let mut phases: Vec<String> = Vec::new();
        tauri::async_runtime::block_on(fetch_and_decrypt(
            &reqwest::Client::new(),
            &format!("http://127.0.0.1:{port}/api/files/f/data"),
            "t",
            &cipher_path,
            &plain_path,
            key,
            Some(digest),
            |phase, _, _| phases.push(phase.to_string()),
        ))
        .unwrap();
        let out = std::fs::read(&plain_path).unwrap();
        assert_eq!(out, plain);
        assert!(!cipher_path.exists(), "staged ciphertext must be cleaned");
        assert!(phases.contains(&"download".to_string()));
        assert!(phases.contains(&"decrypt".to_string()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_wrong_digest_yields_no_file_at_all() {
        let dir = temp_dir("digest");
        let plain = pattern(64 * 1024);
        let key = vec![9u8; 32];
        let cipher = engram_ffi::encrypt_content(plain, key.clone()).unwrap();
        let port = serve_bytes(cipher);
        let cipher_path = dir.join("f.cipher");
        let plain_path = dir.join("f.plain");
        let refused = tauri::async_runtime::block_on(fetch_and_decrypt(
            &reqwest::Client::new(),
            &format!("http://127.0.0.1:{port}/api/files/f/data"),
            "t",
            &cipher_path,
            &plain_path,
            key,
            Some("not-the-digest".to_string()),
            |_, _, _| {},
        ));
        assert!(refused.is_err());
        assert!(!plain_path.exists(), "a failed check must leave nothing");
        assert!(!cipher_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn collisions_number_themselves_like_a_desktop_would() {
        let dir = temp_dir("names");
        std::fs::write(dir.join("clip.mov"), b"a").unwrap();
        std::fs::write(dir.join("clip 2.mov"), b"b").unwrap();
        assert_eq!(
            unique_destination(&dir, "clip.mov").file_name().unwrap(),
            "clip 3.mov"
        );
        assert_eq!(unique_destination(&dir, "other.mov").file_name().unwrap(), "other.mov");
        assert_eq!(unique_destination(&dir, "README").file_name().unwrap(), "README");
        let _ = std::fs::remove_dir_all(dir);
    }
}
