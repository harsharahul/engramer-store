import { describe, expect, it } from "vitest";
import { spotCandidates } from "./candidates";
import { judgedFacts } from "./judge";
import { labelledFacts } from "./labels";
import { reservationFacts } from "./reservation";
import {
  alreadyRead,
  asFacts,
  groundFacts,
  isTracked,
  settleDisputes,
  maskTail,
  mergeFacts,
  offeredFacts,
  reconcileFacts,
  type Fact,
} from "./facts";

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "f1",
  kind: "expiry",
  document: "drivers-license",
  value: "2029-03-12",
  source: "label",
  confidence: 0.7,
  ...over,
});

describe("groundFacts", () => {
  it("keeps a fact whose date appears in the source", () => {
    expect(groundFacts([fact()], "Expires 03/12/2029")).toHaveLength(1);
  });

  it("an ics fact is structured and never grounded away", () => {
    // A calendar invite states its own times; there is no text to check them against.
    const invite = fact({ kind: "event", document: "event-ticket", source: "ics", confidence: 1, label: "Concert" });
    expect(groundFacts([invite], "")).toEqual([invite]);
  });

  it("discards a fact whose date appears nowhere in the source", () => {
    expect(groundFacts([fact()], "Expires 04/01/2030")).toHaveLength(0);
  });

  it("matches a date written the long way", () => {
    expect(groundFacts([fact()], "Valid until 12 March 2029")).toHaveLength(1);
  });

  it("matches a date written month first", () => {
    expect(groundFacts([fact()], "Valid until March 12, 2029")).toHaveLength(1);
  });

  it("matches a zero-padded day, which documents print interchangeably", () => {
    const early = fact({ value: "2029-03-02" });
    expect(groundFacts([early], "Valid until March 02, 2029")).toHaveLength(1);
    expect(groundFacts([early], "Valid until 2029 March 02")).toHaveLength(1);
    expect(groundFacts([early], "Valid until 02 March 2029")).toHaveLength(1);
  });

  it("never discards a fact the user entered by hand", () => {
    const typed = fact({ source: "user", value: "2031-01-01" });
    expect(groundFacts([typed], "nothing relevant here")).toHaveLength(1);
  });

  it("never discards a structured read, which has no free text to match", () => {
    expect(groundFacts([fact({ source: "barcode" })], "")).toHaveLength(1);
  });

  it("keeps a fact whose time also appears in the source", () => {
    const flight = fact({ kind: "event", time: "09:40" });
    expect(groundFacts([flight], "Departs 12 March 2029 at 09:40")).toHaveLength(1);
  });

  it("matches a time the document wrote the twelve hour way", () => {
    const flight = fact({ kind: "event", time: "21:40" });
    expect(groundFacts([flight], "Departs 12 March 2029 at 9:40 PM")).toHaveLength(1);
  });

  it("discards a fact whose date is right but whose time is not in the source", () => {
    const flight = fact({ kind: "event", time: "09:40" });
    expect(groundFacts([flight], "Departs 12 March 2029 at 18:15")).toHaveLength(0);
  });

  it("matches a whole hour the document wrote without a colon", () => {
    const stay = fact({ kind: "event", time: "15:00" });
    expect(groundFacts([stay], "Check-in 12 March 2029 from 3pm")).toHaveLength(1);
    expect(groundFacts([stay], "Check-in 12 March 2029 from 3 p.m.")).toHaveLength(1);
    expect(groundFacts([fact({ kind: "event", time: "00:00" })], "Ends 12 March 2029 at 12am")).toHaveLength(1);
  });

  it("a date whose year was assumed is found by its month and day, as a date and not as a run of characters", () => {
    const arriving = fact({ kind: "event", value: "2026-11-12", assumedYear: true });
    for (const text of ["Arriving Thursday, November 12", "Arriving Thu 12 Nov", "Arriving Nov. 12th", "Arriving 12th November"]) {
      expect(groundFacts([arriving], text), text).toHaveLength(1);
    }
    for (const text of ["Arriving November 1", "Arriving November 120 Main St", "Arriving 2 November", "Arriving December 12"]) {
      expect(groundFacts([fact({ kind: "event", value: "2026-11-12", assumedYear: true })], text), text).toHaveLength(0);
    }
  });

  it("a month and a year ground a date only where the document names no day", () => {
    const proposed = (value: string) => fact({ kind: "due", value, source: "model", confidence: 0.45 });
    // The document names another day of that month: the proposal is a wrong day.
    expect(groundFacts([proposed("2026-11-03")], "Your appointment is on 14 Nov 2026.")).toHaveLength(0);
    expect(groundFacts([proposed("2027-04-15")], "Your room is ready from 15:00 on 8 April 2027.")).toHaveLength(0);
    expect(groundFacts([proposed("2027-04-15")], "Ready on April 8, 2027.")).toHaveLength(0);
    // A card or a permit that prints only its month and year.
    expect(groundFacts([proposed("2026-11-30")], "Card valid thru Nov 2026")).toHaveLength(1);
    expect(groundFacts([proposed("2029-11-01")], "Expires November 2029")).toHaveLength(1);
    expect(groundFacts([proposed("2029-11-01")], "Expires: November, 2029")).toHaveLength(1);
  });

  it("does not find a whole hour in the tail of another clock", () => {
    const stay = fact({ kind: "event", time: "15:00" });
    expect(groundFacts([stay], "Departs 12 March 2029 at 12:03pm")).toHaveLength(0);
    expect(groundFacts([stay], "Departs 12 March 2029 at 13pm")).toHaveLength(0);
    expect(groundFacts([stay], "Departs 12 March 2029 at 3am")).toHaveLength(0);
  });

  it("grounds a non-date value literally", () => {
    const amount = fact({ kind: "amount", value: "410.00", source: "pattern" });
    expect(groundFacts([amount], "Total due: $410.00")).toHaveLength(1);
    expect(groundFacts([amount], "Total due: $9.99")).toHaveLength(0);
  });
});

