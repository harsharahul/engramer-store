# Backing stores

Engram Store keeps ciphertext in a pluggable blob store. Because every byte
is encrypted on the client before it is uploaded, the backing store needs no
trust at all: it provides durability and bandwidth, nothing else. That is
what makes consumer cloud storage you already pay for a legitimate backing
store for a self-hosted deployment.

The server integrates against protocols, not providers. It speaks the S3
protocol; providers attach in one of two ways:

- **Directly**, when the provider has a real S3 API: AWS S3, MinIO,
  Cloudflare R2, Garage, Ceph RGW, FileLu S5, and others. Configure
  `ENGRAMER_S3_*` as described in [storage.md](storage.md).
- **Through an rclone sidecar**, for everything else: `rclone serve s3`
  translates the S3 protocol to any of rclone's several dozen remotes
  (Drime, pCloud, Dropbox, Google Drive, Box, Koofr, Mega, and more). The
  sidecar runs next to the server, holds the provider credential, and is
  never reachable from outside the compose network.

What a backing store must provide: streaming uploads, ranged downloads,
deletes, and multipart uploads. `rclone serve s3` provides all four over any
remote that supports plain file operations.

## Quick start on a consumer cloud

Any provider rclone reaches can back the vault. Some are already
streamlined for getting started, Drime and pCloud for example: their
whole credential is one token in `.env` and a profile flag. Using Drime
here; pCloud differs only in the token.

1. Create an API token with your provider. Drime: Settings, then Developer.
2. `cp .env.example .env`, paste the token, and generate the internal
   gateway credentials with the two `openssl` lines in the file.
3. `docker compose -f compose.rclone.yml --profile drime up -d`, then open
   `http://your-host:3080` and create the first account.

Every other provider, including the OAuth ones (Dropbox, Google Drive,
OneDrive, Box), uses the `custom` profile: run `rclone config` on any
machine, name the remote `remote`, copy the resulting `rclone.conf` next
to the compose file, and start with `--profile custom`.

What appears in your provider account is a single folder of opaque
ciphertext under meaningless names. Do not rename or reorganize anything in
it: the application cannot repair changes made behind its back, although
the integrity check detects every damaged file.

## Compatibility settings

These exist because third-party S3 implementations differ from AWS in ways
that break byte transport rather than merely erroring:

| Variable | What it does |
|---|---|
| `ENGRAMER_S3_CHECKSUMS` | `when-required` keeps streaming request bodies plainly sized. The SDK default rewrites them into `aws-chunked` framing with checksum trailers, which strict servers, including `rclone serve s3`, refuse with 411. Set `when-required` for any non-AWS backend. |
| `ENGRAMER_S3_CREATE_BUCKET` | `false` for hosts that hand out a fixed bucket and deny CreateBucket; the bucket must then already exist. |
| `ENGRAMER_S3_KEY_LAYOUT` | `sharded` fans keys into two directory levels. Leave it `flat` for gateway-backed providers: where creating a directory costs an application-API round trip, a sharded layout pays that on nearly every upload (measured at seconds per new shard), while listings of one large folder are rare and cached. `sharded` suits true S3 services, where prefixes are free. Choose before the first upload; layouts are not migrated. |

The recipes in `compose.rclone.yml` set all three.

## Where speed comes from

A consumer cloud is seconds away per request. The deployment stays fast by
keeping request-heavy data local and shaping what remains:

- **A local write spool** (`--vfs-cache-mode writes` in the gateway, on by
  default in the recipe). An upload is acknowledged once it is durably on
  the server's disk; the gateway drains it to the provider in the
  background and keeps retrying, resuming pending uploads across restarts.
  Without it, every upload waits out the provider's own write latency,
  which for providers that ingest through an application API is seconds
  per file. The trade, stated plainly: between acknowledgment and drain,
  the only copy is the server's disk, so the spool volume deserves the
  same care as the metadata database. Bound it with
  `--vfs-cache-max-size`; the recipe uses 20G.
- **Derived data on local disk** (`ENGRAMER_DERIVED_BACKEND=fs`).
  Thumbnails and search indexes are request-heavy and byte-light; a grid
  paint touches hundreds. On the local volume they cost nothing. Everything
  in this directory regrows if lost: clients rebuild thumbnails and indexes
  automatically, and media bookends re-copy from the primary on demand.
- **Media tiers.** Seekable media gets its head and tail copied locally at
  upload and its playback windows cached on first read, so starting a video
  and seeking through it touch the provider at most once per window.
- **A small-content cache** (`ENGRAMER_CONTENT_CACHE_MAX_BYTES`). Documents
  at or under the cap are kept locally after their first read, so repeat
  opens are instant instead of seconds.
- **Request budgets and lanes** (`ENGRAMER_S3_MAX_TPS`,
  `ENGRAMER_S3_MAX_CONCURRENT`). Rate-limited providers throttle hard past
  their caps; the budget paces requests below them, and background work
  (bookend copies, cache fills, healing) only ever spends budget no
  interactive request is waiting for.
- **Tier geometry** (`ENGRAMER_MEDIA_WINDOW_BYTES`,
  `ENGRAMER_BOOKEND_HEAD_BYTES`, `ENGRAMER_BOOKEND_TAIL_BYTES`). High
  latency favors fewer, larger reads; tune if measurements say so.

With the provider unreachable, the grid, search, thumbnails, media starts,
and recently opened documents keep working from the local tiers; only cold
content reads fail, and the client surfaces that as a sync error.

## Day two

- Updates: `docker compose -f compose.rclone.yml --profile <p> pull`, then
  `up -d`.
- Back up the metadata in the `engramer-data` volume; it holds the wrapped
  keys. The ciphertext sits with the provider, and the derived tier
  regrows itself.
- An rclone sidecar restart aborts uploads in flight; the client notices
  and the upload retries. Files already spooled are safe: the gateway
  re-uploads pending spool entries when it comes back.
- If a reverse proxy or WAF fronts the deployment, two settings decide
  whether uploads work at all: HTTP/3 must be off unless the proxy's
  QUIC stack demonstrably handles multi-megabyte request bodies (several
  do not, and the failure is a silent stream reset that clients report
  as a network error), and any request-body inspection limit must either
  exceed the largest upload part or fail open. Encrypted uploads are
  indistinguishable from random bytes, so body inspection buys nothing
  here anyway.
- Provider terms of service are your responsibility; some providers
  restrict API-only usage patterns.

## Limits, stated plainly

- `rclone serve s3` is marked experimental by the rclone project. It has
  held up under our end-to-end tests, which assert byte equality on every
  transfer shape the application uses, and the same tests run in CI against
  a local rclone. Treat provider-side quirks as possible until your own
  deployment has run for a while.
- Some providers expose no content hashes through rclone; transfers there
  compare by size only. Engram Store does not rely on provider hashes: the
  client records its own digest of every file and verifies content end to
  end on download and on demand ("Check every file" in the profile).
- Providers meter requests. The budget knobs exist for exactly that; start
  with the recipe defaults and tune from measurements.
