# Storage architecture and reliability

## Where bytes live

Engramer Store separates two very different kinds of data:

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

## Integrity

Every blob is an XChaCha20-Poly1305 secretstream: each 4 MiB chunk carries an authentication tag, and the final chunk carries a terminal tag. Any bit flip, truncation, or reordering anywhere in a blob fails decryption loudly on the client. Silent corruption cannot masquerade as valid data; the storage layer does not need its own checksum scheme to detect it.

Quota enforcement counts bytes during streaming and aborts mid-upload, so a client cannot exceed its quota by lying about content length.

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
