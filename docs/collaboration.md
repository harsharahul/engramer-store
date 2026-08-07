# Live collaboration

Two people can edit the same Word document or spreadsheet at once, and the
server that carries their changes cannot read a single one of them.

## How it works

Every document has a **channel**: an ordered, append-only log the server
keeps on its behalf. When you type, the editor produces a change, the page
seals it under the file key, and the sealed bytes go to the channel. The
server gives each frame a position, stores it, and broadcasts it to whoever
else is connected. It never opens one.

Each participant's page decrypts the frames it receives and hands them to
its editor, which merges them — the editing engine has always known how to
do this; what is new is that the messages travel sealed. Cursors and
presence ride the same channel as ephemeral frames that are broadcast and
never stored.

## Joining, leaving, and staying honest about order

A page joins by asking for a **ticket** over the ordinary authenticated
API. The ticket is single-use, expires in thirty seconds, and is checked
against the document's membership before the socket exists, so the
long-lived session token never appears in a URL.

Order is the database's decision, not any one page's: each durable frame
takes its position from a single-row atomic write, so two people typing at
the same moment cannot take the same place in the log. Reconnecting names
the last position seen and replays exactly what was missed.

Inside every sealed frame is the sender and a counter that only ever
climbs. A page applies a frame only if it comes from the connection the
server says it came from and continues that sender's run. A gap means
frames were lost or withheld, and the only safe answer is to reload the
document rather than apply changes out of order.

Locks fall out of the same order with no arbiter: the first claim since the
last release wins, and every page computes the same winner from the same
log.

## Saving, and what the log is for

The log is a tail between saves, not storage. Any participant's save is a
**snapshot**: it writes the whole document the normal way — re-encrypted,
verified by reading it back, stored as a new generation with its own entry
in version history — and the server then trims the log up to the point that
save covered. Frames that arrived after it survive and replay on top.

Only a save the server itself committed can trim the log. There is no
message a page can send to ask for it, because a page that could name the
position could discard other people's unsaved work.

A quiet room still converges: the participant with the lowest index (an
election every page computes identically) saves on its own after a spell of
silence or a long enough log.

## Roles

A **viewer** watches the document change in real time and can write
nothing: not a change, not a cursor, and not a snapshot. An **editor**
writes, and their bytes count against the owner's storage, since the file
is the owner's. Losing access closes any open connection immediately.

## When the channel is unavailable

If the relay is switched off (`ENGRAMER_COLLAB_RELAY=off`) or unreachable,
the editor says so and the document stays fully editable for one person at
a time: the server accepts one save and refuses the other, and whoever
loses the race chooses between reloading and keeping their work as their
own copy. Nothing is lost, and nothing silently overwrites.

## What the server learns

Which accounts connect to which document, when, and how many frames of what
size pass between them. Frame contents are ciphertext under a key it never
holds, and typing rhythm is visible as timing — inherent to any relay, and
stated here rather than hidden. Presence and cursors are never written
down; durable frames live only until the next save.

A malicious server can stall or withhold, which is denial of service; it
cannot forge a frame or reorder one sender's run undetectably, because the
sender and counter are inside the sealed bytes.

## Running it behind a proxy

The channel is a WebSocket at `/api/collab/…`. A proxy in front of the app
must forward `Upgrade` and `Connection` headers for that path and allow an
idle connection to live longer than 75 seconds. A deployment served over
plain HTTP works as it stands; one served over TLS needs the proxy to
terminate it as usual.
