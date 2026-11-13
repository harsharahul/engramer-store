import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LABEL_MEANINGS, lexiconFrom, loadLexicon, meaningOf, normalizeLabel, parseLabelTable } from "./lexicon";
import shipped from "./tables/labels.json";

// The table's source, as people edit it. Tests run from apps/web.
const SOURCE = resolve(process.cwd(), "../../tools/label-lexicon/dates.tsv");
const SHIPPED = resolve(process.cwd(), "src/intel/tables/labels.json");
const source = parseLabelTable(readFileSync(SOURCE, "utf8"));
const lexicon = lexiconFrom(source.rows);

describe("normalizeLabel", () => {
  it("a label is known by what it says, not how it is written", () => {
    expect(normalizeLabel("Statement Date:")).toBe("statement");
    expect(normalizeLabel("statement date")).toBe("statement");
    expect(normalizeLabel("STATEMENT-DATE")).toBe("statement");
    expect(normalizeLabel("Check-in date")).toBe("check in");
    expect(normalizeLabel("  Expires   on ")).toBe("expires");
    expect(normalizeLabel("Terms & conditions updated")).toBe("terms and conditions updated");
  });

  it("words that carry the meaning are kept", () => {
    // "by" and "until" say what the date is for; "of" turns a label around.
    expect(normalizeLabel("Pay by")).toBe("pay by");
    expect(normalizeLabel("Valid until")).toBe("valid until");
    expect(normalizeLabel("Date of service")).toBe("date of service");
    expect(normalizeLabel("Service date")).toBe("service");
    expect(normalizeLabel("Arriving at")).toBe("arriving at");
  });

  it("a label that is only the word date, or holds no letters, stays what it is or is nothing", () => {
    expect(normalizeLabel("Date")).toBe("date");
    expect(normalizeLabel("On")).toBe("on");
    expect(normalizeLabel("12/03")).toBe("");
  });
});

describe("parseLabelTable", () => {
  it("reads label and meaning, skips headers and blank lines, and folds the same label written twice", () => {
    const parsed = parseLabelTable("# Bills\nPayment due\tdue\n\nStatement date\tnone\nSTATEMENT DATE\tnone\n");
    expect(parsed.rows).toEqual([
      ["payment due", "due"],
      ["statement", "none"],
    ]);
    expect(parsed.problems).toEqual([]);
  });

  it("refuses a label listed with two meanings, a meaning it does not know, and a line it cannot read", () => {
    const parsed = parseLabelTable("Renewal date\tdue\nRenewal\texpiry\nCover ends\tends\nno tab here\n12/03\tnone\n");
    expect(parsed.problems).toEqual([
      'two meanings for "renewal": due, expiry',
      'unknown meaning "ends" for "Cover ends"',
      'no label and meaning in "no tab here"',
      'a label with no words: "12/03"',
    ]);
    // A label with two meanings is in neither: unknown is safe.
    expect(parsed.rows).toEqual([]);
  });
});

describe("the shipped label table", () => {
  it("has one meaning per label and nothing it cannot read", () => {
    expect(source.problems).toEqual([]);
  });

  it("is what its source says, and small enough to ship", () => {
    expect(shipped).toEqual({ v: 1, dates: source.rows });
    expect(statSync(SHIPPED).size).toBeLessThan(120_000);
  });

  it("holds at least 1,200 labels, a nobody's-business list small enough to read whole, and few issue labels", () => {
    const count = (meaning: string) => source.rows.filter(([, held]) => held === meaning).length;
    expect(source.rows.length).toBeGreaterThanOrEqual(1_200);
    expect(count("none")).toBeGreaterThanOrEqual(150);
    expect(count("none")).toBeLessThanOrEqual(500);
    expect(count("issued")).toBeLessThanOrEqual(30);
    for (const meaning of LABEL_MEANINGS) {
      expect({ meaning, some: count(meaning) > 0 }).toEqual({ meaning, some: true });
    }
  });

  it("a list cannot silence a deadline: no nobody's-business label holds a word of paying, expiring, attending, travelling or delivering", () => {
    const deadline = /\b(?:pay|paid|due|owe|expir|valid|renew|deadline|appoint|meet|class|show|event|check|depart|arriv|deliver|return|repl|respond)/;
    const silenced = source.rows.filter(([, meaning]) => meaning === "none").map(([label]) => label);
    expect(silenced.filter((label) => deadline.test(label))).toEqual([]);
    // Nor one that is about a birth, or that only opens a span ("valid from").
    expect(silenced.filter((label) => /\bbirth|\bborn\b/.test(label) || /\b(?:from|to|through|for|of)$/.test(label))).toEqual([]);
  });

  it("a label whose meaning depends on the document is not in the table", () => {
    const depends = [
      "Date", "When", "Start", "Start date", "End", "End date", "From", "To", "Time", "Period", "Valid", "Valid from",
      "Arrival", "Arrival date", "Departure", "Departure date", "Return", "Return date", "Collection date", "Closing date",
      "Completion date", "Service date", "Billing date", "Outbound", "Inbound", "Effective date", "Commencement date",
    ];
    expect(depends.filter((label) => meaningOf(lexicon, label) !== undefined)).toEqual([]);
  });

  it("holds nothing about offers: an advertisement's dates stay nobody's reminder", () => {
    // A trial here is the kind a shop offers; a court's trial is a day to attend.
    const offers = /\b(?:offer|sale|promo|promotion|coupon|voucher|discount|deal)s?\b|\b(?:free|introductory) trial\b|\btrial (?:period|offer|ends?|expir\w*)\b/;
    expect(source.rows.filter(([label]) => offers.test(label)).map(([label]) => label)).toEqual([]);
    expect(offers.test("free trial ends")).toBe(true);
    expect(offers.test("date of trial")).toBe(false);
  });

  it("answers the labels a form really prints", () => {
    const known: [string, string | undefined][] = [
      ["Statement Date:", "none"],
      ["Invoice date", "none"],
      ["Order date", "none"],
      ["Booked on", "none"],
      ["Date printed", "none"],
      ["Billing period", "none"],
      ["Next statement date", "none"],
      ["Member since", "none"],
      ["Valid until", "expiry"],
      ["Valid Until Date", "expiry"],
      ["Expiry date", "expiry"],
      ["Cover ends", "expiry"],
      ["Payment due", "due"],
      ["Payment Due Date", "due"],
      ["Pay by", "due"],
      ["Direct debit date", "due"],
      ["Please confirm by", "due"],
      ["Issue date", "issued"],
      ["Date of issue", "issued"],
      ["Check-in", "check-in"],
      ["Check in date", "check-in"],
      ["Check-out", "check-out"],
      ["Departs", "depart"],
      ["Arrives", "arrive"],
      ["Next appointment", "event"],
      ["Estimated delivery", "event"],
      // Unknown is an answer too: the line is then read as before.
      ["Boarding group", undefined],
      ["Date", undefined],
    ];
    expect(known.map(([label]) => [label, meaningOf(lexicon, label)])).toEqual(known);
  });
});

describe("loadLexicon", () => {
  it("loads the shipped table once and answers from it", async () => {
    const loaded = (await loadLexicon())!;
    expect(loaded).toBeDefined();
    expect(loaded).toBe(await loadLexicon());
    expect(meaningOf(loaded, "Statement date")).toBe("none");
    expect(loaded.dates.size).toBe(source.rows.length);
  });
});
