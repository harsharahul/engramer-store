# Product principles

Engram Store is built against a short list of principles. Every change is
held to them; when a change and a principle disagree, the change is wrong
or the principle needs an explicit, recorded amendment.

## 1. It just works

The happy path needs zero instruction. Anything the system can do on its
own, it does: missing thumbnails fill themselves in, deferred analysis
catches up from whichever signed-in device is open, damaged reads heal
through bounded retries. Buttons and palette commands accelerate what
would happen anyway; they are never homework the user must remember.

## 2. Nothing happens invisibly

Background work that reads, downloads, or uploads data shows itself: a
progress pill while it runs, a state page (Profile's Library index) for
what remains, honest completion messages when it lands. Where work is
automatic, the user can see it, stop it, or tune it. Visibility without
control is surveillance of one's own app; control without visibility is
a hidden switch.

## 3. Security is the floor, not a feature

The server stores ciphertext and never sees plaintext, keys, or file
names. No feature ships if it weakens that, whatever it offers in
exchange. The reverse also holds: encryption is never the excuse for a
worse experience. When a capability seems impossible under end-to-end
encryption, the answer is a better client design, not a hole in the
model and not a missing feature.

## 4. Search finds it

Any word the user remembers should find the file: its name, the folder
it lives in, the text inside it, what a photo shows, a date it mentions.
Search results never contradict themselves: one merged list feeds the
count, the keyboard, and the rows, and a result that is shown is a
result that is counted and reachable.

## 5. Cohesive by construction

One mechanism per concept, reused everywhere. The remaining-work numbers
in Profile are computed by the same predicates the sweeps run, so what
is shown is exactly what will happen. New features join existing
mechanisms (encrypted metadata, the sync feed, derived blobs) rather
than growing parallel ones that drift.

## 6. Honest states

Counts, checkmarks, and the word "done" mean what they say. A reading
that ran and found nothing is recorded as finished, not left looking
pending. Failures are named, never silent, and never retried forever
without a record. Storing the wrong bytes is the one unforgivable bug;
byte counts are verified at ingest and digests recorded so later checks
have something to compare against.
