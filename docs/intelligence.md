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
  The text keeps the page as a person sees it (see "Text keeps its structure"
  below).
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

### Text keeps its structure

Every reader that works on lines (a form field, a label above its value, a
clock under its date, a table) depends on the text holding the lines and
columns of the page.

```
 a PDF page                           its text
 ----------------------------------   -------------------------------------
 Statement date: 2 November 2026      Statement date: 2 November 2026

 Description   Period      Amount     Description | Period | Amount (GBP)
 Electricity   1-31 Oct     52.10     Electricity | 1-31 Oct | 52.10
 Gas           1-31 Oct     34.25     Gas | 1-31 Oct | 34.25
```

- **A PDF** places pieces of text at points on a page. Pieces on one
  baseline are one line; a gap wider than two characters parts two cells,
  written ` | `; a tall gap is a blank line; a sentence the page wrapped is
  one line again; text set at an angle comes last. A tall heading or a
  stamp keeps to its own line, and slanted text is upright text.
- **An HTML email** is laid out with tables. A row of cells is one line
  with ` | ` between its cells: an empty cell keeps its place and a cell
  that spans columns takes theirs. A cell that holds blocks is layout and
  only parts lines. A list item starts with a dash, a quoted message is
  marked line by line with `> `, and `pre` text keeps its lines. What a
  browser hides is left out (a hidden preview line, a block shown on
  phones only), and entities are decoded as a browser decodes them. The
  walk is one pass over the tags, so its time is in proportion to the
  mail's size whatever the mail holds.
- **Which body of a mail is read.** The plain part of a mail in running
  words; the HTML part when it holds a row of cells, or when the plain
  part is a stub ("View this email in your browser"). Save as PDF prints
  the same text.

**Stored files take the new text once.** A PDF with text and a stored mail
carry a stamp that says which text step read them. A file whose stamp is
older is read again: by the background pass when it was stored in the last
ninety days, and when it is opened whatever its age. The new text replaces
the old; the file's contents, its vectors and the evidence of its facts are
not touched. The label rules' readings are made fresh from the new text,
while your answers and every other reader's facts stand, and the on-device
model is not asked again. A file that reads as less than it holds (a scan
whose text came from recognition) keeps its text. A second pass reads
nothing and writes nothing.

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
- Mail has its own filters: `type:email`, `from:<name or address>`,
  `to:<address>` and `has:attachment`. An email in the results shows who
  sent it and when, with a chip for each attachment that opens it.

Search never issues a network request; the index is the decrypted metadata already in memory.

## Mail

Mail comes into the vault as content: saved messages (`.eml`) and mailbox
exports (`.mbox`, such as Google Takeout or an Apple Mail export folder)
are imported from the New menu, the command palette, or by dropping them on
the window.

- **What is kept.** Each message becomes an email record: a small file
  holding its headers, its text and HTML, and the images its body shows
  inline, filed in Mail/Imported. Each real attachment becomes a file of its
  own in Mail/Imported/Attachments/<year>, linked to its email both ways.
  Tracking pixels are dropped. A message over 50 MB is skipped and named in
  the summary.
- **On the device.** The export is read in fixed chunks and each message is
  parsed in a worker on the device; the server stores only ciphertext, like
  every other file.
- **Nothing twice.** A message already in the vault (same Message-ID, or for
  a message without one, the same date, sender, subject and opening text) is
  left alone, so importing the same file again, or after Stop, adds only what
  is new. An attachment already in the vault is linked, not stored again.
- **Understood like any file.** An email's search text starts with its
  subject, sender and recipients; booking data in its HTML becomes dates and
  reference numbers as it does for a saved confirmation page; and it files
  under the Mail category.
- **Reading safely.** The viewer shows the body in a sandboxed frame with a
  policy that forbids scripts. Remote images and backgrounds stay off until
  "Load remote images" is pressed for that email, so opening a message tells
  no sender it was read; links open in a new tab and show their real address.
- **Save as PDF.** The viewer turns an email into a plain PDF (headers, text,
  attachment list) stored beside it. Characters the standard font cannot draw
  appear as "?", and the PDF says so.

## Search in plain words

