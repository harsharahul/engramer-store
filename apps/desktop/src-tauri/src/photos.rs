//! The photo picker that hands over originals.
//!
//! A web `<input type="file">` cannot reach a photo's real bytes on iOS.
//! Measured against a HEIC in the library on real iOS WebKit, every accept
//! string returns a JPEG the system transcoded on the way out: the page
//! never sees the original. The deciding property lives on the native
//! picker, `preferredAssetRepresentationMode`, and `Current` is what asks
//! for the file as stored rather than a compatible re-encode. The same
//! switch stops video being re-exported from HEVC to H.264.
//!
//! `PHPickerViewController` also runs out of process, so this needs no
//! photo-library permission at all: strictly less access than asking for
//! the library, and nothing extra to justify at review.

#[cfg(target_os = "ios")]
mod ios {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{
        define_class, extern_class, msg_send, AnyThread, DefinedClass, MainThreadMarker,
        MainThreadOnly,
    };
    use objc2_foundation::{NSArray, NSError, NSObjectProtocol, NSURL};
    use objc2_photos_ui::{
        PHPickerConfiguration, PHPickerConfigurationAssetRepresentationMode, PHPickerFilter,
        PHPickerResult,
    };
    use objc2_ui_kit::{UIApplication, UIResponder, UIViewController};

    // objc2-photos-ui binds PHPickerViewController for macOS only: it
    // subclasses NSViewController there and UIViewController here, and the
    // crate carries no UIKit variant. The class is the same one at runtime,
    // so it is declared rather than done without.
    extern_class!(
        #[unsafe(super(UIViewController, UIResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        // The runtime name, which is NOT taken from the Rust one: without
        // this it looks up a class called "PickerController", finds nothing,
        // and panics inside a callback that cannot unwind, aborting the app.
        #[name = "PHPickerViewController"]
        #[derive(Debug)]
        struct PickerController;
    );
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::mpsc::Sender;

    /// One picked item: the staged file, and the library identity of the
    /// asset it came from when the picker knows it (a shared or external
    /// item carries none).
    pub type PickedEntry = (String, Option<String>);

    /// Where the delegate keeps what it is collecting between callbacks.
    pub struct PickerState {
        /// Entries copied out so far, in the order the loads completed.
        picked: RefCell<Vec<PickedEntry>>,
        /// Items still loading; the answer is sent when this reaches zero.
        outstanding: RefCell<usize>,
        reply: RefCell<Option<Sender<Result<Vec<PickedEntry>, String>>>>,
    }

