//! Read access to the device photo library, for automatic backup.
//!
//! The web layer drives the backup loop while the app is open: it lists
//! the library, compares against what it already synced (each backed-up
//! file carries its asset's identifier in encrypted metadata), and pushes
//! the new originals through the same encrypt-and-upload path every other
//! upload uses. Native code does only what a web view cannot: ask for
//! library permission, enumerate assets, and export an original's bytes
//! untranscoded. Everything cryptographic still happens in the web view.
//!
//! This is a real permission step-change from the picker, which needs
//! nothing: full-library access is requested here, and the UI says so
//! plainly before the system prompt.

#[tauri::command]
pub async fn photos_available() -> bool {
    cfg!(target_os = "ios")
}

/// Requests full-library read access; returns "authorized", "limited",
/// "denied", "restricted", or "notDetermined".
#[tauri::command]
pub async fn photos_authorize() -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        return Ok(apple::authorize());
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err("photo library is iOS only".into())
    }
}

#[derive(serde::Serialize)]
pub struct PhotoAsset {
    pub id: String,
    /// "image" or "video".
    pub kind: String,
    pub filename: String,
    pub mtime_ms: f64,
    /// When the photo was taken; what a backup window filters on
    /// (mtime moves on every edit, capture time does not).
    pub created_ms: f64,
    pub screenshot: bool,
}

/// Every non-hidden asset, newest first.
#[tauri::command]
pub async fn photos_list() -> Result<Vec<PhotoAsset>, String> {
    #[cfg(target_os = "ios")]
    {
        return tauri::async_runtime::spawn_blocking(apple::list)
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err("photo library is iOS only".into())
    }
}

/// Exports one asset's original bytes to a temp file and returns the path.
/// The web layer reads it (through the existing picked-file bridge shape),
/// uploads, and deletes it.
#[tauri::command]
pub async fn photos_export(id: String) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        return tauri::async_runtime::spawn_blocking(move || apple::export(&id))
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = id;
        Err("photo library is iOS only".into())
    }
}

#[cfg(target_os = "ios")]
mod apple {
    use super::PhotoAsset;
    use block2::RcBlock;
    use objc2_foundation::{NSString, NSURL};
    use objc2_photos::{
        PHAccessLevel, PHAsset, PHAssetMediaSubtype, PHAssetMediaType, PHAssetResource,
        PHAssetResourceManager, PHAuthorizationStatus, PHPhotoLibrary,
    };
    use std::sync::mpsc;

    fn status_word(status: PHAuthorizationStatus) -> String {
        match status {
            PHAuthorizationStatus::Authorized => "authorized",
            PHAuthorizationStatus::Limited => "limited",
            PHAuthorizationStatus::Denied => "denied",
            PHAuthorizationStatus::Restricted => "restricted",
            _ => "notDetermined",
        }
        .to_string()
    }

    pub fn authorize() -> String {
        let (tx, rx) = mpsc::channel::<PHAuthorizationStatus>();
        let handler = RcBlock::new(move |status: PHAuthorizationStatus| {
            let _ = tx.send(status);
        });
        unsafe {
            PHPhotoLibrary::requestAuthorizationForAccessLevel_handler(
                PHAccessLevel::ReadWrite,
                &handler,
            );
        }
        rx.recv()
            .map(status_word)
            .unwrap_or_else(|_| "notDetermined".into())
    }

    pub fn list() -> Result<Vec<PhotoAsset>, String> {
        let mut out = Vec::new();
        unsafe {
            let result = PHAsset::fetchAssetsWithOptions(None);
            let count = result.count();
            for i in 0..count {
                let asset = result.objectAtIndex(i);
                let kind = match asset.mediaType() {
                    PHAssetMediaType::Image => "image",
                    PHAssetMediaType::Video => "video",
                    _ => continue,
                };
                let resources = PHAssetResource::assetResourcesForAsset(&asset);
                let filename = if resources.count() > 0 {
                    resources.objectAtIndex(0).originalFilename().to_string()
                } else {
                    format!("{}.dat", asset.localIdentifier())
                };
                let mtime_ms = asset
                    .modificationDate()
                    .or_else(|| asset.creationDate())
                    .map(|d| d.timeIntervalSince1970() * 1000.0)
                    .unwrap_or(0.0);
                let created_ms = asset
                    .creationDate()
                    .map(|d| d.timeIntervalSince1970() * 1000.0)
                    .unwrap_or(mtime_ms);
                let screenshot = asset
                    .mediaSubtypes()
                    .contains(PHAssetMediaSubtype::PhotoScreenshot);
                out.push(PhotoAsset {
                    id: asset.localIdentifier().to_string(),
                    kind: kind.to_string(),
                    filename,
                    mtime_ms,
                    created_ms,
                    screenshot,
                });
            }
        }
        Ok(out)
    }

    pub fn export(id: &str) -> Result<String, String> {
        unsafe {
            let ids = objc2_foundation::NSArray::from_retained_slice(&[NSString::from_str(id)]);
            let fetched = PHAsset::fetchAssetsWithLocalIdentifiers_options(&ids, None);
            if fetched.count() == 0 {
                return Err("asset not found".into());
            }
            let asset = fetched.objectAtIndex(0);
            let resources = PHAssetResource::assetResourcesForAsset(&asset);
            if resources.count() == 0 {
                return Err("asset has no resource".into());
            }
            // The original resource: a plain photo or video, not a derived
            // rendition, so the bytes match what the camera wrote.
            let mut chosen = resources.objectAtIndex(0);
            for i in 0..resources.count() {
                let r = resources.objectAtIndex(i);
                let t = r.r#type().0;
                if t == 1 || t == 3 {
                    // PHAssetResourceTypePhoto = 1, ...Video = 3
                    chosen = r;
                    break;
                }
            }

            // Into the picker's own directory so the existing
            // picked_file_read bridge, path-scoped there, reads and
            // deletes it: backup needs no new file-reading command.
            let dir = crate::photos::picked_dir();
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let filename = chosen.originalFilename().to_string();
            let path = dir.join(format!("{}-{}", sanitize(id), filename));
            let _ = std::fs::remove_file(&path);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));

            let (tx, rx) = mpsc::channel::<Option<String>>();
            let handler = RcBlock::new(move |error: *mut objc2_foundation::NSError| {
                let message = error.as_ref().map(|e| e.localizedDescription().to_string());
                let _ = tx.send(message);
            });
            PHAssetResourceManager::defaultManager()
                .writeDataForAssetResource_toFile_options_completionHandler(
                    &chosen, &url, None, &handler,
                );
            match rx.recv() {
                Ok(None) => Ok(path.to_string_lossy().to_string()),
                Ok(Some(message)) => Err(message),
                Err(_) => Err("export did not complete".into()),
            }
        }
    }

    fn sanitize(id: &str) -> String {
        id.chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect()
    }
}
