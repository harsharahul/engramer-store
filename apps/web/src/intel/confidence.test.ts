import { describe, expect, it } from "vitest";
import type { Fact } from "./facts";
import {
  acceptance,
  countedKinds,
  MIN_SAMPLE,
  plainAmount,
  plainDue,
  ruleEdition,
  saneFact,
  stakesOf,
  trustedKind,
  trustedKinds,
  trustedMailKind,
  type ReaderScores,
  type RuleRecord,
  type RuleScores,
} from "./confidence";
import { READER_VERSION } from "./reading";
import { readingFingerprint } from "./summarize";

const NOW = Date.UTC(2027, 2, 1);

const fact = (over: Partial<Fact>): Fact => ({
  id: "x",
  kind: "due",
  document: "invoice",
  value: "2027-04-10",
  label: "Payment due",
  source: "model",
  confidence: 0.45,
  ...over,
});

const CURRENT = READER_VERSION.apple!;
const PROMPT = readingFingerprint();

type Measured = { precision: number; offered: number };
const tasks = (dates: Measured) => ({
  dates: { ...dates, recall: 0.5, expected: 40 },
  amounts: { precision: 1, recall: 0.3, offered: 3, expected: 10 },
});
/** Scores for the first set and, unless left out, for the held-out set (the same figures by default). */
const scores = (dates: Measured, version = CURRENT, heldout: Measured | null = dates): ReaderScores => ({
  reader: "apple",
  version,
  prompt: PROMPT,
  tasks: tasks(dates),
  ...(heldout ? { heldout: { cases: 60, tasks: tasks(heldout) } } : {}),
});

const trusted = scores({ precision: 0.99, offered: MIN_SAMPLE + 10 });

describe("acceptance", () => {
  it("a grounded bill due date is accepted where the measured precision allows it", () => {
    expect(acceptance(fact({}), { scores: trusted, siblings: [], now: NOW })).toBe("grounded");
  });

  it("a day said in words, or a year the text left out, always waits for a yes, however well the reader measures", () => {
    expect(acceptance(fact({ relative: true }), { scores: trusted, siblings: [], now: NOW })).toBeNull();
    expect(acceptance(fact({ assumedYear: true }), { scores: trusted, siblings: [], now: NOW })).toBeNull();
  });

  it("the same date stays offered when the task measured below 98%", () => {
    expect(acceptance(fact({}), { scores: scores({ precision: 0.69, offered: 40 }), siblings: [], now: NOW })).toBeNull();
  });

  it("a precision measured over too few readings is not trusted", () => {
    // Amounts measured 100% over three readings.
    const amount = fact({ id: "amount:65.00", kind: "amount", value: "65.00", unit: "USD", label: "Amount due" });
    expect(acceptance(amount, { scores: trusted, siblings: [], now: NOW })).toBeNull();
  });

  it("the gate uses the held-out figures: a first set read right is not enough", () => {
    const good = { precision: 0.99, offered: MIN_SAMPLE + 10 };
    // Documents the instructions were never tuned on, read right nine times in ten.
    expect(acceptance(fact({}), { scores: scores(good, CURRENT, { precision: 0.9, offered: 50 }), siblings: [], now: NOW })).toBeNull();
    // Read right, over too few readings.
    expect(acceptance(fact({}), { scores: scores(good, CURRENT, { precision: 1, offered: MIN_SAMPLE - 1 }), siblings: [], now: NOW })).toBeNull();
    // Never measured on a held-out set at all.
    expect(acceptance(fact({}), { scores: scores(good, CURRENT, null), siblings: [], now: NOW })).toBeNull();
  });

  it("a held-out set read right is not enough when the first set is not", () => {
    const good = { precision: 0.99, offered: MIN_SAMPLE + 10 };
    expect(acceptance(fact({}), { scores: scores({ precision: 0.9, offered: 50 }, CURRENT, good), siblings: [], now: NOW })).toBeNull();
    expect(acceptance(fact({}), { scores: scores(good, CURRENT, good), siblings: [], now: NOW })).toBe("grounded");
  });

  it("scores measured for another version of the reader are not trusted", () => {
    expect(acceptance(fact({}), { scores: scores({ precision: 0.99, offered: 80 }, 0), siblings: [], now: NOW })).toBeNull();
  });

  it("scores measured with another prompt are not trusted", () => {
    expect(acceptance(fact({}), { scores: { ...trusted, prompt: "0000beef" }, siblings: [], now: NOW })).toBeNull();
    const { prompt: _, ...unmarked } = trusted;
    expect(acceptance(fact({}), { scores: unmarked, siblings: [], now: NOW })).toBeNull();
  });

  it("a departure time from the model alone is never accepted", () => {
    const departure = fact({ kind: "event", document: "itinerary", label: "Flight AQ 214 departs SFO", time: "09:40" });
    expect(stakesOf(departure)).toBe("high");
    expect(acceptance(departure, { scores: trusted, siblings: [], now: NOW })).toBeNull();
  });

  it("a stay whose check-out precedes check-in is offered, not accepted", () => {
    const checkin = fact({ id: "in", kind: "event", document: "hotel-booking", value: "2027-04-12", label: "Check-in: Casa do Rio" });
    const checkout = fact({ id: "out", kind: "event", document: "hotel-booking", value: "2027-04-08", label: "Check-out: Casa do Rio" });
    expect(saneFact(checkout, [checkin], NOW)).toBe(false);
    expect(acceptance(checkout, { scores: trusted, siblings: [checkin], now: NOW })).toBeNull();
  });

  it("exact readings are accepted whatever the scores say", () => {
    expect(acceptance(fact({ source: "jsonld", confidence: 1 }), { scores: undefined, siblings: [], now: NOW })).toBe("exact");
  });
});

