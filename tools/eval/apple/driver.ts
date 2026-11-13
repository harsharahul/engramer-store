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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generate, type AssistantTransport, type GenerateRequest } from "../../../apps/web/src/intel/assistant";
import { CATEGORIES } from "../../../apps/web/src/intel/categorize";
import { EVAL_CASES } from "../../../apps/web/src/intel/eval/cases";
import { HELDOUT_CASES } from "../../../apps/web/src/intel/eval/heldout";
import { hashRequest, replayRunner, StaleAnswer, type SavedAnswer } from "../../../apps/web/src/intel/eval/replay";
import { errorsByClass, factCases, kindCases, measure, scoreKinds, type EvalCase, type SetFigures } from "../../../apps/web/src/intel/eval/score";
import { mergeFacts, type Fact } from "../../../apps/web/src/intel/facts";
import { EMAIL_MIME } from "../../../apps/web/src/mail/kind";
import { MODEL_READER, READER_VERSION } from "../../../apps/web/src/intel/reading";
import { scanForFacts } from "../../../apps/web/src/intel/scan";
import { FactsOwed, messageOf, readingFingerprint, summarize, type SummaryInput } from "../../../apps/web/src/intel/summarize";

const [binary, out] = process.argv.slice(2);
if (!binary || !out) {
  throw new Error("usage: driver <harness binary> <scores.json>");
}

// Every answer is kept beside the harness, one file per case, under the name
// of the request it answered: a wrong reading can be looked at as the model
// gave it, and EVAL_REPLAY=1 scores the kept answers again without the
// model. A request that changed since is stale and needs the model. Not
// committed.
const replay = Boolean(process.env["EVAL_REPLAY"]);
const rawDir = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(rawDir, { recursive: true });
const runFile = join(rawDir, "_run.json");

// The window the model reports here is the one the app reads with.
let contextSize: number;
if (replay) {
  if (!existsSync(runFile)) {
    process.stderr.write("No kept run here. Run once without EVAL_REPLAY, with the model.\n");
    process.exit(2);
  }
  contextSize = (JSON.parse(readFileSync(runFile, "utf8")) as { contextSize: number }).contextSize;
} else {
  const reported = JSON.parse(spawnSync(binary, ["--availability"], { encoding: "utf8" }).stdout) as {
    state?: string;
    contextSize?: number;
    reason?: string;
  };
  if (reported.state !== "available" || !reported.contextSize) {
    throw new Error(`the on-device model is not available here: ${reported.reason ?? "no reason given"}`);
  }
  contextSize = reported.contextSize;
  writeFileSync(runFile, `${JSON.stringify({ contextSize })}\n`);
}

const harness = replay ? null : spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
const waiting: ((line: string) => void)[] = [];
if (harness) {
  createInterface({ input: harness.stdout }).on("line", (line) => waiting.shift()?.(line));
}

const transport: AssistantTransport = {
  available: async () => ({ state: "available", contextSize }),
  generate: (request) =>
    new Promise((resolve, reject) => {
      waiting.push((line) => {
        const answer = JSON.parse(line) as { ok?: unknown; error?: string; detail?: string };
        if ("ok" in answer) {
          resolve(answer.ok);
        } else {
          reject({ code: answer.error, detail: answer.detail ?? "" });
        }
      });
      harness!.stdin.write(`${JSON.stringify(request)}\n`);
    }),
  cancel: async () => {},
  listen: async () => () => {},
};

type Runner = (request: GenerateRequest) => Promise<unknown>;
const kept = new Map<string, SavedAnswer[]>();
const keptFile = (id: string) => join(rawDir, `${id}.json`);

/** The model, with each answer kept under the name of its request. */
function recording(id: string, change: (request: GenerateRequest) => GenerateRequest = (request) => request): Runner {
  return async (asked) => {
    const request = change(asked);
    const name = hashRequest(request);
    const held = kept.get(id) ?? [];
    kept.set(id, held);
    try {
      const answer = await generate(request, transport);
      held.push({ request: name, answer });
      return answer;
    } catch (error) {
      held.push({ request: name, error: (error as { code?: string }).code ?? "other" });
      throw error;
    }
  };
}

/** The runner for one case: the model, or the answers kept for it. */
function runnerFor(id: string): Runner {
  if (!replay) {
    return recording(id);
  }
  const saved = existsSync(keptFile(id)) ? (JSON.parse(readFileSync(keptFile(id), "utf8")) as SavedAnswer[]) : [];
  return replayRunner(Array.isArray(saved) ? saved : []);
}

/** Whether a reading failed only because no kept answer belongs to its request. */
const isStale = (error: unknown): boolean => error instanceof StaleAnswer || (error instanceof FactsOwed && error.cause instanceof StaleAnswer);

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
// EVAL_SET=first reads one set and writes no scores: the way to work on the
// instructions without touching the held-out set.
const oneSet = process.env["EVAL_SET"];
const sets = oneSet ? SETS.filter((set) => set.key === oneSet) : SETS;
if (sets.length === 0) {
  throw new Error(`EVAL_SET names no set: ${oneSet}`);
}
const everyCase = sets.flatMap((set) => set.cases.map((evalCase) => ({ evalCase, quiet: set.quiet })));

