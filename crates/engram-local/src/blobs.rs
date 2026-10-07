//! Blob files under the vault directory, laid out as the server's file
//! store lays them out (`<data dir>/blobs/<key>`), so a vault directory is
//! a server data directory: `<id>` or `<id>.g<N>` for content, `<id>.thumb`
//! and `<id>.idx` for the derived blobs. Every write goes through a
//! temporary file and a rename, so a failed upload never leaves a partial
//! blob under its final name. The bytes are ciphertext the client sealed;
//! this store never reads them except to digest them.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::{Body, Bytes};
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

/// The directory under the data directory that holds the blobs.
pub const BLOBS_DIR: &str = "blobs";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobKind {
    Data,
    Thumb,
    Index,
}

/// The server's key for a blob: generation 0 content is the bare id.
pub fn blob_key(file_id: &str, kind: BlobKind, generation: i64) -> String {
    match kind {
        BlobKind::Thumb => format!("{file_id}.thumb"),
        BlobKind::Index => format!("{file_id}.idx"),
        BlobKind::Data if generation > 0 => format!("{file_id}.g{generation}"),
        BlobKind::Data => file_id.to_string(),
    }
}

/// Why a write did not land.
#[derive(Debug)]
pub enum PutError {
    /// The body ran past the allowed size, or short of its declared length.
    TooLarge,
    /// The body could not be read to its end: the client went away.
    Body,
    Io(io::Error),
}

impl From<io::Error> for PutError {
    fn from(err: io::Error) -> PutError {
        PutError::Io(err)
    }
}

/// What a completed write recorded about the bytes.
#[derive(Debug)]
pub struct Written {
    pub bytes: u64,
    /// Lowercase hex SHA-256 of the stored bytes.
    pub sha256: String,
}

