# Scoring the on-device model

`run.sh` measures how well Apple's on-device model reads two synthetic sets
of messages and documents, per task, and writes
`apps/web/src/intel/eval/scores.json`:

- **The first set** (`apps/web/src/intel/eval/cases.ts`): the documents the
  rules and the model's instructions were written against.
- **The held-out set** (`apps/web/src/intel/eval/heldout.ts`): sixty documents
  written without sight of the readers. Nothing is ever tuned on it, and the
  run prints its totals only, never its cases one by one.

The app accepts a model reading without the owner's yes only for tasks whose
measured precision is at least 98% on both sets, over enough readings.

The harness is the app's own Swift shim (`apps/desktop/src-tauri/apple/Intel`,
linked into `Sources/EvalApple`, not copied) run from the command line, and
the requests are built by the app's own `summarize()`, at the window size the
model reports on this Mac, so what is measured is what ships. It needs a Mac
with Apple Intelligence on, and never runs in CI.

```
tools/eval/apple/run.sh
```

For each set the run reports two things: what the model alone offered (the
figures the app's trust rests on), and what the rules and the model give
together (what the owner is shown). Each reports dates and amounts found,
how many of those offered were right, and the noise: documents that state
nothing and still got an offer.

While working on the instructions, read the first set alone or a few of its
cases without writing scores, or check that a document is read the same way
twice:

```
EVAL_SET=first tools/eval/apple/run.sh
EVAL_ONLY=dentist,rent-reminder tools/eval/apple/run.sh
EVAL_TWICE=1 tools/eval/apple/run.sh
```

Each case is given what the app gives a reading: a message's subject, sender
and sending day, what the rules already found, and for a stored file the day
it was kept (the cases name none, so one fixed early day stands for all).

Every answer is kept in `out/` (not committed), one file per case, under the
name of the request it answered. After a change to the code around the model
(the merge, the rules that do not change what the model is asked, the
scoring), score the kept answers again in seconds, with no model:

```
EVAL_REPLAY=1 tools/eval/apple/run.sh
```

A request that changed since the kept run is stale: the replay says how many
cases need the model and writes no scores, so an answer to another request
is never counted.

Beside found and right, each set reports the questions a person would be
shown per 100 documents (counted the way the app asks them, on the day each
document reached its reader), how many of those are wrong, and what kind of
error each wrong reading is.

Run it again whenever a prompt, a schema, the model reader's version or a set
changes, and commit the new `scores.json`. Dates and amounts are judged at
temperature 0 and read the same way every time; the summary and the mail
kind are sampled with a little temperature and can move a few points between
runs. Each task records how many readings its figures rest on (`offered`),
and the app does not trust a precision measured over too few.