describe("offeredFacts", () => {
  const NOW = Date.UTC(2026, 7, 5);
  const shelf = (facts: Fact[]) => [{ id: "f1", trashed: false, facts }];

  it("offers an unanswered future date", () => {
    expect(offeredFacts(shelf([fact({ value: "2027-10-19" })]), NOW)).toHaveLength(1);
  });

  it("keeps a long-past date out of the queue, however unanswered", () => {
    // A thousand old documents carry mostly past dates. None of them is a
    // deadline anymore, so a bulk upload must not bury the owner in cards.
    expect(offeredFacts(shelf([fact({ value: "2019-05-01" })]), NOW)).toHaveLength(0);
  });

  it("still offers a recently missed deadline, which is actionable", () => {
    expect(offeredFacts(shelf([fact({ kind: "due", value: "2026-07-28" })]), NOW)).toHaveLength(1);
  });

  it("offers a labelled date whose meaning is unknown", () => {
    const generic = fact({ kind: "dated", value: "2027-10-19", label: "Benefit End Date" });
    expect(offeredFacts(shelf([generic]), NOW)).toHaveLength(1);
  });

  it("never re-offers what is answered, and never reads trash", () => {
    expect(offeredFacts(shelf([fact({ value: "2027-10-19", confirmed: true })]), NOW)).toHaveLength(0);
    expect(offeredFacts(shelf([fact({ value: "2027-10-19", dismissed: true })]), NOW)).toHaveLength(0);
    expect(
      offeredFacts([{ id: "f1", trashed: true, facts: [fact({ value: "2027-10-19" })] }], NOW),
    ).toHaveLength(0);
  });
});

describe("mergeFacts and corrected values", () => {
  it("does not re-offer a value the owner already confirmed under another identity", () => {
    // A fact corrected from 10 May to 19 October keeps its original id.
    // A rescan then finds 19 October under a new id; the owner already
    // said it, so it is not news.
    const corrected = fact({ id: "expiry:2027-05-10", value: "2027-10-19", confirmed: true });
    const refound = fact({ id: "expiry:2027-10-19", value: "2027-10-19" });
    const merged = mergeFacts([corrected], [refound]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("expiry:2027-05-10");
  });
});

describe("reconcileFacts", () => {
  const confirmed = fact({ digest: "d1", confirmed: true });

  it("keeps a confirmed fact the new contents still say, and moves it forward", () => {
    const [out] = reconcileFacts([confirmed], [fact({ digest: "d2" })], "d2");
    expect(out).toMatchObject({ confirmed: true, digest: "d2" });
    expect(out!.stale).toBeFalsy();
  });

  it("keeps a confirmed fact the new contents dropped, and says so", () => {
    const [out] = reconcileFacts([confirmed], [], "d2");
    expect(out).toMatchObject({ confirmed: true, stale: true });
  });

  it("leaves a stale fact pointing at the contents it actually came from", () => {
    expect(reconcileFacts([confirmed], [], "d2")[0]!.digest).toBe("d1");
  });

  it("drops an unconfirmed fact the new contents no longer support", () => {
    expect(reconcileFacts([fact({ digest: "d1" })], [], "d2")).toEqual([]);
  });

  it("clears staleness when a later edit puts the value back", () => {
    const stale = fact({ digest: "d1", confirmed: true, stale: true });
    expect(reconcileFacts([stale], [fact({ digest: "d3" })], "d3")[0]!.stale).toBeFalsy();
  });

  it("does not bring back something the owner dismissed", () => {
    const dismissed = fact({ digest: "d1", dismissed: true });
    const [out] = reconcileFacts([dismissed], [fact({ digest: "d2" })], "d2");
    expect(out!.dismissed).toBe(true);
  });

  it("adds what the new contents introduced, unconfirmed", () => {
    const fresh = fact({ id: "f2", kind: "due", value: "2026-09-01" });
    const out = reconcileFacts([], [fresh], "d2");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "f2", digest: "d2" });
    expect(out[0]!.confirmed).toBeFalsy();
  });

  it("still caps what one file may carry", () => {
    const many = Array.from({ length: 30 }, (_, i) => fact({ id: `f${i}` }));
    expect(reconcileFacts([], many, "d2").length).toBe(12);
  });
});

