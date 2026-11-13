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

  it("the first set holds the distractor and the form cases, each id once, none shared with the held-out set", () => {
    expect(EVAL_CASES).toHaveLength(132);
    expect(EVAL_CASES.filter((c) => c.id.startsWith("x-"))).toHaveLength(30);
    expect(EVAL_CASES.filter((c) => c.id.startsWith("f-"))).toHaveLength(40);
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

/** Documents laid out as forms: a date line with its clock lines under it. */
const laidOutAsForm = (evalCase: EvalCase) => evalCase.id.startsWith("f-");
/**
 * Wrong typed readings the rules give today on the form cases: a clock line
 * under a date line is read against the next date instead of the one above
 * it, and a day to act by loses its clock. A ceiling until the rules for
 * such blocks are written. It may only be lowered.
 */
const WRONG_ON_FORMS = 12;

describe("label rules on the eval set", () => {
  it("on documents laid out as forms, the wrong typed readings may only become fewer", async () => {
    const forms = EVAL_CASES.filter(laidOutAsForm);
    const score = await scoreReader(forms, labelReadings, "dates");
    const wrong = score.perCase.reduce((sum, c) => sum + c.extra, 0);
    const offered = score.perCase.reduce((sum, c) => sum + c.found + c.extra, 0);
    console.info(`label rules on the form cases, dates: ${wrong} wrong of ${offered} typed readings, recall ${score.recall.toFixed(3)}`);
    // Exactly the count: a change that lowers it must lower the ceiling with it,
    // so wrong readings can never creep back under an old, higher number.
    expect(wrong).toBe(WRONG_ON_FORMS);
    // And a part is never offered as the total.
    const amounts = await scoreReader(forms, labelReadings, "amounts");
    expect(amounts.precision).toBe(1);
  });

  it("are right at least nine times in ten, on dates and on amounts", async () => {
    // The form cases are counted in the test above until their block rules exist.
    const written = EVAL_CASES.filter((c) => !laidOutAsForm(c));
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
