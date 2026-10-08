//! Optional feature packs: the office editor tree and the on-device
//! intelligence runtimes. The app bundles a manifest naming each pack's
//! archive and every file in it with sizes and digests; a pack is
//! downloaded on an explicit request, resumed if interrupted, verified
//! against the manifest and installed whole or not at all. This module
//! reads the manifest and tracks pack state; the download arrives next.

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

/// Where installed packs live under the data directory: `packs/<name>/`.
pub const PACKS_DIR: &str = "packs";
/// The manifest the web build writes next to the core bundle.
pub const MANIFEST_FILE: &str = "packs.json";

/// `packs.json`, schema 1: every pack's archive and files.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub packs: BTreeMap<String, PackSpec>,
    #[serde(skip)]
    owner_of: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackSpec {
    pub archive: String,
    #[serde(rename = "archiveBytes")]
    pub archive_bytes: u64,
    #[serde(rename = "archiveSha256")]
    pub archive_sha256: String,
    #[serde(rename = "installedBytes")]
    pub installed_bytes: u64,
    pub files: Vec<FileSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileSpec {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

impl Manifest {
    /// Reads and checks a manifest: schema 1, archive names that are plain
    /// file names, and file paths that stay inside the pack, so a manifest
    /// can never make the server read or write outside its directories.
    pub fn read(path: &Path) -> Result<Manifest, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
        Manifest::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Manifest, String> {
        let mut manifest: Manifest =
            serde_json::from_str(text).map_err(|err| format!("packs.json: {err}"))?;
        if manifest.schema != 1 {
            return Err(format!(
                "packs.json: unsupported schema {}",
                manifest.schema
            ));
        }
        let mut owner_of = HashMap::new();
        for (name, pack) in &manifest.packs {
            if !is_plain_name(name) || !is_plain_name(&pack.archive) {
                return Err(format!("packs.json: pack {name} has an unsafe name"));
            }
            for file in &pack.files {
                if clean_relative(Path::new(&file.path)).as_deref() != Some(file.path.as_str()) {
                    return Err(format!("packs.json: unsafe path {}", file.path));
                }
                if owner_of.insert(file.path.clone(), name.clone()).is_some() {
                    return Err(format!("packs.json: {} is listed twice", file.path));
                }
            }
        }
        manifest.owner_of = owner_of;
        Ok(manifest)
    }

    /// The pack a served path belongs to, if any.
    pub fn pack_of(&self, rel: &str) -> Option<&str> {
        self.owner_of.get(rel).map(String::as_str)
    }

    /// Where a pack's archive is downloaded from.
    pub fn archive_url(&self, pack: &PackSpec) -> String {
        format!("{}{}", self.base_url, pack.archive)
    }
}

fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// `path` as a clean relative path with `/` separators: only normal
/// components, no `.`, `..`, root or prefix, valid UTF-8. `None` otherwise.
pub fn clean_relative(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_str()?;
                if part.is_empty() || part.contains('\\') || part.contains('\0') {
                    return None;
                }
                parts.push(part);
            }
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackState {
    Installed,
    Missing,
    Downloading,
}

impl PackState {
    pub fn as_str(self) -> &'static str {
        match self {
            PackState::Installed => "installed",
            PackState::Missing => "missing",
            PackState::Downloading => "downloading",
        }
    }
}

#[derive(Debug, Default, Clone)]
struct Progress {
    downloading: bool,
    downloaded: u64,
    /// Why the last attempt did not install the pack, until the next one.
    error: Option<String>,
}

/// The packs directory and what is happening in it.
pub struct Packs {
    dir: PathBuf,
    manifest: Option<Manifest>,
    progress: Mutex<HashMap<String, Progress>>,
}

impl Packs {
    /// Opens `dir`, creating it and removing the leftovers of an
    /// installation a crash cut short (a partial archive is kept: the next
    /// request resumes it).
    pub fn open(dir: PathBuf, manifest: Option<Manifest>) -> Result<Packs, String> {
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".staging-") || name.starts_with(".removing-") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(Packs {
            dir,
            manifest,
            progress: Mutex::new(HashMap::new()),
        })
    }

    pub fn manifest(&self) -> Option<&Manifest> {
        self.manifest.as_ref()
    }

    /// Where an installed pack's files live.
    pub fn install_dir(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn installed(&self, name: &str) -> bool {
        self.install_dir(name).is_dir()
    }

    fn progress_of(&self, name: &str) -> Progress {
        self.progress
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .unwrap_or_default()
    }

    pub fn state(&self, name: &str) -> PackState {
        if self.progress_of(name).downloading {
            PackState::Downloading
        } else if self.installed(name) {
            PackState::Installed
        } else {
            PackState::Missing
        }
    }

    /// `{ "<name>": "<state>" }` for every pack the manifest names.
    pub fn summary(&self) -> Value {
        let mut out = serde_json::Map::new();
        if let Some(manifest) = &self.manifest {
            for name in manifest.packs.keys() {
                out.insert(name.clone(), json!(self.state(name).as_str()));
            }
        }
        Value::Object(out)
    }

    /// Every pack with its state, sizes, progress and the last failure.
    pub fn status(&self) -> Value {
        let mut packs = serde_json::Map::new();
        if let Some(manifest) = &self.manifest {
            for (name, spec) in &manifest.packs {
                let progress = self.progress_of(name);
                packs.insert(
                    name.clone(),
                    json!({
                        "state": self.state(name).as_str(),
                        "archiveBytes": spec.archive_bytes,
                        "installedBytes": spec.installed_bytes,
                        "downloadedBytes": progress.downloaded,
                        "error": progress.error,
                    }),
                );
            }
        }
        json!({ "packs": packs })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifests_are_checked_before_they_are_trusted() {
        let good = r#"{"schema":1,"version":"1","baseUrl":"http://h/","packs":{"office":{"archive":"a.tar.gz","archiveBytes":1,"archiveSha256":"x","installedBytes":1,"files":[{"path":"office/a.js","bytes":1,"sha256":"y"}]}}}"#;
        let manifest = Manifest::parse(good).unwrap();
        assert_eq!(manifest.pack_of("office/a.js"), Some("office"));
        assert_eq!(manifest.pack_of("office/b.js"), None);
        assert_eq!(
            manifest.archive_url(&manifest.packs["office"]),
            "http://h/a.tar.gz"
        );
        for (bad, why) in [
            (
                good.replace("\"schema\":1", "\"schema\":2"),
                "unsupported schema",
            ),
            (good.replace("office/a.js", "../a.js"), "unsafe path"),
            (good.replace("office/a.js", "/etc/passwd"), "unsafe path"),
            (good.replace("a.tar.gz", "../a.tar.gz"), "unsafe name"),
            (good.replace("\"office\":{", "\"../x\":{"), "unsafe name"),
        ] {
            let err = Manifest::parse(&bad).err().unwrap();
            assert!(err.contains(why), "{err}");
        }
        let twice = good.replace(
            "[{\"path\":\"office/a.js\",\"bytes\":1,\"sha256\":\"y\"}]",
            "[{\"path\":\"office/a.js\",\"bytes\":1,\"sha256\":\"y\"},{\"path\":\"office/a.js\",\"bytes\":1,\"sha256\":\"y\"}]",
        );
        assert!(Manifest::parse(&twice)
            .err()
            .unwrap()
            .contains("listed twice"));
    }

    #[test]
    fn leftover_staging_folders_are_removed_at_open() {
        let dir = crate::server::tests::temp_dir("packs");
        std::fs::create_dir_all(dir.join(".staging-office").join("office")).unwrap();
        std::fs::create_dir_all(dir.join(".removing-office")).unwrap();
        std::fs::create_dir_all(dir.join(".download")).unwrap();
        std::fs::write(dir.join(".download").join("a.part"), "half").unwrap();
        std::fs::create_dir_all(dir.join("intelligence")).unwrap();
        let packs = Packs::open(dir.clone(), None).unwrap();
        assert!(!dir.join(".staging-office").exists());
        assert!(!dir.join(".removing-office").exists());
        assert!(
            dir.join(".download").join("a.part").exists(),
            "a partial download is kept for resuming"
        );
        assert!(packs.installed("intelligence"));
        assert_eq!(packs.summary(), json!({}));
        let _ = std::fs::remove_dir_all(dir);
    }
}
