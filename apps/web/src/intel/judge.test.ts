import { describe, expect, it } from "vitest";
import { spotCandidates } from "./candidates";
import { isTracked, mergeFacts, type Fact } from "./facts";
import { DATE_ANSWERS, NO_TOTAL, fingerprintOf, judgeFingerprint, judgeRequest, judgeSample, judgedFacts } from "./judge";
import { subjectOf } from "./subject";

const TEXT = [
  "Hello! Your room at Casa Azulejo is ready for you from 15:00 on 8 April 2027.",
  "Please leave the key at the desk by 11:00 on 12 April 2027.",
  "Your dental check-up is on 22 July 2027 at 09:30.",
  "Your water bill for the quarter is USD 64.10. Please pay by 15 May 2027.",
  "This letter was written on 2 March 2027.",
].join("\n");
const candidates = spotCandidates(TEXT);
const read = (answer: Record<string, string>) => judgedFacts(answer, candidates, TEXT, "other");
const brief = (facts: Fact[]) => facts.map((f) => [f.kind, f.value, f.time, f.label]);

describe("what the judge is asked", () => {
  it("the candidates are the five dates and the one amount, in order", () => {
    expect(candidates.map((c) => [c.key, c.value, c.time])).toEqual([
      ["d1", "2027-04-08", "15:00"],
      ["d2", "2027-04-12", "11:00"],
      ["d3", "2027-07-22", "09:30"],
      ["d4", "2027-05-15", undefined],
      ["d5", "2027-03-02", undefined],
      ["a1", "64.10", undefined],
    ]);
  });

  it("one answer from a fixed list for each candidate, and nothing else to fill in but a few words", () => {
    const request = judgeRequest({ name: "letter.pdf", text: TEXT, contextSize: 4096, candidates });
    const properties = request.schema!.properties as Record<string, { type: string; enum?: string[] }>;
    expect(Object.keys(properties)).toEqual(["d1", "d1w", "d2", "d2w", "d3", "d3w", "d4", "d4w", "d5", "d5w", "pays", "total"]);
    expect(properties["d1"]!.enum).toEqual([...DATE_ANSWERS]);
    expect(properties["d1w"]).toMatchObject({ type: "string" });
    expect(request.schema!.required).toEqual(["d1", "d2", "d3", "d4", "d5", "pays", "total"]);
    expect(request.temperature).toBe(0);
    expect(request.priority).toBe("background");
  });

  it("the total is one choice among the amounts found, or none of them", () => {
    const text = "Coffee beans: $12.00\nSubtotal: $21.50\nTax: $1.72\nTotal paid: $23.22";
    const found = spotCandidates(text);
    const request = judgeRequest({ name: "receipt.pdf", text, contextSize: 4096, candidates: found });
    const properties = request.schema!.properties as Record<string, { enum?: string[] }>;
    // First whether the document states a whole amount at all, a plain yes or
    // no; then one question for all the amounts, so two cannot both be it.
    expect(Object.keys(properties)).toEqual(["pays", "total"]);
    expect(properties["pays"]!.enum).toEqual(["yes", "no"]);
    expect(properties["total"]!.enum).toEqual([...found.map((c) => c.key), NO_TOTAL]);
    // The total counts only on a yes.
    expect(judgedFacts({ pays: "yes", total: "a1" }, found, text, "other").map((f) => [f.kind, f.value, f.label])).toEqual([["amount", "23.22", "Total"]]);
    expect(judgedFacts({ pays: "no", total: "a1" }, found, text, "other")).toEqual([]);
    expect(judgedFacts({ total: "a1" }, found, text, "other")).toEqual([]);
    expect(judgedFacts({ pays: "yes", total: NO_TOTAL }, found, text, "other")).toEqual([]);
    // A document with no amount is not asked for one.
    const dated = "Your dental check-up is on 22 July 2027 at 09:30.";
    const plain = judgeRequest({ name: "note.pdf", text: dated, contextSize: 4096, candidates: spotCandidates(dated) });
    expect(Object.keys(plain.schema!.properties as object)).toEqual(["d1", "d1w"]);
  });

  it("the judge is not asked whether a date is an issue day", () => {
    expect(DATE_ANSWERS).toEqual(["event", "check-in", "check-out", "depart", "arrive", "due", "expiry", "other"]);
  });

  it("a date that was over before the message was sent is not asked about", () => {
    const text = "You ordered on 8 March 2027. Your sofa will arrive on 6 April 2027.";
    const found = spotCandidates(text, { writtenAt: Date.UTC(2027, 2, 22, 12) });
    const request = judgeRequest({ name: "Your sofa.email", text, contextSize: 4096, candidates: found, mail: { subject: "Your sofa", from: "Oakline Home", writtenAt: Date.UTC(2027, 2, 22, 12) } });
    expect(Object.keys(request.schema!.properties as object)).toEqual(["d1", "d1w"]);
    expect(request.prompt).toContain("d1: 6 April 2027");
    // The order day is still in the opening, as part of what the document says.
    expect(request.prompt).toContain("You ordered on 8 March 2027.");
    // An answer for a date that was never asked about gives nothing.
    expect(judgedFacts({ d1: "event", d2: "due" }, found, text, "delivery").map((f) => f.value)).toEqual(["2027-04-06"]);
  });

  it("the request holds the opening and each candidate with its sentence", () => {
    const request = judgeRequest({ name: "letter.pdf", text: TEXT, contextSize: 4096, candidates });
    expect(request.prompt).toContain("letter.pdf");
    expect(request.prompt).toContain("d3: 22 July 2027, 09:30");
    expect(request.prompt).toContain("Your dental check-up is on 22 July 2027 at 09:30.");
    expect(request.prompt).toContain("a1: USD 64.10");
  });

  it("the instructions and the listing fit beside a useful opening in the smallest window", () => {
    const request = judgeRequest({ name: "letter.pdf", text: TEXT, contextSize: 4096, candidates });
    // Instructions are counted against the window: under a third of it.
    expect(request.instructions.length).toBeLessThan((4096 * 3) / 3);
  });

  it("for mail it says the subject, the sender and the day it was written", () => {
    const request = judgeRequest({
      name: "Your order.email",
      text: TEXT,
      contextSize: 4096,
      candidates,
      mail: { subject: "Your room is ready", from: "Casa Azulejo", writtenAt: Date.UTC(2027, 2, 2, 12) },
    });
    expect(request.prompt).toContain("Subject: Your room is ready");
    expect(request.prompt).toContain("From: Casa Azulejo");
    expect(request.prompt).toContain("Written: Tuesday 2 March 2027");
  });

  it("the request for a long document stays inside the model's window", () => {
    const long = `${"Terms and conditions apply to every booking made with us. ".repeat(700)}\n${TEXT}`;
    const found = spotCandidates(long);
    const request = judgeRequest({ name: "long.pdf", text: long, contextSize: 4096, candidates: found });
    expect(request.instructions.length + request.prompt.length).toBeLessThan(4096 * 3);
    // The tail's candidates are still in it, each with its sentence.
    expect(request.prompt).toContain("Your dental check-up is on 22 July 2027 at 09:30.");
  });

  it("the fingerprint names the instructions and the lists, and is stable", () => {
    expect(judgeFingerprint()).toMatch(/^[0-9a-f]{8}$/);
    expect(judgeFingerprint()).toBe(judgeFingerprint());
  });

  it("the fingerprint covers everything the model is sent: what the schema says and the answer budget too", () => {
    // Measured scores count only for the question as it is asked. The sample
    // the fingerprint is taken from holds a date and an amount, so every
    // part of the schema and the budget is in it.
    const sample = judgeSample();
    expect(Object.keys(sample.schema!.properties as object)).toEqual(["d1", "d1w", "pays", "total"]);
    expect(sample.maxTokens).toBeGreaterThan(0);
    expect(judgeFingerprint()).toBe(fingerprintOf(sample));
    // A word changed in a description, or another budget, is another question.
    const reworded = { ...sample, schema: { ...sample.schema!, properties: { ...sample.schema!.properties, pays: { type: "string" as const, enum: ["yes", "no"], description: "Another wording" } } } };
    expect(fingerprintOf(reworded)).not.toBe(judgeFingerprint());
    expect(fingerprintOf({ ...sample, maxTokens: sample.maxTokens! + 1 })).not.toBe(judgeFingerprint());
  });

  it("a stay or a journey needs its own word in the sentence, or the date is a plain event", () => {
    // A model that calls a show an arrival is caught by the sentence: it holds no word of arriving.
    const show = "Your tickets for The Evening Sparrows are confirmed. The show starts at 8:00 PM on Saturday, November 6, 2027.";
    expect(judgedFacts({ d1: "arrive", d1w: "The Evening Sparrows" }, spotCandidates(show), show, "event-ticket").map((f) => [f.label, subjectOf(f)?.role])).toEqual([
      ["The Evening Sparrows", undefined],
    ]);
    const train = "Your train from Leeds to London King's Cross runs on Fri 9 July 2027.";
    expect(judgedFacts({ d1: "arrive", d1w: "Leeds to London King's Cross" }, spotCandidates(train), train, "other").map((f) => [f.label, subjectOf(f)?.role])).toEqual([
      ["Leeds to London King's Cross", undefined],
    ]);
    // With its word in the sentence the role stands.
    const landing = "Flight SW 212 lands in LIS on Saturday 20 March 2027 at 16:25.";
    expect(judgedFacts({ d1: "arrive", d1w: "LIS" }, spotCandidates(landing), landing, "itinerary").map((f) => [f.label, subjectOf(f)?.role])).toEqual([["Arrives LIS", "arrive"]]);
    const stay = "Hello! Your room at Casa Azulejo is ready for you from 15:00 on 8 April 2027.";
    expect(judgedFacts({ d1: "check-in", d1w: "Casa Azulejo" }, spotCandidates(stay), stay, "hotel-booking").map((f) => [f.label, subjectOf(f)?.role])).toEqual([
      ["Check-in: Casa Azulejo", "check-in"],
    ]);
  });
});

