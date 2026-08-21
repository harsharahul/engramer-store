# Storage architecture and reliability

## Metadata backends

Metadata lives in embedded SQLite by default: one file, no external
services, the right shape for personal self-hosting. Setting
`ENGRAMER_DATABASE_URL` to a PostgreSQL connection string moves the
metadata to a shared database instead, which is the foundation for
replicated deployments: server instances become stateless once metadata is
in PostgreSQL, blobs are in an object store, and the session-signing secret
comes from `ENGRAMER_JWT_SECRET`.

Every correctness mechanism is identical on both backends because it was
designed on single-row atomics: the per-user change sequence that drives
delta sync is one `UPDATE ... RETURNING` that PostgreSQL serializes with a
row lock, version snapshots and restores run inside real transactions, and
the download-limit claim on share links is a single conditional update. The
login-failure throttle is a database table, so every instance sees the same
counters. Queries are indexed for large libraries on both backends,
including the folder-tree recursion and per-folder listings.

Run one server instance per deployment for now; that remains the supported
topology, and the PostgreSQL backend is what makes restarts and rescheduling
instant since no instance-local state matters anymore.

## Where bytes live

Engram Store separates two very different kinds of data:

- **Ciphertext blobs** (file content and thumbnails) live in a blob store, never in the database. Uploads stream to the store in chunks with constant memory; nothing buffers a whole file.
- **Metadata** (wrapped keys, encrypted names and tags, tree shape, quotas) lives in SQLite. Metadata rows are a few kilobytes regardless of file size, so the database stays small even with terabytes of blobs: a million files is roughly a couple of gigabytes of metadata.

This split is why growing file sizes never degrade the database: a 50 GB video adds one small row to SQLite and one object to the blob store.

## Blob store backends

The blob store is pluggable, selected by configuration at startup:

| Backend | Selected by | Suited for |
|---|---|---|
| Filesystem (default) | nothing to configure | Personal and small-team self-hosting |
| S3-compatible object storage | `ENGRAMER_S3_*` variables | Enterprise deployments |

**Filesystem**: blobs are written through a temp file and an atomic rename, so a crashed upload never leaves a partial blob under its final name. Files are mode 0600 under `data/blobs/`.

**S3-compatible**: set the variables below and blobs go to any S3 API implementation: AWS S3, MinIO, Cloudflare R2, Garage, Ceph RGW. Uploads stream through multipart upload; the bucket is created on first run if missing. Because every object is ciphertext before it leaves the client, the object store requires zero trust; it only provides durability.

| Variable | Meaning |
|---|---|
| `ENGRAMER_S3_BUCKET` | Bucket name; setting this enables the S3 backend |
| `ENGRAMER_S3_ENDPOINT` | Endpoint URL (omit for AWS S3) |
| `ENGRAMER_S3_REGION` | Region, default `us-east-1` |
| `ENGRAMER_S3_ACCESS_KEY` / `ENGRAMER_S3_SECRET_KEY` | Credentials |
| `ENGRAMER_S3_FORCE_PATH_STYLE` | Default `true` (right for MinIO and friends); set `false` for AWS |

## Scale knobs for S3 backends (all opt-in)

The default deployment needs none of this: a small self-hosted install on the
filesystem backend is already a single binary with nothing to tune. The knobs
below exist for S3-backed installs that grow into them, in the spirit of a
capability ladder: each is off until its environment variable is set, and
unset means exactly the previous behavior.

