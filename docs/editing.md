# Document editing

Engram Store edits documents without giving the server plaintext. This page explains the design, what ships today, and where collaborative editing is headed.

## The constraint

Self-hosted office suites in the Nextcloud mold (Collabora Online, OnlyOffice Document Server) integrate over WOPI: the storage app hands the document to a suite server, which renders and processes it server-side. That architecture requires plaintext on the server, which is why Nextcloud's own end-to-end encrypted folders cannot be opened by those integrations; their documentation states plainly that some functions "are inherently incompatible with the threat model of E2EE". Bolting a WOPI suite onto Engram Store would quietly delete its core guarantee.

The direction of travel in the ecosystem supports the client-side answer. Nextcloud, after years of holding that browsers should not handle E2EE keys, shipped browser-based E2EE reading in 2025 and browser-based E2EE management, public links, and encrypted file drops in early 2026; office editing on encrypted folders remains absent, because WOPI cannot provide it. CryptPad ships collaborative documents where the server is a blind relay that stores and orders encrypted patches it cannot read, with all merging done client-side, and Proton Docs delivers Google-Docs-style live co-editing (cursors, presence, comments) fully end-to-end encrypted. Editing under E2EE is a solved product category; it just has to run on the client.

A design note this codebase enforces after studying the published break of Nextcloud's E2EE (EuroS&P 2024): repeated re-encryption of the same document must never reuse a (key, nonce) pair, and key material must arrive authenticated. Engram Store draws a fresh random secretstream header on every save (pinned by a regression test), and file keys only ever travel wrapped in authenticated encryption under the master key.

## What ships today

An in-app editor for text, Markdown, and code:

- Open any text file and press Edit, or create a fresh note with "New note" (also in the command palette). Notes are ordinary Markdown files.
- Content decrypts into the editor in your browser, and re-encrypts with the file's existing key on save (Cmd+S). The replaced blob and refreshed metadata (size, modification time, search text) are all the server ever sees, as ciphertext.
- Saved edits are immediately searchable, because the search index lives in the encrypted metadata and is rebuilt from the new content at save time.

Word and Excel documents (.docx, .xlsx):

- Opening a .docx renders it read-only with docx-preview: the decrypted archive is laid out as pages in the browser, images included, with nothing fetched from anywhere.
- Edit opens a full office engine that runs entirely in the browser, so a document is edited in its own format rather than through a lossy intermediate. Saving converts back, re-encrypts under the file's existing key, and keeps the previous version. Spreadsheets go through the same path.
- The engine is vendored third-party code, and it runs in a frame with an opaque origin: it cannot reach the page holding your keys, that page's storage, its cookies or its session. It receives bytes and returns bytes. How that is arranged, and what it costs, is in [office-editing.md](office-editing.md).
- Fidelity is that of the engine behind a widely deployed office suite rather than a JavaScript approximation, which matters most for spreadsheets, where a workbook is a calculation graph with charts and pivot caches rather than a stream of text. The download action always returns exactly the stored bytes, so a round trip is never the only copy.

## Rich document editing: Word and Excel

The requirement is real Office editing (DOCX, XLSX), and the constraint is
unchanged: the editor and every byte of import and export must run in the
browser, because the server must never see plaintext. That constraint removes
most "office editor" products, whose fidelity comes from a server-side
conversion engine. The landscape, as of 2026:

- **OnlyOffice client-side components (the CryptPad architecture).** OnlyOffice
  Docs edits a native OOXML model on a canvas, with no lossy HTML intermediary,
  so styles, formulas, images, charts, comments, and tracked changes survive a
  round trip. CryptPad demonstrated it can run with plaintext never leaving the
  browser: it does not use the OnlyOffice Document Server, it took the
  client-side editor and replaced the server with its own encrypted realtime
  engine. This is the fidelity leader by a wide margin. Its one strategic
  catch, an AGPL-3.0 licence, is not a catch for us: **Engram Store is already
  AGPL-3.0, so embedding it adds no new obligation.** This makes it our
  strongest candidate.
