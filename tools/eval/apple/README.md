# Scoring the on-device model

`run.sh` measures how well Apple's on-device model reads the synthetic eval
set (`apps/web/src/intel/eval/cases.ts`), per task, and writes
`apps/web/src/intel/eval/scores.json`. The app accepts a model reading
without the owner's yes only for tasks whose measured precision is at least
98%.

The harness is the app's own Swift shim (`apps/desktop/src-tauri/apple/Intel`,
linked into `Sources/EvalApple`, not copied) run from the command line, and
the requests are built by the app's own `summarize()`, so what is measured is
what ships. It needs a Mac with Apple Intelligence on, and never runs in CI.

```
tools/eval/apple/run.sh
```

Run it again whenever the prompt, the schema, the model reader's version or
the eval set changes, and commit the new `scores.json`. The model samples
with a little temperature, so figures move a few points between runs; each
task records how many readings its figures rest on (`offered`), and the app
does not trust a precision measured over too few.