| Variable | What it enables |
|---|---|
| `ENGRAMER_BLOB_CACHE_BYTES` | Local hot tier for derived blobs, with this disk budget |
| `ENGRAMER_BLOB_CACHE_DIR` | Hot-tier location, when it should live on separate fast storage |
| `ENGRAMER_CONTENT_CACHE_MAX_BYTES` | Also cache content blobs at or under this size, so repeat document opens are local |
| `ENGRAMER_S3_MAX_TPS` | Cap on request starts per second toward the object store |
| `ENGRAMER_S3_MAX_CONCURRENT` | Cap on in-flight requests toward the object store |
| `ENGRAMER_S3_DERIVED_BUCKET` | Separate destination for thumbnails and search indexes |
| `ENGRAMER_S3_DERIVED_*` | Endpoint, region, credentials, path style, and budget for it |
| `ENGRAMER_DERIVED_BACKEND=fs` | Derived blobs on the server's own disk instead of a second bucket (`ENGRAMER_DERIVED_DIR` overrides the location) |
| `ENGRAMER_S3_CHECKSUMS` | `when-required` for non-AWS S3 implementations; see [backends.md](backends.md) |
| `ENGRAMER_S3_CREATE_BUCKET` | `false` when the host denies bucket creation |
| `ENGRAMER_S3_KEY_LAYOUT` | `sharded` for directory-shaped backends; choose before the first upload |
| `ENGRAMER_MEDIA_WINDOW_BYTES` | Media cache window size, when measurements call for tuning |
| `ENGRAMER_BOOKEND_HEAD_BYTES` / `ENGRAMER_BOOKEND_TAIL_BYTES` | Hot head and tail copy sizes for seekable media |

Consumer cloud storage as the backing store, including the rclone bridge
that reaches providers without an S3 API, is covered in
[backends.md](backends.md).

**Hot tier**: thumbnails and search-index blobs dominate request counts (a
grid paint or a search warm touches hundreds of them) while being a tiny
fraction of stored bytes. With a cache budget set, the server keeps the most
recently used of them on local disk (`data/blob-cache/`) and serves repeats
without a round trip. Content blobs always stream from the object store.
Entries are written atomically and evicted least-recently-used; the
directory is disposable state that is re-indexed at startup, and since
everything in it is ciphertext it needs no more protection than the rest of
`data/`. Correctness rule: derived blobs are the one blob class overwritten
in place, so any overwrite or delete durably invalidates the cache entry
before the operation completes; a stale entry can never be served, even
across a crash and restart.

**Request budget**: consumer object stores and rate-limited gateways
throttle hard past their transaction or connection caps, and staying just
under a cap is faster than triggering the penalty. The budget is enforced
inside the S3 client, so every HTTP attempt pays it: plain requests, each
part of a multipart upload, and retries alike. The pacer is strictly FIFO
with no burst accumulation, which is the discipline mass-transfer tools
converge on for fragile backends. A budget only ever delays requests, never
rejects them, so clients see slower responses rather than errors.

**Split destinations**: content blobs and derived blobs have opposite
storage economics. Originals are byte-heavy and request-light, so they suit
cheap, durable, possibly rate-limited storage; thumbnails and search
indexes are byte-light and request-heavy, so they suit a fast, unmetered
store close to the server, and forcing both through one bucket lets a
library scroll be rate-limited by the store holding the originals. Setting
`ENGRAMER_S3_DERIVED_BUCKET` routes derived blobs to their own backend,
which can be a second bucket on the same store (one variable, connection
settings inherit from the primary) or a different store entirely, such as a
local MinIO for derived data with the originals on a budget provider. The
derived backend gets its own request budget and deliberately does not
inherit the primary's, since the usual point of the split is that the
derived store has no rate limit. Enabling the split on an existing install
needs no migration: a derived blob still sitting in the primary bucket is
served from there on first read and copied to the derived backend on the
way out, so the layout heals itself as the library is used. Deletes always
purge both locations. Since derived blobs are recomputable by clients, the
derived bucket also needs less durability than the originals.

## Integrity

Every blob is an XChaCha20-Poly1305 secretstream: each 4 MiB chunk carries an authentication tag, and the final chunk carries a terminal tag. Any bit flip, truncation, or reordering anywhere in a blob fails decryption loudly on the client. Silent corruption cannot masquerade as valid data; the storage layer does not need its own checksum scheme to detect it.

Quota enforcement counts bytes during streaming and aborts mid-upload, so a client cannot exceed its quota by lying about content length.

