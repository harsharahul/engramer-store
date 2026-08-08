# Automatic photo backup: design

Status: designed, not yet built. This document fixes the decisions the
implementation must honor.

## What it does

With the owner's explicit permission, the iPhone app keeps a copy of the
device photo library in the vault: originals, encrypted on the device
before upload, organized under a destination folder. It does not claim
what iOS cannot deliver: backup runs chiefly while the app is open, with
background windows as a bonus, and the UI never suggests otherwise.

## Permission is a step change

Today the app needs no photo-library permission at all: the system picker
runs out of process and hands over only what was picked. Automatic backup
requires full library read access, which is a different promise to the
user. Consequences the implementation must honor:

- The usage description string must be rewritten; the current one ("reads
  only the photos you pick") becomes false the moment this ships. The App
  Store privacy label changes in the same release.
- A pre-permission explainer screen precedes the system prompt, because a
  denial cannot be asked again. It states plainly: everything is encrypted
  on this device first; the service operator cannot see the photos.
- Limited access (`.limited`) is not a backup: it is declined politely,
  with the share extension suggested instead.

## Change detection

`PHPhotoLibraryChangeObserver` fires only while the app runs; it is a
foreground optimization, not a background wake. The source of truth is
reconciliation: diff the set of `PHAsset.localIdentifier`s against the
ledger on every backup pass. Deletions on the device do not delete from
the vault (a backup that mirrors deletions is not a backup).

## Background execution

`BGProcessingTaskRequest` with `requiresNetworkConnectivity`, and
`requiresExternalPower` when the charging-only policy is on. iOS grants
minutes, opportunistically, typically overnight on power. Uploads
themselves ride a background `URLSession` (shared container), which
survives suspension independently. `UIBackgroundModes: processing` and
the task identifier land in Info.ios.plist in the same change.

## The ledger

`<app group>/ledger.sqlite`, shared with the share extension's outbox
machinery: `local_id, content_digest, file_id, state, attempts,
last_error, bytes, created_at`. It survives app updates; it does not
survive delete-and-reinstall.

Reinstall recovery rebuilds the ledger from the synced library itself:
every backed-up file carries the asset's identifier as `sourceId` inside
its encrypted metadata (schema field added with the crypto core), with
the plaintext `digest` as fallback matching for assets whose identifier
changed. Consequence, stated for the record: a per-device photo
identifier lives inside the encrypted metadata. The server sees neither.

Server-side deduplication by content is deliberately absent: the
plaintext digest never reaches the server, and the ciphertext hash
differs per encryption. Building a server-visible content index would
leak a fingerprint of plaintext and is not worth one avoided re-upload.

## Policy

Settings in the profile, mirrored to `<app group>/policy.json` so the
extension processes can read them without the web view:

| knob | default |
|---|---|
| Back up over Wi-Fi only | on |
| Background runs need charging | on |
| Include videos | on |
| Originals (never recompressed) | on, not configurable |
| Include hidden assets | off |
| Include screenshots | on |
| Destination folder | "Camera Roll" under the vault root |

## What backup writes

Bytes and minimal metadata (name, mime, mtime, dimensions, `sourceId`,
digest). Thumbnails, ThumbHash, OCR, categorization and facts run later
in the containing app, driven off the ledger's enrichment state, exactly
as share-extension arrivals are enriched.

## Honesty in the UI

A visible count of what is not yet backed up; a per-asset error list the
owner can open; no green checkmark that has not been earned. If iOS has
not granted a background window for days, the status says so instead of
pretending.