describe("stakesOf", () => {
  it("weighs identity expiries and travel times high, bills normal, receipts and deliveries low", () => {
    expect(stakesOf(fact({ kind: "expiry", document: "passport" }))).toBe("high");
    expect(stakesOf(fact({ kind: "due" }))).toBe("normal");
    expect(stakesOf(fact({ kind: "amount", label: "Total" }))).toBe("low");
    expect(stakesOf(fact({ kind: "event", document: "delivery", label: "Delivery expected by" }))).toBe("low");
  });
});

describe("saneFact", () => {
  it("refuses a date that does not exist or lies far outside a lifetime of documents", () => {
    expect(saneFact(fact({ value: "2027-02-31" }), [], NOW)).toBe(false);
    expect(saneFact(fact({ value: "2091-01-01" }), [], NOW)).toBe(false);
    expect(saneFact(fact({ kind: "amount", value: "65.00", label: "Amount due" }), [], NOW)).toBe(false);
    expect(saneFact(fact({ kind: "amount", value: "65.00", unit: "USD", label: "Amount due" }), [], NOW)).toBe(true);
  });
});

describe("trustedKind", () => {
  const kindScores = (accuracy: number, cases: number, version = CURRENT): ReaderScores => ({
    reader: "apple",
    version,
    prompt: PROMPT,
    tasks: { mailKind: { accuracy, cases } },
  });

  it("a kind named right a third of the time is not used", () => {
    expect(trustedKind(kindScores(0.33, 24))).toBe(false);
  });

  it("a kind named right nearly always, over enough cases, is used", () => {
    expect(trustedKind(kindScores(0.95, 30))).toBe(true);
    expect(trustedKind(kindScores(0.95, 5))).toBe(false);
  });

  it("kind scores from another version of the reader are not used", () => {
    expect(trustedKind(kindScores(0.95, 30, 0))).toBe(false);
  });

  it("kind scores measured with another prompt are not used", () => {
    expect(trustedKind({ ...kindScores(0.95, 30), prompt: "0000beef" })).toBe(false);
  });
});

describe("trustedMailKind", () => {
  const newsletterScores = (precision: number, offered: number, version = CURRENT): ReaderScores => ({
    reader: "apple",
    version,
    prompt: PROMPT,
    tasks: { mailKind: { accuracy: 0.95, cases: 40, byKind: { newsletter: { precision, offered } } } },
  });

  it("a kind trusted overall is not enough to set a newsletter's dates aside", () => {
    expect(trustedKind(newsletterScores(0.9, 40))).toBe(true);
    expect(trustedMailKind(newsletterScores(0.9, 40), "newsletter")).toBe(false);
  });

  it("the newsletter kind's own precision, over enough emails, sets its dates aside", () => {
    expect(trustedMailKind(newsletterScores(1, MIN_SAMPLE), "newsletter")).toBe(true);
    expect(trustedMailKind(newsletterScores(1, 2), "newsletter")).toBe(false);
    expect(trustedMailKind(newsletterScores(1, MIN_SAMPLE, 0), "newsletter")).toBe(false);
    expect(trustedMailKind(newsletterScores(1, MIN_SAMPLE), "bill")).toBe(false);
    expect(trustedMailKind({ ...newsletterScores(1, MIN_SAMPLE), prompt: "0000beef" }, "newsletter")).toBe(false);
  });
});

