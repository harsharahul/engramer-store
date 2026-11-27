import { describe, expect, it } from "vitest";
import { EMAIL_MIME } from "../../mail/kind";
import { isRealDate } from "../dates";
import { scanForFacts } from "../scan";
import { MAIL_KINDS } from "../summarize";
import { EVAL_CASES } from "./cases";
import { HELDOUT_CASES } from "./heldout";
import { HELDOUT_BILL_CASES } from "./heldoutbills";
import { HELDOUT_BILL2_CASES } from "./heldoutbills2";
import type { EvalCase } from "./score";

/**
 * A second batch of held-out documents: bills, notices and statements that
 * no rule was shaped to. These tests check only that the batch is well
 * formed, and every one of them reports a count, never a case: what the
 * documents say stays unseen by whoever writes the rules.
 */
const BATCHES: readonly { prefix: string; cases: readonly EvalCase[] }[] = [
  { prefix: "h3-", cases: HELDOUT_BILL_CASES },
  { prefix: "h4-", cases: HELDOUT_BILL2_CASES },
];
const ALL = BATCHES.flatMap((batch) => batch.cases);
// The eval takes every stored file as kept on 9 November 2026.
const KEPT_DAY = "2026-11-09";
const isMail = (c: EvalCase) => c.mime === EMAIL_MIME;
const count = (cases: readonly EvalCase[], faulty: (c: EvalCase) => boolean) => cases.filter(faulty).length;

describe("the second held-out batch: bills, notices and statements", () => {
  it("holds two files of 55 cases, each id once and under its file's prefix, none shared with another set", () => {
    for (const batch of BATCHES) {
      expect(batch.cases.length).toBe(55);
      expect(count(batch.cases, (c) => !c.id.startsWith(batch.prefix))).toBe(0);
    }
    const ids = ALL.map((c) => c.id);
    expect(new Set(ids).size).toBe(110);
    const others = new Set([...EVAL_CASES, ...HELDOUT_CASES].map((c) => c.id));
    expect(ids.filter((id) => others.has(id)).length).toBe(0);
  });

  it("each file is 33 emails and 22 stored files", () => {
    for (const batch of BATCHES) {
      expect(count(batch.cases, isMail)).toBe(33);
      expect(count(batch.cases, (c) => c.mime === "application/pdf")).toBe(22);
    }
  });

  it("no document repeats one of another set, or another of its own", () => {
    const texts = ALL.map((c) => c.text);
    expect(new Set(texts).size).toBe(110);
    const others = new Set([...EVAL_CASES, ...HELDOUT_CASES].map((c) => c.text));
    expect(texts.filter((text) => others.has(text)).length).toBe(0);
  });

  it("every email names its sender, the day it was sent and its kind; a stored file names none", () => {
    const from = Date.UTC(2026, 10, 10);
    const to = Date.UTC(2027, 6, 1);
    const mailFault = (c: EvalCase) =>
      !c.name.endsWith(".email") ||
      !c.from ||
      c.writtenAt === undefined ||
      c.writtenAt < from ||
      c.writtenAt >= to ||
      !c.mailKind ||
      !(MAIL_KINDS as readonly string[]).includes(c.mailKind);
    const fileFault = (c: EvalCase) => !c.name.endsWith(".pdf") || c.from !== undefined || c.writtenAt !== undefined || c.mailKind !== undefined;
    expect(count(ALL.filter(isMail), mailFault)).toBe(0);
    expect(count(ALL.filter((c) => !isMail(c)), fileFault)).toBe(0);
  });

  it("every document has text, and none holds a long dash", () => {
    expect(count(ALL, (c) => c.text.trim().length < 40)).toBe(0);
    const dash = new RegExp(`[${String.fromCodePoint(0x2013)}${String.fromCodePoint(0x2014)}]`);
    expect(count(ALL, (c) => dash.test(`${c.name}\n${c.text}\n${c.raw ?? ""}`))).toBe(0);
  });

  it("every expectation is well formed: a real day, a 24-hour clock, one amount at most, with two decimals", () => {
    const fault = (c: EvalCase) =>
      c.expected.filter((want) => want.kind === "amount").length > 1 ||
      c.expected.some((want) => {
        const value = want.kind === "amount" ? /^\d+\.\d{2}$/.test(want.value) : isRealDate(want.value);
        const time = want.time === undefined || (want.kind !== "amount" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(want.time));
        const kind = want.kind === "due" || want.kind === "expiry" || want.kind === "amount";
        return !value || !time || !kind;
      });
    expect(count(ALL, fault)).toBe(0);
  });

  it("no document expects a day that was over before it was sent, or before the day it is taken as kept", () => {
    const behind = (c: EvalCase) => {
      const arrived = c.writtenAt !== undefined ? new Date(c.writtenAt).toISOString().slice(0, 10) : KEPT_DAY;
      return c.expected.some((want) => want.kind !== "amount" && want.value < arrived);
    };
    expect(count(ALL, behind)).toBe(0);
  });

  it("holds no structured data: the exact readers offer nothing", async () => {
    let exact = 0;
    for (const c of ALL) {
      const { facts } = await scanForFacts({ name: c.name, mime: c.mime, text: c.text, ...(c.raw ? { raw: c.raw } : {}) });
      exact += facts.some((fact) => fact.accepted === "exact") ? 1 : 0;
    }
    expect(exact).toBe(0);
  });
});
