# Engram Store local S3 bridge

A local, zero-knowledge S3 endpoint for an Engram Store account. It runs inside
your own trust boundary, unlocks the vault with your password locally, and
serves the S3 protocol so any S3 tool can read your encrypted files. The Engram
Store server still only ever holds ciphertext: decryption happens here, on your
machine.

This is the read path (browse and download). Write support is planned.

## Run

```bash
ENGRAM_SERVER_URL=https://your.engram.host \
ENGRAM_EMAIL=you@example.com \
ENGRAM_PASSWORD='your passphrase' \
pnpm --filter @engramer/bridge start
```

It prints an endpoint and a generated access key and secret. Point any S3 client
at them (path-style, region `us-east-1`).

| Variable | Default | Meaning |
|---|---|---|
| `ENGRAM_SERVER_URL` | `http://127.0.0.1:3080` | Your Engram Store server |
| `ENGRAM_EMAIL` / `ENGRAM_PASSWORD` | required | Your account credentials |
| `ENGRAM_PASSWORD_FILE` | unset | Read the password from this file's first line instead of the environment, which other processes of the same user can read |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `3081` | Where the bridge listens |
| `BRIDGE_ACCESS_KEY` / `BRIDGE_SECRET_KEY` | generated | Pin the S3 credentials instead of generating them |

## What you get

- Each top-level folder is a bucket; files at the vault root live in a
  `vault-root` bucket.
- `ListBuckets`, `ListObjectsV2` (with prefix and delimiter, so folders browse
  naturally), `HeadObject`, and ranged `GetObject`.
- SigV4 request signing, verified locally against the printed credential.

Example with rclone, using a path-style S3 remote pointed at the bridge:

```bash
rclone lsd engram:            # list buckets (top-level folders)
rclone ls engram:Documents    # list files in a folder
rclone copy engram:Documents/report.pdf .
```

## Why local

An S3 endpoint must be able to read the bytes it serves, so a hosted S3 endpoint
can never be zero-knowledge. Running the endpoint here, on your own machine,
keeps the only component that sees plaintext under your control. See
[docs/s3-gateway.md](../../docs/s3-gateway.md) for the full design.