/** A day to pay as a label rule reads it: 10 April 2027, in a mail sent on 1 March 2027. */
const due = (over: Partial<Fact> = {}): Fact => fact({ id: "due:2027-04-10", source: "label", confidence: 0.75, toPay: true, ...over });
const amount = (over: Partial<Fact> = {}): Fact =>
  fact({ id: "amount:84.20", kind: "amount", value: "84.20", unit: "USD", label: "Amount due", source: "label", confidence: 0.75, ...over });

describe("plainDue: a day to pay that leaves no room for doubt", () => {
  it("the one labelled day to pay, ahead of the day its mail was sent, is plain", () => {
    expect(plainDue(due(), [due()], NOW)).toBe(true);
  });

  it("a second day to pay under a label makes neither plain", () => {
    const first = due();
    const second = due({ id: "due:2027-05-10", value: "2027-05-10", label: "Final notice due" });
    expect(plainDue(first, [first, second], NOW)).toBe(false);
    expect(plainDue(second, [first, second], NOW)).toBe(false);
    // The same day stated twice is one day.
    const again = due({ id: "due:2027-04-10:b", label: "Pay by" });
    expect(plainDue(first, [first, again], NOW)).toBe(true);
  });

  it("a day behind the day the mail was sent is not plain; the day itself is", () => {
    expect(plainDue(due({ value: "2027-02-28" }), [], NOW)).toBe(false);
    expect(plainDue(due({ value: "2027-03-01" }), [], NOW)).toBe(true);
  });

  it("a day more than a year ahead is not plain", () => {
    expect(plainDue(due({ value: "2028-03-01" }), [], NOW)).toBe(true);
    expect(plainDue(due({ value: "2028-03-03" }), [], NOW)).toBe(false);
  });

  it("a document that states no day of its own, as a stored file, has no plain day to pay", () => {
    expect(plainDue(due(), [due()], undefined)).toBe(false);
  });

  it("a date of doubt, a costly one, or one that fails the sanity checks is not plain", () => {
    expect(plainDue(due({ relative: true }), [], NOW)).toBe(false);
    expect(plainDue(due({ assumedYear: true }), [], NOW)).toBe(false);
    expect(plainDue(due({ ambiguous: true }), [], NOW)).toBe(false);
    expect(plainDue(due({ label: "Deadline to file" }), [], NOW)).toBe(false);
    expect(plainDue(due({ value: "2027-04-31" }), [], NOW)).toBe(false);
  });

  it("only a day the reader stated outright as a day to pay: any other day to act by still asks", () => {
    // The reader states it where the label says due or pay and the date is
    // the label's own; a renewal, "return by" or a date further along the
    // sentence comes without it, whatever its label reads like here.
    const other = due();
    delete other.toPay;
    expect(plainDue(other, [], NOW)).toBe(false);
    expect(plainDue(due({ label: "Renews", toPay: false }), [], NOW)).toBe(false);
  });

  it("only a label rule's day to pay: no other reader's, and no other kind", () => {
    expect(plainDue(due({ source: "model" }), [], NOW)).toBe(false);
    expect(plainDue(due({ source: "pattern" }), [], NOW)).toBe(false);
    expect(plainDue(due({ kind: "expiry" }), [], NOW)).toBe(false);
    expect(plainDue(due({ kind: "event" }), [], NOW)).toBe(false);
  });
});

