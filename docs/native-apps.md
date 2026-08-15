# Apps and platforms

## What exists today

| Platform | Status |
|---|---|
| Web | Full client at your server's URL |
| Mac app | Tauri 2 shell around the hosted client, shipped as a notarized DMG. Adds a Finder drive (the vault under Locations, beside iCloud Drive), watch folders, Touch ID unlock, share links from Finder's context menu, and a menu-bar tray |
| iPhone app | Native app (TestFlight). Adds the vault as a drive in the Files app and every app's file picker, saving into the vault from any share sheet, automatic photo backup, Face ID unlock, and a native photo picker that keeps HEIC/HEVC originals |
| iPhone / iPad without the app | Installable web app (PWA): Share, then "Add to Home Screen". Opens standalone with its own icon; on iOS 26 home-screen sites open as apps by default |
| Mac without the app | Installable web app: Safari File menu, "Add to Dock", or Chrome "Install Engram Store" |
| Android | Installable PWA with install prompt |

The native shells reuse the web client as-is, so the cryptographic path stays
identical and audited once. Binaries are around 8 MB rather than the roughly
165 MB an equivalent Electron app would need.

## The Mac app is a Finder drive

Turning on "Extensions on this device" in Profile puts the vault under
Locations in Finder's sidebar. Files download and decrypt as they are opened;
new and edited files encrypt and upload in place; a delete goes to the vault's
trash, so it is recoverable; a conflicting save becomes a "(conflicted copy)"
rather than lost work. Finder's own "Download Now" and "Remove Download"
work on drive files, and changes made on other devices appear within a sync
cycle while the app is open. Right-clicking a drive file offers "Copy Share
Link", which puts a working share link on the clipboard, reusing an existing
open share when one exists; links stay revocable from the web app's Shared
view. The app can leave the Dock and park in the menu-bar tray.

Deployments that host a DMG can advertise it by setting
`ENGRAMER_MAC_DMG_URL`; the Profile page then shows a "Get the Mac app" row
to signed-in desktop users. Deployments that offer none show nothing.

## The iPhone app

With extensions turned on, the vault appears as a drive in the Files app and
in any app's file picker: browse it, open from it, save into it, and edit
documents in place. Renames, moves, and deletes update the vault, with
deletes going to the trash. If a file changed elsewhere while you were
editing, your version is kept as a conflicted copy rather than overwriting
the newer one.

The vault also appears in the share sheet from Photos, Safari, Mail, or any
other app; the item is encrypted on-device and uploaded in the background,
with a destination picker offering Smart classify, the vault root, or a
chosen folder. Automatic photo backup is opt-in: originals are never
recompressed, and the choices cover Wi-Fi only, videos, screenshots, and how
far back to reach. Face ID unlocks the vault at app open. The sign-in screen
has a visible server picker, so one app serves any deployment, self-hosted
included. The vault key is stored behind the device passcode, on this device
only, never in iCloud, and removed at sign-out.

### iOS notes

The installed web app (without the native app) works offline for the app
shell, but iOS applies tighter storage limits than other platforms and can
evict site storage after long disuse. Keys live in the session only, so
eviction never risks data loss; you sign back in and the vault resyncs. In
the EU, Apple opens home-screen web apps in the browser instead of
standalone mode.

## Pointing a build at your vault

The shells are native windows around the hosted client, so a build has to be
told which deployment it belongs to. That address belongs to whoever builds
the app rather than to this source tree, so the committed configuration names
only `http://localhost:3080` and the real one is given at build time:

```bash
ENGRAM_APP_URL=https://vault.example.com pnpm --filter @engramer/desktop bundle
```

Two things need it: the window's address, and the capability that lets that
origin call the shell's unlock commands, which is what makes Touch ID work.
Both are written into files that git ignores, so a build can never leave the
builder's own address in a tracked file. The iOS bundle script refuses to run
without `ENGRAM_APP_URL` for the same reason, and the signed, notarized,
stapled DMG comes from `apps/desktop/scripts/mac-release.mjs`, which takes
the signing identity, team, and provisioning profiles entirely from the
environment.
