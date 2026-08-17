//! Drains the share extension's staged uploads when the app opens.
//!
//! The share sheet stages ciphertext in the app-group outbox and hands
//! it to a background URLSession, but iOS schedules extension-initiated
//! transfers at its own discretion. Opening the app is the owner's
//! "make it happen now" gesture, so pending blobs are uploaded here
//! directly, and jobs whose bytes already landed are cleaned up.

#[derive(serde::Serialize, Default)]
pub struct DrainReport {
    pub uploaded: u32,
    pub cleaned: u32,
    pub pending: u32,
}

#[tauri::command]
pub async fn outbox_drain() -> Result<DrainReport, String> {
    #[cfg(target_os = "ios")]
    {
        return tauri::async_runtime::spawn_blocking(apple::drain)
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "ios"))]
    {
        Ok(DrainReport::default())
    }
}

/// Drops every staged share-sheet upload; part of a server switch, where
/// blobs sealed for the previous vault must never reach the next one.
pub fn clear_staging() {
    #[cfg(target_os = "ios")]
    if let Some(dir) = apple::group_outbox_dir() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(target_os = "ios")]
mod apple {
    use super::DrainReport;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    /// The two fields the drain needs from the handoff record.
    #[derive(serde::Deserialize)]
    struct Handoff {
        origin: String,
        token: String,
    }

    pub(super) fn group_outbox_dir() -> Option<PathBuf> {
        unsafe {
            let class = AnyClass::get(c"NSFileManager")?;
            let manager: *mut AnyObject = msg_send![class, defaultManager];
            let group = NSString::from_str("group.com.harsharahul.engramstore");
            let url: *mut AnyObject =
                msg_send![manager, containerURLForSecurityApplicationGroupIdentifier: &*group];
            if url.is_null() {
                return None;
            }
            let path: *const NSString = msg_send![url, path];
            path.as_ref()
                .map(|p| PathBuf::from(p.to_string()).join("outbox"))
        }
    }

    fn remove_job(dir: &Path, file_id: &str) {
        let _ = std::fs::remove_file(dir.join(format!("{file_id}.bin")));
        let _ = std::fs::remove_file(dir.join(format!("{file_id}.job.json")));
    }

    pub fn drain() -> Result<DrainReport, String> {
        let mut report = DrainReport::default();
        let Some(dir) = group_outbox_dir() else {
            return Ok(report);
        };
        if !dir.exists() {
            return Ok(report);
        }
        let jobs: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                Some(name.strip_suffix(".job.json")?.to_string())
            })
            .collect();
        if jobs.is_empty() {
            return Ok(report);
        }

        let record = crate::keychain::read_any(crate::handoff::SERVICE)?
            .ok_or_else(|| "extensions are not connected".to_string())?;
        let handoff: Handoff = serde_json::from_slice(&record)
            .map_err(|_| "handoff record unreadable".to_string())?;
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;

        for file_id in jobs {
            let blob = dir.join(format!("{file_id}.bin"));
            if !blob.exists() {
                remove_job(&dir, &file_id);
                report.cleaned += 1;
                continue;
            }
            let url = format!("{}/api/files/{}/data", handoff.origin, file_id);
            // Did the background daemon already deliver it? A one-byte
            // range answers without pulling the content back down.
            match client
                .get(&url)
                .header("range", "bytes=0-0")
                .bearer_auth(&handoff.token)
                .send()
            {
                Ok(res) if res.status().as_u16() == 401 => {
                    return Err("the stored token was refused; open the app signed in".into());
                }
                Ok(res) if res.status().is_success() => {
                    remove_job(&dir, &file_id);
                    report.cleaned += 1;
                    continue;
                }
                _ => {}
            }
            let Ok(file) = std::fs::File::open(&blob) else {
                report.pending += 1;
                continue;
            };
            match client
                .put(&url)
                .header("content-type", "application/octet-stream")
                .bearer_auth(&handoff.token)
                .body(file)
                .send()
            {
                Ok(res) if res.status().is_success() => {
                    remove_job(&dir, &file_id);
                    report.uploaded += 1;
                }
                // The record is gone (deleted before its bytes arrived);
                // the staged blob has nothing to belong to.
                Ok(res) if res.status().as_u16() == 404 => {
                    remove_job(&dir, &file_id);
                    report.cleaned += 1;
                }
                Ok(res) if res.status().as_u16() == 401 => {
                    return Err("the stored token was refused; open the app signed in".into());
                }
                // 409 means the daemon or a live edit got there first;
                // the next drain's range probe will clean it up.
                _ => report.pending += 1,
            }
        }
        Ok(report)
    }
}
