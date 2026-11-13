import { describe, expect, it } from "vitest";
import { scanForFacts } from "../scan";
import { EVAL_CASES } from "./cases";
import { HELDOUT_CASES } from "./heldout";
import { scoreReader, type EvalCase } from "./score";

/**
 * The exact readers against the eval set. They read only what a document
 * states as data, so they are pinned at perfect precision everywhere and
 * perfect recall on the cases whose every fact is stated as data. Any drop
 * is a reader regression, never noise.
 */

const exactReadings = async (evalCase: EvalCase) =>
  (await scanForFacts({ name: evalCase.name, mime: evalCase.mime, text: evalCase.text, ...(evalCase.raw ? { raw: evalCase.raw } : {}) })).facts.filter(
    (fact) => fact.accepted === "exact",
  );

describe("exact readers on the eval set", () => {
  it("holds forty synthetic cases", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
  });

  it("the first set holds the distractor, the form and the time-language cases, each id once, none shared with the held-out set", () => {
    expect(EVAL_CASES).toHaveLength(162);
    expect(EVAL_CASES.filter((c) => c.id.startsWith("x-"))).toHaveLength(30);
    expect(EVAL_CASES.filter((c) => c.id.startsWith("f-"))).toHaveLength(40);
    expect(EVAL_CASES.filter((c) => c.id.startsWith("t-"))).toHaveLength(30);
    const heldout = new Set(HELDOUT_CASES.map((c) => c.id));
    expect(EVAL_CASES.filter((c) => heldout.has(c.id))).toEqual([]);
  });

  it("exact readers are never wrong on structured cases", async () => {
    const structured = EVAL_CASES.filter((c) => c.exact);
    for (const task of ["dates", "amounts"] as const) {
      const score = await scoreReader(structured, exactReadings, task);
      expect({ task, precision: score.precision, recall: score.recall }).toEqual({ task, precision: 1, recall: 1 });
    }
  });

  it("exact readers claim nothing in plain text", async () => {
    for (const task of ["dates", "amounts"] as const) {
      const score = await scoreReader(EVAL_CASES, exactReadings, task);
      expect({ task, precision: score.precision }).toEqual({ task, precision: 1 });
    }
  });
});

/**
 * The label rules against the eval set. A rule reads only where a document
 * labels its own date or amount with words the vocabulary knows, so what it
 * offers must nearly always be right; how much of the set it finds is
 * printed, and is what the wider vocabulary is for. Its readings still wait
 * for a yes.
 *
 * A form line that only names a date ("Statement date: 3 February 2027") is
 * kept with the document's own words and claims no meaning; those are
 * counted apart and printed, never scored as a typed reading.
 */
const labelFacts = async (evalCase: EvalCase) =>
  (
    await scanForFacts({
      name: evalCase.name,
      mime: evalCase.mime,
      text: evalCase.text,
      ...(evalCase.raw ? { raw: evalCase.raw } : {}),
      ...(evalCase.writtenAt !== undefined ? { writtenAt: evalCase.writtenAt } : {}),
    })
  ).facts.filter((fact) => fact.source === "label");
const NAMED_ONLY = new Set(["dated", "period"]);
const labelReadings = async (evalCase: EvalCase) => (await labelFacts(evalCase)).filter((fact) => !NAMED_ONLY.has(fact.kind));

describe("label rules on the eval set", () => {
  it("the time-language cases hold at most the wrong readings counted when they joined, and fewer as the readers learn", async () => {
    // Counted when the cases joined: a show read at its doors, a range read
    // from the morning. Lowered by each change that fixes one; the cases
    // join the test below once they clear it.
    const WRONG_ON_TIME_CASES = 5;
    const time = EVAL_CASES.filter((c) => c.id.startsWith("t-"));
    const score = await scoreReader(time, labelReadings, "dates");
    const wrong = score.perCase.reduce((sum, c) => sum + c.extra, 0);
    expect(wrong).toBeLessThanOrEqual(WRONG_ON_TIME_CASES);
  });

  it("are right at least nine times in ten, on dates and on amounts", async () => {
    // Every case of the first set: running words, distractors and forms
    // alike. The time-language cases are held by their own ceiling above
    // until the readers clear them.
    const written = EVAL_CASES.filter((c) => !c.id.startsWith("t-"));
    const plain = written.filter((c) => !c.exact);
    const lines: string[] = [];
    const precise: Record<string, boolean> = {};
    for (const task of ["dates", "amounts"] as const) {
      // Precision over every case, so a rule that speaks where data already did counts against it.
      const all = await scoreReader(written, labelReadings, task);
      const found = await scoreReader(plain, labelReadings, task);
      const offered = all.perCase.reduce((sum, c) => sum + c.found + c.extra, 0);
      lines.push(`label rules, ${task}: precision ${all.precision.toFixed(3)} over ${offered} readings, recall ${found.recall.toFixed(3)} on ${plain.length} plain cases`);
      for (const c of all.perCase.filter((c) => c.extra)) {
        lines.push(`  wrong in ${c.id}: ${c.extra}`);
      }
      for (const c of found.perCase.filter((c) => c.missed)) {
        lines.push(`  missed in ${c.id}: ${c.missed}`);
      }
      precise[task] = all.precision >= 0.9;
    }
    let named = 0;
    for (const evalCase of EVAL_CASES) {
      named += (await labelFacts(evalCase)).filter((fact) => NAMED_ONLY.has(fact.kind)).length;
    }
    lines.push(`form lines that only name a date, kept with their own words: ${named}`);
    console.info(lines.join("\n"));
    expect(precise).toEqual({ dates: true, amounts: true });
  });
});
