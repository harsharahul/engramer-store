# Information architecture

Every control and every state in Engram Store has one home. This document
names the surfaces the app is made of, what each one is for, when it is
allowed to speak, and how anything the device worked out on its own is
shown. New features are placed by these rules before they are built, and a
feature that cannot be found or reached is treated as not shipped.

The rules follow the [product principles](principles.md). Principle 1
(it just works) and principle 2 (nothing happens invisibly) decide most
placements; principle 5 (cohesive by construction) is why a capability
has one home and mirrors elsewhere, never two homes that drift.

## 1. Surfaces and their one job

| Surface | Job | What it holds | What it never holds |
|---|---|---|---|
| **Sidebar** | Places: where can I go | Fixed places (Files, Recent, Photos, Favorites, Shared, Trash). Attention places that exist only while they have something in them (Expiring soon, Calendar, Shared with me). Collections, user-made first (Albums, Trips), then derived (the Library categories). | Settings, switches, appearance, progress. |
| **Content area** | Things in the current place | The items of the place. For a place that owns collections, a shelf of those collections at the top, so the collections are content as well as navigation. Empty states with one next action. | Global controls. |
| **Search field and panel** | Find: one box for words, operators, sentences, and questions | When focused and empty: recent searches, chips that narrow a search, and one sentence saying what search reads. While typing: one merged list, with an "Interpreted as" line whenever the query was rewritten. For a question: an answer above the same list, with the files it came from as rows. | A second search anywhere in the app. |
| **Result lists** (search results, Ask sources, palette rows, notices) | Answers: open what was found | One click or Enter opens the item; a modifier click selects it for a batch action; right click or long press opens its menu. A result is an answer, not an icon on a desk, so the item grid's click-selects and double-click-opens convention does not apply here. | A click that only highlights. |
| **Command palette** | Do and jump, by keyboard | Actions and files. Every action is a mirror of a control that has a visible home somewhere else. | The only home of any capability. |
| **Toolbar and view bar** | This view: act on the current place and its display | New, Upload, Select, sort, layout, the details and sidebar toggles, the Activity button. | Account or device settings. |
| **Details pane** | About one thing | Every signal derived about the item, each in its own section with a line saying where it came from and a way to correct or remove it in place. Actions on the item. With nothing selected, a short invitation to select something; never a digest. | Library-wide controls, notices. |
| **Heads-up strip** | Decisions: things waiting for a yes or no, where waiting has a cost | Dates read from documents awaiting confirmation, proposed trips. Collapses to one line; dismissing is one click. | Information, progress, tips. |
| **Notice center** (the bell) | What the app wants to tell you: what needs attention, and what it is doing | Two sections. Needs attention: dates coming up, what the rules noticed, files stored twice, trips, each opening its file, each dismissable. Activity: every background pass with progress, a Stop button, and a log entry saying what it did. The badge counts unread notices and a running job. The same bell on the Mac and the phone. | Settings. Nothing else in the app shows a progress indicator or a digest. |
| **System notifications** | Reaching you when the app is not in front | Time-sensitive notices only: a date approaching or past, a trip proposed. One notification per fact, never repeated, opening the app on that notice. Permission is asked the first time there is something to say, never at launch. A Profile switch turns them off. | Information, progress, anything without a date. |
| **Profile** | Capabilities and settings | Preferences that follow the account to every device (the switches), as every decision does (principle 7). Per-device state with its honest reason when a capability is absent. What remains, as counts computed by the same predicates the passes run. Retry. | Places, items. |
| **Context menu and selection bar** | These items | Per-item and bulk actions, including on-demand readings of a file. | Navigation. |
| **Toasts** | Acknowledge and reveal | An outcome that created or moved something is a toast that opens the destination when clicked. A plain toast is used only for an outcome with nowhere to go. | Anything the user must act on. |
| **Phone** | The same jobs, in fewer columns | The tab bar holds the top places and Add; More is the sidebar; details is a sheet; the search field sits in the top bar as on the desktop. | A different feature set. |

## 2. When a surface speaks

Four modes. Each has a gate, and the gate is the reason the mode exists.

- **Implicit**, while the user types or looks. Allowed only when the
  work is free, finishes in under a second, is reversible, and is offered
  rather than imposed. A rewritten query is labelled and the literal query
  stays one click away. Something that looks exact (a file name, a
  reference number, a proper noun) is never rewritten.
- **Explicit**, from a control the user presses. Anything that costs
  seconds or reads a whole document on request. The control names what it
  will do.
- **Background**, automatic derived work. Always with all three of: an
  Activity job that can be stopped, a switch in Profile, and a count in
  Profile of what remains. Nothing runs that the user cannot see, stop,
  and turn off.
- **Decision**, in the heads-up strip. Only when delaying the answer has a
  cost, such as a date that will pass. Never for information.

Across all four: an unrequested result below confidence is held back
rather than shown as a guess, and a deterministic result is never replaced
by a computed one, only preceded by it.

## 3. How something the device worked out is shown

- One mark means "read by this device": the spark glyph already used for
  the Library and for finding connections between documents. No second
  mark is introduced for the same idea.
- Where it came from is stated in words, never as a percentage: "from the
  barcode", "read on this Mac from the opening pages", "proposed by the
  model and found in the text".
- Correcting or removing it happens in place, in one action, and the
  correction is remembered. A value the user confirmed is never rewritten
  by a later reading; one they dismissed does not come back.
- An interpreted input is shown beside its result and can be undone in
  one click.
