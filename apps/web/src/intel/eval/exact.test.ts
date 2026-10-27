import { describe, expect, it } from "vitest";
import { scanForFacts } from "../scan";
import { EVAL_CASES } from "./cases";
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