    impl PickerState {
        /// Sends the collected paths once, and only once: the picker can
        /// finish with nothing outstanding, and every load can also fail.
        fn finish_if_done(&self) {
            if *self.outstanding.borrow() > 0 {
                return;
            }
            if let Some(reply) = self.reply.borrow_mut().take() {
                let _ = reply.send(Ok(self.picked.borrow().clone()));
            }
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "EngramPhotoPickerDelegate"]
        #[ivars = PickerState]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        impl Delegate {
            #[unsafe(method(picker:didFinishPicking:))]
            fn did_finish_picking(&self, picker: &AnyObject, results: &NSArray<PHPickerResult>) {
                unsafe {
                    let _: () = msg_send![
                        picker,
                        dismissViewControllerAnimated: true,
                        completion: std::ptr::null::<AnyObject>(),
                    ];
                }

                let state = self.ivars();
                *state.outstanding.borrow_mut() = results.len();
                if results.is_empty() {
                    // Cancelled, or picked nothing: an empty list, not an error.
                    state.finish_if_done();
                    return;
                }

                for result in results.iter() {
                    let provider = unsafe { result.itemProvider() };
                    // The library identity, when the picker was configured
                    // with the photo library; rides along so an upload can
                    // stamp the same id the backup ledger keys on.
                    let asset_id = unsafe { result.assetIdentifier() }.map(|s| s.to_string());
                    // The item's OWN type identifier, not one we prefer: asking
                    // for public.jpeg is asking the system to transcode.
                    let identifiers = provider.registeredTypeIdentifiers();
                    let Some(identifier) = identifiers.iter().next() else {
                        *state.outstanding.borrow_mut() -= 1;
                        state.finish_if_done();
                        continue;
                    };

                    // The block outlives this call, so it needs its own
                    // strong reference rather than borrowing the delegate.
                    let this = unsafe { Retained::retain(self as *const Self as *mut Self) }
                        .expect("the delegate is alive while its picker is up");
                    let handler = RcBlock::new(move |url: *mut NSURL, _err: *mut NSError| {
                        let state = this.ivars();
                        if !url.is_null() {
                            // The system deletes this the moment the block
                            // returns, so it has to be copied here, not later.
                            if let Some(copied) = copy_out(unsafe { &*url }) {
                                state.picked.borrow_mut().push((copied, asset_id.clone()));
                            }
                        }
                        *state.outstanding.borrow_mut() -= 1;
                        state.finish_if_done();
                    });
                    unsafe {
                        provider.loadFileRepresentationForTypeIdentifier_completionHandler(
                            &identifier,
                            &handler,
                        );
                    }
                }
            }
        }
    );

    /// Copies a picker's temporary file somewhere it will still exist when
    /// the web layer asks to read it, keeping the original name.
    fn copy_out(url: &NSURL) -> Option<String> {
        let from = PathBuf::from(url.path()?.to_string());
        let name = from.file_name()?.to_owned();
        let dir = super::picked_dir();
        std::fs::create_dir_all(&dir).ok()?;
        let to = dir.join(name);
        std::fs::copy(&from, &to).ok()?;
        Some(to.to_string_lossy().into_owned())
    }

    /// Presents the picker. Must run on the main thread; blocks the caller
    /// until the sheet is dismissed and every chosen item is copied out.
    pub fn present(reply: Sender<Result<Vec<PickedEntry>, String>>) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("the picker must open on the main thread")?;
        unsafe {
            // Configured WITH the photo library so results carry asset
            // identifiers; still the out-of-process picker, still no
            // library permission asked of the person.
            let configuration = PHPickerConfiguration::initWithPhotoLibrary(
                PHPickerConfiguration::alloc(),
                &objc2_photos::PHPhotoLibrary::sharedPhotoLibrary(),
            );
            configuration.setSelectionLimit(0);
            // The whole point of this file.
            configuration.setPreferredAssetRepresentationMode(
                PHPickerConfigurationAssetRepresentationMode::Current,
            );
            let filter =
                PHPickerFilter::anyFilterMatchingSubfilters(&NSArray::from_retained_slice(&[
                    PHPickerFilter::imagesFilter(),
                    PHPickerFilter::videosFilter(),
                ]));
            configuration.setFilter(Some(&filter));

            let controller: Retained<PickerController> = msg_send![
                PickerController::alloc(mtm),
                initWithConfiguration: &*configuration,
            ];

            let delegate = Delegate::alloc(mtm).set_ivars(PickerState {
                picked: RefCell::new(Vec::new()),
                outstanding: RefCell::new(0),
                reply: RefCell::new(Some(reply)),
            });
            let delegate: Retained<Delegate> = msg_send![super(delegate), init];
            let _: () = msg_send![&*controller, setDelegate: &*delegate];
            // Held by the controller only weakly, so it must outlive this call.
            std::mem::forget(delegate);

            let application = UIApplication::sharedApplication(mtm);
            // Deprecated for multi-scene apps; this shell has one window, and
            // the alternative is reaching through connected scenes for the
            // same object. If it ever returns nothing the picker refuses
            // loudly below rather than failing to appear for no stated reason.
            #[allow(deprecated)]
            let window = application
                .keyWindow()
                .ok_or("no window to present the picker from")?;
            let root: Retained<UIViewController> = window
                .rootViewController()
                .ok_or("no view controller to present the picker from")?;
            root.presentViewController_animated_completion(&controller, true, None);
        }
        Ok(())
    }
}

/// Where picked files wait for the web layer to read them.
///
/// Its own directory rather than the temp root, because reading is scoped to
/// exactly this path: the shell will not hand the page bytes from anywhere
/// else, and the page has no say in where that is.
pub fn picked_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("engram-picked")
}

/// Resolves a requested path to a real file inside the staging directory,
/// refusing everything else. Every command that touches staged files goes
/// through this: the page names paths, and the only paths it may name are
/// the ones the picker or an export staged for it.
pub fn staged_path(path: &str) -> Result<std::path::PathBuf, String> {
    let requested = std::path::PathBuf::from(path);
    let canonical = requested.canonicalize().map_err(|err| err.to_string())?;
    let root = picked_dir()
        .canonicalize()
        .map_err(|_| "nothing has been picked".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("that file did not come from the picker".to_string());
    }
    Ok(canonical)
}

/// Reads a file the picker produced, then removes it.
///
/// Separate from `watched_file_read`, which may only read inside folders the
/// person explicitly chose to watch; a picked photo is in neither, and
/// widening that command to reach the temp directory would have handed the
/// page a way to read far more than it was ever offered. Deleting after the
/// read keeps the directory from growing for the life of the app.
///
/// This is the WHOLE-FILE read, kept for pages older than the ranged
/// commands below; those never delete on read, because fifty windows into
/// one file must all find it there.
#[tauri::command]
pub async fn picked_file_read(path: String) -> Result<tauri::ipc::Response, String> {
    let canonical = staged_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&canonical).map_err(|err| err.to_string())?;
        // Best effort: a file left behind is untidy, not incorrect.
        let _ = std::fs::remove_file(&canonical);
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// The largest single ranged read; the page asks in 4 MiB windows, and
/// nothing it can send makes one answer bigger than this.
const RANGE_READ_CLAMP: u64 = 8 * 1024 * 1024;

