---
name: setting-up-engram-store
description: Use when asked to install, deploy, self-host, or set up Engram Store, move an existing deployment to new storage, or put one behind a reverse proxy. Covers local machines, VPS and cloud hosts, S3-compatible storage, and consumer clouds (Drime, pCloud, Dropbox, Google Drive and anything else rclone reaches).
---

# Setting up Engram Store

Engram Store is self-hosted, end-to-end encrypted cloud storage: files,
names, tags and search text are encrypted on the user's device, and the
server only ever holds ciphertext. Two consequences shape everything below:
the backing store needs no trust (a consumer cloud is a legitimate place
for the bytes), and there is no password reset (the server holds no keys,
so the recovery key shown at signup is the only way back in).

You are the installer. Run this as a guided wizard: interview first, then
execute one path, verifying at each gate. Everything here is plain shell
and file edits; no particular agent tooling is assumed. Repo:
`https://github.com/harsharahul/engramer-store`.

## Step 0: Interview, then route

Ask the user (batch the questions, keep it short):

1. Where will this run: this machine / a home server / an internet-facing
   host?
2. Where should the encrypted bytes live: local disk / an S3-compatible
   service (MinIO, R2, FileLu S5, AWS...) / a consumer cloud (Drime,
   pCloud, Dropbox, Google Drive, ...)?
3. Will it be exposed to the internet (a domain, TLS, other users)?

Route:

- Local machine or home server, local disk, no public exposure ->
  **QUICK SETUP**. Say so: "this is the two-minute path."
- Anything else -> **ADVANCED SETUP**, doing only the modules that apply.
- Quick-setup users can migrate later, with one caveat: content already
  uploaded stays on the old backend (blob layouts are not migrated), so
  moving storage is best done while the vault is young.

Prerequisites either way: Docker with the compose plugin, and outbound
HTTPS. Verify before promising anything: `docker compose version`.

## QUICK SETUP (local disk, LAN, ~2 minutes)

```bash
git clone https://github.com/harsharahul/engramer-store.git && cd engramer-store
docker compose up -d
```

Then have the user open `http://<host>:3080`, create a vault, and
**store the recovery key somewhere safe before doing anything else**: losing password and recovery key together is unrecoverable, by design.

Verify: upload a photo (thumbnail renders), open a document, play a
video. State stays in the `engramer-data` volume; back up `/data` inside
it (`engramer.db` matters most). Done. Offer the iPhone/Mac install hint:
open the site in Safari, Share -> Add to Home Screen (or File -> Add to
Dock).

## ADVANCED SETUP

### Module A: where the bytes live

| Choice | Mechanism | File |
|---|---|---|
| Local disk | default, nothing to configure | `compose.yml` |
| S3-compatible service | `ENGRAMER_S3_*` env, no sidecar | `compose.yml` + env |
| Consumer cloud | rclone gateway sidecar | `compose.rclone.yml` |

**S3-compatible service** (MinIO, Cloudflare R2, FileLu S5, Garage, AWS):
add to the app service environment:

```yaml
ENGRAMER_S3_BUCKET: engram-store
ENGRAMER_S3_ENDPOINT: https://...      # omit for AWS
ENGRAMER_S3_ACCESS_KEY: ...
ENGRAMER_S3_SECRET_KEY: ...
ENGRAMER_S3_CHECKSUMS: when-required   # for any non-AWS implementation
ENGRAMER_DERIVED_BACKEND: fs           # thumbnails/search indexes on local disk
ENGRAMER_CONTENT_CACHE_MAX_BYTES: "16777216"
```

`when-required` matters: the AWS SDK's default checksum mode rewrites
streaming bodies into aws-chunked framing that strict third-party servers
refuse with 411, which breaks every part upload. If the provider hands
out a fixed bucket, add `ENGRAMER_S3_CREATE_BUCKET: "false"`. Leave the
key layout flat unless the backend is a true S3 service: `sharded` fans
keys into directories, and on providers where creating a directory costs
an application-API round trip, that taxes nearly every upload by seconds
(measured: a fresh shard pair cost 7.8 s on one provider; the same PUT
flat cost 11 ms). Layouts are never migrated, so decide before the first
upload.

**Consumer cloud**: use `compose.rclone.yml`, which already carries every
setting above plus a local write spool. Three profiles:

- `--profile drime`: user creates a token in Drime -> Settings -> Developer,
  pastes it into `.env` as `DRIME_TOKEN=`.
