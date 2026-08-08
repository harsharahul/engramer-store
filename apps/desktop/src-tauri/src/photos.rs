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
        define_class, extern_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly,
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

    /// Where the delegate keeps what it is collecting between callbacks.
    pub struct PickerState {
        /// Paths copied out so far, in the order the picker returned them.
        picked: RefCell<Vec<String>>,
        /// Items still loading; the answer is sent when this reaches zero.
        outstanding: RefCell<usize>,
        reply: RefCell<Option<Sender<Result<Vec<String>, String>>>>,
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
                                state.picked.borrow_mut().push(copied);
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
    pub fn present(reply: Sender<Result<Vec<String>, String>>) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("the picker must open on the main thread")?;
        unsafe {
            let configuration = PHPickerConfiguration::new();
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

/// Reads a file the picker produced, then removes it.
///
/// Separate from `watched_file_read`, which may only read inside folders the
/// person explicitly chose to watch; a picked photo is in neither, and
/// widening that command to reach the temp directory would have handed the
/// page a way to read far more than it was ever offered. Deleting after the
/// read keeps the directory from growing for the life of the app.
#[tauri::command]
pub async fn picked_file_read(path: String) -> Result<tauri::ipc::Response, String> {
    let requested = std::path::PathBuf::from(&path);
    let canonical = requested.canonicalize().map_err(|err| err.to_string())?;
    let root = picked_dir()
        .canonicalize()
        .map_err(|_| "nothing has been picked".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("that file did not come from the picker".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&canonical).map_err(|err| err.to_string())?;
        // Best effort: a file left behind is untidy, not incorrect.
        let _ = std::fs::remove_file(&canonical);
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Paths to the photos and videos the person chose, as their original files.
///
/// Empty when they cancelled, which is not an error. Every other platform
/// keeps using the web file input, so this exists only on iOS.
#[tauri::command]
pub async fn pick_photos(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "ios")]
    {
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
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err("the native photo picker is only available on iOS".to_string())
    }
}
