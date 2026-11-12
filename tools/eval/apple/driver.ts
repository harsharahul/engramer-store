/**
 * Runs the app's own reading of each eval case through Apple's on-device
 * model and scores it. The request is built by the app's summarize() and
 * generate(), sent to the Swift harness instead of the Tauri bridge, so the
 * prompt, schema and grounding are exactly what ships. Writes the scores the
 * app reads to decide what may count without a yes.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generate, type AssistantTransport } from "../../../apps/web/src/intel/assistant";
import { CATEGORIES } from "../../../apps/web/src/intel/categorize";
import { EVAL_CASES } from "../../../apps/web/src/intel/eval/cases";
import { factCases, kindCases, scoreKinds, scoreReader, scoreRoles } from "../../../apps/web/src/intel/eval/score";
import { EMAIL_MIME } from "../../../apps/web/src/mail/kind";
import { MODEL_READER, READER_VERSION } from "../../../apps/web/src/intel/reading";
import { readingFingerprint, summarize } from "../../../apps/web/src/intel/summarize";

const [binary, out] = process.argv.slice(2);
if (!binary || !out) {
  throw new Error("usage: driver <harness binary> <scores.json>");
}

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
  available: async () => ({ state: "available", contextSize: 8192 }),
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

// EVAL_ONLY=id,id reads a part of the set. EVAL_TWICE=1 reads each case
// twice at temperature 0 and fails when the two answers differ: the same
// document must be read the same way every time.
const only = process.env["EVAL_ONLY"]?.split(",").filter(Boolean);
const chosen = only ? EVAL_CASES.filter((evalCase) => only.includes(evalCase.id)) : EVAL_CASES;
if (process.env["EVAL_TWICE"]) {
  let differing = 0;
  for (const evalCase of chosen) {
    const answers: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      reading = `${evalCase.id}.${run}`;
      await summarize(
        { text: evalCase.text, name: evalCase.name, categories: CATEGORIES, contextSize: 8192, withFacts: true, mail: evalCase.mime === EMAIL_MIME },
        (request) => generate({ ...request, temperature: 0 }, transport),
      ).catch(() => null);
      answers.push(canonical(raw.get(reading)));
    }
    const same = answers[0] === answers[1];
    differing += same ? 0 : 1;
    process.stdout.write(`${evalCase.id}: ${same ? "same" : `differs\n  1: ${answers[0]}\n  2: ${answers[1]}`}\n`);
  }
  harness.stdin.end();
  process.stdout.write(`\n${differing === 0 ? "every case was read the same way twice" : `${differing} of ${chosen.length} cases were read differently the second time`}\n`);
  process.exit(differing === 0 ? 0 : 1);
}

// Each case is read as the app reads it: mail that states its facts as data
// is asked its kind but not its dates; everything else is asked both.
const asked = new Set(factCases(EVAL_CASES).map((evalCase) => evalCase.id));
const readings = new Map<string, Awaited<ReturnType<typeof summarize>>>();
for (const evalCase of chosen) {
  const text = evalCase.text;
  const withFacts = asked.has(evalCase.id);
  reading = evalCase.id;
  try {
    const reading = await summarize(
      { text, name: evalCase.name, categories: CATEGORIES, contextSize: 8192, withFacts, mail: evalCase.mime === EMAIL_MIME },
      (request) => generate(request, transport),
    );
    readings.set(evalCase.id, reading);
    const facts = reading?.facts.map((f) => `${f.kind} ${f.value}${f.time ? ` ${f.time}` : ""}`).join(", ") || "(none)";
    process.stdout.write(`${evalCase.id}: ${facts} | kind ${reading?.mailKind ?? "-"} (want ${evalCase.mailKind ?? "-"})\n`);
  } catch (error) {
    readings.set(evalCase.id, null);
    process.stdout.write(`${evalCase.id}: failed ${JSON.stringify(error)}\n`);
  }
  writeFileSync(join(rawDir, `${evalCase.id}.json`), `${JSON.stringify(raw.get(evalCase.id) ?? [], null, 2)}\n`);
}
harness.stdin.end();
if (only) {
  // A part of the set says nothing about the whole: no scores are written.
  process.exit(0);
}

const read = async (evalCase: (typeof EVAL_CASES)[number]) => readings.get(evalCase.id)?.facts ?? [];
const counts = (score: Awaited<ReturnType<typeof scoreReader>>) => ({
  offered: score.perCase.reduce((sum, c) => sum + c.found + c.extra, 0),
  expected: score.perCase.reduce((sum, c) => sum + c.found + c.missed, 0),
});
const dates = await scoreReader(factCases(EVAL_CASES), read, "dates");
const amounts = await scoreReader(factCases(EVAL_CASES), read, "amounts");
const kinds = await scoreKinds(kindCases(EVAL_CASES), async (evalCase) => readings.get(evalCase.id)?.mailKind ?? null);
const roles = await scoreRoles(factCases(EVAL_CASES), read);
const scores = {
  reader: MODEL_READER,
  version: READER_VERSION[MODEL_READER],
  prompt: readingFingerprint(),
  measuredAt: new Date().toISOString().slice(0, 10),
  cases: EVAL_CASES.length,
  // How many readings each figure rests on: a precision over a handful of
  // readings says nothing, and the app requires a minimum before trusting it.
  tasks: {
    dates: { precision: dates.precision, recall: dates.recall, ...counts(dates) },
    amounts: { precision: amounts.precision, recall: amounts.recall, ...counts(amounts) },
    mailKind: kinds,
    // What each found date is (a check-in, a departure). Informational: a
    // model's date still waits for a yes, and the role rides with it.
    roles,
  },
};
writeFileSync(out, `${JSON.stringify(scores, null, 2)}\n`);
process.stdout.write(`\n${JSON.stringify(scores.tasks)}\n`);
for (const c of [...dates.perCase, ...amounts.perCase].filter((c) => c.missed || c.extra)) {
  process.stdout.write(`  ${c.id}: found ${c.found}, missed ${c.missed}, extra ${c.extra}\n`);
}
