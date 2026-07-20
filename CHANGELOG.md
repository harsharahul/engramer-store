# Changelog

## 0.2.0

Intelligence and experience release. Everything below runs on the client; the server still sees only ciphertext.

- Auto-categorization: uploads are analyzed on-device (type, name patterns, EXIF, dimensions, content keywords) and filed into category folders with auto-assigned tags such as capture year, camera make, screenshot, invoice, contract, and resume.
- Library: live category views in the sidebar (Photos, Screenshots, Documents, Receipts, and more) computed from encrypted tags.
- Deeper search: full-text extraction from PDFs via pdf.js joins text files in the encrypted index; a Cmd+K command palette searches names, tags, and contents with filters (`tag:`, `type:`, `in:`, `is:favorite`) and runs actions.
- Favorites with instant star toggle, editable tag chips, and a post-upload reveal showing where files were filed and how they were tagged.
- Paste to upload: paste a screenshot or file anywhere in the app.
- Installable app (PWA): standalone window, home-screen and Dock icons, offline app shell; encrypted content is deliberately never cached.
- Illustrated folder and file-type artwork with per-kind accent colors, plus per-category sidebar icons.
- Platform documentation: current install options and the native desktop and mobile roadmap.

Designed by Harsha Rahul

## 0.1.0

Initial release.

- End-to-end encrypted file storage: XChaCha20-Poly1305 streaming encryption for content, per-file keys, Argon2id password key derivation, recovery keys.
- Zero-knowledge server: Fastify API with SQLite metadata and on-disk ciphertext blobs, per-user quotas enforced during streaming upload, sequence-number delta sync.
- Web client: Drive-style file browser with nested encrypted folders, drag-and-drop uploads with progress, rename, move, trash and restore.
- Client-side intelligence: fuzzy name search and full-text search over text extracted at upload time, encrypted thumbnails generated in the browser, decrypted previews for images, video, audio, PDF, and text.
- Public share links with the decryption key in the URL fragment, revocable server-side.
- Test suite: crypto round-trip and tamper tests, API integration tests including a ciphertext-only-on-disk assertion.

Designed by Harsha Rahul
