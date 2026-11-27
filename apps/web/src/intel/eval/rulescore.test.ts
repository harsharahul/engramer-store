import { describe, expect, it } from "vitest";
import { EMAIL_MIME } from "../../mail/kind";
import { EVAL_CASES } from "./cases";
import { trustedKinds } from "../confidence";
import { HELDOUT_CASES } from "./heldout";
import { HELDOUT_BILL_CASES } from "./heldoutbills";
import { HELDOUT_BILL2_CASES } from "./heldoutbills2";
import { scoreRules } from "./rulescore";
import type { EvalCase } from "./score";
import shipped from "./rulescores.json";

// Every stored file is taken as kept on this day, as the eval takes it.
const KEPT = Date.UTC(2026, 10, 9, 12);
const dayOf = (evalCase: EvalCase) => evalCase.writtenAt ?? KEPT;

const file = (id: string, text: string, expected: EvalCase["expected"]): EvalCase => ({ id, name: `${id}.pdf`, mime: "application/pdf", text, expected });
const mail = (id: string, text: string, expected: EvalCase["expected"]): EvalCase => ({
  id,
  name: `${id}.email`,
  mime: EMAIL_MIME,
  text,
  expected,
  writtenAt: KEPT,
});

const BILL = "City Water\nAmount due $84.20\nDue date: November 20, 2026";
const VISIT = "Your appointment is on Tuesday, December 8, 2026 at 2:30 PM with Dr. Lee.";

describe("scoreRules: how often a label rule's reading is right, by kind", () => {
  it("a reading is right when the document states that day under that meaning", async () => {
    const cases = [
      file("bill", BILL, [
        { kind: "due", value: "2026-11-20" },
        { kind: "amount", value: "84.20" },
      ]),
      // The same line where the document does not state that day as a day to pay.
      file("not-to-pay", BILL, [{ kind: "issued", value: "2026-11-20" }]),
      file("pass", "Museum annual pass\nBooked on: 3 November 2026\nPass valid until: 2 August 2028", [{ kind: "expiry", value: "2028-08-02" }]),
      mail("visit", VISIT, [{ kind: "event", value: "2026-12-08", time: "14:30" }]),
    ];
    expect(await scoreRules(cases, dayOf)).toEqual({
      due: { offered: 2, right: 1 },
      event: { offered: 1, right: 1 },
      expiry: { offered: 1, right: 1 },
      // The amount of a bill whose day to pay is plain: asked of both bills, stated by one.
      amount: { offered: 2, right: 1 },
    });
  });

  it("a day to pay is measured only where it is plain: the one such day, ahead of the document's day, within a year", async () => {
    const cases = [
      // Two days to pay under labels.
      file("two", "City Water\nDue date: November 20, 2026\nPayment due: December 20, 2026", [{ kind: "due", value: "2026-11-20" }]),
      // Behind the day the file is taken as kept.
      file("behind", "City Water\nAmount due $84.20\nDue date: November 2, 2026", [{ kind: "due", value: "2026-11-02" }]),
      // More than a year ahead.
      file("far", "City Water\nAmount due $84.20\nDue date: December 20, 2027", [{ kind: "due", value: "2027-12-20" }]),
    ];
    const scores = await scoreRules(cases, dayOf);
    expect(scores.due).toEqual({ offered: 0, right: 0 });
    // And with no plain day to pay, no amount is measured.
    expect(scores.amount).toEqual({ offered: 0, right: 0 });
  });

  it("the bill's amount is its amount due, else its one total; a wrong one counts against the rules", async () => {
    const cases = [
      file("total", "City Water\nTotal: $57.45\nDue date: November 20, 2026", [
        { kind: "due", value: "2026-11-20" },
        { kind: "amount", value: "57.45" },
      ]),
      // The document asks for another sum than the one under the label.
      file("other", BILL, [
        { kind: "due", value: "2026-11-20" },
        { kind: "amount", value: "90.00" },
      ]),
    ];
    expect((await scoreRules(cases, dayOf)).amount).toEqual({ offered: 2, right: 1 });
  });

  it("the right day with another clock than the document states is not right", async () => {
    const cases = [mail("visit", VISIT, [{ kind: "event", value: "2026-12-08", time: "15:00" }])];
    expect((await scoreRules(cases, dayOf)).event).toEqual({ offered: 1, right: 0 });
  });

  it("a reading no single reader is trusted with is left out: high stakes, or a date of doubt", async () => {
    const cases = [
      // A legal deadline.
      mail("permit", "The deadline to renew your parking permit is 30 September 2027.", [{ kind: "due", value: "2027-09-30" }]),
      // An identity document.
      file("licence", "DRIVER LICENSE\nDL D1234567\nEXP 08/15/2029", [{ kind: "expiry", value: "2029-08-15" }]),
      // The times of a journey.
      mail("flight", "Flight UA 123 departs SFO 10:15 AM on March 4, 2027, arrives JFK 6:45 PM", [
        { kind: "event", value: "2027-03-04", time: "10:15" },
        { kind: "event", value: "2027-03-04", time: "18:45" },
      ]),
      // A day printed with no year.
      mail("no-year", "City Water\nPayment due: Friday, November 20", [{ kind: "due", value: "2026-11-20" }]),
    ];
    const none = { offered: 0, right: 0 };
    expect(await scoreRules(cases, dayOf)).toEqual({ due: none, event: none, expiry: none, amount: none });
  });
});

describe("the measured record of the label rules", () => {
  // The rules are deterministic: the table is what this code measures, and a
  // change to a rule that moves a figure fails here until the table says so.
  it("the shipped table is what the rules measure on the first set", async () => {
    expect(await scoreRules(EVAL_CASES, dayOf)).toEqual(shipped.first);
  });

  it("and on the held-out set, by its totals only", async () => {
    expect(await scoreRules(HELDOUT_CASES, dayOf)).toEqual(shipped.heldout);
  });

  it("and on the second held-out batch, by its totals only", async () => {
    expect(await scoreRules([...HELDOUT_BILL_CASES, ...HELDOUT_BILL2_CASES], dayOf)).toEqual(shipped.fresh);
  });

  it("the kinds that clear the bar today, on the first set and on the unseen documents together", () => {
    expect(trustedKinds(shipped)).toEqual([]);
  });
});