/// A bounded window of a staged file. What is actually on disk decides
/// the answer: a read past the end returns the bytes that exist, and the
/// page treats any shortfall against its stat as the error it is.
pub fn read_range_at(path: &std::path::Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|err| err.to_string())?;
    let mut bytes = Vec::with_capacity(length.min(RANGE_READ_CLAMP) as usize);
    file.take(length.min(RANGE_READ_CLAMP))
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok(bytes)
}

/// Whether this shell serves the ranged staged-file commands. The page
/// probes this BEFORE presenting the picker, so an old page on a new shell
/// keeps its whole-file path and a new page on an old shell falls back to
/// the browser input instead of reading videos whole.
#[tauri::command]
pub fn picked_probe() -> bool {
    true
}

#[derive(serde::Serialize)]
pub struct PickedStat {
    pub size: u64,
    pub mtime_ms: Option<f64>,
}

/// Size and modification time of a staged file, so the page can build a
/// file handle without moving a single content byte.
#[tauri::command]
pub async fn picked_file_stat(path: String) -> Result<PickedStat, String> {
    let canonical = staged_path(&path)?;
    let meta = std::fs::metadata(&canonical).map_err(|err| err.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    Ok(PickedStat {
        size: meta.len(),
        mtime_ms,
    })
}

/// One bounded window of a staged file; the streaming upload's read.
#[tauri::command]
pub async fn picked_file_read_range(
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    let canonical = staged_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_range_at(&canonical, offset, length).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Removes a staged file once its upload settled; the ranged reads never
/// delete on their own.
#[tauri::command]
pub async fn picked_file_delete(path: String) -> Result<(), String> {
    let canonical = staged_path(&path)?;
    // Best effort: a file left behind is untidy, not incorrect.
    let _ = std::fs::remove_file(&canonical);
    Ok(())
}

/// Sweeps the staging directory, keeping only the named files. Deletion
/// is explicit and an app killed mid-upload deletes nothing, so the page
/// drives this once it knows which interrupted uploads still need their
/// staged bytes; everything else is a leftover of some earlier kill.
#[tauri::command]
pub fn picked_sweep(keep: Vec<String>) -> u32 {
    sweep_dir(&picked_dir(), &keep)
}

fn sweep_dir(dir: &std::path::Path, keep: &[String]) -> u32 {
    let kept: Vec<std::path::PathBuf> = keep
        .iter()
        .filter_map(|path| std::path::PathBuf::from(path).canonicalize().ok())
        .collect();
    let mut removed = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(canonical) = entry.path().canonicalize() else {
                continue;
            };
            if !kept.contains(&canonical) && std::fs::remove_file(&canonical).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn staged(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = picked_dir();
        std::fs::create_dir_all(&dir).expect("staging dir");
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).expect("staged file");
        file.write_all(bytes).expect("staged bytes");
        path
    }

    #[test]
    fn staged_path_admits_the_staging_dir_only() {
        let inside = staged("scope-probe.bin", b"ok");
        assert!(staged_path(&inside.to_string_lossy()).is_ok());
        let err = staged_path("/etc/hosts").unwrap_err();
        assert!(err.contains("picker"), "unexpected refusal: {err}");
        let _ = std::fs::remove_file(inside);
    }

    #[test]
    fn staged_path_refuses_escapes_through_the_staging_dir() {
        let inside = staged("escape-probe.bin", b"ok");
        let sneaky = format!("{}/../..{}", picked_dir().to_string_lossy(), "/etc/hosts");
        assert!(staged_path(&sneaky).is_err());
        let _ = std::fs::remove_file(inside);
    }

    #[test]
    fn ranged_reads_answer_exact_windows() {
        let bytes: Vec<u8> = (0..=255u8).collect();
        let path = staged("window-probe.bin", &bytes);
        assert_eq!(read_range_at(&path, 10, 5).unwrap(), bytes[10..15]);
        assert_eq!(read_range_at(&path, 0, 256).unwrap(), bytes);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_read_past_the_end_returns_what_exists() {
        let path = staged("eof-probe.bin", b"0123456789");
        assert_eq!(read_range_at(&path, 8, 100).unwrap(), b"89");
        assert_eq!(read_range_at(&path, 50, 4).unwrap(), Vec::<u8>::new());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_sweep_keeps_what_interrupted_uploads_still_need() {
        // Its own directory: the shared staging dir belongs to the other
        // tests running beside this one.
        let dir = std::env::temp_dir().join("engram-sweep-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("sweep dir");
        let keeper = dir.join("keeper.bin");
        let leftover = dir.join("leftover.bin");
        std::fs::write(&keeper, b"keep").expect("keeper");
        std::fs::write(&leftover, b"drop").expect("leftover");
        let removed = sweep_dir(&dir, &[keeper.to_string_lossy().into_owned()]);
        assert_eq!(removed, 1);
        assert!(keeper.exists());
        assert!(!leftover.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_window_larger_than_the_clamp_is_bounded() {
        let path = staged("clamp-probe.bin", &[7u8; 64]);
        // The clamp caps the ANSWER, not the file: asking for u64::MAX
        // must not try to allocate it.
        assert_eq!(read_range_at(&path, 0, u64::MAX).unwrap().len(), 64);
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(target_os = "ios")]
async fn run_picker(app: tauri::AppHandle) -> Result<Vec<(String, Option<String>)>, String> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    let present_tx = tx.clone();
    app.run_on_main_thread(move || {
        if let Err(err) = ios::present(present_tx.clone()) {
            let _ = present_tx.send(Err(err));
        }
    })
    .map_err(|err| err.to_string())?;
    rx.recv()
        .map_err(|_| "the picker closed unexpectedly".to_string())?
}

/// Paths to the photos and videos the person chose, as their original files.
///
/// Empty when they cancelled, which is not an error. Every other platform
/// keeps using the web file input, so this exists only on iOS. Kept
/// path-only for pages older than `pick_photos_with_ids`.
#[tauri::command]
pub async fn pick_photos(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "ios")]
    {
        Ok(run_picker(app)
            .await?
            .into_iter()
            .map(|(path, _)| path)
            .collect())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err("the native photo picker is only available on iOS".to_string())
    }
}

/// One picked item: its staged path, and the photo-library identity it
/// came from when the picker knows it.
#[derive(serde::Serialize)]
pub struct PickedItem {
    pub path: String,
    pub id: Option<String>,
}

/// The picker with asset identities, so an upload can stamp the same id
/// the backup ledger keys on and hand-picked photos stop double-uploading.
#[tauri::command]
pub async fn pick_photos_with_ids(app: tauri::AppHandle) -> Result<Vec<PickedItem>, String> {
    #[cfg(target_os = "ios")]
    {
        Ok(run_picker(app)
            .await?
            .into_iter()
            .map(|(path, id)| PickedItem { path, id })
            .collect())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err("the native photo picker is only available on iOS".to_string())
    }
}

/// A poster frame for a staged or watched video, as bounded JPEG bytes.
///
/// The page used to capture posters by pointing a media element at the
/// picked:// protocol and drawing a frame to a canvas; on iOS that path
/// can refuse the load or taint the canvas, and either way the video
/// uploads with no thumbnail. AVFoundation reads the file directly, so
/// none of the browser's cross-origin rules apply.
#[tauri::command]
pub async fn video_poster(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let canonical =
        staged_path(&path).or_else(|_| crate::watched::watched_path(&app, &path))?;
    #[cfg(target_os = "ios")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            poster_jpeg(&canonical).map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|err| err.to_string())?
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = canonical;
        Err("native posters are only generated on iOS".to_string())
    }
}

#[cfg(target_os = "ios")]
fn poster_jpeg(path: &std::path::Path) -> Result<Vec<u8>, String> {
    use objc2::AnyThread;
    use objc2_av_foundation::{AVAsset, AVAssetImageGenerator};
    use objc2_core_foundation::CGSize;
    use objc2_core_media::CMTime;
    use objc2_foundation::{NSString, NSURL};
    use objc2_ui_kit::{UIImage, UIImageJPEGRepresentation};
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let asset = AVAsset::assetWithURL(&url);
        let generator =
            AVAssetImageGenerator::initWithAsset(AVAssetImageGenerator::alloc(), &asset);
        generator.setAppliesPreferredTrackTransform(true);
        generator.setMaximumSize(CGSize {
            width: 1280.0,
            height: 1280.0,
        });
        // Half a second in: past a fade-from-black opening frame, well
        // before any clip's end.
        let time = CMTime::new(1, 2);
        let image = generator
            .copyCGImageAtTime_actualTime_error(time, std::ptr::null_mut())
            .map_err(|err| err.localizedDescription().to_string())?;
        let ui = UIImage::imageWithCGImage(&image);
        let data = UIImageJPEGRepresentation(&ui, 0.85)
            .ok_or_else(|| "the frame did not encode".to_string())?;
        Ok(data.to_vec())
    }
}
