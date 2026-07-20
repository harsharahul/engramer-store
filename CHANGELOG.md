# Changelog

## 0.1.0

Initial release.

- End-to-end encrypted file storage: XChaCha20-Poly1305 streaming encryption for content, per-file keys, Argon2id password key derivation, recovery keys.
- Zero-knowledge server: Fastify API with SQLite metadata and on-disk ciphertext blobs, per-user quotas enforced during streaming upload, sequence-number delta sync.
- Web client: Drive-style file browser with nested encrypted folders, drag-and-drop uploads with progress, rename, move, trash and restore.
- Client-side intelligence: fuzzy name search and full-text search over text extracted at upload time, encrypted thumbnails generated in the browser, decrypted previews for images, video, audio, PDF, and text.
- Public share links with the decryption key in the URL fragment, revocable server-side.
- Test suite: crypto round-trip and tamper tests, API integration tests including a ciphertext-only-on-disk assertion.

Designed by Harsha Rahul