pub struct BlobStore {
    dir: PathBuf,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl BlobStore {
    /// Opens the store at `dir`, creating it.
    pub fn open(dir: PathBuf) -> io::Result<BlobStore> {
        std::fs::create_dir_all(&dir)?;
        Ok(BlobStore { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where `key` lives on disk.
    pub fn path(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }

    /// A random handle for a parts session (the server's: 8 random bytes, hex).
    pub fn new_handle() -> String {
        hex(&engram_core::backend::random_bytes(8))
    }

    fn temp_path(&self, destination: &Path) -> PathBuf {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        destination.with_file_name(format!("{name}.upload-{}-{n}", std::process::id()))
    }

    /// Streams `body` into the blob at `key`, refusing more than `max_bytes`.
    /// On any failure nothing is left under `key` or beside it.
    pub async fn put<S, E>(&self, key: &str, body: S, max_bytes: u64) -> Result<Written, PutError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
    {
        let destination = self.path(key);
        let tmp = self.temp_path(&destination);
        match write_stream(&tmp, body, max_bytes).await {
            Ok(written) => {
                fs::rename(&tmp, &destination).await?;
                Ok(written)
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp).await;
                Err(err)
            }
        }
    }

    /// The blob's bytes, whole or one inclusive byte range. A missing blob
    /// is an `io::ErrorKind::NotFound`. The file is opened here, so a blob
    /// removed while a client reads it still serves its bytes to the end.
    pub async fn get(&self, key: &str, range: Option<(u64, u64)>) -> io::Result<Body> {
        let mut file = File::open(self.path(key)).await?;
        match range {
            Some((start, end)) => {
                file.seek(io::SeekFrom::Start(start)).await?;
                Ok(Body::from_stream(ReaderStream::new(
                    file.take(end - start + 1),
                )))
            }
            None => Ok(Body::from_stream(ReaderStream::new(file))),
        }
    }

    /// Removes the blob; a key that holds nothing is not an error.
    pub fn remove(&self, key: &str) {
        match std::fs::remove_file(self.path(key)) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => eprintln!("engram-local: cannot remove blob {key}: {err}"),
        }
    }

    fn part_path(&self, key: &str, handle: &str, part: i64) -> PathBuf {
        self.path(&format!("{key}.parts-{handle}.{part}"))
    }

    /// Stores one numbered part of a session; the body must be exactly
    /// `length` bytes. A retried part replaces the earlier one.
    pub async fn put_part<S, E>(
        &self,
        key: &str,
        handle: &str,
        part: i64,
        body: S,
        length: u64,
    ) -> Result<u64, PutError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
    {
        let destination = self.part_path(key, handle, part);
        let tmp = self.temp_path(&destination);
        match write_stream(&tmp, body, length).await {
            Ok(written) if written.bytes == length => {
                fs::rename(&tmp, &destination).await?;
                Ok(length)
            }
            Ok(_) => {
                let _ = fs::remove_file(&tmp).await;
                Err(PutError::TooLarge)
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp).await;
                Err(err)
            }
        }
    }

    /// Joins the session's parts, in the order given, into the blob at
    /// `key`, then removes the parts. The joined bytes are what one upload
    /// of the same bytes would have stored.
    pub async fn complete_parts(&self, key: &str, handle: &str, parts: &[i64]) -> io::Result<()> {
        let destination = self.path(key);
        let tmp = self.temp_path(&destination);
        let joined = async {
            let mut sink = File::create(&tmp).await?;
            for part in parts {
                let mut source = File::open(self.part_path(key, handle, *part)).await?;
                tokio::io::copy(&mut source, &mut sink).await?;
            }
            sink.flush().await
        }
        .await;
        if let Err(err) = joined {
            let _ = fs::remove_file(&tmp).await;
            return Err(err);
        }
        fs::rename(&tmp, &destination).await?;
        for part in parts {
            let _ = fs::remove_file(self.part_path(key, handle, *part)).await;
        }
        Ok(())
    }

    /// Removes every part a session stored.
    pub fn abort_parts(&self, key: &str, handle: &str) {
        let prefix = format!("{key}.parts-{handle}.");
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

async fn write_stream<S, E>(path: &Path, mut body: S, max_bytes: u64) -> Result<Written, PutError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    let mut file = File::create(path).await?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| PutError::Body)?;
        bytes += chunk.len() as u64;
        if bytes > max_bytes {
            return Err(PutError::TooLarge);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(Written {
        bytes,
        sha256: hex(&hasher.finalize()),
    })
}

/// Lowercase hex SHA-256 of a file's bytes, read in pieces.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn store() -> (BlobStore, PathBuf) {
        let dir = crate::server::tests::temp_dir("blobs");
        (BlobStore::open(dir.join(BLOBS_DIR)).unwrap(), dir)
    }

    fn chunks(
        parts: &[&[u8]],
    ) -> impl Stream<Item = Result<Bytes, std::convert::Infallible>> + Unpin {
        stream::iter(
            parts
                .iter()
                .map(|p| Ok(Bytes::copy_from_slice(p)))
                .collect::<Vec<_>>(),
        )
    }

