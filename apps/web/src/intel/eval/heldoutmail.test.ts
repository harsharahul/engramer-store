import { describe, expect, it } from "vitest";
import { EMAIL_MIME } from "../../mail/kind";
import { isRealDate } from "../dates";
import { scanForFacts } from "../scan";
import { MAIL_KINDS } from "../summarize";
import { BILL_MAIL_CASES } from "./billmails";
import { BILL_MAIL2_CASES } from "./billmails2";
import { BILL_MAIL3_CASES } from "./billmails3";
import { EVAL_CASES } from "./cases";
import { HELDOUT_CASES } from "./heldout";
import { HELDOUT_BILL_CASES } from "./heldoutbills";
import { HELDOUT_BILL2_CASES } from "./heldoutbills2";
import { HELDOUT_MAIL_CASES } from "./heldoutmail";
import { HELDOUT_MAIL2_CASES } from "./heldoutmail2";
import { HELDOUT_MAIL3_CASES } from "./heldoutmail3";
import type { EvalCase } from "./score";

/**
 * Bills, notices and statements that arrive by mail: three held-out files
 * that no rule was shaped to, and three files of the first set written the
 * same way. These tests check only that each file is well formed, and every
 * one of them reports a count, never a case: what the held-out mails say
 * stays unseen by whoever writes the rules.
 */
const BATCHES: readonly { prefix: string; size: number; html: number; cases: readonly EvalCase[] }[] = [
  { prefix: "h5-", size: 50, html: 20, cases: HELDOUT_MAIL_CASES },
  { prefix: "h6-", size: 50, html: 20, cases: HELDOUT_MAIL2_CASES },
  { prefix: "h7-", size: 50, html: 20, cases: HELDOUT_MAIL3_CASES },
  { prefix: "b1-", size: 30, html: 12, cases: BILL_MAIL_CASES },
  { prefix: "b2-", size: 35, html: 14, cases: BILL_MAIL2_CASES },
  { prefix: "b3-", size: 35, html: 14, cases: BILL_MAIL3_CASES },
];
const ALL = BATCHES.flatMap((batch) => batch.cases);
const count = (cases: readonly EvalCase[], faulty: (c: EvalCase) => boolean) => cases.filter(faulty).length;

describe("the mail batches: bills, notices and statements that arrive by mail", () => {
  it("each file holds its number of cases, each id once and under its file's prefix, none shared with another set", () => {
    for (const batch of BATCHES) {
      expect({ file: batch.prefix, cases: batch.cases.length }).toEqual({ file: batch.prefix, cases: batch.size });
      expect({ file: batch.prefix, strays: count(batch.cases, (c) => !c.id.startsWith(batch.prefix)) }).toEqual({ file: batch.prefix, strays: 0 });
    }
    const ids = ALL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const others = new Set([...EVAL_CASES, ...HELDOUT_CASES, ...HELDOUT_BILL_CASES, ...HELDOUT_BILL2_CASES].map((c) => c.id));
    expect(ids.filter((id) => others.has(id)).length).toBe(0);
  });

  it("no mail repeats one of another set, or another of its own", () => {
    const texts = ALL.map((c) => c.text);
    expect(new Set(texts).size).toBe(texts.length);
    const others = new Set([...EVAL_CASES, ...HELDOUT_CASES, ...HELDOUT_BILL_CASES, ...HELDOUT_BILL2_CASES].map((c) => c.text));
    expect(texts.filter((text) => others.has(text)).length).toBe(0);
  });

  it("every case is a mail that names its sender, the day it was sent and its kind", () => {
    const from = Date.UTC(2026, 10, 10);
    const to = Date.UTC(2027, 6, 1);
    const fault = (c: EvalCase) =>
      c.mime !== EMAIL_MIME ||
      !c.name.endsWith(".email") ||
      !c.from ||
      c.writtenAt === undefined ||
      c.writtenAt < from ||
      c.writtenAt >= to ||
      !c.mailKind ||
      !(MAIL_KINDS as readonly string[]).includes(c.mailKind);
    for (const batch of BATCHES) {
      expect({ file: batch.prefix, faults: count(batch.cases, fault) }).toEqual({ file: batch.prefix, faults: 0 });
    }
  });

  it("each file holds its share of HTML mail, whose body rides as raw", () => {
    for (const batch of BATCHES) {
      const html = count(batch.cases, (c) => c.raw !== undefined);
      expect({ file: batch.prefix, enough: html >= batch.html - 3 && html <= batch.html + 3 }).toEqual({ file: batch.prefix, enough: true });
    }
  });

  it("every mail has text, and none holds a long dash", () => {
    const dash = new RegExp(`[${String.fromCodePoint(0x2013)}${String.fromCodePoint(0x2014)}]`);
    for (const batch of BATCHES) {
      expect({ file: batch.prefix, empty: count(batch.cases, (c) => c.text.trim().length < 40) }).toEqual({ file: batch.prefix, empty: 0 });
      expect({ file: batch.prefix, dashes: count(batch.cases, (c) => dash.test(`${c.name}\n${c.text}\n${c.raw ?? ""}`)) }).toEqual({
        file: batch.prefix,
        dashes: 0,
      });
    }
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
    for (const batch of BATCHES) {
      expect({ file: batch.prefix, faults: count(batch.cases, fault) }).toEqual({ file: batch.prefix, faults: 0 });
    }
  });

  it("no mail expects a day that was over before it was sent", () => {
    const behind = (c: EvalCase) => {
      const sent = new Date(c.writtenAt ?? 0).toISOString().slice(0, 10);
      return c.expected.some((want) => want.kind !== "amount" && want.value < sent);
    };
    for (const batch of BATCHES) {
      expect({ file: batch.prefix, behind: count(batch.cases, behind) }).toEqual({ file: batch.prefix, behind: 0 });
    }
  });

  it("holds no structured data: the exact readers offer nothing", async () => {
    for (const batch of BATCHES) {
      let exact = 0;
      for (const c of batch.cases) {
        const { facts } = await scanForFacts({ name: c.name, mime: c.mime, text: c.text, ...(c.raw ? { raw: c.raw } : {}) });
        exact += facts.some((fact) => fact.accepted === "exact") ? 1 : 0;
      }
      expect({ file: batch.prefix, exact }).toEqual({ file: batch.prefix, exact: 0 });
    }
  });
});
