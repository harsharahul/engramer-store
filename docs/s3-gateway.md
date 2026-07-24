# S3-compatible API (design)

This document describes how Engram Store can speak the S3 protocol, so that any
S3 client (aws-cli, rclone, s3fs, Cyberduck, mountpoint, backup tools, other
services) can read and write data, with buckets presented as folders. It is a
design, not yet implemented.

## The constraint, stated first

Engram Store's core promise is zero-knowledge: the server only ever holds
ciphertext, because all encryption happens on the client with keys derived from
the user's password. A generic S3 client knows nothing of that cryptography and
sends object bytes the endpoint must be able to store and return (TLS protects
only the wire). AWS request signing (Signature Version 4) compounds it: SigV4 is
a symmetric HMAC construction, so to verify a request the endpoint must possess
key material equivalent to the client's secret access key, and it recomputes the
same signature to compare. There is no one-way verifier as there is for a
password: whatever can verify a SigV4 signature can also forge one. So:

> A **hosted** S3 endpoint cannot be both speakable by unmodified S3 clients and
> zero-knowledge. The process that terminates the S3 protocol necessarily holds
> plaintext and secret-equivalent credentials.

Every S3 service that also offers client-side encryption confirms this. The only
ones that keep the S3 endpoint from seeing plaintext do so by moving that
endpoint **inside the user's trust boundary**: Storj's self-hosted Gateway-ST
and uplink, or Cubbit's private gateway, encrypt on the user's own machine
before anything leaves. Storj's own hosted, multi-tenant Gateway-MT is, in their
words, "server-side encrypted instead of end-to-end encrypted," and it vaults a
copy of the user's passphrase. MinIO, Tebi, and Filebase are all server-side
encryption only: the gateway holds plaintext in memory during every request.

Engram Store therefore offers two S3 planes, and makes the zero-knowledge one
first-class rather than a command-line afterthought.

## The two planes

### Plane 1: the local S3 bridge (zero-knowledge)

A small, self-hostable bridge process runs inside the user's trust boundary, on
their laptop, their server, or beside their app in the same VPC. It exposes an
S3 endpoint on loopback, holds the account's keys locally, and encrypts every
object before it leaves for Engram Store, exactly as the web client does. Point
any S3 tool at `http://localhost:<port>`, and it reads and writes the real
end-to-end encrypted vault: the bridge translates S3 verbs into encrypted
uploads and decrypts on the way back, and Engram Store's server still sees only
ciphertext.

This is the Storj Gateway-ST pattern, and it is the way to have both an S3 API
and zero-knowledge: the only component that sees plaintext is one the user runs
themselves. The bridge ships as part of the (planned) native/desktop
app and as a standalone binary and container, so a backup job or another service
can mount the vault over S3 without trusting our cloud with plaintext.

### Plane 2: hosted gateway buckets (server-side encrypted, trusted)

For cases where running a local process is not wanted, an Engram Store folder
can be marked, explicitly and per folder, as a **gateway bucket**: reachable over
S3 directly from our hosted endpoint by any client anywhere, encrypted at rest
by the server. This is convenient and universal, but the hosted endpoint sees
the plaintext of a gateway object while handling the request, so a gateway
bucket is not zero-knowledge. The interface must state that boundary plainly, so
a user always knows which of their data is end-to-end encrypted and which is
gateway-readable. Two refinements make this plane as safe and controlled as the
model allows:

- **Credential-derived keys at rest.** A gateway bucket's data-encryption key is
  derived from its S3 secret access key, and the secret is stored recoverably but
  encrypted under an operator master key (as Storj vaults passphrases in its Auth
  Service). Objects at rest are then encrypted under a key only a holder of the
  S3 secret can derive, which protects against a stolen disk. The S3 secret is a
  separate, weaker symmetric credential from the user's E2EE key, and the two key
  systems are kept strictly apart: neither is ever derived from the other.
- **Revocable, per-folder grants.** A gateway bucket is off by default and
  enabled per folder from an Engram Store client, time-boxed and revocable, so
  the trusted window is as narrow as the user chooses rather than an account-wide
  setting.

A third, standard middle tier is available where useful: **SSE-C**, where the S3
client supplies an encryption key on each request that the server never stores.
It narrows key custody but still passes the key and plaintext through the server
in memory, so it is not zero-knowledge either; it is offered as an option, not as
the headline guarantee.

## Buckets as folders

The mapping is natural and holds on both planes:

| S3 concept | Engram Store concept |
|---|---|
| Bucket | A top-level folder |
| Object key `a/b/c.txt` | Nested folders `a/b/` and file `c.txt` |
| Object metadata | File metadata (encrypted on plane 1) |
| `ListObjectsV2` prefix + delimiter | A walk of the folder tree |
| Multipart upload | The existing chunked upload path |

