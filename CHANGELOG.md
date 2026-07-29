# Changelog

All notable changes to Engram Store are documented here, following
[Keep a Changelog](https://keepachangelog.com/) and semantic versioning.

## [0.20.0] - 2026-07-29

### Security
- A document can no longer carry script into the app. The .docx renderer
  places "alternative content" parts in a same-origin frame, which a
  document arriving from a stranger through a file request could use to
  reach the keys held in the page; the feature is now off.
- Two-factor enrolment can no longer be used to switch two-factor off. A
  session alone could previously call setup and silently clear an enabled
  second factor; that now requires the disable route and a current code.
- Password-hashing parameters have a hard floor on both sides. A hostile
  server could otherwise return trivial parameters before login, watch a
  cheap derivation, and attack the password offline; parameters below the
  OWASP minimum are refused, and local memory pressure now fails rather
  than silently recording weaker parameters forever.
- Share-link password attempts are throttled with the same escalating
  backoff as sign-in, and anonymous file-request uploads are bounded in
  both field size and rows in flight.
- Disabling an account now also stops its share links and file requests,
  not only its sessions.
- Recovery codes carry 128 bits of entropy instead of 40.
- Invite links carry their token in the URL fragment, so it never reaches
  a server log, and it is cleared from the address bar once read.
- `ENGRAMER_TRUSTED_PROXY_HOPS` makes the failure throttle see real client
  addresses behind a reverse proxy; without it every request shares the
  proxy's address, which turns a per-account throttle into a way for a
  stranger to lock someone out.
- Recent searches, which are plaintext, are cleared on sign-out.

## [0.19.0] - 2026-07-29

### Security
- Content Security Policy and companion headers on every response. The
  policy is deny-by-default and allows only what the app uses: no external
  origin is reachable, so even a compromised dependency cannot exfiltrate
  decrypted content, and `object-src` and `frame-ancestors` are closed.
  WebAssembly is permitted for on-device OCR but plain `eval` is not, and
  the client's inline theme script is allowed by hash computed from the
  served page at startup rather than by weakening the policy.
- The pre-login endpoint no longer reveals which emails have accounts. An
  unknown address receives a stable decoy key-derivation salt derived under
  the server's secret, indistinguishable from a real one, and the endpoint
  is now covered by the same failure throttle as sign-in.
- Cross-origin browser access is disabled by default (the client is served
  from the same origin); `ENGRAMER_CORS_ORIGINS` allows listing origins
  explicitly for deployments that need it.
- Validation failures no longer echo the expected payload shape.

## [0.18.0] - 2026-07-29

### Added
- Registration policy (`ENGRAMER_REGISTRATION`): `open` (default), `invite`
  (accounts require a single-use invite link), or `closed`. The sign-up form
  adapts to the server's policy automatically.
- Server administration. Administrators are declared by the operator through
  `ENGRAMER_ADMIN_EMAILS` (they may always register, which also bootstraps a
  fresh locked-down server) and get an admin panel: list accounts with usage
  and status, mint and revoke invite links, set per-user quota overrides,
  disable and re-enable accounts, and permanently delete an account with all
  of its stored data. Disabling cuts existing sessions immediately, not just
  future logins. There is deliberately no password reset: the server holds
  no key material, so the recovery key remains the only way back into an
  account.

## [0.17.0] - 2026-07-28

### Added
- PostgreSQL metadata backend (`ENGRAMER_DATABASE_URL`): metadata can live
  in a shared PostgreSQL database instead of embedded SQLite, the foundation
  for replicated deployments where server instances hold no local state.
  SQLite remains the default and the single-binary experience is unchanged.
  Every correctness mechanism carries over: the per-user change sequence,
  version snapshots and restores in real transactions, the atomic
  download-limit claim, and the append-only content invariants.
- The login-failure throttle now lives in the database, so every server
  instance enforces the same counters instead of each keeping its own.

### Changed
- Query audit for large libraries: added the missing indexes for folder
  tree recursion, per-folder file listings, share lookups by owner and by
  file, and file-request listings. Existing SQLite databases pick these up
  automatically on the next start.
- CI now runs the full product flow against a real PostgreSQL service on
  every push, alongside the SQLite suites.

## [0.16.0] - 2026-07-28

### Added
- Split blob destinations (`ENGRAMER_S3_DERIVED_BUCKET` and the
  `ENGRAMER_S3_DERIVED_*` family): thumbnails and search indexes can live on
  their own S3 backend, separate from the originals. Request-heavy tiny
  objects go to a fast unmetered store (for example a local MinIO) while the
  byte-heavy originals stay on cheap or rate-limited storage. Connection
  settings inherit from the primary so a second bucket on the same store is
  one variable; the derived backend gets its own request budget and never
  inherits the primary's. Enabling the split on an existing install needs no
  migration: pre-split derived blobs are served from the primary on first
  read and copied over on the way out, and deletes purge both locations.
- `ENGRAMER_BLOB_CACHE_DIR` points the disk hot tier at separate fast local
  storage, useful when the data directory lives on slower disks.
- `ENGRAMER_JWT_SECRET` supplies the session-signing secret from the
  environment, so replicated deployments can share one signing key instead
  of each generating a per-instance file.

## [0.15.0] - 2026-07-28

### Added
- Opt-in local hot tier for S3 backends (`ENGRAMER_BLOB_CACHE_BYTES`): the
  server keeps recently used thumbnails and search-index blobs on local disk
  and serves repeats without a round trip to the object store. Entries are
  written atomically, evicted least-recently-used within the configured
  budget, and durably invalidated on overwrite or delete, so a stale entry
  can never be served, even across a restart. Content blobs always stream
  from the object store.
- Opt-in request budget for rate-limited object stores
  (`ENGRAMER_S3_MAX_TPS`, `ENGRAMER_S3_MAX_CONCURRENT`): requests toward the
  S3 backend are paced first-in-first-out with no burst accumulation and
  capped in flight, enforced inside the S3 client so multipart upload parts
  and retries are budgeted too. A budget delays requests rather than
  rejecting them.

Both knobs are off by default; an unset variable means exactly the previous
behavior, and the filesystem backend is unaffected.

## [0.14.0] - 2026-07-27

### Added
- Instant boot from a per-account device cache. The client now persists the
  encrypted sync rows it receives in IndexedDB and hydrates the library from
  them on the next visit, so opening the vault renders in about a second even
  at 50,000 files; a single delta request (`sync?since=<cursor>`) then
  reconciles only what changed. The cached rows are the same ciphertext the
  server already stores, so the cache introduces no new key handling, and
  signing out deletes it.
- Offline reads: with the app shell served by the service worker and the
  library cached, the vault opens and browses even when the server is
  unreachable, shows a clear notice that it is displaying the device's copy,
  and recovers with a plain reload once connectivity returns.
- "Resync library" in the command palette rebuilds the device cache from a
  full sync, an escape hatch for a copy suspected stale.

### Changed
- Deletions now prune the device cache through sync tombstones, and cache
  writes are ordered by sequence number so concurrent tabs can never roll a
  row back to an older state.

## [0.13.0] - 2026-07-27

### Changed
- Search text moved out of the metadata rows into per-file encrypted index
  blobs. Sync payloads shrink to a few hundred bytes per file regardless of
  how much text a document or scan contains, which is the structural change
  that keeps first-load fast as libraries grow toward very large sizes. The
  client warms its search index on first search intent, fetching and
  decrypting index blobs a few at a time with a live "indexing n of m" hint,
  and existing libraries migrate to the new layout automatically in the
  background, no action needed. File-request uploads carry their index blob
  too, so received files stay searchable.

## [0.12.0] - 2026-07-27

### Added
- Folder uploads that keep their shape. Drop a nested folder (or use the new
  Folder button) and the whole tree is recreated: every path becomes the
  right folder, files land where they belong, and thousands of small files
  flow through a bounded parallel pipeline (four transfers at a time, the
  discipline mass-transfer tools converge on) with aggregate progress and
  automatic retry with backoff when the server throttles.
- Instant image grids. Uploads now embed a ~25-byte ThumbHash placeholder in
  the encrypted metadata, so grids paint a blurred stand-in immediately;
  real thumbnails load only as cards approach the viewport, through a small
  concurrency gate that never floods the server.
- Folders with thousands of items stay fluid: offscreen cards and rows skip
  rendering entirely (content-visibility), in the grid, the list, and search
  results alike.

## [0.11.0] - 2026-07-27

### Added
- Two-factor authentication with any authenticator app (RFC 6238 TOTP,
  implemented in-tree and pinned by the RFC's test vectors). Enrollment shows
  a QR code and manual key and requires a first valid code; login becomes two
  steps, and the account's key material is withheld until the second factor
  passes. Codes tolerate one step of clock drift and can never be replayed;
  ten one-time recovery codes are issued once and stored only as digests.
  The S3 bridge supports two-factor accounts via ENGRAM_TOTP. The design,
  including what a second factor can and cannot protect in an end-to-end
  encrypted system, is documented in docs/auth.md alongside the planned
  bring-your-own OpenID Connect single sign-on.
- Authentication endpoints now throttle failures per address and identity
  with exponential backoff and Retry-After, so password and code guessing
  gets slow fast without affecting anyone else.

### Fixed
- The interface no longer hangs on "Decrypting your library" when the first
  sync fails (server briefly unreachable, or a page restored from the
  browser's back/forward cache): it shows the error with a working retry,
  keeps the unlocked session, and a single undecryptable item can no longer
  block the rest of the library from loading.

## [0.10.0] - 2026-07-27

### Added
- Version history for every file. Saving new content, from the text editor,
  the Word editor, or a re-upload, keeps the previous content as a version
  instead of destroying it. The details panel lists each version with its
  date and size, offers a decrypted download of any version, and restores
  with one click; a restored file keeps its current name and tags while its
  content, size, and search text revert together. Restoring displaces the
  current content into history too, so a restore can always be undone.
  The server keeps the last 10 versions per file (`ENGRAMER_MAX_VERSIONS`),
  counts them against the storage quota, and purges them on permanent delete.
- The write path behind this is append-only: new content lands in a new blob
  before any pointer moves, inside a transaction that detects concurrent
  saves, so an interrupted or failed save can never corrupt a file. Design
  notes in docs/storage.md.

## [0.9.0] - 2026-07-27

### Added
- On-device OCR, opt-in from the sidebar. With "Read text in images" on, new
  screenshots, scans, and photos are read by tesseract.js as they upload, and
  the recognized text joins the encrypted metadata, making images fully
  searchable and improving auto-categorization (a photographed invoice files
  as a receipt). "Make images searchable" in the command palette sweeps the
  existing library with live progress, and any single image can be read from
  its context menu. The OCR worker, WebAssembly engine, and English model are
  all served from the app's own origin; no image, text, or request ever
  leaves the device.
- Search rebuilt around finding files you half-remember. Every term now
  matches names, tags, categories, folder names anywhere on the file's path,
  and extracted content, so typing a folder's name finds what's inside it.
  One-letter typos are forgiven, multi-word queries require every word,
  fresher files rank higher, and `before:`/`after:` date filters join the
  grammar along with type synonyms like `type:photo`.
- Search results redesigned: thumbnails, the folder path, category, date, and
  snippets with every match highlighted, in the top bar and the Cmd+K palette
  alike. Arrow keys move through results and Enter opens the preview.
  Focusing the empty search box offers recent searches and clickable
  operator hints.

## [0.8.0] - 2026-07-27

### Added
- Word documents, viewed and edited entirely in the browser. Opening a .docx
  renders it read-only with docx-preview; Edit opens it in SuperDoc, a
  browser-native OOXML editor licensed AGPL-3.0 like this project. Import and
  export both run on your device: saving exports a fresh .docx, re-encrypts it
  with the file's existing key, and replaces the blob, the same flow as text
  editing. The editor ships as a separate code chunk loaded only when a
  document is opened, its telemetry is disabled, and no request leaves the
  device. Design notes and the editor landscape in docs/editing.md.
- A regression test pinning that saving the same file twice never repeats an
  encryption nonce, hardening the editing path against the nonce-reuse class
  of failure documented in published analyses of other E2EE products.

### Security
- Stubbed out a build tool that SuperDoc lists as a runtime dependency, which
  dragged an unpatched brace-expansion into the tree (GHSA-mh99-v99m-4gvg).
  The browser bundle never imports it.

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
