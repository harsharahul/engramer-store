/**
 * Runs the app's own reading of each eval case through Apple's on-device
 * model and scores it. The requests are built by the app's summarize() and
 * generate(), sent to the Swift harness instead of the Tauri bridge, so the
 * prompts, schemas and checks are exactly what ships, at the window size
 * the model reports on this Mac. Two sets are read: the first, which the
 * instructions were written against, and the held-out set, which nothing is
 * ever tuned on and whose cases are never printed one by one. Writes the
 * scores the app reads to decide what may count without a yes.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generate, type AssistantTransport } from "../../../apps/web/src/intel/assistant";
import { CATEGORIES } from "../../../apps/web/src/intel/categorize";
import { EVAL_CASES } from "../../../apps/web/src/intel/eval/cases";
import { HELDOUT_CASES } from "../../../apps/web/src/intel/eval/heldout";
import { factCases, kindCases, measure, scoreKinds, type EvalCase, type SetFigures } from "../../../apps/web/src/intel/eval/score";
import { mergeFacts, type Fact } from "../../../apps/web/src/intel/facts";
import { EMAIL_MIME } from "../../../apps/web/src/mail/kind";
import { MODEL_READER, READER_VERSION } from "../../../apps/web/src/intel/reading";
import { scanForFacts } from "../../../apps/web/src/intel/scan";
import { messageOf, readingFingerprint, summarize, type SummaryInput } from "../../../apps/web/src/intel/summarize";

const [binary, out] = process.argv.slice(2);
if (!binary || !out) {
  throw new Error("usage: driver <harness binary> <scores.json>");
}

// The window the model reports here is the one the app reads with.
const reported = JSON.parse(spawnSync(binary, ["--availability"], { encoding: "utf8" }).stdout) as {
  state?: string;
  contextSize?: number;
  reason?: string;
};
if (reported.state !== "available" || !reported.contextSize) {
  throw new Error(`the on-device model is not available here: ${reported.reason ?? "no reason given"}`);
}
const contextSize = reported.contextSize;

const harness = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: harness.stdout });
const waiting: ((line: string) => void)[] = [];
lines.on("line", (line) => waiting.shift()?.(line));

// Every raw answer is kept beside the harness, one file per case, so a
// wrong reading can be looked at as the model gave it. Not committed.
const rawDir = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(rawDir, { recursive: true });
const raw = new Map<string, unknown[]>();
let reading = "";

const transport: AssistantTransport = {
  available: async () => ({ state: "available", contextSize }),
  generate: (request) =>
    new Promise((resolve, reject) => {
      waiting.push((line) => {
        const answer = JSON.parse(line) as { ok?: unknown; error?: string; detail?: string };
        raw.set(reading, [...(raw.get(reading) ?? []), "ok" in answer ? answer.ok : { error: answer.error }]);
        if ("ok" in answer) {
          resolve(answer.ok);
        } else {
          reject({ code: answer.error, detail: answer.detail ?? "" });
        }
      });
      harness.stdin.write(`${JSON.stringify(request)}\n`);
    }),
  cancel: async () => {},
  listen: async () => () => {},
};

/** An answer with its keys in one order: the shim hands objects back in no fixed order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    held && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(Object.entries(held as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : held,
  );
}

const SETS = [
  { key: "first", title: "the first set", cases: EVAL_CASES, quiet: false },
  // Never printed case by case: a case that is looked at is a case that gets tuned on.
  { key: "heldout", title: "the held-out set", cases: HELDOUT_CASES, quiet: true },
] as const;
const everyCase = SETS.flatMap((set) => set.cases.map((evalCase) => ({ evalCase, quiet: set.quiet })));

/** A case as the app's reading pass is given it: a message carries its headers. */
function inputOf(evalCase: EvalCase, withFacts: boolean): SummaryInput {
  const mail = evalCase.mime === EMAIL_MIME;
  const message = mail
    ? messageOf({ subject: evalCase.name.replace(/\.email$/, ""), from: evalCase.from ?? "", date: evalCase.writtenAt ?? 0 })
    : undefined;
  return { text: evalCase.text, name: evalCase.name, categories: CATEGORIES, contextSize, withFacts, mail, ...(message ? { message } : {}) };
}

// EVAL_ONLY=id,id reads a part of the sets. EVAL_TWICE=1 reads each case
// twice at temperature 0 and fails when the two answers differ: the same
// document must be read the same way every time.
const only = process.env["EVAL_ONLY"]?.split(",").filter(Boolean);
const chosen = only ? everyCase.filter(({ evalCase }) => only.includes(evalCase.id)) : everyCase;
if (process.env["EVAL_TWICE"]) {
  let differing = 0;
  for (const { evalCase, quiet } of chosen) {
    const answers: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      reading = `${evalCase.id}.${run}`;
      await summarize(inputOf(evalCase, true), (request) => generate({ ...request, temperature: 0 }, transport)).catch(() => null);
      answers.push(canonical(raw.get(reading)));
    }
    const same = answers[0] === answers[1];
    differing += same ? 0 : 1;
    if (!quiet) {
      process.stdout.write(`${evalCase.id}: ${same ? "same" : `differs\n  1: ${answers[0]}\n  2: ${answers[1]}`}\n`);
    }
  }
  harness.stdin.end();
  process.stdout.write(`\n${differing === 0 ? `every one of ${chosen.length} cases was read the same way twice` : `${differing} of ${chosen.length} cases were read differently the second time`}\n`);
  process.exit(differing === 0 ? 0 : 1);
}

