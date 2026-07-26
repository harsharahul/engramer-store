# Changelog

All notable changes to Engram Store are documented here, following
[Keep a Changelog](https://keepachangelog.com/) and semantic versioning.

## [0.7.0] - 2026-07-26

### Added
- Password-protected share links. Setting a password wraps the file key under
  an Argon2id-derived key on your device; the server stores only the wrapped
  key and a verifier digest (the same scheme as login), so it can refuse
  visitors who do not know the password while remaining unable to decrypt
  anything itself. The public page prompts for the password and unwraps the
  key locally.
- Link expiry (1 hour to 30 days, or never) and download limits (including
  one-time links), both enforced server side with an atomic download counter.
- A Shared view in the sidebar listing every active link with its file, expiry,
  download count, and protection status, plus copy and revoke actions.
- File requests: create a link anyone can use to send files into your vault.
  The public page encrypts each file on the sender's device, including
  thumbnail and searchable metadata, and seals the file key to your public
  key; arrivals are unsealed, re-wrapped, and filed into the folder you chose
  automatically on your next sync. Requests support labels (kept out of the
  server's sight), destination folders, expiry, and closing at any time.
  Design notes in docs/sharing.md.

### Fixed
- The Share dialog opens again from the context menu, preview, and details
  panel; its mount was lost in the 0.4.0 interface rework.

## [0.6.0] - 2026-07-24

### Added
- Local S3 bridge (`apps/bridge`): a self-hostable, zero-knowledge S3 endpoint
  that runs inside your own trust boundary, unlocks the vault locally, and lets
  any S3 client (rclone, s3fs, the AWS SDK) browse and download your encrypted
  files, with each top-level folder presented as a bucket. It serves
  ListBuckets, ListObjectsV2 with prefix and delimiter, HeadObject, and ranged
  GetObject, verifying SigV4 against a locally generated credential. The Engram
  Store server still only ever holds ciphertext. Read path first; write support
  is planned. Design in docs/s3-gateway.md.

### Security
- Cleared three dependency advisories: bumped `@fastify/static` to 10.1.2 (route
  guard and non-canonical path authorization bypasses), and migrated the web
  client from the frozen `react-router-dom` 7 to `react-router` 8 (the RSC-mode
  CSRF advisory; the app is a client-side SPA, so the flaw did not apply, and the
  supported fix is the v8 package merge).

## [0.5.0] - 2026-07-22

Rebrand to Engram Store, with a themeable ocean design system.

### Changed
- New brand: the app is now Engram Store, with a shield-document logo, the
  "engram store" wordmark, and the tagline "Private, encrypted, yours." The app
  icons and the in-app brand mark are generated from the ocean logo.
- Redesigned around an ocean palette (deep navy ink, cool paper, an ocean-blue
  accent with a cyan highlight) in place of the previous warm theme, and the
  primary button gets a cleaner two-stop fill.
- Typography moves to Geist, with Geist Mono for keyboard hints, for a crisper,
  more premium feel.

### Added
- Day and night (light and dark) modes, remembered per device and initialised
  from the system preference, with a toggle in the sidebar.
- Accent themes drawn from the brand's gradient variants: Ocean, Aurora,
  Emerald, Violet, Sunset, and Midnight. Selecting one recolours the whole
  interface and the in-app logo together.

## [0.4.1] - 2026-07-21

### Changed
- App icon refined: richer brass, layered papers, sheen, and an embossed
  keyhole, with the same mark now used as the in-app brand on the sign-in
  screen and sidebar.
- Every file kind casts its own subtle color atmosphere behind its card art,
  and thumbnails ease into a gentle zoom on hover.
- Newly uploaded files greet you with a brass shimmer sweep.
- View titles are set in the display serif; the active sidebar item gains a
  brass indicator bar; primary buttons, the storage meter, and the details
  panel pick up gradient, glow, and slide-in refinements.
- Empty states show the folder illustration with clear next actions.

## [0.4.0] - 2026-07-21

### Added
- Details panel: a right-hand inspector with preview, metadata, actions, and
  inline tag editing, opened by selecting any file.
- Selection model: click to select, double-click to open, shift and
  Cmd/Ctrl-click for ranges, with a floating bulk bar for favorite, move, and
  trash across many files at once.
- Right-click context menus for files and folders, a Move dialog, and
  drag-and-drop of files onto folders and breadcrumbs.
- List view with sortable columns alongside the grid, plus sort controls and a
  per-user remembered layout.
- S3-compatible blob storage backend (`ENGRAMER_S3_*`): AWS S3, MinIO,
  Cloudflare R2, Garage, and Ceph RGW, with streaming multipart uploads and
  automatic bucket creation. Storage architecture and reliability recipes are
  documented in docs/storage.md.

### Changed
- New app icon: a brass vault dial.
- Keyboard focus outlines throughout, and animations respect
  `prefers-reduced-motion`.

## [0.3.0] - 2026-07-21

### Added
- In-app editor for text, Markdown, and code files: content decrypts in the
  browser and re-encrypts with the file's existing key on save (Cmd+S), with
  the search index refreshed from the new content in the same operation.
- Notes: create a Markdown note from the toolbar prompt or the command palette
  and start writing immediately.
- Document editing architecture documentation, including the end-to-end
  encrypted live-collaboration design (client-side CRDTs over an encrypted
  relay) and the reasoning for not integrating server-side office suites.

## [0.2.1] - 2026-07-20

### Fixed
- Password key derivation now uses libsodium's moderate Argon2id profile
  (256 MiB, 3 passes) instead of the sensitive profile (1 GiB). The larger
  allocation exhausted memory on mobile browsers and CI runners, so signup and
  unlock could fail outright on constrained devices. The moderate profile
  remains an order of magnitude above the OWASP floor, and signup and unlock
  are now substantially faster. Existing accounts are unaffected: each account
  stores the parameters it was created with and keeps using them.

### Added
- A test asserting the Argon2id parameters stay at or above the OWASP floor, so
  the cost cannot be weakened unnoticed.

## [0.2.0] - 2026-07-20

Intelligence and experience release. Everything below runs on the client; the
server still sees only ciphertext.

### Added
- Auto-categorization: uploads are analyzed on-device (type, name patterns,
  EXIF, dimensions, content keywords) and filed into category folders with
  auto-assigned tags such as capture year, camera make, screenshot, invoice,
  contract, and resume.
- Library: live category views in the sidebar (Photos, Screenshots, Documents,
  Receipts, and more) computed from encrypted tags.
- Full-text extraction from PDFs via pdf.js, joining text files in the
  encrypted search index.
- Command palette (Cmd+K) searching names, tags, and contents, with a query
  grammar of `tag:`, `type:`, `in:`, and `is:favorite` filters, plus actions.
- Favorites with an instant star toggle, editable tag chips, and a post-upload
  reveal showing where each file was filed and how it was tagged.
- Paste to upload: paste a screenshot or file anywhere in the app.
- Installable app (PWA): standalone window, home-screen and Dock icons, and an
  offline app shell.
- Docker image and Compose file for one-command self-hosting, published to the
  GitHub Container Registry by CI.
- Platform documentation covering current install options and the native
  desktop and mobile roadmap.

### Changed
- Card artwork is now illustrated: layered folders that open on hover and
  file-type sheets with per-kind accent colors, replacing text badges.
- Category views and the sidebar use per-category icons.

### Security
- The service worker precaches the application shell only. Encrypted blobs and
  API responses are deliberately never cached.

## [0.1.0] - 2026-07-19

Initial release.

### Added
- End-to-end encrypted file storage: XChaCha20-Poly1305 streaming encryption
  for content, per-file keys, Argon2id password key derivation, recovery keys.
- Zero-knowledge server: Fastify API with SQLite metadata and on-disk
  ciphertext blobs, per-user quotas enforced during streaming upload, and
  sequence-number delta sync.
- Web client: Drive-style file browser with nested encrypted folders,
  drag-and-drop uploads with progress, rename, move, trash, and restore.
- Client-side intelligence: fuzzy name search and full-text search over text
  extracted at upload time, encrypted thumbnails generated in the browser, and
  decrypted previews for images, video, audio, PDF, and text.
- Public share links with the decryption key in the URL fragment, revocable
  server-side.
- Test suite: crypto round-trip and tamper tests, plus API integration tests
  including a ciphertext-only-on-disk assertion.

Designed by Harsha Rahul
