# Vendored swift-rs

This is `swift-rs` 1.0.8 from crates.io (MIT OR Apache-2.0, see the two
LICENSE files), used through `[patch.crates-io]` in the workspace
`Cargo.toml`. Packaging leftovers (`Cargo.lock`, `.github`, VCS metadata)
were removed; nothing else differs except the change below.

## Change

`src-rs/build.rs`, `globalize_cdecl_symbols`: Xcode 27 release builds
mark the Swift `@_cdecl` exports in a static library local. Version 1.0.8
restores them with `llvm-objcopy --globalize-symbol`, but only for the
archive member named after the package (`Tauri.o`). The members that come
from the package's dependencies keep their exports local; in Tauri's iOS
API package that is `SwiftRs.o`, whose `retain_object`, `release_object`
and `string_from_bytes` the Rust side needs, so the app failed to link.
The vendored copy considers every member. Symbols defined in more than one
member are still left alone, as upstream does.

`llvm-objcopy` comes from rustup's `llvm-tools` component
(`rustup component add llvm-tools`); without it the step only warns.

Drop this directory and the patch entry once an upstream release carries
the fix.