- `--profile pcloud`: run `rclone authorize pcloud` on any desktop, paste
  the JSON into `.env` as `PCLOUD_TOKEN=`.
- `--profile custom`: **any backend rclone supports.** Run
  `rclone config` on any machine, name the remote `remote`, copy the
  resulting `rclone.conf` next to the compose file. This is the path for
  Dropbox, Google Drive, Box, Mega, OneDrive, and everything else.

Setup:

```bash
cp .env.example .env && chmod 600 .env
echo "ENGRAM_GATEWAY_KEY=$(openssl rand -hex 16)" >> .env
echo "ENGRAM_GATEWAY_SECRET=$(openssl rand -hex 32)" >> .env
# add the provider token line (never echo its value anywhere)
docker compose -f compose.rclone.yml --profile drime pull
docker compose -f compose.rclone.yml --profile drime up -d --no-build
```

`--no-build` matters: the compose file carries both `image:` and
`build:`, and a plain `up` on a clean host starts a long source build
instead of pulling the published image.

Explain to the user what they will see in their provider account: one
`engram-store` folder of opaque ciphertext under meaningless names. They
must never rename, "organize", or let another tool write inside it, and
one deployment per folder, ever; the gateway assumes it is the only
writer. Also explain the spool semantics honestly: an upload is
acknowledged once it is durably on this machine's disk, then delivered to
the provider in the background with retries that survive restarts; losing
this machine's disk before a file drains loses that file.

### Module B: public exposure, in this order

**B1. Lock down registration BEFORE the host is reachable.** The shipped
compose files carry storage settings only, and editing a tracked file
turns every upgrade into a merge conflict. Put the exposure settings in
an untracked overlay instead, `compose.public.yml`:

```yaml
services:
  engramer-drime:            # match the service the chosen profile runs
    environment:
      ENGRAMER_REGISTRATION: "invite"   # exactly "invite" or "closed"
      ENGRAMER_ADMIN_EMAILS: "user@example.com"
      ENGRAMER_TRUSTED_PROXIES: "<address the app sees the proxy as>"
      ENGRAMER_PUBLIC_ORIGINS: "https://vault.example.com"
```

then pin both files and the profile in `.env` so no future command can
forget them:

```
COMPOSE_FILE=compose.rclone.yml:compose.public.yml
COMPOSE_PROFILES=drime
```

This last step is load-bearing: without it, one `up -d` that omits the
overlay recreates the app without the lockdown and registration silently
reverts to open. With it, a bare `docker compose up -d --no-build` in
this directory always carries everything.

Warn about two sharp edges: the registration value **fails open on any
typo** (anything unrecognized means open registration, silently), and the
admin address may always register even when closed; that is the
bootstrap, so the user must claim it before the site is public (over an
SSH tunnel to port 3080 if need be). At first login: recovery key stored
offline, then enable two-factor from the profile and store those codes
too.

**B2. Bind the app to loopback** so nothing reaches it around the proxy:
`ENGRAM_BIND=127.0.0.1` in `.env` (the compose files honor it), and keep
the host firewall closed to 3080 regardless.

**B3. The proxy contract.** The origin speaks HTTP/1.1; HTTP/2 to
browsers is good. The rules that decide whether the deployment works:

- Preserve the original `Host` header and send `X-Forwarded-Proto:
  https`, with `ENGRAMER_TRUSTED_PROXIES` set to the address the app
  actually sees (from a host proxy that is the Docker bridge, commonly
  `172.17.0.1`, not `127.0.0.1`). The security policy the server emits is
  built from these; getting them wrong silently breaks live collaboration.
  Untrusted-proxy mode also makes every rate limit key on the proxy's own
  address, so a few failed logins from anyone lock everyone out.
- **Turn HTTP/3 off** unless proven otherwise: more than one QUIC proxy
  stack kills multi-megabyte upload bodies with a silent stream reset
  that clients report as a network error while everything else works.
  Verified live against BunkerWeb; h2 is not affected.
- Request body limit at least 64 MiB on `/api/` (Apple clients send
  single 64 MiB PUTs). The proxy is the right layer for this: the app
  streams upload bodies past its own 16 MiB JSON body limit by design,
  so there is no app-side number to "fix". And **no request-body
  inspection** on upload paths: the bodies are encrypted, indistinguishable from random bytes,
  and randomly trip WAF content signatures, including deny-with-ban
  responses that then block the whole address. Body-inspection caps
  (CrowdSec AppSec defaults to 10 MiB, deny) must be raised or set to
  fail open.
