# Engram Store: Architecture

Engram Store is a self-hostable, end-to-end encrypted cloud storage platform. Files, file names, folder names, and all other user metadata are encrypted on the client before they leave the device. The server stores ciphertext and opaque identifiers only; it can never read user content, and neither can anyone who compromises it.

The cryptographic design follows the model proven by [Ente](https://ente.io/architecture): a password-derived key encryption key, a random master key, per-file keys, and streaming authenticated encryption for file content.

## Repository layout

```
engramer-store/
  packages/crypto/   Shared E2EE core (libsodium). Used by the web client and by server tests.
  apps/server/       Zero-knowledge API server. Fastify, SQLite or PostgreSQL metadata, pluggable blob stores.
  apps/web/          Web client. React + Vite. All encryption and decryption happens here.
  apps/desktop/      Tauri 2 shell for the Mac and iPhone apps, with the Files/Finder provider extensions.
  apps/bridge/       Local zero-knowledge S3 endpoint over the vault.
  crates/            Rust mirror of the crypto core plus Swift bindings, for the Apple extensions.
  docs/              Architecture and security documentation.
```

The core is TypeScript. A single language keeps the crypto core in one package, tested once, and consumed identically by the browser client and by the server's integration tests, which exercise the real encryption path against the real API. The Apple extensions cannot run TypeScript, so they consume a Rust mirror of the crypto core kept byte-compatible by committed cross-language test vectors that CI regenerates from both sides.

### Approaches considered

1. Go server with a TypeScript client (the Ente split). Strong operationally, but the crypto and DTO logic would exist twice, and an E2EE product lives or dies on that logic being correct in exactly one place.
2. Single TypeScript monorepo with a shared crypto package. Chosen for the reason above. Node with streaming I/O is more than adequate for a self-hosted deployment.
3. Building on an existing sync stack. Rejected: the encryption model must be foundational, not retrofitted.

## Cryptography

All primitives come from libsodium (`libsodium-wrappers-sumo`), the same library Ente uses. No hand-rolled crypto.

| Purpose | Primitive |
|---|---|
| Password key derivation | Argon2id (`crypto_pwhash`) |
| Key and metadata encryption | XSalsa20-Poly1305 (`crypto_secretbox`) |
| File content encryption | XChaCha20-Poly1305 streaming (`crypto_secretstream`), 4 MiB chunks |
| Asymmetric sharing | X25519 sealed boxes (`crypto_box_seal`) |
| Key digests and subkeys | BLAKE2b (`crypto_generichash`) |

### Key hierarchy

```
password ── Argon2id ──> keyEncryptionKey (KEK)      never leaves the client
                              │
                              ├─ BLAKE2b(KEK, "login") ──> loginKey   sent to server for auth
                              │
                              └─ secretbox ──> masterKey (random 32 B) never leaves the client
                                                  │
                                                  ├─ secretbox ──> folderKey (per folder)
                                                  ├─ secretbox ──> fileKey   (per file)
                                                  └─ secretbox ──> privateKey (X25519)
recoveryKey (random 32 B) <── secretbox ── masterKey (and vice versa)
```

- The KEK is derived on the client with Argon2id at libsodium's moderate profile (256 MiB, 3 passes). If a device cannot afford that allocation, memory halves and passes double until it can; the parameters that succeeded are stored per account and reused for every later derivation. The sensitive profile (1 GiB) is not the default because a single allocation that large fails on mobile browsers.
- The master key is random, encrypted with the KEK, and stored on the server as ciphertext. Password changes re-wrap the master key without re-encrypting any data.
- The login key is a one-way BLAKE2b subkey of the KEK. The server stores only a BLAKE2b digest of the login key, so the server can verify authentication but can never recover the KEK or master key.
- The recovery key is random, shown to the user exactly once at signup. Master key and recovery key are each stored encrypted with the other, enabling password reset without data loss.
- Each account has an X25519 key pair, used by account-to-account sharing and file requests to seal keys to a recipient. The private key is stored encrypted with the master key.

### File encryption

Every file gets a fresh random 32-byte file key.

- Content is encrypted with `crypto_secretstream` in 4 MiB chunks, so arbitrarily large files stream through constant memory on both encrypt and decrypt. The stream header is stored as a prefix of the blob.
- Metadata (name, MIME type, size, modification time, extracted search text, image dimensions) is a JSON object encrypted with the file key via `crypto_secretbox`.
- Thumbnails are generated on the client, encrypted with the file key, and uploaded as a separate blob.
- The file key is encrypted with the master key.

Folder names are encrypted with a per-folder key, which is itself encrypted with the master key. Folders form a tree via parent identifiers; the tree shape and timestamps are the only structural facts the server can see.

### Authentication

1. Client requests the account's KDF salt and parameters by email.
2. Client derives the KEK, computes the login key, and sends it over TLS.
3. Server compares the BLAKE2b digest and issues a JWT.
4. Client decrypts the master key locally with the KEK. The password, KEK, and master key are never transmitted.

### Public share links

A share link contains a server-side token and the file key in the URL fragment: `/s/<token>#<fileKey>`. Fragments are never sent in HTTP requests, so the server can serve the ciphertext to link holders without ever seeing the key. Links can be revoked server-side by deleting the token.

## Server

Fastify 5, better-sqlite3 for metadata, content blobs on the local filesystem under `data/blobs/`. The server is deliberately dumb: it authenticates, enforces quotas, stores ciphertext, and answers delta-sync queries.

### API surface

The core routes are below. Features added since carry their own route families, documented with the feature: version history and integrity ([storage.md](storage.md)), sharing with people, invitations (`/c/<token>`) and file requests (`/r/<token>`) ([sharing.md](sharing.md)), live collaboration (`/api/collab`, [collaboration.md](collaboration.md)), and two-factor and admin routes ([auth.md](auth.md)).

```
POST /api/auth/register        create account with key attributes
GET  /api/auth/attributes      fetch KDF salt and parameters by email
POST /api/auth/login           login key in, JWT out
GET  /api/user                 profile, storage usage

POST   /api/folders            create folder (encrypted name, wrapped key)
PATCH  /api/folders/:id        rename, move
DELETE /api/folders/:id        delete (recursive, to trash)

POST   /api/files              register file record (wrapped key, encrypted metadata)
PUT    /api/files/:id/data     stream ciphertext blob (octet-stream)
PUT    /api/files/:id/thumbnail
GET    /api/files/:id/data     stream ciphertext blob
GET    /api/files/:id/thumbnail
PATCH  /api/files/:id          update metadata, move
DELETE /api/files/:id          move to trash
POST   /api/trash/:id/restore
DELETE /api/trash/:id          permanent delete

GET  /api/sync?since=<seq>     delta sync: changed folders, files, tombstones

POST   /api/shares             create public link token for a file
GET    /api/shares             list own share links
DELETE /api/shares/:id         revoke
GET  /api/public/:token/meta   public: encrypted metadata for a shared file
GET  /api/public/:token/data   public: ciphertext blob
```

Every mutation bumps a monotonic per-user sequence number; `/api/sync` returns everything above the client's cursor, including deletions, so clients converge with one round trip.

### What the server stores

Users (email, login key digest, key attributes as ciphertext), folders (ciphertext names, wrapped keys, tree shape), files (wrapped keys, ciphertext metadata, blob sizes), share tokens, and quota accounting. There is no plaintext user content anywhere, including logs.

## Web client

React 19 + Vite. All cryptography runs in the browser through the shared crypto package.

- Sign-up generates the full key hierarchy locally and displays the recovery key once.
- The file browser is a Drive-style tree with grid and list views, breadcrumbs, drag-and-drop upload, multi-file upload with per-file progress, and keyboard navigation.
- Uploads: read, chunk-encrypt, and stream per file; generate and encrypt thumbnails for images and video frames; extract text content from small text files into the encrypted metadata for search.
- Previews decrypt to an in-memory blob URL: images, video, audio, PDF, and text render natively without the plaintext ever touching the server.
- Search runs entirely on the client over decrypted metadata: fuzzy file name match, type filters, and full-text hits from the extracted content index. This is the Ente principle applied to files: the intelligence lives with the user, the ciphertext lives with the server. Auto-categorization, tags, and the search grammar are described in [intelligence.md](intelligence.md).
- Session state keeps decrypted keys in memory only. Reloading re-derives from the password or a session-cached wrapped key.

## Trust model

- The server is honest-but-curious at best, fully compromised at worst. In both cases it holds only ciphertext, wrapped keys, and traffic metadata (sizes, timestamps, tree shape, access patterns).
- TLS protects the login key in transit; a network attacker who somehow obtained the login key still could not decrypt any content.
- The client is the trust anchor. Anyone who controls the code served to the browser controls the crypto, which is the standard limitation of web-delivered E2EE; self-hosting puts that code under the operator's control.
- Local caches on the client device hold decrypted metadata in memory for the session. Device security is the user's responsibility.

## Testing

- `packages/crypto`: unit tests for every primitive wrapper: encrypt/decrypt round trips, tamper detection, wrong-password failure, cross-key isolation, streaming with multi-chunk files.
- `apps/server`: integration tests that drive the real API with the real crypto package: register, login, upload, download, sync, share, trash, quota.
- End-to-end: a browser session that signs up, uploads, searches, previews, and downloads, plus a check that the blob on disk is ciphertext.