describe("plainAmount: the amount of a bill whose day to pay is plain", () => {
  it("the amount due beside a plain day to pay is plain", () => {
    const facts = [due(), amount()];
    expect(plainAmount(facts[1]!, facts, NOW)).toBe(true);
  });

  it("the amount due comes before a total; with no amount due, the one total", () => {
    const total = amount({ id: "amount:99.00", value: "99.00", label: "Total" });
    const both = [due(), amount(), total];
    expect(plainAmount(both[1]!, both, NOW)).toBe(true);
    expect(plainAmount(total, both, NOW)).toBe(false);
    const one = [due(), total];
    expect(plainAmount(total, one, NOW)).toBe(true);
  });

  it("two totals are not guessed between, and a sum that is neither is never the bill's", () => {
    const first = amount({ id: "amount:99.00", value: "99.00", label: "Total" });
    const second = amount({ id: "amount:120.00", value: "120.00", label: "Total" });
    const two = [due(), first, second];
    expect(plainAmount(first, two, NOW)).toBe(false);
    expect(plainAmount(second, two, NOW)).toBe(false);
    const other = amount({ id: "amount:12.00", value: "12.00", label: "Late fee" });
    expect(plainAmount(other, [due(), other], NOW)).toBe(false);
  });

  it("without a plain day to pay beside it, no amount is plain", () => {
    expect(plainAmount(amount(), [amount()], NOW)).toBe(false);
    const doubt = due({ assumedYear: true });
    expect(plainAmount(amount(), [doubt, amount()], NOW)).toBe(false);
  });

  it("only a label rule's amount, with its currency", () => {
    const model = amount({ source: "model" });
    expect(plainAmount(model, [due(), model], NOW)).toBe(false);
    const bare = amount({ unit: undefined });
    expect(plainAmount(bare, [due(), bare], NOW)).toBe(false);
  });
});

describe("trustedKinds: the kinds of label reading measured right often enough to count", () => {
  const none = { offered: 0, right: 0 };
  const tally = (offered: number, right: number) => ({ offered, right });
  /** A record by its day-to-pay tallies: the first set, then the three unseen parts (the held-out set, the bills, the mails). */
  const record = (first: RuleScores["due"], unseen: readonly RuleScores["due"][], amounts = [none, none, none, none]): RuleRecord => ({
    first: { due: first, event: none, expiry: none, amount: amounts[0]! },
    heldout: { due: unseen[0]!, event: none, expiry: none, amount: amounts[1]! },
    fresh: { due: unseen[1]!, event: none, expiry: none, amount: amounts[2]! },
    mail: { due: unseen[2]!, event: none, expiry: none, amount: amounts[3]! },
  });

  it("a kind is trusted at 98% over thirty readings, on the first set and on the unseen documents together", () => {
    expect(trustedKinds(record(tally(33, 33), [tally(18, 18), tally(24, 24), tally(60, 59)]))).toEqual(["due"]);
    // The unseen parts are one measure: 101 right of 102.
    expect(trustedKinds(record(tally(33, 33), [tally(18, 17), tally(24, 24), tally(60, 60)]))).toEqual(["due"]);
    // 99 right of 102 is under the bar.
    expect(trustedKinds(record(tally(33, 33), [tally(18, 17), tally(24, 23), tally(60, 59)]))).toEqual([]);
  });

  it("too few readings on either side mean nothing", () => {
    expect(trustedKinds(record(tally(29, 29), [tally(18, 18), tally(24, 24), tally(60, 60)]))).toEqual([]);
    expect(trustedKinds(record(tally(33, 33), [tally(10, 10), tally(10, 10), tally(9, 9)]))).toEqual([]);
  });

  it("both sides, not one", () => {
    expect(trustedKinds(record(tally(33, 31), [tally(18, 18), tally(24, 24), tally(60, 60)]))).toEqual([]);
  });

  it("the amount is trusted only where it clears the bar and the day to pay does", () => {
    const well = [tally(18, 18), tally(24, 24), tally(60, 60)];
    const good = [tally(35, 35), tally(10, 10), tally(10, 10), tally(40, 40)];
    expect(trustedKinds(record(tally(33, 33), well, good))).toEqual(["due", "amount"]);
    expect(trustedKinds(record(tally(33, 33), [tally(18, 10), tally(24, 24), tally(60, 60)], good))).toEqual([]);
    const poor = [tally(35, 35), tally(10, 8), tally(10, 10), tally(40, 40)];
    expect(trustedKinds(record(tally(33, 33), well, poor))).toEqual(["due"]);
  });

  it("no record, or one that lacks a part, trusts nothing", () => {
    expect(trustedKinds(undefined)).toEqual([]);
    const whole = record(tally(33, 33), [tally(18, 18), tally(24, 24), tally(60, 60)]);
    expect(trustedKinds(whole)).toEqual(["due"]);
    const { mail: _mail, ...older } = whole;
    expect(trustedKinds(older as RuleRecord)).toEqual([]);
  });
});