// A stored file has a day it was kept, and the app reads it from that day. The
// cases name none, so every file is taken as kept on the day of the earliest
// message in the sets: early enough that no date a case expects lies behind it.
const KEPT = Date.UTC(2026, 10, 9, 12);

/** What the app's rules and exact readers find in a case, before any model is asked. */
const scans = new Map<string, Fact[]>();
async function scanned(evalCase: EvalCase): Promise<Fact[]> {
  const held = scans.get(evalCase.id);
  if (held) {
    return held;
  }
  const { facts } = await scanForFacts({
    name: evalCase.name,
    mime: evalCase.mime,
    text: evalCase.text,
    ...(evalCase.raw ? { raw: evalCase.raw } : {}),
    ...(evalCase.writtenAt !== undefined ? { writtenAt: evalCase.writtenAt } : {}),
  });
  scans.set(evalCase.id, facts);
  return facts;
}

/**
 * A case as the app's reading pass is given it: a message carries its
 * headers, a stored file the day it was kept, and both what the rules
 * already read, so the model is asked only about the rest.
 */
async function inputOf(evalCase: EvalCase, withFacts: boolean): Promise<SummaryInput> {
  const mail = evalCase.mime === EMAIL_MIME;
  const message = mail
    ? messageOf({ subject: evalCase.name.replace(/\.email$/, ""), from: evalCase.from ?? "", date: evalCase.writtenAt ?? 0 })
    : undefined;
  return {
    text: evalCase.text,
    name: evalCase.name,
    categories: CATEGORIES,
    contextSize,
    withFacts,
    mail,
    ...(message ? { message } : {}),
    ...(mail ? {} : { keptAt: KEPT }),
    known: await scanned(evalCase),
  };
}

// EVAL_ONLY=id,id reads a part of the sets. EVAL_TWICE=1 reads each case
// twice at temperature 0 and fails when the two answers differ: the same
// document must be read the same way every time.
const only = process.env["EVAL_ONLY"]?.split(",").filter(Boolean);
const chosen = only ? everyCase.filter(({ evalCase }) => only.includes(evalCase.id)) : everyCase;
if (process.env["EVAL_TWICE"]) {
  if (replay) {
    throw new Error("EVAL_TWICE asks the model twice; it cannot run from kept answers");
  }
  let differing = 0;
  for (const { evalCase, quiet } of chosen) {
    const answers: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const reading = `${evalCase.id}.${run}`;
      await summarize(await inputOf(evalCase, true), recording(reading, (request) => ({ ...request, temperature: 0 }))).catch(() => null);
      answers.push(canonical((kept.get(reading) ?? []).map((held) => held.answer ?? { error: held.error })));
    }
    const same = answers[0] === answers[1];
    differing += same ? 0 : 1;
    if (!quiet) {
      process.stdout.write(`${evalCase.id}: ${same ? "same" : `differs\n  1: ${answers[0]}\n  2: ${answers[1]}`}\n`);
    }
  }
  harness?.stdin.end();
  process.stdout.write(`\n${differing === 0 ? `every one of ${chosen.length} cases was read the same way twice` : `${differing} of ${chosen.length} cases were read differently the second time`}\n`);
  process.exit(differing === 0 ? 0 : 1);
}

// Each case is read as the app reads it: mail that states its facts as data
// is asked its kind but not its dates; everything else is asked both.
const asked = new Set(sets.flatMap((set) => factCases(set.cases)).map((evalCase) => evalCase.id));
const readings = new Map<string, Awaited<ReturnType<typeof summarize>>>();
let stale = 0;
for (const { evalCase, quiet } of chosen) {
  let line: string;
  try {
    const answer = await summarize(await inputOf(evalCase, asked.has(evalCase.id)), runnerFor(evalCase.id));
    readings.set(evalCase.id, answer);
    const facts = answer?.facts.map((f) => `${f.kind} ${f.value}${f.time ? ` ${f.time}` : ""}`).join(", ") || "(none)";
    line = `${evalCase.id}: ${facts} | kind ${answer?.mailKind ?? "-"} (want ${evalCase.mailKind ?? "-"})`;
  } catch (error) {
    readings.set(evalCase.id, null);
    stale += isStale(error) ? 1 : 0;
    line = `${evalCase.id}: ${isStale(error) ? "no kept answer for this request" : `failed ${JSON.stringify(error)}`}`;
  }
  if (!quiet) {
    process.stdout.write(`${line}\n`);
  }
  if (!replay) {
    writeFileSync(keptFile(evalCase.id), `${JSON.stringify(kept.get(evalCase.id) ?? [], null, 2)}\n`);
  }
}
harness?.stdin.end();
if (stale > 0) {
  // An answer to another request says nothing about this one: no scores.
  process.stdout.write(`\n${stale} of ${chosen.length} cases need the model: their request changed since the kept run. Run without EVAL_REPLAY.\n`);
  process.exit(2);
}
if (only) {
  // A part of the sets says nothing about the whole: no scores are written.
  process.exit(0);
}

