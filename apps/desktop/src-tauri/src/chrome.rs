//! The web view owns the whole screen on iOS.
//!
//! WKWebView's scroll view adjusts its content inset for the safe areas by
//! default, which shrinks the page's viewport by the status bar and the
//! home indicator; the stylesheet then subtracts them a second time
//! through env(safe-area-inset-*), and everything sits 34px too high on a
//! viewport already 96pt short. The page is the better judge of its own
//! edges, so the adjustment is turned off and the insets are left for
//! env() to report honestly. Verified by the in-app viewport diagnostics:
//! done when inner equals screen.

#[cfg(target_os = "ios")]
pub fn extend_under_safe_area(window: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_ui_kit::{
        UIRectEdge, UIScrollView, UIScrollViewContentInsetAdjustmentBehavior, UIViewController,
    };

    let _ = window.with_webview(|webview| unsafe {
        let wk = webview.inner() as *mut AnyObject;
        if let Some(wk) = wk.as_ref() {
            let scroll: Retained<UIScrollView> = objc2::msg_send![wk, scrollView];
            scroll.setContentInsetAdjustmentBehavior(
                UIScrollViewContentInsetAdjustmentBehavior::Never,
            );
        }
        let vc = webview.view_controller() as *mut UIViewController;
        if let Some(vc) = vc.as_ref() {
            vc.setEdgesForExtendedLayout(UIRectEdge::All);
            vc.setExtendedLayoutIncludesOpaqueBars(true);
        }
    });
}
