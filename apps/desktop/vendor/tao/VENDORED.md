# Vendored tao

This is `tao` 0.35.3 from crates.io (Apache-2.0, see LICENSE), the
windowing layer under Tauri 2.11, used through `[patch.crates-io]` in the
workspace `Cargo.toml`. Examples and packaging leftovers were removed;
nothing else differs except the changes below.

## Changes

`src/platform_impl/ios/view.rs`, `configuration_for_connecting_scene_session`:
the scene configuration handed back to UIKit was the raw pointer of a
`Retained` value dropped at the end of the function, so UIKit received a
freed object and a release build crashed in `objc_retain` inside
`-[UIApplication _connectUISceneFromFBSScene:transitionContext:]` while
the first scene connected (debug builds survived on the autorelease
pool). The object is now autoreleased, which is what tao 0.37 does.

`src/platform_impl/macos/view.rs`, `inset_traffic_lights`: the traffic
light buttons now take the requested inset as the distance from the
window's top to their top edge. Upstream moves only their x and resizes
the title bar strip, keeping AppKit's own offset from the strip's bottom;
macOS 26 raised that offset to 9 points, so the lights sat about 9 points
above the configured `trafficLightPosition`. With `ENGRAM_WINDOW_CHROME_LOG`
set, the function reports the close button's landing position on stderr
(`window-chrome: close-light top-left=(x,y) size=s`); the release check
`scripts/mac-chrome-check.mjs` reads that line.

`src/platform_impl/macos/window_delegate.rs`, `reapply_traffic_lights`:
the inset is applied again from `windowDidResize:`, `windowDidBecomeKey:`,
`windowDidExitFullScreen:` and `windowDidChangeBackingProperties:`.
Upstream applies it only from the content view's `drawRect:`; a web view
covers that view for the life of the window, so the inset ran once at
most and AppKit's own layout of the standard buttons stood.

Tauri 2.11 pins `tao ^0.35`, so 0.37 cannot be taken directly. Drop this
directory and the patch entry once Tauri moves to a tao release that
carries the fix.
