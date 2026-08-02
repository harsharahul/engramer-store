# Word and Excel editing

Engram Store edits .docx and .xlsx documents with the same guarantee as
everything else it stores: the server holds ciphertext and never sees a
document's contents. This page explains how that is possible, what runs where,
and the security reasoning behind the parts that look unusual.

For the text and Markdown editor, and for the collaborative roadmap, see
[editing.md](editing.md).

## Why the editor is vendored

Server-rendered office suites integrate over WOPI: the storage app hands a
document to a suite server, which parses and renders it. That design requires
plaintext on the server and is exactly why end-to-end encrypted storage cannot
use it. The only route that preserves the guarantee is an editor that runs
entirely in the browser, importing and exporting the original file format
without a conversion service.

One engine meets that bar today: the client-side components of OnlyOffice,
which edit a native OOXML model rather than a lossy HTML intermediary, so
styles, formulas, images, charts and tracked changes survive a round trip.
CryptPad proved the model in production, and the licence is compatible: both
projects and this one are AGPL-3.0.

The cost is that the engine is a large third-party bundle, and it needs script
permissions this application's origin must never grant. The rest of this page
is about containing that.

## What runs where

```
app page                      holds the master key, decrypts and re-encrypts
  └─ sandboxed frame          opaque origin; no key, no storage, no session
       ├─ x2t (WebAssembly)   converts .docx/.xlsx to the editor's format
       └─ editor frame        the OnlyOffice editor itself
```

A document opens like this: the app decrypts the file in the page that already
holds the key, transfers the plaintext bytes into the sandboxed frame as a
zero-copy transferable, and the frame converts and edits them. Saving reverses
it, and the returned bytes are re-encrypted under the file's existing key and
stored as a new version. Keys never cross the boundary.

## The isolation, and why it is an opaque origin

The editor requires `'unsafe-eval'`. In this application's own origin that would
be fatal, because the page holding the master key lives there; the security
model assumes that any script execution in this origin is a total compromise.

The editor therefore runs in a frame with the `sandbox` attribute and without
`allow-same-origin`, which places it in an *opaque* origin. Measured from inside
a running editor, the frame cannot reach:

- the page holding the master key, or any window above it
- `localStorage`, `sessionStorage`, `IndexedDB` or the Cache API
- cookies, or any credentialed request to this application's API
- service worker registration, so a compromised editor build cannot install
  anything that survives a reload

This is stronger than hosting the editor on a second domain, which is the more
common answer: a second origin has its own storage and can register a service
worker, so a compromise there can persist. An opaque origin gets no persistence
at all. It also avoids requiring every self-hoster to run a second hostname and
certificate.

The relaxed script policy is scoped to the vendored asset path alone. The
application's own documents and every API route keep the strict policy, which
is verified by response headers rather than assumed.

Two costs come with this choice, and both are deliberate:

- **The editor document can be framed by anyone.** An opaque ancestor cannot be
  named by `frame-ancestors`, so that protection is dropped for those responses.
  The document holds no key, no cookie and no storage, and it does nothing
  without a host that speaks its message protocol, but it is a clickjacking
  surface that a second origin would not have.
- **Data must travel as messages and data URLs.** A `blob:` URL is readable only
  by the origin that created it, so the converted document and its images cross
  as `data:` URLs, and every host-driven editor action is a message rather than
  a property access.

## The patch set

Four changes are applied to the upstream release by
`scripts/office-assets.mjs`. Three are one line each; the fourth injects a
script tag. Every anchor must match exactly once, so an upstream change fails
the build loudly rather than silently skipping.

| Patch | What it does | Why |
|---|---|---|
| `shim` | loads our shim first in each editor document | see below |
| `service-worker-guard` | makes a service worker probe tolerate a throw | `"serviceWorker" in navigator` is true even when sandboxed, and the next statement throws; harmless but noisy |
| `parent-origin` | uses `window.origin` instead of `location.origin` | in an opaque origin, `location.origin` reports the URL's origin while messages carry `null` |
| `frame-origin` | same, on the receiving side | without both, each side silently drops the other's messages and the editor hangs after loading completely |

The shim itself (`apps/web/office/engram-sandbox-shim.js`) is ours and is the
only file to re-read on an upstream upgrade. It exists because the editor reads
`window.parent` without guarding for a cross-origin parent, which throws in an
opaque origin and stops the SDK from loading. Rather than patch every such read
inside a multi-megabyte minified bundle, the shim replaces `window.parent`
itself, which the HTML specification permits because it is a replaceable
property. The replacement exposes only `postMessage`, a capability a
cross-origin parent already had, and keeps the real window in a closure.
`window.top` is unforgeable by specification and is left alone, so the page
holding the key stays unreachable.

## Assets

The upstream release is roughly 550MB of archives; the vendoring script keeps
only what the two editors load, which is about 220MB, and drops the help
content, spelling dictionaries, the PowerPoint, PDF and Visio engines, and every
translation the application does not offer. Nothing is fetched at runtime and
nothing comes from a third-party host, which is what the content policy
requires.

Assets are served with a preference for their pre-compressed variants, and are
excluded from the app-shell precache: they belong to the HTTP cache, because a
user who never opens a document should never download an editor.

Upgrading is one command plus the round-trip tests. If an anchor moved, the
build says so.

## Fidelity and limits

The engine is the same one used by a widely deployed office suite, so fidelity
is far beyond what JavaScript document libraries achieve, particularly for
spreadsheets, where a workbook is a calculation graph with charts and pivot
caches rather than a stream of text.

The honest limits: opening is heavier than the lightweight text editor because a
real engine has to load; very large workbooks are bounded by the converter's
32-bit address space, and that ceiling is lower on mobile browsers; and the
original ciphertext is always downloadable unchanged, so a round trip can never
be the only copy of a document.
