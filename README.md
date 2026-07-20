# Engramer Store

Self-hostable, end-to-end encrypted cloud storage. Files, file names, folder names, and search text are encrypted on your device before upload; the server stores ciphertext it cannot read.

![Engramer Store vault](docs/media/vault.png)

## Why

Cloud storage should not require trusting the storage provider. Engramer Store applies the end-to-end encryption model proven by [Ente](https://ente.io) to general-purpose file storage: the intelligence (search, previews, thumbnails) lives on the client, and the server is reduced to an authenticated ciphertext warehouse.

## Features

- **True end-to-end encryption.** XChaCha20-Poly1305 streaming encryption for file content, XSalsa20-Poly1305 for keys and metadata, Argon2id for password key derivation. All primitives from libsodium; no custom cryptography.
- **Drive-style file management.** Nested folders, drag-and-drop multi-file upload with per-file progress, rename, move, trash and restore.
- **Client-side search.** Fuzzy file name search plus full-text search over content extracted from text files at upload time. The index is part of the encrypted metadata; queries never leave your device.
- **Encrypted previews and thumbnails.** Images, video, audio, PDF, and text preview in the browser after local decryption. Thumbnails are generated on the client and stored encrypted.
- **Public share links that keep the server blind.** The decryption key travels in the URL fragment, which browsers never send over the wire. Links are revocable server-side.
- **Recovery keys.** A random recovery key, shown once at signup, can restore access after a lost password. Password changes re-wrap the master key without re-encrypting any data.
- **Quotas and delta sync.** Per-user storage quotas enforced during streaming upload, and a sequence-number sync protocol so clients converge in one round trip.

## What the server can and cannot see

The server stores: ciphertext blobs, wrapped keys, KDF parameters, a one-way digest of the login key, blob sizes, timestamps, and the shape of your folder tree.

The server can never see: file contents, file names, folder names, thumbnails, extracted search text, your password, or any decryption key. This holds even if the server is fully compromised. The full design is in [docs/architecture.md](docs/architecture.md).

## Quickstart

Requirements: Node.js 22+ and pnpm.

```bash
pnpm install
pnpm --filter @engramer/web build   # build the web client
pnpm --filter @engramer/server start
```

Open http://127.0.0.1:3080, create a vault, and store your recovery key somewhere safe. All state lives under `apps/server/data/`.

Configuration via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ENGRAMER_PORT` | `3080` | Listen port |
| `ENGRAMER_HOST` | `127.0.0.1` | Bind address |
| `ENGRAMER_DATA_DIR` | `data` | SQLite database and blob storage location |
| `ENGRAMER_QUOTA_BYTES` | `10737418240` | Per-user storage quota (10 GB) |
| `ENGRAMER_MAX_BLOB_BYTES` | `21474836480` | Hard cap for a single upload |
| `ENGRAMER_WEB_DIST` | auto-detected | Path to a built web client to serve |

Run it behind TLS in production; the login key must only ever travel over HTTPS.

## Development

```bash
pnpm --filter @engramer/server dev   # API server with reload, port 3080
pnpm --filter @engramer/web dev      # Vite dev server, port 5173, proxies /api
pnpm test                            # crypto unit tests + server integration tests
pnpm build                           # typecheck and build everything
```

The repository is a pnpm workspace:

```
packages/crypto/   E2EE core: key hierarchy, streaming encryption, sealed boxes
apps/server/       Zero-knowledge API: Fastify, SQLite metadata, on-disk blobs
apps/web/          Web client: React, all crypto in the browser
```

The integration tests drive the real API with the real crypto package, including a check that blobs on disk contain no plaintext.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report vulnerabilities.

## License

[AGPL-3.0-only](LICENSE).