- **Univer (Apache-2.0) plus a self-built format layer.** Univer's open core is
  an excellent editor surface, but its XLSX and DOCX import and export are a
  commercial, server-backed feature, and the server-backed path would see
  plaintext. Staying client-side means bolting a browser parser (SheetJS,
  Luckyexcel) onto Univer's model yourself, which is unofficial and lossy on
  exactly the hard parts (charts, pivots, tracked changes). It buys a permissive
  licence at the cost of fidelity and effort.
- **LibreOffice in WebAssembly (ZetaOffice).** Runs the real LibreOffice engine
  fully in the browser, so the fidelity ceiling is LibreOffice itself, but it
  loads on the order of a gigabyte and is single-user today. Promising to watch,
  too heavy to ship as the default editor now.
- **SuperDoc (the shipped editor).** A ProseMirror-based editor that parses
  OOXML directly into its schema and exports .docx in the browser, keeping
  styles, tables, images, headers and footers, comments, and tracked changes.
  AGPL-3.0 (matching this project), with import and export both genuinely
  client-side and no server component. Fidelity sits between the lightweight
  stacks and a native OOXML engine: strong for everyday documents, with known
  simplifications on complex constructs.
- **Lightweight word-processing (TipTap or ProseMirror with mammoth.js and the
  `docx` library).** Fine for notes, but semantically lossy on real Word files
  (fonts, borders, tracked changes, comments), so not a path to fidelity. Note
  also that some commercial conversion extensions in this family run import
  through a vendor cloud API, which disqualifies them here outright.

The lightweight stacks all lose the same things: tracked changes, comments,
pivot tables, charts, complex conditional formatting, embedded vector images,
and precise pagination. Only the native-model engines (OnlyOffice client-side,
LibreOffice WASM) preserve them.

Presentations (PPTX) come with the OnlyOffice path for free and are otherwise
deferred.

## What was chosen

There is no permissively licensed, drop-in, high-fidelity option, so this was a
licence-versus-fidelity choice, and because Engram Store is already AGPL-3.0 the
usual blocker on the strongest candidates does not apply here.

1. A browser-native OOXML editor delivered everyday Word editing first, with
   docx-preview for fast read-only rendering. Preview still uses it; editing
   has since moved to the engine below.
2. The OnlyOffice client-side engine in the CryptPad style: the editor canvas
   plus the x2t conversion engine compiled to WebAssembly, all assets
   self-hosted. This is the only path to native-model fidelity with no server,
   and it brings spreadsheets with it. The cost is a large asset payload and an
   integration layer of our own, described in
   [office-editing.md](office-editing.md).

## References

- SuperDoc, browser-native DOCX editing: https://github.com/superdoc-dev/superdoc
- docx-preview, client-side DOCX rendering: https://github.com/VolodymyrBaydalka/docxjs
- OnlyOffice, true WYSIWYG native-model editing: https://www.onlyoffice.com/blog/2026/02/what-is-true-wysiwyg-editing
- CryptPad, client-side OnlyOffice integration and FAQ: https://docs.cryptpad.org/en/FAQ.html
- CryptPad's x2t conversion engine compiled to WebAssembly: https://github.com/cryptpad/onlyoffice-x2t-wasm
- Nextcloud end-to-end encryption (design and limitations): https://github.com/nextcloud/end_to_end_encryption_rfc/blob/master/RFC.md
- Albrecht, Backendal, Coppola, Paterson: Share with Care, Breaking E2EE in Nextcloud (EuroS&P 2024): https://eprint.iacr.org/2024/546
- Univer import and export (Pro, server-backed): https://docs.univer.ai/guides/sheets/features/import-export
- SheetJS documentation (client-side, data-level): https://docs.sheetjs.com/
- Luckysheet end-of-life notice (redirects to Univer): https://github.com/dream-num/Luckysheet/issues/1454
- ZetaOffice, LibreOffice in WebAssembly: https://www.theregister.com/AMP/2025/02/13/libreoffice_wasm_zetaoffice
- Proton Sheets format support: https://proton.me/support/sheets-import-export
- secsync, an architecture for E2EE CRDTs with a Yjs reference implementation: https://github.com/serenity-kit/secsync
- Peritext, a CRDT for rich text: https://www.inkandswitch.com/peritext/