describe("asFacts", () => {
  it("reads facts back out of what metadata carried", () => {
    const stored = [{ ...fact(), confirmed: true }];
    expect(asFacts(stored)).toEqual(stored);
  });

  it("returns nothing for a file that carries none", () => {
    expect(asFacts(undefined)).toEqual([]);
    expect(asFacts(null)).toEqual([]);
    expect(asFacts("not a list")).toEqual([]);
  });

  it("drops an entry missing a field every fact must have", () => {
    expect(asFacts([{ id: "a", kind: "expiry" }])).toEqual([]);
    expect(asFacts([{ ...fact(), confidence: "high" }])).toEqual([]);
  });

  it("keeps a kind it does not recognize, rather than deleting what a newer version wrote", () => {
    // An older client reading metadata a newer one wrote must store it back
    // unchanged. Validating the vocabulary here would quietly destroy it.
    const future = { ...fact(), kind: "carbon-offset", id: "f9" };
    expect(asFacts([future])).toEqual([future]);
  });

  it("caps what one file may carry, however much metadata claimed", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...fact(), id: `f${i}` }));
    expect(asFacts(many).length).toBe(12);
  });

  it("reads back a whole booking: exact readings beside the twelve soft ones, thirty-two at most", () => {
    const exact = Array.from({ length: 40 }, (_, i) => ({ ...fact(), id: `e${i}`, source: "jsonld", confidence: 1 }));
    const soft = Array.from({ length: 40 }, (_, i) => ({ ...fact(), id: `s${i}` }));
    expect(asFacts([...exact.slice(0, 16), ...soft]).map((kept) => kept.id)).toEqual([...exact.slice(0, 16), ...soft.slice(0, 12)].map((kept) => kept.id));
    expect(asFacts([...exact, ...soft]).length).toBe(32);
  });
});

describe("maskTail", () => {
  it("keeps only the last four characters", () => {
    expect(maskTail("D1234567")).toBe("4567");
  });

  it("returns a short value unchanged rather than revealing nothing", () => {
    expect(maskTail("123")).toBe("123");
  });
});

describe("a stored form line, read again by what its label means", () => {
  const NOW = Date.UTC(2027, 2, 1);
  const shelf = (facts: Fact[]) => [{ id: "f1", trashed: false, facts }];
  // The line as it was stored before its label had a meaning, and as it is read now.
  const named = (over: Partial<Fact> = {}) =>
    fact({ id: "dated:2028-08-02", kind: "dated", document: "other", value: "2028-08-02", label: "Cover ends", confidence: 0.4, ...over });
  const typed = fact({ id: "expiry:2028-08-02", kind: "expiry", document: "other", value: "2028-08-02", label: "Cover ends" });

  it("a line the owner said no to does not come back typed", () => {
    const merged = mergeFacts([named({ dismissed: true })], [typed]);
    expect(merged.filter((held) => !held.dismissed)).toEqual([]);
    expect(offeredFacts(shelf(merged), NOW)).toEqual([]);
  });

  it("a line the owner confirmed stays as it was confirmed", () => {
    const merged = mergeFacts([named({ confirmed: true })], [typed]);
    expect(merged.map((held) => [held.kind, held.value, held.confirmed])).toEqual([["dated", "2028-08-02", true]]);
  });

  it("an unanswered line that only names its date gives way to the typed reading", () => {
    expect(mergeFacts([named()], [typed]).map((held) => [held.kind, held.value])).toEqual([["expiry", "2028-08-02"]]);
    // Whichever arrives first.
    expect(mergeFacts([typed], [named()]).map((held) => [held.kind, held.value])).toEqual([["expiry", "2028-08-02"]]);
  });

  it("booking data on a day the owner answered still stands", () => {
    const booked = fact({ id: "event:2028-08-02 stay", kind: "event", value: "2028-08-02", source: "jsonld", confidence: 1, accepted: "exact" });
    expect(mergeFacts([named({ dismissed: true })], [booked]).map((held) => held.id)).toContain(booked.id);
  });
});