In the Mac and iPhone apps on macOS 26 and iOS 26, a search written as a
sentence is read by Apple's on-device language model and turned into the
filters above. "Receipts from last december" becomes `tag:receipt
after:2025-12 before:2025-12`, and the ordinary engine runs it. The model
only proposes: it is handed the library's own vocabulary (categories, scene
labels, the most-used tags, folder names) and today's date, and whatever it
answers is kept only where that vocabulary or the calendar confirms it. A
tag it invents is dropped, a date it misreads is dropped, and a reading it
is unsure of is not shown at all.

The line beside the results says what was searched: "interpreted as" and
the filters as chips, with the words as typed one click away. A query that
already finds something, contains an operator, looks like a file name or a
code, or is a question is never rewritten. The switch is in Profile under
Preferences and follows the account; Profile's This device section states
whether the model is available here and, when it is not, why. Nothing about
the request leaves the device, and nothing is stored.

## Summaries and tags from the assistant

On the same devices, every text-bearing document (a PDF, a note, a scan
with text, a spreadsheet's cells) gets one sentence saying what it is and
what it is for, and a few tags for finding it later, read by Apple's
on-device model from the document's opening pages. The reading rides the
same one pass that fills in previews and labels, narrated through the bell
where it can be stopped, and whichever signed-in device can run the model
does the reading; every other device sees the result, because it lives in
the encrypted metadata like every other signal.

**Each file is read once.** A reading leaves one stamp in the file's
encrypted metadata: which reader, at what rank and version, of which
contents, for which tasks, and what came of it. A file is read again only
when its contents change, when a stronger reader for a wanted task is
available, when you ask, or when the reader itself changes (and then only
files whose reading came back empty or declined, or that are recent). A
different answer, another device having read it, a restart or a sync is
never a reason. A reading that fails for a passing reason, such as a
deadline, is tried again, three times in all across your devices; then it
stops and says why, and Profile offers Retry. If another device finishes
the same contents while this one is still reading, its reading stands.

What is stored is checked before it is stored: one sentence under a hard
cap, with reference numbers and addresses masked to their last four
characters, because metadata is decrypted on every device on every sync.
The summary appears in the details pane with where it came from and a
Remove button, search matches it (so "insurance policy" finds a scan named
`scan-0042.pdf`), and the tags are ordinary tags. A document the model
declined, could not read, or that was too short is recorded as such rather
than tried again forever; Profile's Library index says how many documents
are waiting, and for which device. "Summarize now" in a file's menu reads
one file on request.

**Trust is measured, not assumed.** A model reading counts without your yes
only for a task where that reader's precision is measured at 98% or more,
for the version and the exact prompt of the reader that ships, over at
least 30 readings, on each of two synthetic sets; never for a travel time,
an identity document's expiry or a legal deadline, which need exact data;
and only when the value passes sanity checks (the day exists, a stay ends
after it begins, an amount names its currency). The first set is 238
invented emails and documents: a third of them written so that the date or
amount that matters stands among others that do not, forty written as
forms (labels and values, flattened tables, a time on the line under its
date), thirty about time (doors and a show's start, ranges of hours,
clocks in words, days said in words), thirty about amounts (a total
among its parts, the currency behind the number, a label on the line
above its amount), and thirty about structure (HTML mails laid out as
tables, pages with rows of cells, a quoted reply, a footer), and sixteen
about one day that holds several clocks or a list of records; the rules,
the label tables and the model's instructions are written against it. The
second is 100 more, written without sight of the readers: nothing is ever
tuned on it, and it is the one that says how unseen documents are read.
Forty of its documents are bills, notices and statements, most with a
labelled date that is not the day to pay (a payment received, the last
bill's due day, the day a statement was made). The exact readers are
scored in the test suite, and Apple's on-device model is scored on a Mac
by a harness that runs the app's own reading code (`tools/eval/apple`).

On the second set today, the rules and the model together find 86% of the
dates and 93% of the amounts a careful reader would, and of what they
offer 56% of the dates and 92% of the amounts are right (the dates offered
include every form line kept with its own words); three of fourteen
documents that state nothing still get an offer. Where a label names the
whole amount, the rule states it with no model: that covers 26% of the
second set's amounts, and every one of them is right. The model's own
readings measure 63% right for dates and 89% for amounts, well below the
bar, so they are offered for a yes, and naming an email's kind (81%) is
below its bar too. The bar never moves: a task earns trust only by
measuring above it.

The label rules are measured the same way, by kind
(`apps/web/src/intel/eval/rulescores.json`, computed from the two sets by
a test, so the table cannot drift from the code). A due date read from a
label is right 56 times of 56 on the first set and 31 of 32 on the second:
one wrong reading in thirty-two is under the bar, so a labelled due date
still waits for your yes, as an event (56 of 58, and too few on the
second set) and an expiry (12 of 13) do.

Until the text of a PDF kept its lines, a page reached the readers as one
line, while the stored-file cases of both sets held their line breaks. The
figures published for earlier versions were therefore better than what the
app read from a PDF. Measured the way the app read then (one line per
page, `EVAL_SHAPE=flat`), the first set gave 81% of its dates and 84% of
its amounts, with 34 wrong offers for every 100 documents. With the text
keeping its lines, rows and cells, and the readers using them, it gives
94% and 98%, with 23. The second set holds few tables and reads the same
either way.

The same harness counts what a person is asked, the way the app asks it:
every unanswered date still ahead, or a deadline lately behind, on the day
the document arrived. On the second set that is 96 suggestions for every
100 documents, 9 of them on a day the document does not state for its
reader or under the wrong meaning. Before a form line under an unknown
label went quiet, the same hundred documents gave 112 and 23: on a busy
bill most such lines are dates that are nobody's reminder. Both numbers
are tracked from change to change, and a change that raises either does
not ship. The harness also counts what was given up for that: a day that
matters, named only by such a line and by no other reading, is shown
nowhere. That is 2 days in the hundred documents. With no model to say
what such a date is it would be 10, which is why the line goes quiet only
in a file the model has read.

**Mail is read newest first, within a window.** The model reads email from
the last 12 months by default (3 to 12 in Profile, following your account);
older mail stays kept and searchable, and the booking data in it is still
read. Email is read from much less text than a document, since most mail is
a few lines, and an email whose own booking data gave its dates is only
summarized. The reading also names the kind of email (booking, bill,
delivery, receipt, newsletter, personal); the kind is stored as a `mail:`
tag once kinds are measured right 90% of the time. A newsletter's dates are
set aside only once the model's "newsletter" is itself measured right 98%
of the time, since a bill taken for a newsletter would lose its due date.
On a phone, each time the app comes to the front the model starts at most
40 readings, whatever started them; the rest wait for the next open, newest
first.

## Ask your files

On the same devices, a question typed into the search field ("what did I
pay Acme for the drill?") adds a row above the results: Ask your files.
Pressing it, or Enter when nothing else matched, has the on-device model
answer from your own documents. The model reads only a few thousand words
at a time, so it never reads the library: what is already known about every
file (names, tags, summaries, extracted text, meaning matches) picks a
handful of sources, short excerpts are cut around the words asked about,
and the model answers only from those, saying when they do not contain the
answer. The answer appears above the ordinary results, which stay exactly
where they were, with the files it came from as rows that open them.
Nothing about the question, the excerpts, or the answer is stored or leaves
the device. When no file mentions the question, the card says so without
asking the model. The command palette offers the same row and hands the
question to the search field.

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

**Scene labels.** The same vector is scored against a small vocabulary of
everyday words (beach, food, dog, document, screenshot, and about forty more)
with the model's text encoder, on the device. The few confident labels become
tags, so `tag:beach` finds them, they show as chips, and albums can be built
from them; an unsure picture gets no label rather than a wrong one. Labels are
stamped with the vocabulary version they came from, so a changed vocabulary
re-labels what lags. The same score decides whether a photo is worth a text
reading at all: most photographs carry no words, and skipping the reader for
them is what makes filling in a large library fast.

**Filling in.** Files can arrive without any of this: the iPhone's Files app
stores a photo as bytes and a name, because that process cannot decode media.
Whichever signed-in device is open next takes such files up in one pass, a few
at a time: each original is downloaded and decrypted once and goes through the
same analyzer an upload does, producing the preview, the category and basic
tags, the text reading, the meaning vector and its labels together, with one
metadata write per file. The pass narrates through the Activity button in the
toolbar, where it can be stopped, and leaves an entry saying exactly what it
did; the Profile page shows what is still left.

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
- **Booking data, bills, orders, deliveries and invites.** Confirmation
  emails and saved pages carry schema.org data about themselves: flights,
  stays, car rentals, trains, buses, boats, event tickets and restaurant
  tables, each with the price the booking states; a bill's due date, amount
  and number; a shop order's total and number; a parcel's delivery window
  and tracking number. Calendar invites (`.ics`, uploaded or attached to
  mail) state their events' times. These are read as stated, at full
  confidence, with times kept in the zone they were written in. A booking's
  time is shown as its place printed it: a flight's clock is its airport's,
  whether booking data or a calendar file states it. A meeting's invite
  names an instant, and is shown in the device's own zone on every surface,
  as a calendar shows it; an invite that is part of a trip keeps the clock
  of the place it happens in. A price is
  read as written (`1,184.50`, `148,50`, `1.184,00`); one that could be read
  two ways states no price. A cancelled booking or order states nothing.
- **Labelled dates.** A date is claimed only where the document's own words
  say what it is, over the text extraction already produces; an unlabelled
  date is almost always a print date. The words cover:
  - expiries: "Expires", "Valid until", "Valid thru", "Renewal date",
    "Coverage ends", and `EXP` as a licence prints it;
  - due dates: "Payment due", "Pay by", "Respond by", "Reply by", "Return
    by", "Due back", "Must be received by", "Deadline", "Let us know by",
    and the day a plan renews or a payment will be collected;
  - moments: check-in and check-out, departures and arrivals, pick-up and
    drop-off, an appointment, a show's doors, each with its time ("14:30",
    "2:30 PM", "3pm");
  - deliveries: "Estimated delivery", "Expected delivery", "Delivered by",
    and, in a message about an order, "Arriving" and "should arrive";
  - a flight written in words ("Flight UA 123 departs SFO 10:15 AM on March
    4, 2027, arrives JFK 6:45 PM"), which keeps its number and airports;
  - the whole amount of a bill or a receipt, by the label beside it or by a
    line that says it is due (more on amounts below).

  A label claims the date on its own line before any line below it. The
  labels a form prints ("Expiry date", "Due date", "Check-in") also read
  the value on the line below; the words of running text ("reply by",
  "arriving", "appointment") claim from their own line only, and `EXP`
  only a date that follows it at once, so an order day, a street name or
  the header of a forwarded message on the next line is never theirs. In a
  message, a date with no year ("Thursday, November 12") is the next such
  day after the message was written, and is marked as having an assumed
  year; an expiry never takes one, and in any other file a date with no
  year is not read.

  A form line, a label and its date ("Cover ends: 30 November 2027"), is
  also looked up in a table of about 1,900 labels that ships with the app
  (`tools/label-lexicon/dates.tsv`). A label is matched whole, after its
  case, its punctuation and a closing "date" or "on" are set aside; nothing
  is matched loosely. The line then has one of three outcomes:
  - a label the table gives a meaning (a due date, an expiry, an issue
    date, an event, a check-in or check-out, a departure or an arrival) is
    read as that, under the document's own words, with the clock on its
    line or on the clock line a form prints under it ("Class begins: 2
    November 2027", then "Class time: 6:30 PM");
  - a label the table marks as needing no reminder (the day a statement
    was made, an order placed, a booking made, a document printed) gives
    nothing: no fact, no row, no question, and the on-device model is not
    asked about that line either;
  - a label the table does not hold, or one whose meaning depends on the
    document ("Date", "Start date", "Arrival"), is kept with the
    document's own words in the file's details. The on-device model is
    asked what that date is, and once it has read the file, what it said
    is what is offered: the line itself asks nothing, since a label whose
    meaning is not known is no question to put to you. Where no model
    read the file's dates (no signed-in device runs one, or it could not
    read this file), nobody said what the date is, so the line still
    waits for your yes while its day is ahead.

  No label that speaks of paying, expiring, attending, travelling or
  delivering can be marked as needing no reminder; a test holds the whole
  table to that. On a form, a clock line ("Departs: 08:42") belongs to the
  date line above it, never to a date below. Files stored earlier take the
  table on the next date sweep, and a line you already answered stays as
  you answered it. If the table cannot be loaded, every line is read with
  its own words.

  Clocks are read as "14:30", "2:30 PM" and "3pm", and also as "noon",
  "midday", "9 o'clock in the evening" and "15h30". An hour o'clock with no
  word for the half of the day ("dinner at 7 o'clock") is not read, and
  neither is "midnight" (which day it closes is unclear), a length of time
  ("Running time: 2h30") or an amount shaped like a clock ("Total: 14.30").
  A range of hours ("7-9pm", "between 10:00 and 14:00") is read from its
  start: the start takes the end's half of the day, a range never crosses
  a line, and a range elsewhere on a line never replaces the clock beside
  a date. A show's start ("Show starts", "Curtain up", "Kick-off") is its
  moment, and its doors are not a second one. A clock alone on the line
  under a date line ("Sat 14 Nov 2026", then "8:00 PM") belongs to that
  date, for the rules and for the on-device model.

  In a message, days said in words are read against the day it was sent:
  "today", "tonight", "tomorrow", "this Saturday", "on Saturday", "next
  Friday" and "Saturday the 5th". They go to the on-device model as dates
  to judge, never as rule readings, and a reading of one always waits for
  your yes. A date the message writes out in the same sentence is the
  reading instead. Not read: a weekday said of the past or of a schedule,
  "the day after tomorrow", and anything a reply quotes or a message
  forwards, which was said on another day.

  A table is read by its rows and its headers (`intel/tables.ts`). Two or
  more lines of cells, one under the other, are a table; its first row is
  a header when it holds names only.
  - Under a header, each cell is a form line named by its column: a day
    under "Check-in" is a check-in, a day under "Statement date" needs no
    reminder. A header row is never a label for the line under it.
  - A row is one moment: with one day in a row, each clock under
    "Departs", "Arrives", "Check-in", "Check-out" or an event's name is
    that moment on the row's day. Under columns called "Date" and "Time"
    a day and its clock are a moment too (a course timetable), unless the
    row holds an amount: a payment with its time of day is no moment.
  - A cell under a name the label table does not hold gives nothing: a
    list of payments under "Date" asks no questions.
  - A row with a cell missing is not read under the header: a page's text
    has no mark for an empty cell, so its cells cannot be placed. A name
    and its sum ("Total paid | 160.00") is the exception: the sum stands
    in the last column.
  - With no header, a row of two cells is a label and its value, and a
    cell that is itself "Label: value" is a field of its own, so a page
    set in two columns is read column by column.
  - Tables that stand under each other are told apart: a row of names
    after a row of values is the header of the next one.

  In a message, some parts are not its own words (`intel/zones.ts`). What
  it quotes (lines that start with `>`, all that follows "On ... wrote:",
  and in a reply the block of From and Sent lines some mail programs print
  above the message they answer) is read by no rule and never put to the
  model. Neither is the sender's footer: one footer mark (unsubscribe,
  "you received this email because", all rights reserved, a copyright
  sign) starts a footer only in the last two fifths of a message, and a
  long footer under a short message starts at its first line when it holds
  two marks, so a mark in the first lines hides nothing. An offer printed
  straight above the footer's first line ("Rate us before 28 February")
  belongs to it. Words a body uses too ("terms and conditions", "privacy
  policy") hide only the rest of their own line. A message it forwards is
  read for the dates and amounts it writes out (a booking forwarded to
  oneself). A stored file is no message: every line of it is its own.

  A day a document was issued is read where the document runs out or only
  states it (a licence, a certificate). On a bill, a ticket or a timetable
  it is the day the paper was made, and is not read.

  Amounts are read with their currency before or behind the number, as a
  symbol or a three-letter code ("$1,250.50", "EUR 1.250,00", "86.40 GBP",
  "29,99 €"), with two decimals; a code behind a dollar amount says which
  dollar ("$35.00 CAD"). Each amount is read with the words that name it:
  the words before it on its line, or the line above an amount that stands
  alone, as a table read out cell by cell prints it. A second table of
  about 560 labels (`tools/label-lexicon/amounts.tsv`), matched whole like
  the first, says what those words mean:
  - what is still to pay ("Amount due", "Total to pay", "Balance due",
    "Patient balance");
  - what the document came to, or what was paid ("Total", "Order total",
    "Total paid", "Total fare");
  - a part, which is never the whole ("Subtotal", "VAT", "Shipping",
    "Discount", a named fee, "Deposit paid", "Previous balance", "Minimum
    payment").

  An amount with a minus sign, a rate ("per night"), a deposit and the
  price of one of several ("2 x $55.00") are parts whatever their words.

  The whole amount of a document is then read by rule: the one amount that
  is still to pay or, with nothing to pay, the one total. A line that says
  an amount is due ("Rent of USD 2,400.00 is due") counts too. Two
  different amounts due, or two different totals, are not guessed between,
  and a statement that prints a minimum beside its balance names no single
  amount. A payslip's total, or a bank account's, is no bill's: on such a
  document only an amount that is due is read. The reading keeps the
  document's own words and waits for your yes, like every reading by rule.
  A label the table does not hold, or one whose meaning depends on the
  document ("Balance", "Fare", "Premium", "Amount paid", "New balance"),
  decides nothing. Not read: an amount with no decimals ("$50") or with no
  currency. In a table, a number alone in its cell takes the currency its
  column names ("Amount (GBP)"), and beside a name the table knows
  ("Amount due") the one currency the document names. It is named by the
  words in its cell, the name its row starts with, or its column's header:
  the first of them the table knows says what it is, so "Subtotal" under a
  column "Total" is a part. A rate or a count beside the amounts is no
  amount.
- **Amounts and reference numbers**, at low confidence, from any document,
  including kinds no rule anticipated.
- **The assistant's judgement**, at the lowest confidence of all, on the Mac
  and iPhone apps where the on-device model runs. Running words no label
  covers ("your dental check-up on 22 July at 09:30", "payable by 10
  April") are read in two steps. First the rules find every date in the
  whole text, each with the clock beside it, and every amount, and set
  aside what cannot matter: a day that was already over when the message
  was sent or the file was kept, a part of a bill (a rate, a deposit, an
  amount with a minus sign, an amount whose label the table calls a part),
  and anything a rule or the document's own booking data already read.
  A moment that was read with its clock also settles the end of its own
  range of hours and the clocks beside that printed date which only open,
  close or bound it ("Doors: 7:00 PM", "Gates open at 1pm", "Registration
  from 17:30", "Arrive by: 09:20", "until 22:00"): they are no second
  thing to ask about. A clock with a name of its own ("School play: 7:00
  PM" beside an appointment) still is, and a departure that was read
  leaves the arrival beside it open.
  Where the totals a document labels differ, only those are kept. Then
  the on-device model is asked once about what is left. For each date it
  answers from a short fixed list: something that happens, a check-in, a
  check-out, a departure, an arrival, a day to pay or act by, an expiry,
  or none of these. For the amounts it first answers yes or no, whether
  the document states a whole amount you paid or have to pay, and only
  then which one. It may add up to six of the document's own words (what
  happens, or the place of a stay or a journey), kept only when the text
  holds them and they hold no date or clock. The model has nowhere to
  write a date or an amount of its own, so a value the document does not
  state cannot arrive. For a message it is told the subject, the sender and
  the day it was sent. A document with nothing left to ask about is not
  asked, and an email whose booking data already gave its dates is only
  summarized. A moment that a rule and the model both read is one fact,
  and a form line that only names a date ("Date: 15 May 2027") gives way
  to what the model says the date is. What the model labels is offered
  like every other reading, marked "proposed and checked against the
  document", and confirmed by you or not at all.

**What counts without asking, and what waits for a yes.** A fact counts
(for the bell, notifications, the Timeline and trips) when you
confirmed it, or when the evidence settles it on its own: a reading from a
barcode, a passport's zone, booking data or an invite, or two independent
readers (a labelled date and the assistant) stating the same value. Everything
else arrives as a suggestion in a single line above your files and counts
once you accept it. One fixed order decides between readings of the same
thing: your answer, then exact data, then the rest. Where the assistant and a
labelled date disagree about a due date or an expiry, both are offered as one
question ("Which one?"), and your answer (or Ignore) settles both. Booking
data or an invite that states an event's day settles the assistant's reading
of that day, and a bill's own amount settles the assistant's. A date
that could be read two ways (`03/04/2028`) offers both readings as dates
rather than picking one. A wrong expiry date is worse than no expiry date,
because it gets relied on. Each fact in a file's details says why it counts:
"confirmed by you", "read from the booking data", "two readers agree".

A suggestion is made only while it can still matter. A date more than sixty
days behind is not asked about; a deadline missed lately still is, because
it can be acted on. A form line that only names its date ("Job completed:
28 October") says nothing of a deadline, so it is not asked about once its
day is behind, and not at all once the on-device model has read the file.
Such facts stay in the file's details, quietly, where you can still track
or ignore them, and an answer you gave to one earlier stays as it is.

**Reference numbers are kept short.** Metadata carries the last four
characters; the whole value lives in the file's index blob and is fetched only
when you ask to see it. Metadata is decrypted on every device on every sync,
which is not where a licence number belongs.

**How much a file keeps.** A file carries at most thirty-two facts, twelve of
them readings softer than exact data. A package of flights and hotels keeps
all of its dates, references and prices, while the amounts and codes a long
statement prints are held to twelve. Past the limit, exact dates are kept
first, then references, then prices.

**One purchase, one bill.** A file's bill is its invoice's amount due, else
its order's total, else each total its bookings state, so a package with
flights in one currency and a hotel in another is two bills. A purchase
stated again in a later message (a changed schedule, a shipping notice) under
the same booking, order or invoice number is billed once; the same amount on
the same account is still a bill every month.

**What it notices.** A small table of rules turns confirmed facts into the few
observations worth interrupting for, several of which read more than one
document at once:

- A passport expiring 14 Feb 2027 stops being useful for travel around 14 Aug
  2026, because many countries require six months of validity. That date
  appears on no document you own.
- A residence permit that outlives the passport it is attached to.
- An insurance period that ended with nothing newer stored.
- A warranty in its last thirty days, or an invoice past its due date.

These appear behind the bell in the toolbar, on the Mac and the phone alike,
with the reasoning behind each one a click away; the badge counts what you
have not seen yet. A date close enough to matter also reaches you as a system
notification when the app is not in front, once per document, with a switch
in Profile under This device. The **Timeline** lists everything being
tracked, in order.
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
airport table (about 3,800 airports with their zones and positions, shipped
with the app), which is also what turns JFK into New York on a card. An
airport that loses its scheduled service or its code stays in the table, so
bookings already stored keep their times.

**Trips booked exactly come together on their own; the rest are offered.**
Documents whose tracked events fall near each other, share a
booking-reference tail, or point at the same destination are candidates for
one trip. When booking data states the journey itself (a flight, train, bus
or boat, on the owner's word or from a structured source), the trip is
grouped on every device without asking, together with what links to it
exactly: a document dated near the journey that shares its booking
reference, a file that came in the same email, and an exact booking for a
day the traveller is away. Each journey is its own trip, so two trips a few
weeks apart, or a commuter's weekly flights, never merge into one. The
bell and the trip's page say so, and the page offers Not a trip: after
asking once, it takes the trip's tag off every member, the documents you
added included, and the refusal is remembered by the account, so the trip
never comes back; a document taken out of a trip is never put back. A document that
matches only by date is offered once for a yes, with the evidence stated in
words, and a candidate with no exact journey is offered the same way.
Assembly covers the whole library, and trips long past group quietly: one
line in Activity, nothing in the bell. "Assemble trips automatically" in
Profile turns it off, and then every candidate is offered. A trip is a
shared tag on its members and nothing more; its name, span and itinerary
derive from the members' facts, so a correction reshapes the trip on its
own. Places open in Maps: a handoff to the system, because door-to-door
timing would mean sending your location and route somewhere, and this
feature refuses that. The one computed line is the airport lead time,
three hours international and two domestic, stated only when both ends of
the flight resolve.

Cross-document rules run on confirmed facts: a passport checked against
every trip's return date, a permit that expires mid-trip, the night between
landing and check-in that nothing covers, and check-in opening the day
before a flight.

**The Timeline** is the place for time. It lists every dated thing in
order, one row each: a flight's two legs as one row with its codes and
times, a stay's check-in and check-out, a delivery window, a ticket or a
table, a due date with its amount, a bill on its email's date (once its
total is tracked; an invoice still owed is never counted as paid), and a
day of photos. The now line sits where the device's clock falls, trips run
as a band along the rail, and the questions still open are asked in place:
"Part of Lisbon? Only the date matches." with Add and No, a date to
confirm, a trip to keep. Its Month view shows each trip as a strip and each
day's first row and dots; choosing a day opens it on the list. Beside the
list, an ordinary day's cards: what is left today, this week, the one date
waiting for a yes, the photos from this day in earlier years, and what the
month has paid and still owes per currency, never converted. The poster
shows the home city (set in Profile, otherwise the city most journeys start
from) with its local time and its sky: dawn and dusk around a sunrise and
sunset worked out on the device from the airport's position, the hour
alone where no airport is known.

**What a fact is about.** Every reader says what each date is, not only
when: a departure or an arrival (with its carrier, number and airports), a
check-in or check-out (with the place and, from booking data, its address),
a pick-up, the start or end of an event. Booking data, boarding passes,
invites and the on-device model all state it the same way, so a guesthouse
booked by a plain email becomes a stay like any hotel once you say yes, and
a boarding pass joins the flight it was issued for. Each printed time is
read in its own place's zone: the offset the sender printed, else its
airport's, else the trip's destination's. The label stays the document's
own words, and facts stored before this was read keep their meaning from
those words, so nothing is read again.

**The Timeline follows your trip.** From a month before a trip, the
Timeline's hero becomes that trip, through seven moments: Planning (the
countdown, the trip, its checks, what has been spent), Soon (when check-in
opens, the boarding pass to come, what is ready), Travel day (when to leave
for the airport, three hours before an international departure and two
before a domestic one, the boarding pass, the landing against check-in), In
the air (the flight's progress from its two times, read offline), Staying
(the night of your stay, the hotel with its reference behind Reveal, today
in the destination, the flight home), Last day (check out by, leave by),
and Back home for three days (a recap, the photos from those days, what the
trip cost). The destination is where the journey stays longest, never a
hub it changes planes at; day and night counts follow the destination's
calendar. A date nobody has said yes to sets no time, and a trip flown out
to with no known way back never says Welcome back. The trip's checks are
the same ones the bell gives, so the two never disagree.

**A trip's page.** Any trip, near or far, past or future, opens as a page
over the Timeline: from its poster, Welcome back, a row's trip chip, the
details pane's "Part of" line, or the bell. It shows the route drawn on the
device as great circles between the trip's airports on a plain grid (no map
tiles, so no map service learns the destination), with the flight in the
air drawn up to where it is; the itinerary in time order; what is booked
there and the trip's checks; what it cost, bill by bill, per currency and
never converted, with a receipt matched only by date waiting for Add; and
every document that belongs to it. Every value opens its document.
Export to calendar saves the whole trip as one file: each leg at its real
instants with an alarm at leave-by, each stay as all-day nights, each
booking; dates nobody has said yes to stay out, and exporting again
updates the same events. Open album, on the hero's photos card, opens
Photos limited to the trip's days, counted by the same rule as the
Timeline, without creating an album.

**Finding connections without a shared reference** is the one place a model
enters, and only on request. A small zero-shot entity extractor (GLiNER,
about 180MB, staged by the same script as the semantic-search model and
served only from this origin) reads the already-decrypted text for place
names when the "Find connections" button is pressed. Its output is
spans: pointers into the text, so it cannot invent a value. The places it
finds feed the same deterministic clustering, are never stored, and never
leave the device. Opt-in beside the other reading toggles.
