# Apps and platforms

## What exists today

| Platform | Status |
|---|---|
| Web | Full client at your server's URL |
| iPhone / iPad | Installable web app (PWA): Share, then "Add to Home Screen". Opens standalone with its own icon; on iOS 26 home-screen sites open as apps by default |
| Mac | Installable web app: Safari File menu, "Add to Dock", or Chrome "Install Engram Store". Runs in its own window with a Dock icon |
| Android | Installable PWA with install prompt |
| Native desktop | Tauri 2 shell around the hosted client: watch folders, Touch ID unlock, and native file dialogs. Binaries are around 8 MB rather than the roughly 165 MB an equivalent Electron app would need, and the web client is reused as-is, so the cryptographic path stays identical and audited once |
| Native mobile binaries | Not available; the installable web app is the mobile client |

For comparison: Google Drive ships native iOS, Android, and desktop sync clients; Ente ships Flutter apps for iOS and Android plus desktop builds. Engram Store starts from an installable web app because the entire client, including all cryptography, already runs in the browser.

### iOS notes

The installed web app works offline for the app shell, but iOS applies tighter storage limits than other platforms and can evict site storage after long disuse. Keys live in the session only, so eviction never risks data loss; you sign back in and the vault resyncs. In the EU, Apple opens home-screen web apps in the browser instead of standalone mode.

## Pointing a build at your vault

The desktop shell is a native window around the hosted client, so a build has
to be told which deployment it belongs to. That address belongs to whoever
builds the app rather than to this source tree, so the committed
configuration names only `http://localhost:3080` and the real one is given at
build time:

```bash
ENGRAM_APP_URL=https://vault.example.com pnpm --filter @engramer/desktop bundle
```

Two things need it: the window's address, and the capability that lets that
origin call the shell's unlock commands, which is what makes Touch ID work.
Both are written into files that git ignores, so a build can never leave the
builder's own address in a tracked file.