- Never re-frame request bodies as chunked (part uploads require exact
  `Content-Length`), pass `Range` headers through untouched, do not cache
  anything under `/api/`, and do not inject or override
  `Content-Security-Policy` or `X-Frame-Options` (the office editor
  depends on the server's own values).
- WebSockets: forward `Upgrade`/`Connection` on `/api/collab/`, idle
  timeout above 75 seconds.
- Add HSTS at the proxy; the app does not set it.

### Module C: verification gates (run all that apply; do not skip)

1. `docker compose ... ps` shows the services up and the app log shows
   one "listening on" line, no restart loop. A crash loop naming the
   bucket unreachable means the gateway is down or misconfigured; a
   gateway loop logging `Unauthenticated` means the provider token is
   wrong.
2. `curl -s https://host/api/health` returns `{"status":"ok"}`, through
   the proxy, not just locally. A WAF challenge page here breaks the
   native apps.
3. `curl -s https://host/api/auth/registration` shows the intended mode.
   This one call is the entire lockdown check, and it matters because the
   setting fails open.
4. Upload a text file, a photo, and a video from a browser. The photo
   must render a real thumbnail; the video must play and seek to the
   middle and near the end.
5. For remote backends: list the provider folder (e.g.
   `docker compose ... exec rclone-drime rclone lsf remote:engram-store/blobs`)
   : only opaque sharded names, no readable filenames, no thumbnails.
6. Profile -> Integrity -> run both "Check stored files" and "Deep check";
   every file intact. This is the end-to-end proof that the backend
   returns exactly what was uploaded.
7. Behind a proxy: response headers on `/` must contain
   `wss://<public-host>` in the CSP and `upgrade-insecure-requests`;
   both present means Host and X-Forwarded-Proto survived. Then upload a
   file >16 MiB and one >64 MiB; failures here are proxy body rules, and
   the app log (`ENGRAMER_LOG_REQUESTS: "true"`) tells you whether the
   request even arrived.
8. Reload the app and upload again: the second session must show no
   re-download of the multi-megabyte ML runtimes (`/ort/`, `/ocr/`) in
   the browser's network panel.
9. Back up `/data/engramer.db` from the data volume, restore it into a
   scratch container, sign in. A backup never restored is a hypothesis.
   Tell the user plainly: losing this database loses the vault even if
   the provider still has every byte; the wrapped keys live here.

### Module D: day two (tell the user before leaving)

- Upgrades: `git pull`, then `compose pull` and `up -d --no-build`.
- Back up the metadata database continuously if possible; everything
  derived (thumbnails, indexes, caches, media windows) regrows on its
  own and needs no backup.
- Provider down or throttled: browsing, search, thumbnails, playback
  starts and recently opened documents keep working from local tiers;
  only cold content reads fail, and they self-heal when it returns.
- A gateway restart aborts in-flight uploads; clients retry; spooled
  files are re-delivered automatically.

## Traps that have each burned a real deployment

| Symptom | Cause | Fix |
|---|---|---|
| App crash-loops at boot, "bucket not reachable" | gateway not up yet, wrong endpoint, or remote folder missing | check gateway log first; the app retries an unreachable endpoint 15 s |
| Gateway crash-loops, `Unauthenticated` | bad or expired provider token | recreate the token; never echo it |
| Every part upload fails 411 | checksum mode left at SDK default against a non-AWS backend | `ENGRAMER_S3_CHECKSUMS: when-required` |
| Uploads fail as "network error" only for multi-MB files, everything else fine | HTTP/3 at the proxy | disable h3 |
| Uploads 403 or the whole IP gets blocked mid-batch | WAF inspecting encrypted bodies | exempt upload paths, raise inspection caps |
| Photo uploads finalize in ~10 s | no write spool, provider app-tier ingest | the shipped gateway config spools; check `--vfs-cache-mode writes` survived any edits |
| Every upload's data PUT takes ~5-8 s, everything else fast | sharded key layout paying provider directory creation per new shard | use the flat layout on gateway-backed providers |
| First uploads each session wait on a huge download | ML runtimes not cached (old build) | upgrade; verify gate 8 |
| Registration open despite "locked down" | typo fails open | verify gate 3, always |
| Fast LAN, slow from outside | comparison across different network paths | measure upstream bandwidth before blaming the stack |

## Where to read more

`docs/backends.md` (backing stores, speed model, limits, day two),
`docs/storage.md` (architecture, scale knobs, backup recipes),
`docs/auth.md`, `SECURITY.md`. If something here disagrees with those
files at the version being deployed, the repo files win.
