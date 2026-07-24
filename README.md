# Engram Store

**Self-hostable cloud storage that is end-to-end encrypted, and still smart.**

[![CI](https://github.com/harsharahul/engramer-store/actions/workflows/ci.yml/badge.svg)](https://github.com/harsharahul/engramer-store/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/ghcr.io-engramer--store-2496ed?logo=docker&logoColor=white)](https://github.com/harsharahul/engramer-store/pkgs/container/engramer-store)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](package.json)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

Files, file names, folder names, tags, and search text are encrypted on your device before upload; the server stores ciphertext it cannot read. Auto-categorization, full-text search, and previews all run on the client, so the intelligence works without giving anyone else your data.

![Engram Store vault](docs/media/vault.png)

## Why

Cloud storage should not require trusting the storage provider. Engram Store applies the end-to-end encryption model proven by [Ente](https://ente.io) to general-purpose file storage: the intelligence (search, previews, thumbnails) lives on the client, and the server is reduced to an authenticated ciphertext warehouse.

## Features

- **True end-to-end encryption.** XChaCha20-Poly1305 streaming encryption for file content, XSalsa20-Poly1305 for keys and metadata, Argon2id for password key derivation. All primitives from libsodium; no custom cryptography.
- **Drive-style file management.** Nested folders, drag-and-drop multi-file upload with per-file progress, rename, move, trash and restore.
- **Auto-organization.** Every upload is analyzed on your device and filed into category folders (Photos, Screenshots, Receipts, Code, and more) with auto-assigned tags: capture year, camera make, invoice, contract, resume. The Library sidebar gives live category views. All of it lives inside encrypted metadata; the server sees none of it. See [docs/intelligence.md](docs/intelligence.md).
- **Client-side search.** A Cmd+K command palette and top-bar search over names, tags, and full text extracted from text files and PDFs at upload time, with filters like `tag:receipts`, `type:image`, `in:Work`, `is:favorite`. Queries never leave your device.
- **Encrypted previews and thumbnails.** Images, video, audio, PDF, and text preview in the browser after local decryption. Thumbnails are generated on the client and stored encrypted.
- **Public share links that keep the server blind.** The decryption key travels in the URL fragment, which browsers never send over the wire. Links are revocable server-side.
- **Recovery keys.** A random recovery key, shown once at signup, can restore access after a lost password. Password changes re-wrap the master key without re-encrypting any data.
- **In-app editing and notes.** Edit text, Markdown, and code in the browser, or create notes from the command palette. Content decrypts into the editor and re-encrypts on save; edits are instantly searchable. The live-collaboration architecture is documented in [docs/editing.md](docs/editing.md).
- **Installable app.** The web client is a PWA: add it to your iPhone home screen or your Mac Dock and it runs standalone with its own icon. Paste a screenshot anywhere in the app to store it encrypted. Native desktop and mobile plans are in [docs/native-apps.md](docs/native-apps.md).
- **Quotas and delta sync.** Per-user storage quotas enforced during streaming upload, and a sequence-number sync protocol so clients converge in one round trip.

## What the server can and cannot see

The server stores: ciphertext blobs, wrapped keys, KDF parameters, a one-way digest of the login key, blob sizes, timestamps, and the shape of your folder tree.

The server can never see: file contents, file names, folder names, thumbnails, extracted search text, your password, or any decryption key. This holds even if the server is fully compromised. The full design is in [docs/architecture.md](docs/architecture.md).

## Quickstart

### Docker

```bash
docker run -d --name engramer -p 3080:3080 -v engramer-data:/data \
  ghcr.io/harsharahul/engramer-store:latest
```

Or with Compose: `docker compose up -d` (see [compose.yml](compose.yml)). All state lives in the `/data` volume.

### From source

Requirements: Node.js 22+ and pnpm.

```bash
pnpm install
pnpm --filter @engramer/web build   # build the web client
pnpm --filter @engramer/server start
```

Open http://127.0.0.1:3080, create a vault, and store your recovery key somewhere safe. All state lives under `apps/server/data/`.

To use it as an app: on iPhone, open the site in Safari, tap Share, then "Add to Home Screen"; on a Mac, use Safari's File menu, "Add to Dock" (or Chrome's Install button).

Configuration via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ENGRAMER_PORT` | `3080` | Listen port |
| `ENGRAMER_HOST` | `127.0.0.1` | Bind address |
| `ENGRAMER_DATA_DIR` | `data` | SQLite database and blob storage location |
| `ENGRAMER_QUOTA_BYTES` | `10737418240` | Per-user storage quota (10 GB) |
| `ENGRAMER_MAX_BLOB_BYTES` | `21474836480` | Hard cap for a single upload |
| `ENGRAMER_WEB_DIST` | auto-detected | Path to a built web client to serve |
| `ENGRAMER_S3_BUCKET` | unset | Store blobs in an S3-compatible bucket instead of local disk |

Run it behind TLS in production; the login key must only ever travel over HTTPS. Storage architecture, the S3-compatible backend, and backup recipes are covered in [docs/storage.md](docs/storage.md). A design for exposing an S3 API and for rich document editing lives in [docs/s3-gateway.md](docs/s3-gateway.md) and [docs/editing.md](docs/editing.md).

## Development

```bash
pnpm --filter @engramer/server dev   # API server with reload, port 3080
pnpm --filter @engramer/web dev      # Vite dev server, port 5173, proxies /api
pnpm test                            # crypto, web, and server suites
pnpm build                           # typecheck and build everything
docker build -t engramer-store .     # container image
```

The repository is a pnpm workspace:

```
packages/crypto/   E2EE core: key hierarchy, streaming encryption, sealed boxes
apps/server/       Zero-knowledge API: Fastify, SQLite metadata, on-disk blobs
apps/web/          Web client: React, all crypto in the browser
```

The integration tests drive the real API with the real crypto package, including a check that blobs on disk contain no plaintext. CI runs the suites on Node 22 and 24, audits production dependencies, and builds the container image; pushes to `main` and version tags publish a multi-architecture image to `ghcr.io`.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report vulnerabilities.

## License

[AGPL-3.0-only](LICENSE).