// Each case is read as the app reads it: mail that states its facts as data
// is asked its kind but not its dates; everything else is asked both.
const asked = new Set(SETS.flatMap((set) => factCases(set.cases)).map((evalCase) => evalCase.id));
const readings = new Map<string, Awaited<ReturnType<typeof summarize>>>();
for (const { evalCase, quiet } of chosen) {
  reading = evalCase.id;
  let line: string;
  try {
    const answer = await summarize(inputOf(evalCase, asked.has(evalCase.id)), (request) => generate(request, transport));
    readings.set(evalCase.id, answer);
    const facts = answer?.facts.map((f) => `${f.kind} ${f.value}${f.time ? ` ${f.time}` : ""}`).join(", ") || "(none)";
    line = `${evalCase.id}: ${facts} | kind ${answer?.mailKind ?? "-"} (want ${evalCase.mailKind ?? "-"})`;
  } catch (error) {
    readings.set(evalCase.id, null);
    line = `${evalCase.id}: failed ${JSON.stringify(error)}`;
  }
  if (!quiet) {
    process.stdout.write(`${line}\n`);
  }
  writeFileSync(join(rawDir, `${evalCase.id}.json`), `${JSON.stringify(raw.get(evalCase.id) ?? [], null, 2)}\n`);
}
harness.stdin.end();
if (only) {
  // A part of the sets says nothing about the whole: no scores are written.
  process.exit(0);
}

// The model's own readings, and what the owner is shown: the rules' readings
// and the model's together, as the app joins them.
const judged = async (evalCase: EvalCase): Promise<Fact[]> => readings.get(evalCase.id)?.facts ?? [];
const shown = async (evalCase: EvalCase): Promise<Fact[]> => {
  const scanned = await scanForFacts({
    name: evalCase.name,
    mime: evalCase.mime,
    text: evalCase.text,
    ...(evalCase.raw ? { raw: evalCase.raw } : {}),
    ...(evalCase.writtenAt !== undefined ? { writtenAt: evalCase.writtenAt } : {}),
  });
  return mergeFacts(scanned.facts, (await judged(evalCase)).map((fact) => ({ ...fact, reader: MODEL_READER })));
};

const stored = ({ wrong: _wrong, ...figures }: SetFigures) => figures;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const report = (title: string, figures: SetFigures, documents: number) =>
  `${title}: dates found ${percent(figures.dates.recall)} (${figures.dates.expected} stated), right ${percent(figures.dates.precision)} of ${figures.dates.offered} offered; ` +
  `amounts found ${percent(figures.amounts.recall)} (${figures.amounts.expected} stated), right ${percent(figures.amounts.precision)} of ${figures.amounts.offered} offered; ` +
  `noise ${figures.noise.loud} of ${figures.noise.cases} empty documents; ` +
  `${documents - figures.wrong.length} of ${documents} documents read with nothing missed and nothing added`;

const measured: Record<string, { cases: number; tasks: ReturnType<typeof stored> & { mailKind: Awaited<ReturnType<typeof scoreKinds>> } }> = {};
for (const set of SETS) {
  const model = await measure(set.cases, judged);
  const whole = await measure(set.cases, shown);
  const kinds = await scoreKinds(kindCases(set.cases), async (evalCase) => readings.get(evalCase.id)?.mailKind ?? null);
  measured[set.key] = { cases: set.cases.length, tasks: { ...stored(model), mailKind: kinds } };
  const documents = factCases(set.cases).length;
  process.stdout.write(`\n${report(`${set.title}, the model alone`, model, documents)}\n`);
  process.stdout.write(`${report(`${set.title}, rules and model together`, whole, documents)}\n`);
  process.stdout.write(`${set.title}, mail kind: right ${percent(kinds.accuracy)} of ${kinds.cases}\n`);
  if (!set.quiet) {
    for (const c of model.wrong) {
      process.stdout.write(`  ${c.id}: found ${c.found}, missed ${c.missed}, extra ${c.extra}\n`);
    }
  }
}

const scores = {
  reader: MODEL_READER,
  version: READER_VERSION[MODEL_READER],
  prompt: readingFingerprint(),
  measuredAt: new Date().toISOString().slice(0, 10),
  contextSize,
  cases: measured["first"]!.cases,
  // Each figure carries the readings it rests on: a precision over a handful
  // says nothing, and the app requires a minimum before trusting it.
  tasks: measured["first"]!.tasks,
  // The same tasks on documents nothing was tuned on. A model reading counts
  // without a yes only where both sets clear the bar.
  heldout: measured["heldout"]!,
};
writeFileSync(out, `${JSON.stringify(scores, null, 2)}\n`);
