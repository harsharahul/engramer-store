# Client-side intelligence

Everything described here runs in the browser, on decrypted data that never leaves the device. The server continues to store only ciphertext; categories, tags, and extracted text live inside each file's encrypted metadata. This is the same principle Ente applies to photos (on-device ML, encrypted indexes) applied to general file storage.

## Auto-categorization

Every upload is analyzed on the client before encryption:

1. **Type signals**: MIME type and extension.
2. **Name signals**: filename patterns (for example `Screenshot 2026-07-19 at ...`, `IMG_1234`, `invoice-march.pdf`).
3. **Image signals**: EXIF (capture date, camera make) and pixel dimensions.
4. **Content signals**: keywords in extracted text (invoice, receipt, total due, agreement, resume, tax year, and similar).

The analyzer produces one **category** and a set of **tags**:

| Category | Examples of what lands here |
|---|---|
| Photos | Camera images (EXIF present or photo-like names) |
| Screenshots | Screen captures by filename or exact screen dimensions |
| Videos, Audio | By MIME |
| Documents | PDF and word-processing files without a stronger signal |
| Receipts | Documents whose text reads like an invoice or receipt |
| Notes | Markdown and plain text |
| Code | Source files by extension |
| Spreadsheets, Presentations | By MIME and extension |
| Design | SVG, PSD, Figma exports, fonts |
| Archives | zip, tar, dmg, and friends |
| Books | epub, mobi |
| Other | Everything else |

Tags always include the category, the year (from EXIF capture date or file modification time), and the extension; plus situational tags such as `screenshot`, the camera make, or document tags like `invoice`, `contract`, `resume`.

**Auto-filing**: files uploaded at the root are placed into a category folder (`Photos`, `Receipts`, ...) created on demand with an encrypted name. Uploads into a folder the user chose stay where the user put them; they are still tagged. After each upload batch, a reveal toast summarizes what was filed where and which tags were added; clicking it navigates to the destination.

Categories and tags are ordinary metadata fields (`category`, `tags`, `favorite`) inside the encrypted metadata blob, so the server learned nothing new in this release and no schema migration was needed.

## Content extraction

- Plain text and code: read directly (512 KB read cap, 100 KB stored).
- PDF: text extracted in the browser with pdf.js, capped at 40 pages and 100 KB.
- Images: EXIF capture date and camera make.
- Images, with OCR enabled: the text in screenshots, scans, and photos, read on
  this device by tesseract.js. The worker, WebAssembly engine, and English
  model are all served from the app's own origin; nothing is fetched from a
  CDN and no image ever leaves the browser. OCR is opt-in from the sidebar,
  runs automatically on new image uploads, and can sweep the existing library
  ("Make images searchable" in the command palette) or a single image from its
  context menu. Recognized text also sharpens categorization: a photographed
  invoice files as a receipt.

Extracted text is stored as a per-file encrypted index blob (metadata carries only a marker), fetched and decrypted lazily when search is used, so metadata sync stays small no matter how much text a library holds. Legacy libraries migrate to this layout automatically.

## Search

One engine serves the top bar and the command palette (Cmd+K or Ctrl+K):

- Every term must match somewhere: file name, tags, category, the name of any
  folder on the file's path, or extracted content (including OCR text). Typing
  a folder's name finds the files inside it, so remembering the folder is as
  good as remembering the name.
- Name matches tolerate a one-letter typo; word-prefix and tight subsequence
  matches rank below exact ones, and fresher files float upward.
- Results show a thumbnail, the folder path, the category, and a snippet with
  every match highlighted, in the top bar and the palette alike. Arrow keys
  move through results and Enter opens straight into the preview.
- Filters compose with free text: `tag:receipts`, `type:image` (synonyms like
  `type:photo` work), `in:<folder>`, `is:favorite`, `before:2026-03`,
  `after:2025`. Focusing the empty search box shows recent searches and
  clickable operator hints.

Search never issues a network request; the index is the decrypted metadata already in memory.

## Library views

The sidebar's Library section lists auto-categories with live counts (Photos, Screenshots, Documents, Receipts, and any other non-empty category) plus Favorites. These are smart views computed from tags, independent of physical folder location.

## Semantic image search

Opt-in, alongside OCR. A CLIP-family model (MobileCLIP-S0, through
transformers.js) turns images and typed queries into vectors whose similarity
is meaning rather than spelling, so "dog on a beach" finds the photo even when
nothing in its name or its text says so. The model, its tokenizer, and the ONNX
runtime are all served from the app's own origin; the page's content security
policy would reject a CDN fetch even if one were attempted. Embeddings ride in
the same encrypted index blob as extracted text, and videos contribute several
sampled frames so any scene matches, not only the poster.
