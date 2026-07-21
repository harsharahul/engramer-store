# Changelog

All notable changes to Engramer Store are documented here, following
[Keep a Changelog](https://keepachangelog.com/) and semantic versioning.

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