describe("mergeFacts", () => {
  it("keeps a confirmed fact even when a rescan no longer finds it", () => {
    const confirmed = fact({ confirmed: true });
    expect(mergeFacts([confirmed], [])).toEqual([confirmed]);
  });

  it("does not resurrect a dismissed fact", () => {
    const dismissed = fact({ dismissed: true });
    expect(mergeFacts([dismissed], [fact()])[0]!.dismissed).toBe(true);
  });

  it("prefers the higher-confidence source when both found the same value", () => {
    const merged = mergeFacts([fact()], [fact({ source: "mrz", confidence: 1 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("mrz");
  });

  it("leaves a weaker rescan of the same value alone", () => {
    const merged = mergeFacts([fact({ source: "mrz", confidence: 1 })], [fact()]);
    expect(merged[0]!.source).toBe("mrz");
  });

  it("appends a value the file did not carry before", () => {
    const found = fact({ id: "f2", kind: "due", value: "2026-09-01" });
    expect(mergeFacts([fact()], [found])).toHaveLength(2);
  });

  it("caps how many soft readings one file may carry, dropping the weakest", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      fact({
        id: `f${i}`,
        value: `2029-03-${String((i % 28) + 1).padStart(2, "0")}`,
        confidence: i === 0 ? 0.7 : 0.3,
      }),
    );
    const merged = mergeFacts([], many);
    expect(merged).toHaveLength(12);
    expect(merged[0]!.confidence).toBe(0.7);
  });

  it("an exact reading does not use up the room for soft ones", () => {
    const exact = Array.from({ length: 16 }, (_, i) => fact({ id: `e${i}`, kind: "event", value: `2029-04-${String(i + 1).padStart(2, "0")}`, source: "jsonld", confidence: 1 }));
    const soft = Array.from({ length: 30 }, (_, i) => fact({ id: `s${i}`, value: `2029-03-${String((i % 28) + 1).padStart(2, "0")}`, confidence: 0.3 }));
    const merged = mergeFacts([], [...soft, ...exact]);
    expect(merged.filter((kept) => kept.confidence === 1)).toHaveLength(16);
    expect(merged.filter((kept) => kept.confidence < 1)).toHaveLength(12);
  });

  it("among weak readings, the limit still keeps amounts before reference numbers", () => {
    // Harvested from a long receipt: what was paid matters more than its codes.
    const codes = Array.from({ length: 14 }, (_, i) => fact({ id: `identifier:AB${i}`, kind: "identifier", value: `AB${i}0000`, source: "pattern", confidence: 0.3 }));
    const paid = fact({ id: "amount:410.00", kind: "amount", value: "410.00", unit: "USD", source: "pattern", confidence: 0.3 });
    expect(mergeFacts([], [...codes, paid]).some((kept) => kept.kind === "amount")).toBe(true);
  });
});

describe("isTracked", () => {
  it("counts confirmed or accepted, never dismissed", () => {
    expect(isTracked(fact({ confirmed: true }))).toBe(true);
    expect(isTracked(fact({ accepted: "exact" }))).toBe(true);
    expect(isTracked(fact({ accepted: "agreement" }))).toBe(true);
    expect(isTracked(fact())).toBe(false);
    expect(isTracked(fact({ accepted: "exact", dismissed: true }))).toBe(false);
    expect(isTracked(fact({ confirmed: true, dismissed: true }))).toBe(false);
  });

  it("reads an exact fact stored before the marker existed as accepted", () => {
    // Booking data read by an earlier version carries no marker but counted
    // then; it must keep counting.
    const [old] = asFacts([fact({ source: "jsonld", confidence: 1, kind: "event" })]);
    expect(old!.accepted).toBe("exact");
    const [soft] = asFacts([fact({ source: "label", confidence: 0.7 })]);
    expect(soft!.accepted).toBeUndefined();
    const [offered] = asFacts([fact({ source: "barcode", confidence: 0.6 })]);
    expect(offered!.accepted).toBeUndefined();
  });
});

describe("one order between readers", () => {
  const NOW = Date.UTC(2027, 2, 1);
  const checkin = (over: Partial<Fact>): Fact =>
    fact({
      id: "event:2027-03-04 check-in: the larkspur hotel",
      kind: "event",
      document: "hotel-booking",
      value: "2027-03-04",
      label: "Check-in: The Larkspur Hotel",
      ...over,
    });

  it("booking data beats the model on a departure time", () => {
    const exact = checkin({ time: "15:00", zone: "+01:00", source: "jsonld", confidence: 1, accepted: "exact" });
    const model = checkin({ time: "14:00", source: "model", confidence: 0.45 });
    for (const merged of [mergeFacts([model], [exact]), mergeFacts([exact], [model])]) {
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({ time: "15:00", source: "jsonld", accepted: "exact" });
    }
    expect(offeredFacts([{ id: "f", trashed: false, facts: mergeFacts([], [exact, model]) }], NOW)).toEqual([]);
  });

  it("a model date and a label date that agree are accepted together", () => {
    const due = (source: Fact["source"], confidence: number) =>
      fact({ id: "due:2027-04-10", kind: "due", document: "invoice", value: "2027-04-10", source, confidence });
    const merged = mergeFacts([due("label", 0.7)], [due("model", 0.45)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ accepted: "agreement", reader: "label + model" });
    expect(isTracked(merged[0]!)).toBe(true);
  });

  it("a date whose year was assumed stays a question, even when a second reader names the same day", () => {
    const due = (source: Fact["source"], confidence: number, extra: Partial<Fact> = {}) =>
      fact({ id: "due:2026-11-13", kind: "due", document: "other", value: "2026-11-13", source, confidence, ...extra });
    for (const merged of [
      mergeFacts([due("label", 0.5, { assumedYear: true })], [due("model", 0.45)]),
      mergeFacts([due("model", 0.45)], [due("label", 0.5, { assumedYear: true })]),
    ]) {
      expect(merged).toHaveLength(1);
      expect(merged[0]!.accepted).toBeUndefined();
      expect(merged[0]!.assumedYear).toBe(true);
      expect(isTracked(merged[0]!)).toBe(false);
    }
  });

  it("two readers that disagree on an amount ask once", () => {
    const amount = (value: string, source: Fact["source"], confidence: number) =>
      fact({ id: `amount:${value}`, kind: "amount", document: "invoice", value, unit: "USD", label: "Amount due", source, confidence });
    const merged = mergeFacts([amount("56.00", "label", 0.7)], [amount("65.00", "model", 0.45)]);
    expect(merged).toHaveLength(2);
    expect(merged.every((f) => f.disputed !== undefined && f.accepted === undefined)).toBe(true);
    const offered = offeredFacts([{ id: "f", trashed: false, facts: merged }], NOW);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.alternative?.value).toBe(offered[0]!.fact.value === "56.00" ? "65.00" : "56.00");

    // The owner picks one: the other is dismissed, and nothing asks again.
    const answered = settleDisputes(merged.map((f) => (f.value === "65.00" ? { ...f, confirmed: true } : f)));
    expect(answered.find((f) => f.value === "56.00")!.dismissed).toBe(true);
    expect(offeredFacts([{ id: "f", trashed: false, facts: answered }], NOW)).toEqual([]);
    const rescanned = mergeFacts(answered, [amount("56.00", "label", 0.7), amount("65.00", "model", 0.45)]);
    expect(rescanned).toEqual(answered);
  });

  it("a confirmed fact is never displaced by a later reading", () => {
    const mine = fact({ id: "due:2027-04-10", kind: "due", document: "invoice", value: "2027-04-10", confirmed: true });
    const exact = fact({
      id: "due:2027-04-12",
      kind: "due",
      document: "invoice",
      value: "2027-04-12",
      source: "jsonld",
      confidence: 1,
      accepted: "exact",
    });
    expect(mergeFacts([mine], [exact])).toEqual([mine]);
  });

  it("an exact due date settles a softer reading of the same date slot", () => {
    const model = fact({ id: "due:2027-04-01", kind: "due", document: "invoice", value: "2027-04-01", source: "model", confidence: 0.45 });
    const exact = fact({
      id: "due:2027-04-10",
      kind: "due",
      document: "invoice",
      value: "2027-04-10",
      source: "jsonld",
      confidence: 1,
      accepted: "exact",
    });
    expect(mergeFacts([model], [exact]).map((f) => f.value)).toEqual(["2027-04-10"]);
  });
});

describe("readers as they really meet", () => {
  const NOW = Date.UTC(2027, 2, 1);

  it("booking data on a date settles the model's own reading of that date", () => {
    // Real ids: the model's carries its own label and clock, so it never
    // shares an id with the booking data's.
    const exact = reservationFacts(
      `<script type="application/ld+json">{"@type":"LodgingReservation","checkinTime":"2027-03-04T15:00:00+01:00","reservationFor":{"name":"Casa do Rio"}}</script>`,
    ).map((f) => ({ ...f, accepted: "exact" as const }));
    const text = "Check-in from 14:00 on 4 March 2027 at Casa do Rio.";
    const model = judgedFacts({ d1: "check-in", d1w: "Casa do Rio" }, spotCandidates(text), text, "hotel-booking");
    expect(model.map((f) => [f.value, f.time, f.source])).toEqual([["2027-03-04", "14:00", "model"]]);
    const merged = mergeFacts(exact, model);
    expect(merged.filter((f) => f.kind === "event").map((f) => [f.time, f.source])).toEqual([["15:00", "jsonld"]]);
    expect(offeredFacts([{ id: "f", trashed: false, facts: merged }], NOW)).toEqual([]);
  });

  it("a moment a rule already read is one fact: the model's reading of it is an echo", () => {
    // The rules read the labelled lines; the model is asked about every date
    // in the text, so it judges the same two moments under its own words.
    const text = "Harbor House\nCheck-in: 12 March 2027 from 3pm\nCheck-out: 15 March 2027 by 11am";
    const rules = labelledFacts(text);
    const model = judgedFacts({ d1: "check-in", d1w: "Harbor House", d2: "check-out", d2w: "Harbor House" }, spotCandidates(text), text, "hotel-booking");
    expect(model).toHaveLength(2);
    for (const merged of [mergeFacts(rules, model), mergeFacts(model, rules)]) {
      const moments = merged.filter((f) => f.kind === "event");
      expect(moments.map((f) => [f.value, f.time, f.source])).toEqual([
        ["2027-03-12", "15:00", "label"],
        ["2027-03-15", "11:00", "label"],
      ]);
      // An echo is no second witness: the rule's reading still asks.
      expect(moments.some((f) => f.accepted !== undefined)).toBe(false);
    }
  });

  it("a moment with no clock and the model's reading of that day with one are the same moment", () => {
    const rule = fact({ id: "event:2026-11-12 delivery expected by", kind: "event", value: "2026-11-12", label: "Delivery expected by", source: "label", confidence: 0.7 });
    const model = fact({ id: "event:2026-11-12 arrives 13:00", kind: "event", value: "2026-11-12", time: "13:00", label: "Arrives", source: "model", confidence: 0.45 });
    expect(mergeFacts([rule], [model]).map((f) => f.source)).toEqual(["label"]);
  });

  it("another clock on the same day is another moment, and stays", () => {
    const rule = fact({ id: "event:2027-03-04 departs sfo", kind: "event", value: "2027-03-04", time: "10:15", label: "Departs SFO", source: "label", confidence: 0.7 });
    const model = fact({ id: "event:2027-03-04 arrives jfk 18:45", kind: "event", value: "2027-03-04", time: "18:45", label: "Arrives JFK", source: "model", confidence: 0.45 });
    expect(mergeFacts([rule], [model]).map((f) => [f.time, f.source])).toEqual([
      ["10:15", "label"],
      ["18:45", "model"],
    ]);
  });

  it("a date a form line only names gives way to what the model says it is: one date, one question", () => {
    // "Date: Saturday 15 May 2027" on a ticket is a labelled date with no
    // meaning of its own; the model says the journey leaves then.
    const named = fact({ id: "dated:2027-05-15", kind: "dated", value: "2027-05-15", label: "Date", source: "label", confidence: 0.4 });
    const judged = fact({ id: "event:2027-05-15 departs eastbridge 08:42", kind: "event", value: "2027-05-15", time: "08:42", label: "Departs Eastbridge", source: "model", confidence: 0.45 });
    for (const merged of [mergeFacts([named], [judged]), mergeFacts([judged], [named])]) {
      expect(merged.map((f) => [f.kind, f.source])).toEqual([["event", "model"]]);
    }
    // The model's no to the meaning does not bring the bare line back as a second question.
    expect(mergeFacts([{ ...judged, dismissed: true }], [named]).filter((f) => !f.dismissed)).toEqual([]);
    // A line the owner confirmed stays, whatever the model says later.
    expect(mergeFacts([{ ...named, confirmed: true }], [judged]).some((f) => f.kind === "dated" && f.confirmed)).toBe(true);
    // Another day's line is untouched.
    const other = fact({ id: "dated:2027-05-02", kind: "dated", value: "2027-05-02", label: "Booked on", source: "label", confidence: 0.4 });
    expect(mergeFacts([other], [judged]).map((f) => f.kind).sort()).toEqual(["dated", "event"]);
  });

  it("a moment the owner said no to does not come back as the model's reading of it", () => {
    const rule = fact({ id: "event:2026-12-08 appointment", kind: "event", value: "2026-12-08", time: "14:30", label: "Appointment", source: "label", confidence: 0.7, dismissed: true });
    const model = fact({ id: "event:2026-12-08 dental check-up 14:30", kind: "event", value: "2026-12-08", time: "14:30", label: "Dental check-up", source: "model", confidence: 0.45 });
    expect(mergeFacts([rule], [model]).filter((f) => !f.dismissed)).toEqual([]);
  });

  it("a model moment the owner confirmed is not taken back when a rule reads the same one later", () => {
    const rule = fact({ id: "event:2026-12-08 appointment", kind: "event", value: "2026-12-08", time: "14:30", label: "Appointment", source: "label", confidence: 0.7 });
    const model = fact({ id: "event:2026-12-08 dental check-up 14:30", kind: "event", value: "2026-12-08", time: "14:30", label: "Dental check-up", source: "model", confidence: 0.45, confirmed: true });
    expect(mergeFacts([model], [rule]).some((f) => f.source === "model" && f.confirmed)).toBe(true);
  });

  it("an ambiguous date is never accepted by agreement", () => {
    const due = (source: Fact["source"], confidence: number, ambiguous: boolean) =>
      fact({ id: "due:2027-03-04", kind: "due", document: "invoice", value: "2027-03-04", source, confidence, ...(ambiguous ? { ambiguous: true } : {}) });
    const merged = mergeFacts([due("label", 0.5, true)], [due("model", 0.45, false)]);
    expect(merged[0]!.accepted).toBeUndefined();
    expect(merged[0]!.ambiguous).toBe(true);
  });

  it("booking data's amount settles the model's amount even without a currency", () => {
    const exact = fact({ id: "amount:65.00", kind: "amount", document: "invoice", value: "65.00", unit: "USD", label: "Amount due", source: "jsonld", confidence: 1, accepted: "exact" });
    const model = fact({ id: "amount:56.00", kind: "amount", document: "invoice", value: "56.00", label: "Amount due", source: "model", confidence: 0.45 });
    expect(mergeFacts([exact], [model]).map((f) => f.value)).toEqual(["65.00"]);
  });

  it("a confirmed date does not silently drop another reading a rule found", () => {
    // Two installments: the owner confirmed one; the other is still worth asking about.
    const first = fact({ id: "due:2027-04-10", kind: "due", document: "invoice", value: "2027-04-10", confirmed: true });
    const second = fact({ id: "due:2027-05-10", kind: "due", document: "invoice", value: "2027-05-10", source: "label", confidence: 0.7 });
    expect(mergeFacts([first], [second]).map((f) => f.value).sort()).toEqual(["2027-04-10", "2027-05-10"]);
  });

  it("ignoring a disagreement settles both readings", () => {
    const pair = [
      fact({ id: "due:2027-04-01", kind: "due", document: "invoice", value: "2027-04-01", source: "label", confidence: 0.7, disputed: "due:2027-04-10" }),
      fact({ id: "due:2027-04-10", kind: "due", document: "invoice", value: "2027-04-10", source: "model", confidence: 0.45, disputed: "due:2027-04-01" }),
    ];
    const answered = settleDisputes(pair.map((f) => (f.source === "label" ? { ...f, dismissed: true } : f)));
    expect(answered.every((f) => f.dismissed === true)).toBe(true);
    expect(offeredFacts([{ id: "f", trashed: false, facts: answered }], NOW)).toEqual([]);
  });

  it("an answer an older build gave to one side is not asked again", () => {
    // An older build confirms one side and knows nothing of the pair.
    const facts = [
      fact({ id: "due:2027-04-01", kind: "due", document: "invoice", value: "2027-04-01", source: "label", confidence: 0.7, disputed: "due:2027-04-10" }),
      fact({ id: "due:2027-04-10", kind: "due", document: "invoice", value: "2027-04-10", source: "model", confidence: 0.45, disputed: "due:2027-04-01", confirmed: true }),
    ];
    expect(offeredFacts([{ id: "f", trashed: false, facts }], NOW)).toEqual([]);
  });
});

describe("what the model is not asked about again", () => {
  const event = (over: Partial<Fact>): Fact => fact({ id: `event:${over.value} ${over.label ?? ""}`, kind: "event", ...over });

  it("a date a rule or booking data gave a meaning, with its clock when it has one", () => {
    const known = alreadyRead([
      event({ value: "2027-03-04", time: "10:15", label: "Flight UA 123 departs SFO", source: "label", confidence: 0.7 }),
      fact({ id: "due:2027-06-30", kind: "due", value: "2027-06-30", source: "label", confidence: 0.7 }),
      event({ value: "2027-04-08", time: "15:00", label: "Check-in", source: "jsonld", confidence: 1, accepted: "exact" }),
    ]);
    expect(known.read).toEqual([{ value: "2027-03-04", time: "10:15" }, { value: "2027-06-30" }, { value: "2027-04-08", time: "15:00" }]);
    expect(known.total).toBe(false);
  });

  it("the model's own earlier reading is asked about again, unless the owner answered it", () => {
    const mine = event({ value: "2027-07-22", time: "09:30", label: "Dental check-up", source: "model", confidence: 0.45 });
    expect(alreadyRead([mine]).read).toEqual([]);
    expect(alreadyRead([{ ...mine, confirmed: true }]).read).toEqual([{ value: "2027-07-22", time: "09:30" }]);
    expect(alreadyRead([{ ...mine, dismissed: true }]).read).toEqual([{ value: "2027-07-22", time: "09:30" }]);
  });

  it("a form line that only names a date has no meaning yet, so the model is asked", () => {
    expect(alreadyRead([fact({ id: "dated:2027-05-15", kind: "dated", value: "2027-05-15", label: "Date", source: "label", confidence: 0.4 })]).read).toEqual([]);
  });

  it("a date line the owner already answered is not asked about again under the model's words", () => {
    const line = fact({ id: "dated:2027-05-15", kind: "dated", value: "2027-05-15", label: "Date", source: "label", confidence: 0.4 });
    expect(alreadyRead([{ ...line, dismissed: true }]).read).toEqual([{ value: "2027-05-15" }]);
    expect(alreadyRead([{ ...line, confirmed: true }]).read).toEqual([{ value: "2027-05-15" }]);
    // So the answered day is no candidate, and nothing new asks about it.
    const text = "Date: 15 May 2027. Bring the form with you.";
    const asked = spotCandidates(text, undefined, alreadyRead([{ ...line, dismissed: true }]));
    expect(asked).toEqual([]);
  });

  it("a total a reader named is the total; an amount nobody named is not", () => {
    const amount = (over: Partial<Fact>): Fact => fact({ id: `amount:${over.value}`, kind: "amount", unit: "USD", ...over });
    expect(alreadyRead([amount({ value: "84.20", label: "Amount due", source: "label", confidence: 0.7 })]).total).toBe(true);
    expect(alreadyRead([amount({ value: "1184.00", label: "Total", source: "jsonld", confidence: 1 })]).total).toBe(true);
    expect(alreadyRead([amount({ value: "45.00", source: "pattern", confidence: 0.3 })]).total).toBe(false);
    expect(alreadyRead([amount({ value: "64.10", label: "Total", source: "model", confidence: 0.45 })]).total).toBe(false);
    expect(alreadyRead([amount({ value: "64.10", label: "Total", source: "model", confidence: 0.45, confirmed: true })]).total).toBe(true);
  });
});

describe("subjects across stores and rescans", () => {
  const checkIn = (over: Partial<Fact> = {}): Fact =>
    fact({ id: "event:2026-11-13 check-in: casa do rio", kind: "event", document: "hotel-booking", value: "2026-11-13", label: "Check-in: Casa do Rio", source: "jsonld", confidence: 1, ...over });

  it("a subject a newer version wrote is kept as written", () => {
    const stored = [checkIn({ subject: { role: "teleport", place: "Casa do Rio" } as never })];
    expect(asFacts(stored)[0]!.subject).toEqual({ role: "teleport", place: "Casa do Rio" });
  });

  it("a rescan brings a fact's subject forward and keeps the owner's answer", () => {
    const subject = { role: "check-in" as const, place: "Casa do Rio", address: "Rua das Flores 12, 1200-195 Lisboa" };
    const [out] = reconcileFacts([checkIn({ confirmed: true, digest: "d1" })], [checkIn({ subject, digest: "d2" })], "d2");
    expect(out).toMatchObject({ confirmed: true, digest: "d2", subject });
  });

  it("a confirmed fact gains its subject from a re-read by the same reader, and stays the owner's", () => {
    const said = (over: Partial<Fact> = {}): Fact =>
      fact({ id: "event:2026-11-13 room ready 15:00", kind: "event", document: "hotel-booking", value: "2026-11-13", time: "15:00", label: "Room ready", source: "model", confidence: 0.45, ...over });
    const subject = { role: "check-in" as const, place: "Casa Azulejo" };
    const [out] = mergeFacts([said({ confirmed: true })], [said({ subject })]);
    expect(out).toMatchObject({ confirmed: true, subject });
    // A different reader's words never become the owner's fact's meaning.
    const [kept] = mergeFacts([said({ confirmed: true })], [said({ subject, source: "label" })]);
    expect(kept!.subject).toBeUndefined();
  });

  it("a relabelled re-read lends its subject to the confirmed fact of the same date", () => {
    const confirmed = fact({ id: "event:2026-11-13 room ready 15:00", kind: "event", document: "hotel-booking", value: "2026-11-13", time: "15:00", label: "Room ready", source: "model", confidence: 0.45, confirmed: true });
    const relabelled = { ...confirmed, id: "event:2026-11-13 check-in 15:00", label: "Check-in", confirmed: undefined, subject: { role: "check-in" as const, place: "Casa Azulejo" } };
    const merged = mergeFacts([confirmed], [relabelled]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: confirmed.id, confirmed: true, subject: { role: "check-in", place: "Casa Azulejo" } });
  });

  it("a fresh reading adds its subject to the stored fact", () => {
    const subject = { role: "check-in" as const, place: "Casa do Rio", reservation: 0 };
    const [out] = mergeFacts([checkIn({ accepted: "exact" })], [checkIn({ subject })]);
    expect(out!.subject).toEqual(subject);
  });
});