- Absence is one sentence with the reason and the single next step:
  "Needs macOS 26 with Apple Intelligence on."
- Nothing a model produced reaches a surface until it has been checked:
  a query token against the search grammar, a date against the document
  text it claims to come from, a stored line against its length and
  masking rules.

## 4. Sidebar rules

The sidebar is the surface most likely to hide what it holds, because it
scrolls, collapses, and narrows to a rail. These rules keep every place
reachable.

1. **Nothing has zero footprint.** When the sidebar is a rail, each group
   is an icon that opens its rows on hover or click. A group is never
   hidden outright.
2. **A group the user just added to opens.** Creating an album or adding
   to one expands the Albums group whatever its remembered state, scrolls
   the row into view, and highlights it briefly.
3. **User-made collections come first and order by recency.** Pinned
   items lead, then the most recently changed, then the rest by title.
   Derived collections order by count. A collapsed group shows its count
   in its header.
4. **The sidebar holds no settings.** Switches, appearance, and
   preferences live in Profile. What stays at the foot of the sidebar is
   state: storage used, the version, the account.
5. **At most two levels.** Groups are the first level and their rows the
   second. Deeper hierarchies live in the content area.
6. **A collection that is a place is also content.** Photos shows an
   albums shelf, so albums are reachable without the sidebar at all.

## 5. Platform layout

The same jobs, placed per platform. Benchmarks: the Finder and Files
sidebars, Photos on macOS 26 (pinned collections in a floating sidebar),
Files and Photos on iOS 26 (a floating tab bar with a search tab).

- **Mac, window 900 px and wider.** A source-list sidebar with three
  groups in this order: Places (Files, Recent, Photos, Favorites, Shared,
  Trash, and the attention places while they hold something), Albums
  (user-made collections: pinned first, then most recently changed, then
  by title), Library (derived categories, by count). Two levels, never
  three. A collapsed group header shows its count. The toolbar holds this
  view's actions (New, Upload, Select, sort, layout, the details and
  sidebar toggles, Notices). The sidebar foot holds state only: storage
  used, the version, the account row; every switch lives in Profile.
  In rail mode each group header keeps its icon, so no group ever has
  zero footprint, and resting the pointer on the rail brings the full
  sidebar back.
- **iPad and wide phone, 700 px and wider.** The Mac layout with the
  sidebar as a drawer that starts open.
- **iPhone.** Five tabs, the iOS 26 shape: Files, Photos, Search,
  Notices, More. Tabs are places, never actions, so Add is the plus in
  the top bar as in Files and Photos. Search is a tab because finding is
  a primary job here, the convention Photos, Files and the App Store
  follow. Notices is a tab so the bell has the same footprint on the
  phone as on the Mac. More is the sidebar as a list: Recent, Favorites,
  Shared, Trash, Albums, Library, Profile.
- **Collections are content too.** The Photos place carries an albums
  shelf above the months, so an album is reachable without the sidebar
  at all, on the Mac and on the phone alike.
- **One icon per concept**, identical on the Mac and the phone, drawn
  from the existing glyph set; a pinned collection is marked by a pin
  label, never by a second album icon.

## 6. Placing a new feature

A plan for a new capability answers these before any code is written:

1. Which surface owns each of its controls and each of its states
   (section 1), and which surfaces mirror them.
2. Which mode it speaks in and the gate it passes (section 2).
3. How its output is labelled, corrected, and reversed (section 3).
4. Which existing surface it joins, and whether that surface has a
   reachability defect to fix first (section 4).
5. Which established products place the same thing where, cited.

Two examples of the rules at work:

- **Dates read from documents.** The reading is background work, so it
  has an Activity job, a Profile switch, and a Profile count. A date is a
  decision, so it appears in the heads-up strip with confirm and dismiss,
  and on the file in the details pane with its source named. Once
  confirmed it becomes a notice in the bell as it approaches, a system
  notification when the app is not in front, and a place: Expiring soon
  and Calendar appear in the sidebar only while they hold something.
- **Albums.** An album is a user-made collection, so it sits in the
  first sidebar group, opens and reveals itself when created, orders by
  recency, and is also a shelf in Photos. Adding to an album shows a toast
  that opens the album.

## Sources

The guidance these rules draw on:

- Apple. *Human Interface Guidelines: Sidebars.* At most two levels of
  hierarchy; let people hide the sidebar with the interactions they
  already know. https://developer.apple.com/design/human-interface-guidelines/sidebars
- Apple. *Human Interface Guidelines: Machine Learning.* Explicit and
  implicit inputs; calibrate confidence in the user's terms; state
  limitations before they surprise; make mistakes cheap to undo.
  https://developer.apple.com/design/human-interface-guidelines/machine-learning
- Google PAIR. *People + AI Guidebook.* Mental models, explainability and
  trust, feedback and control, graceful failure.
  https://pair.withgoogle.com/guidebook/
- Amershi et al. "Guidelines for Human-AI Interaction." CHI 2019.
  Guidelines 1, 2, 3, 8, 9, 10, 11, 17, 18 in particular.
  https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/
- Nielsen Norman Group. "Visibility of System Status"; "Accordions on
  Desktop: When and How to Use"; "Explainable AI in Chat Interfaces";
  "AI: First New UI Paradigm in 60 Years."
  https://www.nngroup.com/
- Apple Support. "Browse your photo collections on Mac." The Pinned
  section and collapsible Albums group in Photos.
  https://support.apple.com/guide/photos/browse-photo-collections-phtf6b8c37c3/mac