describe("what the judge's answers become", () => {
  it("each answer becomes its fact, with the candidate's own value and clock", () => {
    const facts = read({ d1: "check-in", d1w: "Casa Azulejo", d2: "check-out", d2w: "Casa Azulejo", d3: "event", d3w: "dental check-up", d4: "due", d5: "other", pays: "yes", total: "a1" });
    expect(brief(facts)).toEqual([
      ["event", "2027-04-08", "15:00", "Check-in: Casa Azulejo"],
      ["event", "2027-04-12", "11:00", "Check-out: Casa Azulejo"],
      ["event", "2027-07-22", "09:30", "Dental check-up"],
      ["due", "2027-05-15", undefined, undefined],
      ["amount", "64.10", undefined, "Total"],
    ]);
    expect(facts.every((f) => f.source === "model" && f.confidence === 0.45 && f.accepted === undefined)).toBe(true);
    expect(subjectOf(facts[0]!)).toMatchObject({ role: "check-in", place: "Casa Azulejo" });
    expect(subjectOf(facts[1]!)).toMatchObject({ role: "check-out", place: "Casa Azulejo" });
    expect(facts[4]).toMatchObject({ unit: "USD" });
  });

  it("other, a key that is no candidate, and a word outside the list give nothing", () => {
    expect(read({ d1: "other", d2: "other", d3: "other", d4: "other", d5: "other", pays: "no", total: NO_TOTAL })).toEqual([]);
    // "issued" is no longer an answer; a total names an amount's key and nothing else.
    expect(read({ d9: "due", d1: "birthday", d2: "DUE", d5: "issued", total: "a7" })).toEqual([]);
    expect(read({ total: "d4" })).toEqual([]);
    expect(read({ a1: "total" })).toEqual([]);
    expect(judgedFacts(null, candidates, TEXT, "other")).toEqual([]);
    expect(judgedFacts("due", candidates, TEXT, "other")).toEqual([]);
  });

  it("a value is always a candidate's: an answer cannot bring its own date or amount", () => {
    const facts = read({ d4: "due", d4w: "2031-01-01", pays: "yes", total: "a1", a1w: "999.99" } as Record<string, string>);
    expect(brief(facts)).toEqual([
      ["due", "2027-05-15", undefined, undefined],
      ["amount", "64.10", undefined, "Total"],
    ]);
  });

  it("words the text does not hold are dropped, and the fact stays", () => {
    const facts = read({ d3: "event", d3w: "annual board meeting", d1: "check-in", d1w: "Grand Hotel Lisboa" });
    expect(brief(facts)).toEqual([
      ["event", "2027-04-08", "15:00", "Check-in"],
      // No words of its own: the screen names it by the document, and nothing is made up here.
      ["event", "2027-07-22", "09:30", undefined],
    ]);
    expect(subjectOf(facts[0]!)).toEqual({ role: "check-in" });
  });

  it("words that hold a date, a clock or the answer's own word are dropped", () => {
    const text = "Harbor House\nCheck-in: 12 March 2027 from 3pm\nFlight UA 123 departs SFO 10:15 AM on March 4, 2027.\nYour ride on Thursday 10 June 2027 was a pleasure.";
    const found = spotCandidates(text);
    const facts = judgedFacts(
      {
        d1: "check-in",
        d1w: "Check-in: 12 March 2027 from 3pm",
        d2: "depart",
        d2w: "Flight UA 123 departs SFO",
        d3: "event",
        d3w: "Thursday 10 June 2027",
      },
      found,
      text,
      "other",
    );
    expect(facts.map((f) => [f.value, f.label])).toEqual([
      ["2027-03-12", "Check-in"],
      ["2027-03-04", "Departs"],
      ["2027-06-10", undefined],
    ]);
    // A place that only starts with the answer's word keeps what follows it.
    const stay = judgedFacts({ d1: "check-in", d1w: "Check-in: Harbor House" }, spotCandidates("Check-in: Harbor House, 12 March 2027."), "Check-in: Harbor House, 12 March 2027.", "other");
    expect(stay.map((f) => f.label)).toEqual(["Check-in: Harbor House"]);
  });

  it("a departure and an arrival say what they are, and are not a flight without one", () => {
    const text = "Train IC 521 leaves Porto Campanha at 08:05 on 11 June 2027 and arrives at Lisboa Santa Apolonia at 10:55.";
    const facts = judgedFacts({ d1: "depart", d1w: "Porto Campanha", d2: "arrive", d2w: "Lisboa Santa Apolonia" }, spotCandidates(text), text, "other");
    expect(facts.map((f) => [f.value, f.time, subjectOf(f)?.role, subjectOf(f)?.mode])).toEqual([
      ["2027-06-11", "08:05", "depart", undefined],
      ["2027-06-11", "10:55", "arrive", undefined],
    ]);
  });

  it("a date whose year was assumed, or that could be read two ways, says so on its fact", () => {
    const text = "Your order has shipped. Arriving Thursday, November 12. Pay by 03/04/2028.";
    const found = spotCandidates(text, { writtenAt: Date.parse("2026-11-09T12:00:00Z") });
    const facts = judgedFacts({ d1: "event", d1w: "Arriving", d2: "due" }, found, text, "delivery");
    expect(facts.map((f) => [f.value, f.assumedYear, f.ambiguous])).toEqual([
      ["2026-11-12", true, undefined],
      ["2028-03-04", undefined, true],
    ]);
  });

  it("a judged due date and a label's due date for the same day are one fact two readers agree on, unless its year was assumed", () => {
    const judged = read({ d4: "due" });
    const label: Fact = { id: "due:2027-05-15", kind: "due", document: "other", value: "2027-05-15", source: "label", confidence: 0.7 };
    const merged = mergeFacts([label], judged);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ accepted: "agreement" });
    const assumed = mergeFacts([{ ...label, assumedYear: true }], judged.map((f) => ({ ...f, assumedYear: true })));
    expect(isTracked(assumed[0]!)).toBe(false);
  });
});