describe("acceptance of a label rule's reading", () => {
  const none = { offered: 0, right: 0 };
  const well = { offered: 60, right: 60 };
  const rules = (dues: RuleScores["due"], amounts: RuleScores["due"]): RuleRecord => ({
    first: { due: dues, event: well, expiry: well, amount: amounts },
    heldout: { due: dues, event: well, expiry: well, amount: amounts },
    fresh: { due: dues, event: well, expiry: well, amount: amounts },
    mail: { due: dues, event: well, expiry: well, amount: amounts },
  });
  const TRUSTED = rules(well, well);
  const DAY_ONLY = rules(well, { offered: 60, right: 50 });
  const UNDER = rules({ offered: 60, right: 50 }, well);
  /** `written: null` is a document that states no day of its own: a stored file. */
  const ctx = (siblings: Fact[], record: RuleRecord = TRUSTED, written: number | null = NOW) => ({
    scores: undefined,
    rules: record,
    siblings,
    now: NOW,
    ...(written !== null ? { written } : {}),
  });

  it("a plain day to pay counts where the measured record trusts that kind", () => {
    expect(acceptance(due(), ctx([due()]))).toBe("grounded");
  });

  it("it waits for a yes where the record is under the bar, or there is none", () => {
    expect(acceptance(due(), ctx([due()], UNDER))).toBeNull();
    expect(acceptance(due(), ctx([due()], rules(none, none)))).toBeNull();
    expect(acceptance(due(), { scores: undefined, siblings: [due()], now: NOW, written: NOW })).toBeNull();
  });

  it("a day to pay that is not plain waits for a yes, however well the kind measures", () => {
    const second = due({ id: "due:2027-05-10", value: "2027-05-10" });
    expect(acceptance(due(), ctx([due(), second]))).toBeNull();
    expect(acceptance(due(), ctx([due()], TRUSTED, null))).toBeNull();
    expect(acceptance(due({ assumedYear: true }), ctx([]))).toBeNull();
  });

  it("an event or an expiry read by a label never counts on the rule's word", () => {
    expect(acceptance(due({ kind: "event" }), ctx([]))).toBeNull();
    expect(acceptance(due({ kind: "expiry" }), ctx([]))).toBeNull();
  });

  it("a reading another reader disputes waits for a yes", () => {
    const disputed = due({ disputed: "due:2027-04-12" });
    expect(acceptance(disputed, ctx([disputed]))).toBeNull();
  });

  it("the bill's amount counts with its day where amounts are trusted, and waits where they are not", () => {
    const facts = [due(), amount()];
    expect(acceptance(facts[1]!, ctx(facts))).toBe("grounded");
    expect(acceptance(facts[1]!, ctx(facts, DAY_ONLY))).toBeNull();
    expect(acceptance(facts[0]!, ctx(facts, DAY_ONLY))).toBe("grounded");
    // An amount with no plain day to pay beside it.
    expect(acceptance(amount(), ctx([amount()]))).toBeNull();
  });

  it("the rule has a name that changes with what it is trusted with, also when that becomes nothing", () => {
    expect(ruleEdition(TRUSTED)).toBe("due+amount.1");
    expect(ruleEdition(DAY_ONLY)).toBe("due.1");
    expect(ruleEdition(UNDER)).toBe("none.1");
    expect(countedKinds(UNDER)).toEqual([]);
    // The record this build ships trusts the day alone.
    expect(ruleEdition()).toBe("due.1");
    expect(countedKinds()).toEqual(["due"]);
  });

  it("another reader's day to pay on another day makes the rule's reading a question", () => {
    const booked = fact({ id: "due:2027-04-08", kind: "due", value: "2027-04-08", source: "jsonld", confidence: 1, accepted: "exact" });
    expect(acceptance(due(), ctx([due(), booked]))).toBeNull();
    // The same day from another reader contradicts nothing.
    const same = fact({ id: "due:2027-04-10:b", kind: "due", value: "2027-04-10", source: "jsonld", confidence: 1, accepted: "exact" });
    expect(acceptance(due(), ctx([due(), same]))).toBe("grounded");
    // A reading the owner put away says nothing any more.
    expect(acceptance(due(), ctx([due(), { ...booked, dismissed: true }]))).toBe("grounded");
  });

  it("the model's reading takes nothing from the rules' record", () => {
    const model = fact({});
    expect(acceptance(model, { scores: scores({ precision: 0.69, offered: 40 }), rules: TRUSTED, siblings: [model], now: NOW, written: NOW })).toBeNull();
  });
});