    async fn read_all(body: Body) -> Vec<u8> {
        axum::body::to_bytes(body, usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn keys_follow_the_servers_scheme() {
        assert_eq!(blob_key("f", BlobKind::Data, 0), "f");
        assert_eq!(blob_key("f", BlobKind::Data, 3), "f.g3");
        assert_eq!(blob_key("f", BlobKind::Thumb, 7), "f.thumb");
        assert_eq!(blob_key("f", BlobKind::Index, 0), "f.idx");
    }

    #[tokio::test]
    async fn put_stores_the_bytes_under_the_key_and_digests_them() {
        let (store, dir) = store();
        let written = store
            .put("blob-1", chunks(&[b"0123", b"456", b"789"]), 1024)
            .await
            .unwrap();
        assert_eq!(written.bytes, 10);
        assert_eq!(
            written.sha256,
            "84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882"
        );
        assert_eq!(std::fs::read(store.path("blob-1")).unwrap(), b"0123456789");
        assert_eq!(
            files(store.dir()),
            vec!["blob-1"],
            "no temporary file remains"
        );
        assert_eq!(sha256_file(&store.path("blob-1")).unwrap(), written.sha256);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn get_serves_the_whole_blob_or_a_range() {
        let (store, dir) = store();
        store
            .put("blob-2", chunks(&[b"0123456789"]), 1024)
            .await
            .unwrap();
        assert_eq!(
            read_all(store.get("blob-2", None).await.unwrap()).await,
            b"0123456789"
        );
        assert_eq!(
            read_all(store.get("blob-2", Some((2, 5))).await.unwrap()).await,
            b"2345"
        );
        assert_eq!(
            store.get("nothing", None).await.err().map(|e| e.kind()),
            Some(io::ErrorKind::NotFound)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_body_past_the_limit_is_refused_and_leaves_nothing() {
        let (store, dir) = store();
        let refused = store.put("big", chunks(&[b"0123", b"4567"]), 6).await;
        assert!(matches!(refused, Err(PutError::TooLarge)));
        assert!(files(store.dir()).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_body_that_fails_midway_leaves_nothing() {
        let (store, dir) = store();
        let failing = stream::iter(vec![
            Ok(Bytes::from_static(b"0123")),
            Err("the client went away"),
        ]);
        assert!(matches!(
            store.put("cut", failing, 1024).await,
            Err(PutError::Body)
        ));
        assert!(files(store.dir()).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_removed_blob_still_streams_to_a_reader_that_opened_it() {
        let (store, dir) = store();
        store
            .put("blob-3", chunks(&[b"still here"]), 1024)
            .await
            .unwrap();
        let body = store.get("blob-3", None).await.unwrap();
        store.remove("blob-3");
        store.remove("blob-3");
        assert_eq!(read_all(body).await, b"still here");
        assert!(store.get("blob-3", None).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn parts_join_in_order_and_are_removed() {
        let (store, dir) = store();
        let handle = BlobStore::new_handle();
        assert_eq!(handle.len(), 16);
        store
            .put_part("movie", &handle, 2, chunks(&[b"456"]), 3)
            .await
            .unwrap();
        store
            .put_part("movie", &handle, 1, chunks(&[b"0123"]), 4)
            .await
            .unwrap();
        // A retried part replaces the earlier bytes.
        store
            .put_part("movie", &handle, 3, chunks(&[b"xxx"]), 3)
            .await
            .unwrap();
        store
            .put_part("movie", &handle, 3, chunks(&[b"789"]), 3)
            .await
            .unwrap();
        assert_eq!(files(store.dir()).len(), 3);
        store
            .complete_parts("movie", &handle, &[1, 2, 3])
            .await
            .unwrap();
        assert_eq!(std::fs::read(store.path("movie")).unwrap(), b"0123456789");
        assert_eq!(files(store.dir()), vec!["movie"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_part_of_the_wrong_length_is_refused() {
        let (store, dir) = store();
        let handle = BlobStore::new_handle();
        assert!(matches!(
            store.put_part("k", &handle, 1, chunks(&[b"01"]), 3).await,
            Err(PutError::TooLarge)
        ));
        assert!(matches!(
            store.put_part("k", &handle, 1, chunks(&[b"0123"]), 3).await,
            Err(PutError::TooLarge)
        ));
        assert!(files(store.dir()).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn abort_removes_one_sessions_parts_only() {
        let (store, dir) = store();
        let (a, b) = (BlobStore::new_handle(), BlobStore::new_handle());
        store
            .put_part("k", &a, 1, chunks(&[b"a"]), 1)
            .await
            .unwrap();
        store
            .put_part("k", &b, 1, chunks(&[b"b"]), 1)
            .await
            .unwrap();
        store.put("k", chunks(&[b"final"]), 10).await.unwrap();
        store.abort_parts("k", &a);
        assert_eq!(
            files(store.dir()),
            vec!["k".to_string(), format!("k.parts-{b}.1")]
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
