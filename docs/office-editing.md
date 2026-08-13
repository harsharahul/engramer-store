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
app page                    holds the master key, decrypts and re-encrypts
  ├─ converter worker       x2t (WebAssembly): file format <-> editor format
  └─ sandboxed frame        opaque origin: no key, no storage, no session
       └─ the editor        one document, framed directly
```

A document opens like this. The app decrypts the file in the page that already
holds the key and converts it in a worker on this origin. The converted
document and the images the conversion extracted are transferred into the
sandboxed frame as bytes. Saving reverses it: the editor returns the document
in its internal format, the worker converts it back to .docx or .xlsx, and the
result is re-encrypted under the file's existing key and stored as a new
version. Keys never cross the frame boundary, and neither does anything but
bytes.

The converter runs beside the app rather than inside the frame because it
needs none of the permissions the editor does, and because an opaque origin
has no usable HTTP cache: the largest single asset in the system would be
re-fetched on every document open. On this origin it is fetched once and
revalidated cheaply, and it still runs under the application's strict content
policy, in a worker realm of its own. One converter is held per open document,
because importing extracts a document's images into a working directory and
exporting reads them back from the same place.

## The isolation, and why it is an opaque origin

The editor requires `'unsafe-eval'`. In this application's own origin that
would be fatal, because the page holding the master key lives there; the
security model assumes that any script execution in this origin is a total
compromise.

The editor therefore runs in a frame with the `sandbox` attribute and without
`allow-same-origin`, which places it in an *opaque* origin. Measured from
inside a running editor, the frame cannot reach:

- the page holding the master key, or any window above it
- `localStorage`, `sessionStorage`, `IndexedDB` or the Cache API
- cookies, or any credentialed request to this application's API
- service worker registration, so a compromised editor build cannot install
  anything that survives a reload

This is stronger than hosting the editor on a second domain, which is the more
common answer: a second origin has storage of its own and can register a
service worker, so a compromise there can persist, and on a subdomain it can
also set cookies that the parent domain's other services will accept. An
opaque origin gets no persistence at all. It also avoids requiring every
self-hoster to run a second hostname and certificate.

The relaxed script policy is scoped to the vendored asset path alone. The
application's own documents and every API route keep the strict policy, which
is verified by response headers rather than assumed.

One deployment note follows from naming an origin rather than saying `'self'`.
A proxy that rewrites the `Host` header leaves the server naming an internal
hostname, and the editor then refuses every asset it loads, which looks from
the outside like an editor that never starts. Set `ENGRAMER_PUBLIC_ORIGINS` to
the addresses browsers actually use, comma separated, and those are named too.
A deployment reached at the address the server itself sees needs nothing.

One cost comes with this choice, and it is deliberate: **everything travels
as messages.** A `blob:` URL is readable only by the origin that created it, so
the document and its images cross as bytes and the frame mints its own URLs
from them; every app-driven editor action is a message rather than a property
access.

Framing is still restricted normally. The editor's only ancestor is this
application's own page, which has a real origin, so `frame-ancestors 'self'`
applies to it. That was not possible while a second sandboxed document sat in
between, because an opaque ancestor matches no source expression and the
protection had to be dropped; collapsing to one document brought it back.

## Why exactly one document is in the sandbox

The vendored suite comes in two halves: the editor itself, and a wrapper script
meant to run on the hosting page, which creates the editor's frame and speaks
to it. Using the wrapper puts *two* documents inside the sandbox, and every
document nested in a sandboxed context gets its own, distinct opaque origin.
The two halves of the vendor's own code then cannot reach each other, which is
what forces this design onto a second real origin in every integration that
uses the wrapper.

So the wrapper is not used. The app frames the editor's own page directly and
speaks its protocol from [`apps/web/src/office/session.ts`](../apps/web/src/office/session.ts).
The protocol is small: the editor announces itself and is given a
configuration and a document, then talks to what it believes is a
collaboration server, asking to be authenticated and taking and releasing
locks. All of it is answered in memory, on the page, and none of it goes near a
network. The editor reads the origin it should trust from its own URL, which
this arrangement can name honestly, because the page above it has a real one.

The result is one sandboxed document with no storage, no second hostname to
buy or configure, and less vendored code served: the wrapper is no longer
loaded at all.

## The patch set

Two changes are applied to the upstream release by `scripts/office-assets.mjs`,
both to the editor's own page. Every anchor must match exactly once, so an
upstream change fails the build loudly rather than silently skipping.

| Patch | What it does | Why |
|---|---|---|
| `shim` | loads our shim first in each editor document | see below |
| `service-worker-guard` | makes a service worker probe tolerate a throw | `"serviceWorker" in navigator` is true even when sandboxed, and the next statement throws |

Four vendor behaviors are asserted rather than patched: the anchors of the
engine's HTML paste path (the paste iframe it creates, and the early return
that leaks its long-action counter) and of its copy path (the switch that
prefers the asynchronous clipboard, and the event handler it bypasses). The
shim compensates for all four, so if an upstream upgrade changes an anchor
the build stops and the matching shim section must be re-read; it may have
become unnecessary.

The shim itself (`apps/web/office/engram-sandbox-shim.js`) is ours and is the
only file to re-read on an upstream upgrade. It does five things, each because
the editor was not written to run without an origin:

- **Replaces `window.parent`.** The editor reads `window.parent.APP` without
  guarding for a cross-origin parent, which throws in an opaque origin and
  stops the SDK from loading. Rather than patch every such read inside a
  multi-megabyte minified bundle, the shim replaces `window.parent` itself,
  which the HTML specification permits because it is a replaceable property.
  The replacement exposes only `postMessage`, a capability a cross-origin
  parent already had, and keeps the real window in a closure. `window.top` is
  unforgeable by specification and is left alone, so the page holding the key
  stays unreachable.
- **Answers the document's address.** The editor loads its document by URL. The
  shim gives it a sentinel and answers that request from the bytes posted in,
  minting a `blob:` URL in the frame's own origin. Requests that arrive early
  simply wait, which is what lets the editor load while the file is still being
  decrypted.
- **Resolves embedded images** from the same bytes, for the callback the editor
  expects its host to provide.
- **Carries actions across the boundary**: the save shortcut outward, and the
  save call inward, because a cross-origin page cannot reach into the editor
  to make it directly. Focus is not in that list: the editor has its own
  command for it, and using it rather than reaching for the editor's hidden
  input element is the difference between a document you can type into and a
  caret that quietly swallows every keystroke.
- **Takes over the HTML paste path.** The engine pastes formatted content by
  writing it into an iframe it creates and reading that frame's document
  back. Sandbox flags inherit, so inside this document that frame is another
  opaque origin and the read throws; the throw escapes after the engine has
  counted a long action and before the only place it is ever released, which
  both loses the paste and leaves the document ignoring every keystroke. The
  shim reads the clipboard synchronously inside the paste event, cleans the
  markup of anything that could execute, and feeds the engine through its own
  paste API. The text-only and internal-copy paths work today and stay with
  the vendor. Pictures in pasted content are not carried yet; the editor
  says so instead of dropping them quietly.
- **Routes copy and cut back to the vendor's event path.** The engine prefers
  the asynchronous clipboard whenever the browser exposes one, and this
  document's opaque origin holds no clipboard-write permission: the write is
  refused, the refusal is swallowed, and the user's copy lands nowhere. The
  vendor's own event path fills the clipboard synchronously inside the
  gesture, which needs no permission, so the shim forces the preference off
  once the engine is up. Same-session internal copies carry the same
  internal format either way.

One more workaround lives there: an opaque origin cannot construct a worker
from an `http(s)` script URL at all, and the editor builds its spellchecker
inside the document-open path with no error handling, so that single throw
would stop every open at 94%. The shim routes it through a `blob:` worker that
imports the real script.

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
32-bit address space, and that ceiling is lower on mobile browsers; pictures in
pasted content are not carried into the document yet, and the editor reports
that rather than dropping them silently; PDF export is not offered, because the
converter build this app vendors cannot write PDFs (its OpenDocument writers
work; its PDF writer does not, verified against every input form the engine
can produce); and the original ciphertext is always downloadable unchanged, so
a round trip can never be the only copy of a document.
