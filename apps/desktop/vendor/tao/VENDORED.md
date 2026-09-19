# Vendored tao

This is `tao` 0.35.3 from crates.io (Apache-2.0, see LICENSE), the
windowing layer under Tauri 2.11, used through `[patch.crates-io]` in the
workspace `Cargo.toml`. Examples and packaging leftovers were removed;
nothing else differs except the change below.

## Change

`src/platform_impl/ios/view.rs`, `configuration_for_connecting_scene_session`:
the scene configuration handed back to UIKit was the raw pointer of a
`Retained` value dropped at the end of the function, so UIKit received a
freed object and a release build crashed in `objc_retain` inside
`-[UIApplication _connectUISceneFromFBSScene:transitionContext:]` while
the first scene connected (debug builds survived on the autorelease
pool). The object is now autoreleased, which is what tao 0.37 does.

Tauri 2.11 pins `tao ^0.35`, so 0.37 cannot be taken directly. Drop this
directory and the patch entry once Tauri moves to a tao release that
carries the fix.
