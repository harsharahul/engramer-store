# Changelog

All notable changes to Engram Store are documented here, following
[Keep a Changelog](https://keepachangelog.com/) and semantic versioning.

## [0.41.2] - 2026-08-10

### Fixed
- **A co-editor's save no longer strands other surfaces on a stale
  integrity check.** Previews, downloads, the text editor, snapshot
  shares, and background text-recognition sweeps now refresh the
  library and retry when a shared file's recorded digest is momentarily
  behind its content, with paced retries covering the window between a
  save's bytes and its metadata landing. A live session's log trim also
  refreshes the library immediately instead of waiting for the next
  poll.

## [0.41.1] - 2026-08-10

### Fixed
- **Live co-editing no longer wedges after edits that add or restructure
  paragraphs.** The editor identifies itself and its collaborators by a
  composite id it builds internally; we were sending a shorter form, so
  the editor could mistake its own paragraph locks for a stranger's,
  draw a red bracket, and refuse the next keystroke. It also had no way
  to clear a collaborator's lock once that person committed or left, so
  the brackets accumulated until one side could not type while the other
  saw everything. Identity now matches what the editor expects, locks
  are released when their holder commits or leaves, and a session that
  loses contact with the relay repairs itself instead of going quiet.

## [0.41.0] - 2026-08-10

### Added
- **See or rotate your recovery key** from the profile's security
  section, each behind a password check. Rotating generates a new
  recovery key and retires the old one immediately, without touching
  your password or re-encrypting any data.
- **Change your vault password** from the profile's security section.
  The current password is verified on your device before anything
  changes, only the password wrapping is re-sealed (your files and
  recovery key are untouched), and your other signed-in devices are
  signed out.
- Live sessions count their traffic (changes posted and acknowledged,
  acknowledgement latency, cursor frames sent and received per member)
  in the in-app diagnostics, so a collaboration problem can be
  attributed instead of guessed at. Nothing is transmitted or stored.

### Fixed
- **A shared document opens correctly right after a co-editor saved
  it.** Opening used the reader's cached record of the file, so a save
  that had just moved the content was refused as an integrity mismatch
  until the next background sync, which on phones could take long
  enough to look like the document was permanently broken. A mismatch
  on a shared file now refreshes that record once and retries; a
  mismatch that survives the refresh still fails, so real corruption
  is caught exactly as before.
- Closing a document with unsaved changes, discarding a text edit, and
  restoring a file version now ask with in-app dialogs. The previous
  browser-native confirmations never render in the iOS app, which
  silently skipped the question and the action with it.
- A content blocker that refuses the editor frame's assets is now named
  within twenty seconds, with a retry button, instead of leaving the
  document on a spinner until the startup deadline gives up.
- Remote cursor positions are coalesced to at most ten frames a second
  instead of one websocket frame per keystroke, which reduces typing
  lag in live sessions on slow links.
- **A collaborative session that repairs itself no longer sticks on
  "Starting the editor".** The editor announces itself exactly once per
  frame load, so a repair that rebuilt the session against the
  already-loaded frame waited forever for an announce that had already
  happened. Every repair now reloads the frame itself, so reconnects,
  membership upgrades and channel repairs land back in the document
  instead of a spinner.

## [0.40.7] - 2026-08-10

### Fixed
- **Live co-editing works.** Three startup-order flaws kept real-time
  collaboration from engaging outside local testing: a fast-loading
  editor could announce itself before anyone listened and wait forever;
  a promptly connected session could be mistaken for a late one and
  never join the room; and the first person in a room typed invisibly,
  because the editor chooses single-user mode when it starts alone and
  never reconsidered. Sessions now start regardless of arrival order,
  and a room re-engages collaboration the moment company arrives,
  preserving any unsent work.
- The collaboration handshake now records itself in the in-app
  diagnostics, so a future failure names its own cause.

## [0.40.6] - 2026-08-09

### Fixed
- **Shared documents open even when the collaboration connection is
  slow or unreachable.** The document loads immediately and in
  parallel; a session that cannot reach the live channel within ten
  seconds opens solo and fully editable, and upgrades to live when the
  connection arrives.
- Live sessions survive quiet spells behind proxies: the connection
  carries a heartbeat, and reconnecting no longer counts against the
  session's repair attempts.
- A live room whose change log reaches its size ceiling now saves a
  snapshot automatically instead of silently refusing further changes.
- The rotate-key question now appears on iPhone; it previously used a
  dialog the iOS app could not display, so rotation was silently
  skipped when removing someone's access from a phone.

### Added
- **The Shared page now opens with the people you share files with**,
  across the whole library, manageable in place; links and file
  requests follow.
- **Snapshot links.** Share a frozen copy of a document's current
  contents with its own link; the original keeps evolving privately.
- **Automatic key release to a named invitee.** Enter their email when
  creating an invitation and the key releases itself the moment that
  exact account claims it; unnamed invitations keep the explicit
  approval step.

## [0.40.5] - 2026-08-09

### Fixed
- **A shared document no longer becomes unopenable after co-editing.**
  A save during live collaboration could leave the document's change
  stream in a state every fresh open misread as corruption, reloading
  forever; affected documents open normally again on their own.
- If a live session genuinely cannot be repaired, the editor now says
  so instead of spinning indefinitely.
- Saving during live collaboration no longer raises a false conflict
  when a co-editor saved moments earlier.

## [0.40.4] - 2026-08-08

### Added
- **The vault keeps itself current.** An open window refreshes when you
  return to it and checks in while it stays visible, so shared
  documents, approvals, and uploads from your phone appear on their own
  instead of waiting for a manual refresh.
- **Opening the iPhone app delivers pending share-sheet uploads
  immediately**, instead of waiting for the system's background
  scheduler, and cleans up staging the system already delivered.

### Fixed
- The invitation page now describes how a share is approved: the owner
  releases it from the document's Share panel.

## [0.40.3] - 2026-08-08

### Added
- **Choose where shared files go.** The share sheet opens on a
  destination picker: Smart classify (an Inbox folder whose arrivals the
  app tags and categorizes), the vault root, or one of your folders,
  remembering your last choice.
- **Choose how far back photo backup reaches.** Back up the whole
  library, only photos taken from today on, or the last 30 or 90 days.

### Fixed
- **Large files open reliably from the Files app.** Downloads stream to
  disk and decrypt in small slices, so any size works within the tight
  memory limits iOS gives extensions; downloads also retry once after a
  cold start and show real progress. Saves from other apps stream the
  same way.
- The server picker on the sign-in screen is now a visible control
  instead of fine print hidden behind the iPhone's home indicator, so
  pointing the app at a self-hosted server is discoverable.
- The photos timeline's month marker is now a frosted pill that renders
  correctly in the light theme.

## [0.40.2] - 2026-08-08

### Fixed
- **Opening the app now reconnects its extensions.** The Files app drive
  and the share sheet read the vault key the moment the app has stored
  it, instead of staying signed out until iOS restarted them.
- The share sheet lays its message out correctly and keeps error
  messages on screen long enough to read.
- When extensions cannot read the vault key, they now say why, and the
  profile's new connection check can store the key again and confirm it
  reads back.

### Added
- The profile shows which server this app is connected to.

## [0.40.1] - 2026-08-08

### Added
- **Choose your server from the login screen.** The iPhone and desktop
  apps show which vault server they are connected to and let you change
  it, so one app serves any deployment, self-hosted included.

### Fixed
- The App Store build now refuses to produce an app pointed at a
  development address, and bakes the deployment it is told about.

## [0.40.0] - 2026-08-08

### Added
- **Save to Engram Store from any app.** A share extension puts the vault
  in the iOS share sheet: pick it from Photos, Safari, Mail, anywhere, and
  the item is encrypted on your device and uploaded in the background.
  Photos keep their originals.
- **Your vault in the Files app.** With extensions turned on, the vault
  appears as a drive in the Files app and any app's file picker: browse
  it, open from it, save into it, and edit documents in place. Files you
  rename, move, or delete update the vault; a delete goes to the trash so
  it is recoverable. If a file changed elsewhere while you were editing,
  your version is kept as a conflicted copy rather than overwriting the
  newer one.
- **Automatic photo backup.** Opt in, and your photos and videos are
  copied to the vault, each encrypted on your device first. You choose
  Wi-Fi only, whether to include videos and screenshots. Turning it on
  asks for access to your photo library and says exactly why.
- **Extensions on this device** (Profile): the switch that turns on
  sharing and the Files-app drive. Your vault key is stored behind the
  device passcode, on this device only, never in iCloud, and removed when
  you sign out.
- **A Photos view.** Every photo and video in the vault, wherever it is
  filed, as one timeline: month sections, edge-to-edge thumbnails, and a
  filter to show only favorites.
- **Albums.** Group photos into albums without moving them; a photo can
  live in any number of albums. Albums appear in the sidebar, can be
  created on the spot while filing, and are searchable by exact name.
  Stored as encrypted tags, so the server learns nothing.
- **Select multiple files on a phone.** Hold a photo (or choose Select)
  to start gathering, tap to add more, then favorite, file into an album,
  move, download, or trash them together.
- **Pinch to zoom in the viewer.** Pinch, double-tap, trackpad pinch, or
  the +, -, and 0 keys; panning while zoomed no longer flips to the next
  file.
- **A star in the viewer toolbar** marks a photo as a favorite without
  leaving it.

### Changed
- **Phone sheets behave like sheets.** The action sheet, the details
  sheet, and the album picker share one gesture: drag down to dismiss,
  with a flick closing from anywhere. The photo viewer closes with a
  downward swipe. File lists refresh when pulled.
- **Notifications stopped colliding.** Toasts, upload progress, and the
  selection bar stack in one column above the tab bar instead of landing
  on the same spot.
- **Dialogs rise above the keyboard** instead of hiding behind it, and
  touch targets across the phone layout got bigger and answer the finger
  immediately.

## [0.39.6] - 2026-08-07

### Fixed
- **The iPhone app can reach its own device features again.** Because the app
  loads the vault over the network, iOS was refusing every request it made of
  the device itself. Unlocking with Face ID or Touch ID, watched folders, and
  media playback were all turned away silently and simply appeared to be
  unavailable. They work again.
- **Photos picked on iPhone keep their original quality.** Completes the
  system picker added in 0.39.5: a photo now travels from the library into
  your vault exactly as it was recorded, rather than as a copy iOS re-encodes
  on the way out. Requires the updated iPhone app.

## [0.39.5] - 2026-08-07

### Fixed
- **Details opens on a phone.** It never has. The rule that hides the
  side pane on narrow screens outranked the rule that turns the same
  element into a bottom sheet, so the sheet mounted at `display: none`:
  present, correct, and invisible. Tapping Details appeared to do nothing.

### Added
- **Photos keep their original quality on iPhone.** Adding photos through
  the app now uses the system picker, which hands over each photo and video
  as it was recorded. Until now iOS re-encoded every HEIC photo to JPEG and
  every HEVC video to H.264 on its way into the app, and no setting on the
  web side could prevent it. The picker needs no access to your photo
  library: it runs outside the app and passes over only what you choose.
  Requires the updated iPhone app; everywhere else is unchanged.
- **Move between files without leaving the viewer.** Swipe left or right on
  a phone, use the arrow buttons or the arrow keys elsewhere. It steps
  through whatever the current view is showing, in the order it is showing
  it, and stops at the ends rather than looping.

### Changed
- **A file's facts are visible without scrolling.** The preview in the
  details sheet took a 4:3 slice of the screen, pushing Where, Type, Size
  and the dates below the fold. It is shorter on phones now.
- **The photo picker accepts images and videos broadly again.** iOS decides
  the format itself: measured against a HEIC on real iOS WebKit, every
  candidate accept string returned a transcoded JPEG, so narrowing the list
  only cost formats. Keeping HEIC originals needs a native picker, not an
  attribute.

## [0.39.4] - 2026-08-07

### Fixed
- **Details stays open on a phone.** The panel read its file out of the
  current selection, and a selection is cleared by ordinary things: a tap
  on empty space, a menu opening, the grid rebuilding. Opening details now
  pins the file it was opened on, and the panel reads the pin, in both the
  phone sheet and the desktop pane.
- **Photos picked from the library keep their original HEIC.** The picker
  declared `image/*` alongside the HEIC types, and iOS reads a wildcard as
  permission to hand over whatever format it likes: it transcoded to JPEG
  at pick time, before the page saw a byte. The formats are now named
  outright, with no wildcard.

### Added
- **Choose the name collaborators see.** Profile has a name field. Set it
  and the people you edit a document with see that name beside your
  cursor; leave it empty and they see your email address, as before. The
  name is visible only to people invited to a document you are both in.

## [0.39.3] - 2026-08-07

### Fixed
- **Details no longer flickers shut on a phone.** Opening Details from an
  open file closed that file, and the same tap then landed on the grid
  underneath, which cleared the selection the panel was reading from — so
  it appeared and vanished, back to the folder. The panel now keeps hold
  of the file it was opened on.

### Changed
- **Details is second in a file's actions menu**, named for what it is, so
  reading a file's dates, tags and history no longer means opening the
  file first.
- **People editing together are named.** The editor showed "member 1" and
  "member 2"; it now shows who is actually there. Identity travels no
  further than the document's own membership — everyone listed was
  invited to that document by its owner.

## [0.39.2] - 2026-08-07

### Fixed
- **Uploading photos from the iPhone no longer closes the app.** A photo
  was being decoded three separate times — once for its thumbnail, again
  to recognise text, and again to scan for barcodes — each at full
  resolution. Keeping HEIC originals made that far heavier, since a
  two-megabyte HEIC can hold tens of megapixels, and the phone ran out
  of memory. Each photo is now decoded once, and everything that reads
  it works from a single bounded copy.

## [0.39.1] - 2026-08-07

### Fixed
- **The iPhone app no longer closes while uploading several photos.**
  Reading a photo is the heaviest thing the app does — recognising text,
  scanning for barcodes at full resolution, thumbnailing — and uploading
  a batch had started doing all of that for several photos at once,
  which exhausted the memory of a phone and had iOS close the app
  mid-upload. Transfers still overlap, because that is where the waiting
  is; the reading now happens one photo at a time on a phone.

## [0.39.0] - 2026-08-07

### Added
- **Editing together, live.** Two people can now edit the same Word
  document or spreadsheet at the same time and watch each other's
  changes appear, with a marker showing who else is here. Every change
  travels sealed under the file's key: the server orders and relays the
  bytes without being able to read one of them. If the channel is
  unavailable the document stays fully editable one person at a time.
  See [docs/collaboration.md](docs/collaboration.md).
- **Invitations wait for you.** A claimed invitation now names the
  account that claimed it and holds the key until you release it, so a
  link that reached the wrong person hands over nothing on its own.

### Fixed
- **A collaborator's save reported failure after succeeding.** The
  document was stored correctly and the editor said the save had failed.
- **A share could stay invisible to the person it was shared with.** A
  grant that arrived while the recipient was syncing was skipped, and
  Shared with me stayed empty until a manual resync.
- **Version history is the owner's again.** A collaborator could read
  every retained earlier version of a file shared with them, including
  content removed before they were invited.

### Security
- A view-only collaborator could write to a shared document through the
  live channel, and could destroy other people's unsaved work by
  claiming a save that never happened. Both are closed: the channel now
  distinguishes viewers from editors for its whole life, and only a save
  the server itself committed can discard history.
- Members could act as one another on the channel: a change could claim
  someone else's identity, taking their locks or forcing others to
  reload. Identity now comes from the connection the server saw.
- Revoking access disconnects that person immediately instead of when
  they next happen to disconnect.
- On a deployment served over plain HTTP, the app's own security headers
  blocked the collaboration channel outright.
- The invitation throttle counted attempts in a way that could never
  trigger its own backoff.

## [0.38.0] - 2026-08-06

### Security
- **PDF renderer updated against GHSA-hq66-cqwq-w95j.** pdf.js moves to
  6.2.108, closing an arbitrary script execution issue a crafted PDF
  could trigger in affected versions.

### Added
- **Sharing with people, not just links.** A file can be shared to another
  account as a viewer or an editor. The invitation is a claim-once link
  that carries no key material; the recipient claims it signed in, the
  owner's device seals the file key to exactly that account, and the file
  appears in the recipient's new **Shared with me** view. No endpoint maps
  an email to an account, and every dead invitation answers identically,
  so accounts cannot be enumerated.
- **Safe concurrent editing.** When two people save the same document, the
  server accepts one save and refuses the other atomically; the refused
  editor chooses between reloading the winner's document and keeping their
  own work as a new file they own. Nothing is silently overwritten.
- **Key rotation.** Removing a collaborator can also rotate the file's
  key: content, thumbnail, and search index are re-encrypted under a fresh
  key, which is re-sealed to every remaining member automatically.
- **HEIC photos keep their original bytes.** A dedicated photo picker
  stops iOS converting HEIC to JPEG on the way in, and an on-device
  decoder (loaded only when needed) renders HEIC thumbnails, previews,
  text recognition and meaning search in browsers without native support.

### Fixed
- **Editing documents on iPhone no longer zooms the page.** The office
  editors' hidden input sat below the size at which iOS zooms to a
  focused field; it is now pinned above it inside the editor frame, and
  double-tap zoom is quieted there too.
- **Faster photo uploads.** Picked photos upload through the same bounded
  pool folder uploads always had, and each file's follow-up requests
  (checksum, thumbnail, search index) travel together instead of one
  after another.
- **A visible Details button.** The file preview toolbar gains an explicit
  Details button alongside the existing routes to the panel.

## [0.37.1] - 2026-08-06

### Fixed
- **iPhone privacy permissions.** The iOS app now declares why it uses
  Face ID, the camera, and the photo library. Unlocking the vault asks
  for Face ID instead of falling back to the device passcode, and
  adding files through the photo picker no longer closes the app.
- **Long-press on files.** On touchscreens a long-press reliably opens
  the file actions menu, including tags and details; it no longer
  competes with drag and drop, which stays a pointer feature.
- **Profile on small screens.** Long values wrap instead of pushing
  the profile cards past the screen edge, and taps no longer flash
  the system highlight rectangle.

## [0.37.0] - 2026-08-06

### Added
- **Travel intelligence.** The documents a trip generates become the trip.
  Boarding-pass barcodes (IATA BCBP, on photos and on PDFs), the
  schema.org reservation data airlines and hotels embed in saved
  confirmations, and a travel vocabulary for check-in, departure,
  boarding and their kin all feed the same on-device reader, with times
  kept local to their places and zones carried only where genuinely
  known, backed by an offline table of 3,700 airports.
- **Trips are proposed, never assumed.** Documents with nearby confirmed
  dates, a shared booking-reference tail, or a common destination are
  offered as one trip with the evidence in words; accepting writes a
  shared tag and nothing more. The itinerary derives live from the
  members' facts: legs in city names, calendar export per leg, a Maps
  handoff instead of any routing, and the airport lead-time line
  computed only when both ends of the flight resolve.
- **Cross-document travel rules.** A passport is checked against every
  trip's return date, a permit that dies mid-trip is called out, so is
  the night between landing and check-in that nothing covers, and
  check-in opening the day before a flight.
- **A calendar.** Tracked dates as dots, trips as named spans across the
  month, days that list what they hold, keyboard navigation throughout.
- **Find connections.** An optional on-device entity extractor
  links travel documents that share nothing exact, on request only. It
  can only point at words that exist in the text, its findings feed the
  same deterministic grouping, and nothing it finds is stored or sent
  anywhere.
- **Search inside Word, Excel and PowerPoint files.** Their words are
  read at the data level on your device, the same as PDFs and plain
  text: a document's paragraphs, a spreadsheet's cell texts, a deck's
  slides. Saving from the built-in editor refreshes the index too, so
  an edited document is findable by what it says now.
- **The iOS app.** The native shell now builds for iPhone from the same
  crate as the desktop app, distributed through TestFlight. And it
  behaves like an iPhone app: Face ID unlocks the vault the moment the
  app opens, video playback uses the shell's native streaming path
  with a whole-file fallback where streaming cannot reach yet, and the
  words on every surface say Face ID on a phone and Touch ID on a Mac.
- **Trip cards worth looking at.** Flights read as one row with both
  ends, clocks over dates over places; stays and rentals read as a
  short rail of moments with real day names; every segment carries a
  properly drawn glyph matched to the app's stroke style.

### Fixed
- The words "boarding pass" no longer read as a boarding time.
- The desktop app's watched-folder and tray features are compile-gated
  so every other platform keeps a clean shell.

## [0.36.0] - 2026-08-06

### Added
- **Every labelled date is found now, not only the ones with familiar
  labels.** Real documents carry their controlling dates under labels no
  vocabulary anticipates, sometimes in formats no pattern expected, and
  a date the reader cannot see loses to a lesser date it can. The reader
  now surfaces every labelled date in a document and, when it does not
  recognize the label, quotes the document's own words and asks; you
  supply the meaning once. Labels it does recognize are typed as before,
  dates labelled anything birth-shaped are refused outright, as are
  print and generation stamps, and the date grammar learned the
  year-first forms some documents use.
- **Any date can be corrected on the spot.** "Wrong date?" opens an
  editor prefilled with the reading; the corrected value is stored as
  your statement, marked "entered by you", and a later rescan can
  neither resurrect the wrong reading nor re-offer your correction as
  news.
- **Add to calendar.** Any tracked date becomes a calendar event with
  the reminder built in, generated entirely on your device and handed
  to the calendar you already trust. A time a document gave stays
  floating local time, because a departure is local to its airport.
- **Bulk answers.** A document with several dates is one card asking
  which matter, and above a handful of pending documents everything
  listed can be tracked or ignored at once, costing one write per file.
  Only dates still ahead of you, or recently enough past to act on, are
  offered at all: a thousand-file upload of old documents records its
  facts quietly and asks about almost nothing.
- **Done.** A tracked date that has passed can be retired in one click
  instead of nagging forever.

### Fixed
- Files sent to you through a file request now record a content
  checksum on the sender's device, before encryption. Previously every
  received file stayed unverifiable forever.
- The library sweep now revisits documents whose suggestions were never
  answered, so a better reader reaches files that were read badly the
  first time; saving over a file now discovers facts even when the file
  had none before.

## [0.35.0] - 2026-08-05

### Added
- **Your documents can tell you what they say.** Turn on "Read dates in
  documents" and an upload is read for the things it states about
  itself: when it expires, when a payment is due, when it was issued,
  and the reference numbers that identify it. All of the reading happens
  on your device, and the results live inside the encrypted metadata
  like every other derived signal.

  The accurate half comes from documents that state their own data in a
  structured form. A North American driver's licence carries its expiry
  in the barcode on the back, as a field rather than as printed
  characters. A passport carries a machine-readable zone whose fields
  are protected by check digits, so a misread is detectable; a failed
  check discards the whole read rather than producing a fact with lower
  confidence, because knowing a scan went wrong is the only thing that
  made the zone better than a guess in the first place.

  Everywhere else, dates are claimed only where a document labelled one.
  An unlabelled date is nearly always a print date, and a wrong expiry
  date is worse than no expiry date because it gets relied on. Nothing
  is acted on until you confirm it, and a date that could be read two
  ways offers both readings rather than choosing.
- **Barcodes are now readable at all.** Character recognition reads
  printed text and cannot read a barcode, so the code on a ticket, the
  QR on an invoice and the block on a licence were invisible to search
  no matter how good the text extraction became. Every symbology the
  decoder knows is enabled and every decoded payload joins the
  searchable text, so a booking reference is findable by being readable.
  The decoder is WebAssembly served from your own host, like the text
  recognizer and the model runtime, and it loads only when used.
- **A few observations worth interrupting for.** A passport expiring in
  February stops being useful for travel around the previous August,
  because many countries require six months of validity; that date
  appears on no document you own. A residence permit can outlive the
  passport it is attached to. An insurance period can end with nothing
  newer stored. These read across more than one document at once, which
  only something that can see your whole library can do.
- **An Expiring soon view**, the facts read out of each file shown on
  the file itself with the source of each, and "Find dates in my
  documents" in the command palette to read a library stored before any
  of this existed, working from text the vault already holds.

### Fixed
- **Renaming or tagging a file erased its content digest.** Every
  metadata change rebuilt the stored metadata and left the digest out,
  so the record of what a file held when it was stored was destroyed the
  first time it was renamed. Nothing failed at the time; the file simply
  became permanently unverifiable and reported as never checked. Files
  affected before this release need a re-upload to become verifiable
  again.
- **Saving a Word or Excel document left the previous version's digest
  on the new contents**, which would have made a verification pass
  report a healthy file as damaged. Both save paths now record the
  digest of what they actually wrote.
- The details panel compressed its own contents instead of scrolling
  when it had more to show than room to show it.

## [0.34.0] - 2026-08-03

### Added
- **Checking your files no longer means downloading them.** The server
  cannot read what you store, but it can tell whether what it holds is
  still what it was handed, so it now records a digest of each stored
  blob as it writes it and answers a list of files with a verdict for
  each. A vault of any size is checked in seconds, over a few kilobytes
  of requests. This catches what happens to data at rest: a truncated
  write, a replaced object, bit rot.
- The check that reads every file back is still there, beside it, for
  proving contents rather than storage, with the download it costs
  stated on the button. It reads the smallest files first and reports
  bytes as well as counts, so a large file no longer looks like a hang.
- **A file says what is known about its integrity** in its details:
  checked and matching, a checksum recorded but not read yet, not
  matching, or stored before any of this existed.

### Fixed
- **Documents fit the screen they are shown on.** A Word page has a
  paper width and was drawn at that width whatever the space allowed,
  so on a phone or in a narrow window everything on the page sat
  outside the visible area and the document read as a blank sheet.
- **Closing a spreadsheet no longer discards the cell you were typing
  in.** The cell is not part of the document until you leave it, so
  nothing knew there was anything unsaved and the question was never
  asked.
- **A home-screen app opens at the right height.** The height a browser
  reports as a page loads is not always what it settles on, which left
  a band of empty space under the tab bar until something was tapped.

## [0.33.0] - 2026-08-03

### Added
- **Every file now proves it is the file it was.** A digest of the
  contents is taken on your device before any encryption and checked
  after decryption, so the whole path is covered rather than the
  storage half of it. Encryption already proved the server returned
  what it was given; it could never prove that what it was given was
  what your file held. The digest rides along with the encryption
  rather than costing a second read.
- **Check every file, on request.** Under your account menu, a pass
  that reads the whole vault back and reports what it finds: intact,
  damaged, unreadable, or stored before this existed and carrying
  nothing to check against. Nothing else can tell you this, because the
  server cannot read your files. It downloads everything, so it is
  asked for rather than automatic, reports progress by name, and can be
  stopped.
- A file that fails its check is marked in the library, says so when
  opened, and still downloads: a check that could itself be wrong must
  never be the reason data becomes unreachable.

### Fixed
- **Watched folders were storing every file corrupted.** A file read
  through the desktop shell was declared to be bytes rather than
  converted into them, and what arrives is an array of byte values,
  which a Blob stringifies without complaint. Files were stored as the
  text "37,80,68,70,..." at about three and a half times their real
  size, unopenable, and nothing reported it. Uploads from a watched
  folder since the feature shipped need replacing; the originals were
  never touched.
- **The same watched files uploaded again on every scan.** A file
  counts as new when nothing of its name and size is in the vault, and
  the corrupted size could never match, so the folder re-uploaded
  forever.
- **A spreadsheet dropped the cell you were typing in.** The cell stays
  open until you leave it, and until then its text is not part of the
  document, so typing and pressing Save stored the document without it.
- **Uploads verify what arrived.** Every upload compares the bytes it
  read against the size the file system reported, and completes only
  when the server confirms it holds every byte.
- **A file that only claims to be a PDF offers the download again**
  rather than an error, for pages saved by a browser and other things
  named .pdf that are not.

## [0.32.2] - 2026-08-03

### Added
- **A running client notices when it is out of date.** This app is
  built to be left open: a home-screen app, a desktop window that
  reopens rather than relaunches, a tab that lives for days. When the
  deployment moves on, the window now says so and offers to reload onto
  the new build. Offered rather than forced, because a reload during an
  upload or an unsaved edit is not the app's decision to make. The
  desktop app picks up releases this way, on a reload, without being
  rebuilt; only changes to the native shell itself need a new build.
- **Spreadsheet previews.** Opening a workbook used to offer a download
  and nothing else. It now shows as a table with a tab per sheet, read
  on your device, bounded so a preview stays a preview, and saying when
  it has stopped short.
- **Watched folders file the way you choose.** Per folder: sorted by
  kind like any other upload and tagged with the folder's name, so the
  group stays findable once auto-filing has scattered it; or kept
  together in a vault folder of the same name, subfolders and all.

### Fixed
- **PDFs preview everywhere.** They were handed to the browser in a
  frame, which shows a PDF only where the browser ships a viewer.
  Safari's WebView does not, so the same document opened on one machine
  and was blank in the desktop app and on iPhone. They are now drawn on
  your device, page by page, at screen resolution.
- **PDFs are recognised by their name as well as their type.** A PDF
  that arrived with a missing or generic content type, which is routine
  from a share sheet or a watched folder, was treated as an unknown
  file: no preview, only a download.
- **Watched folders no longer re-upload after a refresh.** A watched
  file counts as new when nothing of that name and size is in the
  library, but the scan ran before the library had loaded and compared
  against an empty one, so every refresh uploaded everything again.

## [0.32.1] - 2026-08-03

### Fixed
- Word and Excel editing behind a reverse proxy. The editor runs in an
  opaque origin, so its content policy has to name the origin its own
  assets come from rather than say `'self'`. Where a proxy rewrites the
  Host header the server named an internal hostname instead, and the
  browser refused every asset the editor loaded, leaving a document
  that never opened. Set `ENGRAMER_PUBLIC_ORIGINS` to the addresses
  browsers actually use and they are named too; a deployment reached at
  the address the server itself sees needs nothing.
- A document that cannot open now says so instead of waiting forever.

## [0.32.0] - 2026-08-03

### Added
- **Word and Excel editing, entirely on your device.** Open a .docx or
  .xlsx and edit it in a real office engine that runs in the browser:
  formulas, charts, images, tables and tracked changes survive a round
  trip, because the document is edited in its own format rather than
  converted through a lossy intermediate. Nothing is converted on a
  server, which is the reason the usual self-hosted office integrations
  cannot work on encrypted storage at all. Saving re-encrypts under the
  file's existing key and keeps the previous version, so an edit joins
  version history like any other change.

  The editor runs in a frame with an opaque origin: no storage, no
  cookies, no session, and no access to the page holding your keys. It
  is handed a document as bytes and hands one back. Editing needs no
  second hostname and no extra certificate; a self-hoster runs what they
  already run. See [docs/office-editing.md](docs/office-editing.md).
- **New documents and spreadsheets, created in the app.** A blank .docx
  or .xlsx is created encrypted in your vault and opened for editing,
  so a document can start here rather than being uploaded from
  somewhere else. Spreadsheets are a file kind the app now recognises
  throughout, with their own art and actions.
- **The running version is visible.** The client names the release it
  was built from: in the sidebar, once in the browser console at
  start-up, and at the head of the activity log, so a captured log
  always says which build produced it. It is compiled into the client
  rather than read from the server, because an installed app or a
  desktop shell can be running an older build than the server has.

### Changed
- **One way to create things.** The four create buttons in the top bar
  became a single New menu offering a note, a Word document, a
  spreadsheet or a folder, each with its own icon. At widths where
  button labels collapse, the old row read as three identical icons
  with no way to tell them apart.

## [0.31.1] - 2026-08-02

### Fixed
- Streaming stays smooth at real-world latency. Media responses now
  read decrypted chunks from one shared pool per file: a missing chunk
  starts a single windowed fetch that every concurrent request joins,
  and read-ahead fills the pool before the playhead arrives, so a
  player reading with several cursors can no longer trigger bursts of
  simultaneous connections that briefly drain its buffer. At the
  network profile that reproduced the periodic mid-play lag, stalled
  playback samples drop to zero, seek settle falls from seconds to
  about 200 ms, and total transfer runs below 1.2x the file's size.
  The activity log now distinguishes fetches a player waited on from
  quiet read-ahead.

## [0.31.0] - 2026-08-02

### Added
- Content storage tiering. The server keeps a bounded on-disk cache of
  aligned 32 MiB ciphertext windows: cold reads stream through at
  unchanged latency while the windows they touch fill behind them, and
  an upload warms its own first and last windows, so a video plays
  smoothly the moment it finishes uploading and repeat viewing costs
  the backing store nothing. When content and derived blobs live on
  separate stores, every file also leaves hot copies of its opening
  and closing bytes on the fast store, written on upload and
  self-healing for existing files, so playback starts and tail-index
  reads never wait on a slow or rate-limited backend.
- The desktop app can refresh in place: a Refresh item in the tray
  menu and Cmd+R in the window reload the page without restarting,
  which also picks up newly deployed versions.
- The activity log narrates streaming: the media bridge reports every
  upstream connection it opens or resumes, so playback behavior is
  visible on the device instead of only in server logs.

### Fixed
- Browser streaming answers range requests in bounded, chunk-aligned
  windows. Desktop Safari's media engine reads with unaligned ranges
  and drains open-ended responses far beyond what it keeps, which
  defeated the single-connection cache and multiplied transfer;
  playback of a large file could stall once the backing store began
  throttling. Measured against real WebKit, Chromium, and Gecko
  engines, upstream requests for a 1 GB play drop from 237 to 54 and
  total transfer from 14.3x the file's size to 1.7x, with playback
  and seeking unchanged.
- A thumbnail that failed to load once no longer stays a blurred
  placeholder for the whole session: fetches retry with backoff, and
  a failure is forgotten so the next look starts over.

## [0.30.0] - 2026-08-01

### Added
- The desktop app plays media through a native protocol. The player's
  byte-range requests are answered inside the app, with ciphertext
  fetched ahead in large spans and chunks decrypted natively (verified
  byte-compatible with the web format), so playback no longer pays a
  network round trip per request. If the protocol is unavailable the
  service worker bridge takes over transparently.

### Fixed
- Streaming rides one connection. Browsers play video as many short
  range requests that continue where the last stopped; the media bridge
  now hands the open ciphertext stream from one request to the next
  instead of reconnecting each time. Six requests that previously cost
  six upstream fetches now cost one; seeks cost exactly one.
- Watched-folder scans and file reads explain themselves in the
  activity log, including a pointer at macOS folder permissions when a
  non-empty folder scans as empty.

## [0.29.0] - 2026-08-01

### Added
- Video meaning search covers every scene. Uploads sample five frames
  across a video's timeline and index each one, so a query matches
  whatever appears anywhere in the clip, not only its opening moment.
- Watched folders in the desktop app. Folders chosen in the profile
  page upload new files automatically, encrypted, with subfolders
  preserved and files already in the vault skipped. Strictly one-way;
  nothing is ever deleted.
- A gentle Lock. Locking keeps Touch ID or the passkey enrolled so one
  touch reopens the vault; signing out remains the full revocation.
- An on-device activity log. The profile page shows what this device
  did recently: upload retries, playback buffering with timestamps,
  watched-folder activity. Kept only in memory, never transmitted.
- Optional structured request logging on the server for cluster log
  collectors, off by default.

### Fixed
- Smoother video playback: the streaming bridge no longer re-fetches
  the media header for every range request browsers issue during
  playback, removing a round trip per cycle.

## [0.28.0] - 2026-07-31

### Added
- Touch ID unlock in the desktop app. The Mac app keeps an unlock secret
  in the macOS Keychain behind the system's biometric prompt, and the
  vault keys are wrapped under a key derived from it, exactly like the
  browser passkey flavor. Signing out clears both halves.
- The desktop app lives in the menu bar: closing the window parks it in
  the tray with open, start-at-login, and quit controls, and the dock
  icon brings it back.

### Fixed
- The sidebar stays put; only the file area scrolls.
- Signing in reads calmly: the button keeps a short label with the
  key-derivation note beneath it instead of overflowing.
- The search field's placeholder shortens before it can clip in narrow
  windows, and the command palette shortcut renders as a proper keycap.

## [0.27.0] - 2026-07-31

### Added
- A profile page. Clicking the account name opens one place for
  everything: storage usage, two-factor authentication, device unlock
  with per-device availability, recovery-key guidance, appearance and
  intelligence preferences, a library resync, and for operators the
  full server administration panel inline.

### Fixed
- Large videos always fit the window. The media viewer previously let
  a 4K video overflow the screen on desktop-sized windows, which could
  squeeze it into a corner or push it out of sight entirely while the
  audio kept playing.
- Video posters no longer come out black: capture waits for a truly
  painted frame, and clips that fade in from black retry a few seconds
  into the footage.
- Failed or cancelled uploads clean up after themselves instead of
  leaving an empty file in the library, upload progress never walks
  backwards during a retry, and a full bar that is still working now
  reads "finalizing".

## [0.26.0] - 2026-07-31

### Added
- Find similar. Any photo or video that has a meaning index gains a
  context-menu action that ranks the whole library by visual closeness,
  entirely on-device: near-duplicates surface first, similar scenes
  follow, and videos match through their poster frames. Results open in
  the familiar search view with one click back to files.
- Uploads can be cancelled. A Cancel control in the upload tray stops
  every transfer in flight immediately.

### Changed
- Uploads now shrug off bad networks. A watchdog aborts any request that
  stops moving bytes instead of hanging forever, timeouts and server
  errors retry with jittered backoff, parts shrink on slow links so a
  retry repeats little work, two parts travel concurrently for higher
  throughput, and going offline pauses the queue until the connection
  returns.

## [0.25.0] - 2026-07-31

### Added
- Search photos and videos by meaning. An optional on-device model (a
  65 MB download, fetched once from the server itself) embeds each
  photo, and each video's poster frame, into a semantic index that is
  encrypted like everything else: type "a dog on a beach" and matching
  media surfaces even when no filename or text agrees. Nothing about
  your files ever leaves the device; the model runs entirely in the
  browser, and search results merge with regular name and content
  matches under a "meaning" tag. A command palette action indexes the
  existing library in one sweep, reading only stored thumbnails for
  videos so no full video is ever re-downloaded.

## [0.24.2] - 2026-07-30

### Fixed
- Large videos play to the end: the media stream now decrypts at the
  player's pace instead of racing ahead, so memory stays flat no matter
  the file size, and an abandoned stream releases its download at once.
- The screen stays awake while uploads run, so a long transfer is not
  killed by the phone locking itself.

## [0.24.1] - 2026-07-30

### Fixed
- On phones, the tab bar no longer floats above the bottom edge after
  logging in with the keyboard open.
- Part uploads survive a brief block from edge protections with a single
  patient retry instead of failing the file.

## [0.24.0] - 2026-07-30

### Added
- Video and audio stream instead of downloading first. Media now uploads
  in a random-access encrypted format, and a service worker serves it to
  the player by byte range, decrypting only the pieces playback touches:
  videos start immediately and seeking anywhere is instant, with memory
  use bounded by a single chunk. Files stored before this release play
  progressively as they decrypt, with a visible progress readout, and
  regain instant seeking when re-uploaded.

### Fixed
- Uploads no longer stall on phones. Preparing a video's thumbnail could
  wait forever on mobile browsers and silently hold the entire upload;
  thumbnailing now follows mobile decoding requirements and every
  analysis step runs under a deadline, so uploads always proceed.
- Mid-size files upload within phone memory limits: the streaming part
  path now takes over at 12 MB, and a redundant in-memory copy of every
  upload is gone.

## [0.23.0] - 2026-07-29

### Added
- Unlock with a device passkey. After a one-time opt-in following login,
  reopening the app takes a single Touch ID, Face ID, or Windows Hello
  prompt instead of the full password. The vault key rests on this device
  only as ciphertext, wrapped under a key that solely the platform
  authenticator can release; a fresh password login renews the session
  window, signing out removes the enrollment, and the password path
  always remains.
- Large files upload reliably. Content over 64 MiB of ciphertext travels
  in resumable parts, so uploads pass through proxies with request-size
  limits, a network failure retries one part instead of restarting the
  file, and memory use during upload stays small and constant regardless
  of file size. On S3-compatible storage, parts stream through native
  multipart uploads.
- Scanned documents become searchable. PDFs without a text layer go
  through the same on-device text recognition as photos, page by page,
  when image reading is enabled; a "Read text in document" action covers
  already-stored scans, and the bulk sweep now includes them.

## [0.22.1] - 2026-07-29

### Fixed
- On narrow windows the details panel no longer covers the tab bar or gets
  buried under the navigation drawer. It now floats as a card above the tab
  bar, closes when the drawer opens, and dismisses on view changes.

## [0.22.0] - 2026-07-29

### Added
- The app is now usable end to end on a phone. A bottom tab bar carries
  the primary views (Files, Recent, Favorites) plus a center add button
  whose action sheet covers uploading files, taking a photo with the
  device camera, uploading a folder, and creating folders and notes. The
  full sidebar (categories, appearance, image text reading, usage, and
  account actions) opens as a drawer behind the More tab.
- File and folder actions are reachable on touch: a long-press or the new
  per-item actions button opens the menu, which renders as a bottom action
  sheet on phones. The details inspector, dialogs, and previews open as
  bottom sheets or full-screen views sized to the safe areas of notched
  devices.
- Touch ergonomics: larger tap targets on coarse pointers, inputs sized to
  avoid focus zoom on iOS, a denser two-column grid, and list columns
  trimmed to fit narrow screens.
- The browser theme color now follows the day and night setting.

### Changed
- Buttons across the app share a fixed control height with an explicit
  line height, crisper icon sizing, a visible keyboard focus ring, and a
  cleaner primary style: the label shadow and sheen gradient are gone in
  favor of a uniform accent fill with a crisp edge.

## [0.21.0] - 2026-07-29

### Changed
- `ENGRAMER_TRUSTED_PROXIES` replaces `ENGRAMER_TRUSTED_PROXY_HOPS`. It
  accepts a comma-separated allowlist of proxy addresses and CIDR ranges
  (preferred, since it keeps working when a proxy layer is added or
  removed) or a plain hop count. Forwarded client addresses are only
  believed when they were set by a listed proxy, so an arbitrary caller
  cannot spoof its address to the failure throttle. Unset means the
  server is directly exposed and forwarded headers are ignored.

## [0.20.0] - 2026-07-29

### Security
- A document can no longer carry script into the app. The .docx renderer
  places "alternative content" parts in a same-origin frame, which a
  document arriving from a stranger through a file request could use to
  reach the keys held in the page; the feature is now off.
- Two-factor enrolment can no longer be used to switch two-factor off. A
  session alone could previously call setup and silently clear an enabled
  second factor; that now requires the disable route and a current code.
- Password-hashing parameters have a hard floor on both sides. A hostile
  server could otherwise return trivial parameters before login, watch a
  cheap derivation, and attack the password offline; parameters below the
  OWASP minimum are refused, and local memory pressure now fails rather
  than silently recording weaker parameters forever.
- Share-link password attempts are throttled with the same escalating
  backoff as sign-in, and anonymous file-request uploads are bounded in
  both field size and rows in flight.
- Disabling an account now also stops its share links and file requests,
  not only its sessions.
- Recovery codes carry 128 bits of entropy instead of 40.
- Invite links carry their token in the URL fragment, so it never reaches
  a server log, and it is cleared from the address bar once read.
- `ENGRAMER_TRUSTED_PROXY_HOPS` makes the failure throttle see real client
  addresses behind a reverse proxy; without it every request shares the
  proxy's address, which turns a per-account throttle into a way for a
  stranger to lock someone out.
- Recent searches, which are plaintext, are cleared on sign-out.

## [0.19.0] - 2026-07-29

### Security
- Content Security Policy and companion headers on every response. The
  policy is deny-by-default and allows only what the app uses: no external
  origin is reachable, so even a compromised dependency cannot exfiltrate
  decrypted content, and `object-src` and `frame-ancestors` are closed.
  WebAssembly is permitted for on-device OCR but plain `eval` is not, and
  the client's inline theme script is allowed by hash computed from the
  served page at startup rather than by weakening the policy.
- The pre-login endpoint no longer reveals which emails have accounts. An
  unknown address receives a stable decoy key-derivation salt derived under
  the server's secret, indistinguishable from a real one, and the endpoint
  is now covered by the same failure throttle as sign-in.
- Cross-origin browser access is disabled by default (the client is served
  from the same origin); `ENGRAMER_CORS_ORIGINS` allows listing origins
  explicitly for deployments that need it.
- Validation failures no longer echo the expected payload shape.

## [0.18.0] - 2026-07-29

### Added
- Registration policy (`ENGRAMER_REGISTRATION`): `open` (default), `invite`
  (accounts require a single-use invite link), or `closed`. The sign-up form
  adapts to the server's policy automatically.
- Server administration. Administrators are declared by the operator through
  `ENGRAMER_ADMIN_EMAILS` (they may always register, which also bootstraps a
  fresh locked-down server) and get an admin panel: list accounts with usage
  and status, mint and revoke invite links, set per-user quota overrides,
  disable and re-enable accounts, and permanently delete an account with all
  of its stored data. Disabling cuts existing sessions immediately, not just
  future logins. There is deliberately no password reset: the server holds
  no key material, so the recovery key remains the only way back into an
  account.

## [0.17.0] - 2026-07-28

### Added
- PostgreSQL metadata backend (`ENGRAMER_DATABASE_URL`): metadata can live
  in a shared PostgreSQL database instead of embedded SQLite, the foundation
  for replicated deployments where server instances hold no local state.
  SQLite remains the default and the single-binary experience is unchanged.
  Every correctness mechanism carries over: the per-user change sequence,
  version snapshots and restores in real transactions, the atomic
  download-limit claim, and the append-only content invariants.
- The login-failure throttle now lives in the database, so every server
  instance enforces the same counters instead of each keeping its own.

### Changed
- Query audit for large libraries: added the missing indexes for folder
  tree recursion, per-folder file listings, share lookups by owner and by
  file, and file-request listings. Existing SQLite databases pick these up
  automatically on the next start.
- CI now runs the full product flow against a real PostgreSQL service on
  every push, alongside the SQLite suites.

## [0.16.0] - 2026-07-28

### Added
- Split blob destinations (`ENGRAMER_S3_DERIVED_BUCKET` and the
  `ENGRAMER_S3_DERIVED_*` family): thumbnails and search indexes can live on
  their own S3 backend, separate from the originals. Request-heavy tiny
  objects go to a fast unmetered store (for example a local MinIO) while the
  byte-heavy originals stay on cheap or rate-limited storage. Connection
  settings inherit from the primary so a second bucket on the same store is
  one variable; the derived backend gets its own request budget and never
  inherits the primary's. Enabling the split on an existing install needs no
  migration: pre-split derived blobs are served from the primary on first
  read and copied over on the way out, and deletes purge both locations.
- `ENGRAMER_BLOB_CACHE_DIR` points the disk hot tier at separate fast local
  storage, useful when the data directory lives on slower disks.
- `ENGRAMER_JWT_SECRET` supplies the session-signing secret from the
  environment, so replicated deployments can share one signing key instead
  of each generating a per-instance file.

## [0.15.0] - 2026-07-28

### Added
- Opt-in local hot tier for S3 backends (`ENGRAMER_BLOB_CACHE_BYTES`): the
  server keeps recently used thumbnails and search-index blobs on local disk
  and serves repeats without a round trip to the object store. Entries are
  written atomically, evicted least-recently-used within the configured
  budget, and durably invalidated on overwrite or delete, so a stale entry
  can never be served, even across a restart. Content blobs always stream
  from the object store.
- Opt-in request budget for rate-limited object stores
  (`ENGRAMER_S3_MAX_TPS`, `ENGRAMER_S3_MAX_CONCURRENT`): requests toward the
  S3 backend are paced first-in-first-out with no burst accumulation and
  capped in flight, enforced inside the S3 client so multipart upload parts
  and retries are budgeted too. A budget delays requests rather than
  rejecting them.

Both knobs are off by default; an unset variable means exactly the previous
behavior, and the filesystem backend is unaffected.

## [0.14.0] - 2026-07-27

### Added
- Instant boot from a per-account device cache. The client now persists the
  encrypted sync rows it receives in IndexedDB and hydrates the library from
  them on the next visit, so opening the vault renders in about a second even
  at 50,000 files; a single delta request (`sync?since=<cursor>`) then
  reconciles only what changed. The cached rows are the same ciphertext the
  server already stores, so the cache introduces no new key handling, and
  signing out deletes it.
- Offline reads: with the app shell served by the service worker and the
  library cached, the vault opens and browses even when the server is
  unreachable, shows a clear notice that it is displaying the device's copy,
  and recovers with a plain reload once connectivity returns.
- "Resync library" in the command palette rebuilds the device cache from a
  full sync, an escape hatch for a copy suspected stale.

### Changed
- Deletions now prune the device cache through sync tombstones, and cache
  writes are ordered by sequence number so concurrent tabs can never roll a
  row back to an older state.

## [0.13.0] - 2026-07-27

### Changed
- Search text moved out of the metadata rows into per-file encrypted index
  blobs. Sync payloads shrink to a few hundred bytes per file regardless of
  how much text a document or scan contains, which is the structural change
  that keeps first-load fast as libraries grow toward very large sizes. The
  client warms its search index on first search intent, fetching and
  decrypting index blobs a few at a time with a live "indexing n of m" hint,
  and existing libraries migrate to the new layout automatically in the
  background, no action needed. File-request uploads carry their index blob
  too, so received files stay searchable.

## [0.12.0] - 2026-07-27

### Added
- Folder uploads that keep their shape. Drop a nested folder (or use the new
  Folder button) and the whole tree is recreated: every path becomes the
  right folder, files land where they belong, and thousands of small files
  flow through a bounded parallel pipeline (four transfers at a time, the
  discipline mass-transfer tools converge on) with aggregate progress and
  automatic retry with backoff when the server throttles.
- Instant image grids. Uploads now embed a ~25-byte ThumbHash placeholder in
  the encrypted metadata, so grids paint a blurred stand-in immediately;
  real thumbnails load only as cards approach the viewport, through a small
  concurrency gate that never floods the server.
- Folders with thousands of items stay fluid: offscreen cards and rows skip
  rendering entirely (content-visibility), in the grid, the list, and search
  results alike.

## [0.11.0] - 2026-07-27

### Added
- Two-factor authentication with any authenticator app (RFC 6238 TOTP,
  implemented in-tree and pinned by the RFC's test vectors). Enrollment shows
  a QR code and manual key and requires a first valid code; login becomes two
  steps, and the account's key material is withheld until the second factor
  passes. Codes tolerate one step of clock drift and can never be replayed;
  ten one-time recovery codes are issued once and stored only as digests.
  The S3 bridge supports two-factor accounts via ENGRAM_TOTP. The design,
  including what a second factor can and cannot protect in an end-to-end
  encrypted system, is documented in docs/auth.md alongside the planned
  bring-your-own OpenID Connect single sign-on.
- Authentication endpoints now throttle failures per address and identity
  with exponential backoff and Retry-After, so password and code guessing
  gets slow fast without affecting anyone else.

### Fixed
- The interface no longer hangs on "Decrypting your library" when the first
  sync fails (server briefly unreachable, or a page restored from the
  browser's back/forward cache): it shows the error with a working retry,
  keeps the unlocked session, and a single undecryptable item can no longer
  block the rest of the library from loading.

## [0.10.0] - 2026-07-27

### Added
- Version history for every file. Saving new content, from the text editor,
  the Word editor, or a re-upload, keeps the previous content as a version
  instead of destroying it. The details panel lists each version with its
  date and size, offers a decrypted download of any version, and restores
  with one click; a restored file keeps its current name and tags while its
  content, size, and search text revert together. Restoring displaces the
  current content into history too, so a restore can always be undone.
  The server keeps the last 10 versions per file (`ENGRAMER_MAX_VERSIONS`),
  counts them against the storage quota, and purges them on permanent delete.
- The write path behind this is append-only: new content lands in a new blob
  before any pointer moves, inside a transaction that detects concurrent
  saves, so an interrupted or failed save can never corrupt a file. Design
  notes in docs/storage.md.

## [0.9.0] - 2026-07-27

### Added
- On-device OCR, opt-in from the sidebar. With "Read text in images" on, new
  screenshots, scans, and photos are read by tesseract.js as they upload, and
  the recognized text joins the encrypted metadata, making images fully
  searchable and improving auto-categorization (a photographed invoice files
  as a receipt). "Make images searchable" in the command palette sweeps the
  existing library with live progress, and any single image can be read from
  its context menu. The OCR worker, WebAssembly engine, and English model are
  all served from the app's own origin; no image, text, or request ever
  leaves the device.
- Search rebuilt around finding files you half-remember. Every term now
  matches names, tags, categories, folder names anywhere on the file's path,
  and extracted content, so typing a folder's name finds what's inside it.
  One-letter typos are forgiven, multi-word queries require every word,
  fresher files rank higher, and `before:`/`after:` date filters join the
  grammar along with type synonyms like `type:photo`.
- Search results redesigned: thumbnails, the folder path, category, date, and
  snippets with every match highlighted, in the top bar and the Cmd+K palette
  alike. Arrow keys move through results and Enter opens the preview.
  Focusing the empty search box offers recent searches and clickable
  operator hints.

## [0.8.0] - 2026-07-27

### Added
- Word documents, viewed and edited entirely in the browser. Opening a .docx
  renders it read-only with docx-preview; Edit opens it in SuperDoc, a
  browser-native OOXML editor licensed AGPL-3.0 like this project. Import and
  export both run on your device: saving exports a fresh .docx, re-encrypts it
  with the file's existing key, and replaces the blob, the same flow as text
  editing. The editor ships as a separate code chunk loaded only when a
  document is opened, its telemetry is disabled, and no request leaves the
  device. Design notes and the editor landscape in docs/editing.md.
- A regression test pinning that saving the same file twice never repeats an
  encryption nonce, hardening the editing path against the nonce-reuse class
  of failure documented in published analyses of other E2EE products.

### Security
- Stubbed out a build tool that SuperDoc lists as a runtime dependency, which
  dragged an unpatched brace-expansion into the tree (GHSA-mh99-v99m-4gvg).
  The browser bundle never imports it.

## [0.7.0] - 2026-07-26

### Added
- Password-protected share links. Setting a password wraps the file key under
  an Argon2id-derived key on your device; the server stores only the wrapped
  key and a verifier digest (the same scheme as login), so it can refuse
  visitors who do not know the password while remaining unable to decrypt
  anything itself. The public page prompts for the password and unwraps the
  key locally.
- Link expiry (1 hour to 30 days, or never) and download limits (including
  one-time links), both enforced server side with an atomic download counter.
- A Shared view in the sidebar listing every active link with its file, expiry,
  download count, and protection status, plus copy and revoke actions.
- File requests: create a link anyone can use to send files into your vault.
  The public page encrypts each file on the sender's device, including
  thumbnail and searchable metadata, and seals the file key to your public
  key; arrivals are unsealed, re-wrapped, and filed into the folder you chose
  automatically on your next sync. Requests support labels (kept out of the
  server's sight), destination folders, expiry, and closing at any time.
  Design notes in docs/sharing.md.

### Fixed
- The Share dialog opens again from the context menu, preview, and details
  panel; its mount was lost in the 0.4.0 interface rework.

## [0.6.0] - 2026-07-24

### Added
- Local S3 bridge (`apps/bridge`): a self-hostable, zero-knowledge S3 endpoint
  that runs inside your own trust boundary, unlocks the vault locally, and lets
  any S3 client (rclone, s3fs, the AWS SDK) browse and download your encrypted
  files, with each top-level folder presented as a bucket. It serves
  ListBuckets, ListObjectsV2 with prefix and delimiter, HeadObject, and ranged
  GetObject, verifying SigV4 against a locally generated credential. The Engram
  Store server still only ever holds ciphertext. Read path first; write support
  is planned. Design in docs/s3-gateway.md.

### Security
- Cleared three dependency advisories: bumped `@fastify/static` to 10.1.2 (route
  guard and non-canonical path authorization bypasses), and migrated the web
  client from the frozen `react-router-dom` 7 to `react-router` 8 (the RSC-mode
  CSRF advisory; the app is a client-side SPA, so the flaw did not apply, and the
  supported fix is the v8 package merge).

## [0.5.0] - 2026-07-22

Rebrand to Engram Store, with a themeable ocean design system.

### Changed
- New brand: the app is now Engram Store, with a shield-document logo, the
  "engram store" wordmark, and the tagline "Private, encrypted, yours." The app
  icons and the in-app brand mark are generated from the ocean logo.
- Redesigned around an ocean palette (deep navy ink, cool paper, an ocean-blue
  accent with a cyan highlight) in place of the previous warm theme, and the
  primary button gets a cleaner two-stop fill.
- Typography moves to Geist, with Geist Mono for keyboard hints, for a crisper,
  more premium feel.

### Added
- Day and night (light and dark) modes, remembered per device and initialised
  from the system preference, with a toggle in the sidebar.
- Accent themes drawn from the brand's gradient variants: Ocean, Aurora,
  Emerald, Violet, Sunset, and Midnight. Selecting one recolours the whole
  interface and the in-app logo together.

## [0.4.1] - 2026-07-21

### Changed
- App icon refined: richer brass, layered papers, sheen, and an embossed
  keyhole, with the same mark now used as the in-app brand on the sign-in
  screen and sidebar.
- Every file kind casts its own subtle color atmosphere behind its card art,
  and thumbnails ease into a gentle zoom on hover.
- Newly uploaded files greet you with a brass shimmer sweep.
- View titles are set in the display serif; the active sidebar item gains a
  brass indicator bar; primary buttons, the storage meter, and the details
  panel pick up gradient, glow, and slide-in refinements.
- Empty states show the folder illustration with clear next actions.

## [0.4.0] - 2026-07-21

### Added
- Details panel: a right-hand inspector with preview, metadata, actions, and
  inline tag editing, opened by selecting any file.
- Selection model: click to select, double-click to open, shift and
  Cmd/Ctrl-click for ranges, with a floating bulk bar for favorite, move, and
  trash across many files at once.
- Right-click context menus for files and folders, a Move dialog, and
  drag-and-drop of files onto folders and breadcrumbs.
- List view with sortable columns alongside the grid, plus sort controls and a
  per-user remembered layout.
- S3-compatible blob storage backend (`ENGRAMER_S3_*`): AWS S3, MinIO,
  Cloudflare R2, Garage, and Ceph RGW, with streaming multipart uploads and
  automatic bucket creation. Storage architecture and reliability recipes are
  documented in docs/storage.md.

### Changed
- New app icon: a brass vault dial.
- Keyboard focus outlines throughout, and animations respect
  `prefers-reduced-motion`.

## [0.3.0] - 2026-07-21

### Added
- In-app editor for text, Markdown, and code files: content decrypts in the
  browser and re-encrypts with the file's existing key on save (Cmd+S), with
  the search index refreshed from the new content in the same operation.
- Notes: create a Markdown note from the toolbar prompt or the command palette
  and start writing immediately.
- Document editing architecture documentation, including the end-to-end
  encrypted live-collaboration design (client-side CRDTs over an encrypted
  relay) and the reasoning for not integrating server-side office suites.

## [0.2.1] - 2026-07-20

### Fixed
- Password key derivation now uses libsodium's moderate Argon2id profile
  (256 MiB, 3 passes) instead of the sensitive profile (1 GiB). The larger
  allocation exhausted memory on mobile browsers and CI runners, so signup and
  unlock could fail outright on constrained devices. The moderate profile
  remains an order of magnitude above the OWASP floor, and signup and unlock
  are now substantially faster. Existing accounts are unaffected: each account
  stores the parameters it was created with and keeps using them.

### Added
- A test asserting the Argon2id parameters stay at or above the OWASP floor, so
  the cost cannot be weakened unnoticed.

## [0.2.0] - 2026-07-20

Intelligence and experience release. Everything below runs on the client; the
server still sees only ciphertext.

### Added
- Auto-categorization: uploads are analyzed on-device (type, name patterns,
  EXIF, dimensions, content keywords) and filed into category folders with
  auto-assigned tags such as capture year, camera make, screenshot, invoice,
  contract, and resume.
- Library: live category views in the sidebar (Photos, Screenshots, Documents,
  Receipts, and more) computed from encrypted tags.
- Full-text extraction from PDFs via pdf.js, joining text files in the
  encrypted search index.
- Command palette (Cmd+K) searching names, tags, and contents, with a query
  grammar of `tag:`, `type:`, `in:`, and `is:favorite` filters, plus actions.
- Favorites with an instant star toggle, editable tag chips, and a post-upload
  reveal showing where each file was filed and how it was tagged.
- Paste to upload: paste a screenshot or file anywhere in the app.
- Installable app (PWA): standalone window, home-screen and Dock icons, and an
  offline app shell.
- Docker image and Compose file for one-command self-hosting, published to the
  GitHub Container Registry by CI.
- Platform documentation covering current install options and the native
  desktop and mobile roadmap.

### Changed
- Card artwork is now illustrated: layered folders that open on hover and
  file-type sheets with per-kind accent colors, replacing text badges.
- Category views and the sidebar use per-category icons.

### Security
- The service worker precaches the application shell only. Encrypted blobs and
  API responses are deliberately never cached.

## [0.1.0] - 2026-07-19

Initial release.

### Added
- End-to-end encrypted file storage: XChaCha20-Poly1305 streaming encryption
  for content, per-file keys, Argon2id password key derivation, recovery keys.
- Zero-knowledge server: Fastify API with SQLite metadata and on-disk
  ciphertext blobs, per-user quotas enforced during streaming upload, and
  sequence-number delta sync.
- Web client: Drive-style file browser with nested encrypted folders,
  drag-and-drop uploads with progress, rename, move, trash, and restore.
- Client-side intelligence: fuzzy name search and full-text search over text
  extracted at upload time, encrypted thumbnails generated in the browser, and
  decrypted previews for images, video, audio, PDF, and text.
- Public share links with the decryption key in the URL fragment, revocable
  server-side.
- Test suite: crypto round-trip and tamper tests, plus API integration tests
  including a ciphertext-only-on-disk assertion.

Designed by Harsha Rahul
