# UI checks

Two checks look at every screen of the app on the real surfaces before a
release. Both run against a local server with a test account; neither
changes any data.

## Desktop catalog

`apps/web/scripts/ui-catalog.mjs` drives the web app in Chromium and
WebKit with the Mac desktop shell stubbed, at four window sizes and both
themes, and screenshots twenty states: the file grid and list, the icon
rail, a folder, Recent, Photos, Favorites, Shared, Trash, search with its
suggestions, results, a preview, the details pane, the file menu, the New
menu, the sort menu, notices, the account menu and Profile. In every
state it checks, inside the page:

- nothing extends past the viewport horizontally;
- every open menu or panel is the top-most element at its centre and
  corners;
- every toolbar control shares one centre line;
- no text is clipped without an ellipsis;
- at 1024 wide, no control is smaller than 28 by 28 pixels.

```sh
cd apps/web
CATALOG_EMAIL=you@example.com CATALOG_PASSPHRASE='...' \
  node scripts/ui-catalog.mjs capture out/baseline
# make changes, rebuild, then
node scripts/ui-catalog.mjs capture out/after
node scripts/ui-catalog.mjs compare out/baseline out/after out/diff
```

`compare` writes a red-highlighted diff image per screenshot and
`compare.md`, sorted by the share of changed pixels, plus the invariant
failures that are new or fixed. `selftest` runs the checks against a
deliberately broken page. Playwright's `playwright-core` package and the
browser builds are found through `CATALOG_PLAYWRIGHT`, `CATALOG_CHROMIUM`
and `CATALOG_WEBKIT`; the server through `CATALOG_URL` (default
`http://127.0.0.1:3181`).

## iOS screen walk

`apps/desktop/ios-screenwalk` is a UI test that walks the installed app
on an iOS simulator and saves a screenshot of each screen, with the
keyboard, safe areas and web view of the real app. Its README has the
three commands. Run it on the iPhone 16 Pro Max (the widest phone) and an
iPad Pro before a release that touches layout.