S3 has no real directories; folders are an illusion produced by `/` in keys plus
the list API's delimiter roll-up. `ListObjectsV2` with prefix `notes/` and
delimiter `/` returns files directly in `notes/` as `Contents` and each
subfolder once as a `CommonPrefixes` entry (for example `notes/summer/`), which
is exactly a directory listing. Mapping this onto a real tree makes rclone,
s3fs, and Cyberduck present the vault the way users already expect.

## What implementing the endpoint requires

There is no production-grade, actively maintained pure-Node.js S3 *server*
framework, so the endpoint is built directly on the existing HTTP layer, with
Scality's CloudServer and Arsenal (Apache-2.0) as the correctness oracle and
`aws4` / `@aws-sdk/signature-v4` as the signing reference for recompute-and-
compare verification. The work:

- **SigV4 verification middleware**: canonical request, string-to-sign, the
  HMAC signing-key chain, a clock-skew window, and both header-based and
  presigned-URL signatures.
- **Streaming signed payloads** (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`,
  aws-chunked): the per-chunk signature chain that aws-cli and many SDKs use by
  default. This is the most error-prone piece and the classic source of the
  "not implemented" failure in other S3 servers; it must be handled.
- **The core verbs**: `ListBuckets`; bucket `HEAD`/`GET`/`PUT`/`DELETE` plus the
  `?location`, `?versioning`, `?acl` probes clients fire on connect; object
  `PUT`, `GET` with HTTP Range (s3fs and mountpoint depend on it), `HEAD`,
  `DELETE`, batch `POST ?delete`, and copy via `x-amz-copy-source`;
  `ListObjectsV2` (and V1 for older clients) with correct prefix, delimiter, and
  continuation-token pagination; and full multipart upload.
- **Protocol correctness**: UTF-8 XML with sorted keys, `ETag` in the shapes
  clients verify, and proper S3 XML error codes (`NoSuchKey`, `NoSuchBucket`,
  `SignatureDoesNotMatch`, `AccessDenied`), which clients branch on.

## Hot store

Objects are served from the hot tier with no restore latency: fast local or
standard-tier object storage, a read-through cache for frequently accessed
objects, and streaming range reads. Archival tiering, if added later, is an
explicit per-bucket choice, never a silent default that would surprise a
latency-sensitive S3 client.

## API-centric direction

The S3 endpoint is one expression of making Engram Store programmable, not only
clickable:

- **Scoped API tokens**: non-password credentials a script or CI job can hold,
  limited to specific folders and actions, and the natural home for the S3
  access-key/secret pairs, which a gateway bucket needs anyway.
- **A documented REST API** over the same operations the web client uses.
- **The two S3 planes** for ecosystem interoperability, zero-knowledge locally
  and convenient-but-trusted in the cloud.

## Build sequence

1. **The local S3 bridge, read path (shipped).** `apps/bridge` runs inside the
   user's trust boundary, unlocks the vault locally, and serves `ListBuckets`,
   `ListObjectsV2` (prefix and delimiter), `HeadObject`, and ranged
   `GetObject`, verifying SigV4 against a locally generated credential. An
   end-to-end test drives it with the AWS S3 SDK and confirms downloaded bytes
   decrypt to the original. See [apps/bridge/README.md](../apps/bridge/README.md).
2. The bridge write path: `PutObject`, multipart upload, `DeleteObject`.
3. Scoped API tokens shared by the REST API and both S3 planes.
4. Hosted gateway buckets (plane 2) with credential-derived at-rest keys and
   revocable per-folder grants.

## References

- AWS, creating a signed SigV4 request (symmetric HMAC, server replicates
  derivation): https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
- AWS, SigV4 streaming (chunked, signed payloads):
  https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html
- AWS, ListObjectsV2 (prefix, delimiter, CommonPrefixes, continuation tokens):
  https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
- Storj, server-side encryption design decision (Gateway-MT is not E2EE):
  https://storj.dev/learn/concepts/encryption-key/design-decision-server-side-encryption
- Storj, self-hosted Gateway-ST (client-boundary S3): https://github.com/storj/gateway-st
- Cubbit, DS3 gateway (public managed vs private self-hosted):
  https://docs.cubbit.io/composer/gateway/what-is-a-ds3-gateway
- MinIO, server-side encryption (plaintext in RAM at the server):
  https://github.com/minio/minio/blob/master/docs/security/README.md
- Scality CloudServer, a Node.js S3 server, and Arsenal (SigV4 in JS):
  https://github.com/scality/cloudserver
- s3rver, a lightweight Node.js S3 mock (structural reference):
  https://github.com/jamhall/s3rver