// The model's own readings, and what the owner is shown: the rules' readings
// and the model's together, as the app joins them. An amount no reader named
// (the weakest harvest, listed in a file's details and never on the
// Timeline) is not a reading of what the document is about, and is left out.
const judged = async (evalCase: EvalCase): Promise<Fact[]> => readings.get(evalCase.id)?.facts ?? [];
const shown = async (evalCase: EvalCase): Promise<Fact[]> => {
  const joined = mergeFacts(await scanned(evalCase), (await judged(evalCase)).map((fact) => ({ ...fact, reader: MODEL_READER })));
  return joined.filter((fact) => !(fact.kind === "amount" && fact.source === "pattern"));
};

const stored = ({ wrong: _wrong, ...figures }: SetFigures) => figures;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const report = (title: string, figures: SetFigures, documents: number) =>
  `${title}: dates found ${percent(figures.dates.recall)} (${figures.dates.expected} stated), right ${percent(figures.dates.precision)} of ${figures.dates.offered} offered; ` +
  `amounts found ${percent(figures.amounts.recall)} (${figures.amounts.expected} stated), right ${percent(figures.amounts.precision)} of ${figures.amounts.offered} offered; ` +
  `noise ${figures.noise.loud} of ${figures.noise.cases} empty documents; ` +
  `${documents - figures.wrong.length} of ${documents} documents read with nothing missed and nothing added`;
/** The day a document reached its reader: a message's sending day, a file's kept day. */
const dayOf = (evalCase: EvalCase) => evalCase.writtenAt ?? KEPT;
const questions = (title: string, figures: SetFigures) =>
  `${title}: questions shown per 100 documents ${figures.asked.askedPer100} ` +
  `(${figures.asked.asked} in ${figures.asked.documents}); wrong ${figures.asked.wrongPer100} per 100 (${figures.asked.wrong}); ` +
  `a named-only line on a day that matters ${figures.asked.untyped}`;

interface SetScores {
  cases: number;
  /** The model's own readings: what the app's trust rests on. */
  tasks: ReturnType<typeof stored> & { mailKind: Awaited<ReturnType<typeof scoreKinds>> };
  /** The rules' readings and the model's together: what the owner is shown. Not read by the app. */
  together: ReturnType<typeof stored> & { documents: number; readWhole: number };
}
const measured: Record<string, SetScores> = {};
for (const set of sets) {
  const model = await measure(set.cases, judged, dayOf);
  const whole = await measure(set.cases, shown, dayOf);
  const kinds = await scoreKinds(kindCases(set.cases), async (evalCase) => readings.get(evalCase.id)?.mailKind ?? null);
  const documents = factCases(set.cases).length;
  measured[set.key] = {
    cases: set.cases.length,
    tasks: { ...stored(model), mailKind: kinds },
    together: { ...stored(whole), documents, readWhole: documents - whole.wrong.length },
  };
  process.stdout.write(`\n${report(`${set.title}, the model alone`, model, documents)}\n`);
  process.stdout.write(`${report(`${set.title}, rules and model together`, whole, documents)}\n`);
  process.stdout.write(`${questions(set.title, whole)}\n`);
  // Where the errors are, so the work goes there. The held-out set gives the counts only.
  const classes = Object.entries(await errorsByClass(factCases(set.cases), shown));
  process.stdout.write(`${set.title}, errors by kind: ${classes.map(([name, entry]) => `${name} ${entry.count}`).join("; ")}\n`);
  if (!set.quiet) {
    for (const [name, entry] of classes.filter(([, held]) => held.count > 0)) {
      process.stdout.write(`    ${name}: ${entry.cases.join(", ")}\n`);
    }
  }
  process.stdout.write(`${set.title}, mail kind: right ${percent(kinds.accuracy)} of ${kinds.cases}\n`);
  if (!set.quiet) {
    for (const [title, wrong] of [["the model alone", model.wrong], ["rules and model together", whole.wrong]] as const) {
      process.stdout.write(`  ${title}, not read whole:\n`);
      for (const c of wrong) {
        process.stdout.write(`    ${c.id}: found ${c.found}, missed ${c.missed}, extra ${c.extra}\n`);
      }
    }
  }
}
if (oneSet) {
  // One set says nothing about the other: no scores are written.
  process.exit(0);
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
  // What the owner is shown for the first set: rules and model together.
  together: measured["first"]!.together,
  // The same on documents nothing was tuned on. A model reading counts
  // without a yes only where both sets clear the bar.
  heldout: measured["heldout"]!,
};
writeFileSync(out, `${JSON.stringify(scores, null, 2)}\n`);
