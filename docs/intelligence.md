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

A licensing note: MobileCLIP is Apple's model, distributed under Apple's own
license rather than an open-source one. That license permits redistributing
the model, and its text ships beside the weights in the container image, but
it is worth knowing that this one component of the image is not open source.
See [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## Dates and reference numbers in documents

Opt-in, off by default. When it is on, an upload is read for the things a
document states about itself: when something expires, when a payment is due,
when it was issued, and the reference numbers that identify it. All of the
reading happens on the device, and the results live inside the encrypted
metadata and index blob like every other derived signal.

**Where the values come from**, strongest first:

- **Barcodes.** The block on the back of a North American driver's licence
  (AAMVA) states the expiry as a structured field, so nothing is guessed from
  recognized characters. Every symbology the decoder knows is enabled, so QR,
  Aztec and Data Matrix are read too, and their payloads join the searchable
  text. That is content no character recognizer can reach at all.
- **Machine-readable zones.** The two lines at the foot of a passport carry
  check digits, so a misread is detectable. A failed check discards the whole
  read rather than lowering its confidence, because being able to tell that a
  scan went wrong is the only reason to prefer the zone over the printed text.
- **Labelled dates.** "Expires", "Valid until", "Renewal date", "Payment due"
  and their common variants, over the text extraction already produces. A
  deadline is claimed only where the document labelled one; an unlabelled date
  is almost always a print date.
- **Amounts and reference numbers**, at low confidence, from any document,
  including kinds no rule anticipated.

**Nothing is acted on until you confirm it.** Facts arrive as suggestions in a
single line above your files and move into the library once accepted. A date
that could be read two ways (`03/04/2028`) offers both readings as dates rather
than picking one. A wrong expiry date is worse than no expiry date, because it
gets relied on.

**Reference numbers are kept short.** Metadata carries the last four
characters; the whole value lives in the file's index blob and is fetched only
when you ask to see it. Metadata is decrypted on every device on every sync,
which is not where a licence number belongs.

**What it notices.** A small table of rules turns confirmed facts into the few
observations worth interrupting for, several of which read more than one
document at once:

- A passport expiring 14 Feb 2027 stops being useful for travel around 14 Aug
  2026, because many countries require six months of validity. That date
  appears on no document you own.
- A residence permit that outlives the passport it is attached to.
- An insurance period that ended with nothing newer stored.
- A warranty in its last thirty days, or an invoice past its due date.

These appear in the panel beside your files, with the reasoning behind each one
a click away, and an **Expiring soon** view lists everything being tracked.
Facts read out of a file also appear on the file itself, each naming where it
came from, since how far to trust a date depends on whether a check digit stood
behind it.

Documents stored before this existed are read by "Find dates in my documents"
in the command palette, which works from text the vault already holds and
downloads nothing.

**Facts follow contents.** Every fact records the contents it was read from.
When a file is saved over, a fact the new version still supports keeps its
confirmation, one that was never confirmed and lost its evidence is dropped,
and a confirmed one whose line has been edited away is kept and marked rather
than silently deleted. Restoring an older version restores that version's
facts, because facts describe contents.

## Travel

Documents a trip generates each carry a piece of the trip: the boarding pass
knows the airports, the confirmation knows the hotel and its nights, and no
single one knows the trip. When date reading is on, the pieces are read and,
with confirmation, assembled.

**Where the values come from**, strongest first:

- **Boarding pass barcodes.** IATA BCBP rides in the PDF417 on printed
  passes and the Aztec or QR on mobile ones, and states the route, flight
  and booking reference exactly. Its date has no year, so the year is
  inferred from when the document was stored and the flight is offered for
  confirmation rather than asserted; the barcode carries no departure time
  at all, which the printed text supplies. For a PDF, the first page is
  rendered at recognition width before the read, because a pass's code
  needs more resolution than a thumbnail keeps.
- **Reservation data.** Airlines, hotels and rental agencies embed
  schema.org JSON-LD in their confirmations so mail clients can assemble
  trips; a saved confirmation page or email is an entire reservation as
  structured data. Flights, stays, rentals and trains become events with
  their local times and printed offsets, at full confidence.
- **Travel vocabulary.** Check-in, check-out, departure, boarding, arrival,
  pick-up and drop-off type labelled dates as events, with a time when the
  window carries one and the label kept verbatim.

**Times stay local.** A departure time is local to its airport, and
converting it without knowing the zone produces an answer that looks precise
and is hours wrong. Times are stored as printed; a zone rides along only
where it is genuinely known, from a reservation's own offset or the offline
airport table (about 3,700 scheduled-service airports with their zones,
shipped with the app), which is also what turns JFK into New York on a card.

**Trips are proposed, never assumed.** Documents whose confirmed events fall
near each other, share a booking-reference tail, or point at the same
destination are offered as one trip, with the evidence stated in words.
Accepting writes a shared tag to the members and nothing more; the trip's
name, span and itinerary derive from the members' facts, so a correction
reshapes the trip on its own. The itinerary reads in city names with each
leg's time as printed, exports any leg as a calendar event, and offers the
place in Maps: a handoff to the system, because door-to-door timing would
mean sending your location and route somewhere, and this feature refuses
that. The one computed line is the airport lead time, three hours
international and two domestic, stated only when both ends of the flight
resolve.

Cross-document rules run on confirmed facts: a passport checked against
every trip's return date, a permit that expires mid-trip, the night between
landing and check-in that nothing covers, and check-in opening the day
before a flight.

**The calendar** shows the month with tracked dates as dots and trips as
named spans. Clicking a day lists what it holds, and the entries open their
files. It appears in the sidebar once something is on it.

**Finding connections without a shared reference** is the one place a model
enters, and only on request. A small zero-shot entity extractor (GLiNER,
about 180MB, staged by the same script as the semantic-search model and
served only from this origin) reads the already-decrypted text for place
names when the "Find connections" button is pressed. Its output is
spans: pointers into the text, so it cannot invent a value. The places it
finds feed the same deterministic clustering, are never stored, and never
leave the device. Opt-in beside the other reading toggles.
