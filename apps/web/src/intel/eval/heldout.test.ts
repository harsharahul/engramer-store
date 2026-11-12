import { describe, expect, it } from "vitest";
import { EMAIL_MIME } from "../../mail/kind";
import { isRealDate } from "../dates";
import { scanForFacts } from "../scan";
import { MAIL_KINDS } from "../summarize";
import { EVAL_CASES } from "./cases";
import { HELDOUT_CASES } from "./heldout";
import { scoreReader, type EvalCase } from "./score";

/**
 * The held-out set is the measure nothing is tuned on. These tests check
 * only that it is well formed; what the readers make of it is printed, and
 * no figure here is asserted, so no rule is ever shaped to its cases.
 */
describe("the held-out set", () => {
  it("holds 60 cases with unique ids, none shared with the first set", () => {
    expect(HELDOUT_CASES).toHaveLength(60);
    const ids = HELDOUT_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(60);
    const first = new Set(EVAL_CASES.map((c) => c.id));
    expect(ids.filter((id) => first.has(id))).toEqual([]);
  });

  it("no document of the first set is repeated in it", () => {
    const first = new Set(EVAL_CASES.map((c) => c.text));
    expect(HELDOUT_CASES.filter((c) => first.has(c.text)).map((c) => c.id)).toEqual([]);
  });

  it("twelve of its documents state nothing", () => {
    expect(HELDOUT_CASES.filter((c) => c.expected.length === 0)).toHaveLength(12);
  });

  it("every email names its sender, the day it was sent and its kind; a stored file names none", () => {
    const kinds: readonly string[] = MAIL_KINDS;
    for (const c of HELDOUT_CASES) {
      const mail = c.mime === EMAIL_MIME;
      expect({ id: c.id, name: c.name.endsWith(mail ? ".email" : ".pdf") }).toEqual({ id: c.id, name: true });
      expect({ id: c.id, from: typeof c.from === "string" && c.from.length > 0, sent: typeof c.writtenAt === "number" && c.writtenAt > 0, kind: c.mailKind !== undefined && kinds.includes(c.mailKind) }).toEqual({
        id: c.id,
        from: mail,
        sent: mail,
        kind: mail,
      });
    }
  });

  it("every expectation is well formed: a real day, a 24-hour clock, an amount with two decimals", () => {
    for (const c of HELDOUT_CASES) {
      for (const want of c.expected) {
        const value = want.kind === "amount" ? /^\d+\.\d{2}$/.test(want.value) : isRealDate(want.value);
        const time = want.time === undefined || (want.kind !== "amount" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(want.time));
        expect({ id: c.id, want, value, time }).toEqual({ id: c.id, want, value: true, time: true });
      }
    }
  });

  it("an email announces nothing that was over before it was sent", () => {
    for (const c of HELDOUT_CASES.filter((c) => c.writtenAt !== undefined)) {
      const sent = new Date(c.writtenAt!).toISOString().slice(0, 10);
      // A document's own issue day lies behind it; everything else is ahead.
      const behind = c.expected.filter((want) => want.kind !== "amount" && want.kind !== "issued" && want.value < sent);
      expect({ id: c.id, behind }).toEqual({ id: c.id, behind: [] });
    }
  });

  it("holds no structured data: the exact readers offer nothing", async () => {
    const exact = async (c: EvalCase) => (await scanForFacts({ name: c.name, mime: c.mime, text: c.text })).facts.filter((fact) => fact.accepted === "exact");
    for (const c of HELDOUT_CASES) {
      expect({ id: c.id, exact: (await exact(c)).length }).toEqual({ id: c.id, exact: 0 });
    }
  });

  it("prints what the label rules alone make of it", async () => {
    const labels = async (c: EvalCase) =>
      (await scanForFacts({ name: c.name, mime: c.mime, text: c.text, ...(c.writtenAt !== undefined ? { writtenAt: c.writtenAt } : {}) })).facts.filter(
        (fact) => fact.source === "label",
      );
    const lines: string[] = [];
    for (const task of ["dates", "amounts"] as const) {
      const score = await scoreReader(HELDOUT_CASES, labels, task);
      const offered = score.perCase.reduce((sum, c) => sum + c.found + c.extra, 0);
      lines.push(`label rules on the held-out set, ${task}: precision ${score.precision.toFixed(3)} over ${offered} readings, recall ${score.recall.toFixed(3)}`);
    }
    console.info(lines.join("\n"));
    expect(lines).toHaveLength(2);
  });
});