## Version history

Content saves are append-only across generations. A file's current blob lives
at its bare id (generation 0, which is also every pre-versioning blob) or at
`<id>.g<N>`; replacing content writes the next generation's blob first and
only then, inside a single database transaction, records the displaced
generation as a version, advances the pointer, and bumps the sync sequence.
The consequences are the properties that matter:

- A crash or failed write at any point leaves the file serving its previous
  content. The worst possible leftover is an orphaned blob, never a file row
  that references missing or partial data. No blob a file row points at is
  ever overwritten in place.
- A concurrent save is detected by a generation check inside the transaction
  and rejected with HTTP 409 rather than silently losing an update.
- Each version snapshots the file's encrypted metadata from that moment, so a
  restored version has a coherent size, modification time, and search text.
  Restore itself moves no bytes: it is a pointer swap in one transaction, the
  displaced current content becomes a version, and the client supplies merged
  metadata (current name and tags, the version's content facts). Restoring is
  therefore always undoable.
- Retention keeps the last N versions per file (`ENGRAMER_MAX_VERSIONS`,
  default 10; 0 disables history and restores replace-in-place semantics).
  Version bytes count against the owner's quota, and deleting a file forever
  removes every generation.

The server sees versions exactly as it sees everything else: opaque
ciphertext under an opaque key, plus sizes and timestamps.

## Delta sync and the device cache

Every metadata mutation gets the next value of a per-account monotonic
sequence number, and `GET /api/sync?since=<seq>` returns exactly the rows
that changed after that cursor, tombstones included. Change discovery is one
indexed query whose cost scales with what changed, not with library size; a
client that is up to date pays for an empty response no matter how many
files it stores.

The web client persists the sync rows it receives, verbatim, in IndexedDB,
one cache per account. The rows are already ciphertext plus the structure
the server sees (ids, sizes, timestamps, tree shape), so the cache adds no
additional key handling and stores nothing the server does not already hold;
decryption still happens only in memory, with keys the session holds there
(see [auth.md](auth.md) for how a tab survives a reload without writing a
key to disk).
On the next visit the library decrypts and renders from the cache first, at
50,000 files in roughly a second, and a single delta request then reconciles
whatever changed. Tombstones prune cached rows; a row is only ever replaced
by a strictly newer one, so concurrent tabs cannot roll the cache back; sign
out deletes the cache database.

Because the app shell is a service worker and the library is cached, a
device that cannot reach the server still opens the vault read-only and says
so, and recovers with a plain reload once the server is back. "Resync
library" in the command palette rebuilds the cache from a full sync at any
time.

## Reliability recipes

**Personal (filesystem backend)**
- Put `data/` on a filesystem with checksumming and snapshots if available (ZFS, Btrfs) or any RAID-1 class mirror.
- Back up `data/` with any file-based tool (restic, borg, rsync snapshots). Everything in it is ciphertext plus the server's own bookkeeping; back up the SQLite file with `sqlite3 data/engramer.db ".backup ..."` or stop-copy, and consider [Litestream](https://litestream.io/) for continuous SQLite replication.
- The `jwt-secret` file only signs sessions; losing it merely logs everyone out.

**Enterprise (S3 backend)**
- Point at a bucket with the durability you need: AWS S3 (11 nines by design), or a MinIO/Garage/Ceph cluster with erasure coding or replication across nodes.
- Enable bucket versioning and object lock if you want protection from accidental or malicious deletion at the storage layer.
- Replicate the bucket cross-region if your threat model includes site loss; the objects are ciphertext, so replication targets need no special trust.
- Metadata remains in SQLite next to the server: keep it on reliable disk with Litestream or scheduled backups. It is small enough that even minutely backups are cheap.

**What loss means**: losing a blob loses that file's content; losing metadata loses the mapping and wrapped keys. Both are protected by backing up `data/` (and the bucket, when using S3). Neither the blob store nor the metadata database ever holds key material that could decrypt anything.
