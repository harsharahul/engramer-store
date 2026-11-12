import { describe, expect, it } from "vitest";
import { spotCandidates, type Candidate } from "./candidates";

const dates = (found: Candidate[]) => found.filter((c) => c.what === "date").map((c) => [c.key, c.value, c.time]);
const amounts = (found: Candidate[]) => found.filter((c) => c.what === "amount").map((c) => [c.key, c.value, c.unit]);

describe("the dates a document holds, each with the clock beside it", () => {
  it("a room ready from a time on a day, and a key to leave by a time on another", () => {
    const found = spotCandidates(
      "Hello! Your room is ready for you from 15:00 on 8 April 2027. Please leave the key at reception by 11:00 on 12 April 2027. Warm regards.",
    );
    expect(dates(found)).toEqual([
      ["d1", "2027-04-08", "15:00"],
      ["d2", "2027-04-12", "11:00"],
    ]);
    expect(found[0]).toMatchObject({ printed: "8 April 2027, 15:00", sentence: "Your room is ready for you from 15:00 on 8 April 2027." });
  });

  it("a date with two clocks in its sentence is two candidates", () => {
    const found = spotCandidates("Train IC 521 leaves Porto Campanha at 08:05 on 11 June 2027 and arrives at Lisboa Santa Apolonia at 10:55. Coach 4, seat 61.");
    expect(dates(found)).toEqual([
      ["d1", "2027-06-11", "08:05"],
      ["d2", "2027-06-11", "10:55"],
    ]);
  });

  it("a clock in another sentence is not this date's", () => {
    expect(dates(spotCandidates("Can we move dinner on Friday 14 May 2027 to 20:00? The 19:00 slot is gone."))).toEqual([["d1", "2027-05-14", "20:00"]]);
    expect(dates(spotCandidates("The show is on 5 May 2027. Doors open at 18:00."))).toEqual([["d1", "2027-05-05", undefined]]);
  });

  it("reads a clock written 3pm, 2:30 PM or 14:30", () => {
    expect(dates(spotCandidates("Check-in: 12 March 2027 from 3pm\nYour appointment is on December 8, 2026 at 2:30 PM\nDeparture 4 March 2027 14:30"))).toEqual([
      ["d1", "2027-03-12", "15:00"],
      ["d2", "2026-12-08", "14:30"],
      ["d3", "2027-03-04", "14:30"],
    ]);
  });

  it("the same date and clock twice is one candidate, and a date with many clocks keeps the two nearest", () => {
    expect(dates(spotCandidates("Due 20 November 2026.\nReminder: due 20 November 2026."))).toEqual([["d1", "2026-11-20", undefined]]);
    expect(dates(spotCandidates("12 Nov 2026: 09:00 keynote, 10:30 break, 12:00 lunch, 14:00 workshop"))).toEqual([
      ["d1", "2026-11-12", "09:00"],
      ["d2", "2026-11-12", "10:30"],
    ]);
  });

  it("a date with no year is a candidate only with the day the message was written", () => {
    const text = "Your order has shipped. Arriving Thursday, November 12 by 8pm.";
    expect(spotCandidates(text)).toEqual([]);
    expect(spotCandidates(text, { writtenAt: Date.parse("2026-11-09T12:00:00Z") })).toEqual([
      expect.objectContaining({ key: "d1", value: "2026-11-12", time: "20:00", assumedYear: true }),
    ]);
  });

  it("a date that could be read two ways says so", () => {
    expect(spotCandidates("Pay by 03/04/2028")[0]).toMatchObject({ value: "2028-03-04", ambiguous: true });
  });

  it("a date in the last line of a long document is a candidate", () => {
    const text = `${"Terms and conditions apply to every booking made with us. ".repeat(700)}\nYour stay begins on 4 March 2027.`;
    expect(text.length).toBeGreaterThan(40_000);
    expect(dates(spotCandidates(text))).toEqual([["d1", "2027-03-04", undefined]]);
  });
});

describe("the amounts a document holds", () => {
  it("each amount with its currency is a candidate", () => {
    expect(amounts(spotCandidates("Your water bill for the quarter is USD 64.10. Please pay by 15 May 2027."))).toEqual([["a1", "64.10", "USD"]]);
    expect(amounts(spotCandidates("Trattoria Sole\n2 x Pasta 32.00\n1 x Wine 18.00\nTotal EUR 50.00\nThank you"))).toEqual([["a1", "50.00", "EUR"]]);
  });

  it("an amount stands in its own sentence", () => {
    const [amount] = spotCandidates("We have refunded USD 19.99 to your card. It can take 5 to 10 days to appear.");
    expect(amount).toMatchObject({ what: "amount", printed: "USD 19.99", sentence: "We have refunded USD 19.99 to your card." });
  });
});

describe("a long statement does not flood the reader", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `${String((i % 28) + 1).padStart(2, "0")} March 2027 Coffee no. ${i} USD ${(i + 4).toFixed(2)}`);
  const statement = ["Card statement", ...lines, "Total due USD 1,240.18"].join("\n");

  it("gives ten dates and six amounts, the total among them", () => {
    const found = spotCandidates(statement);
    expect(dates(found)).toHaveLength(10);
    expect(amounts(found)).toHaveLength(6);
    expect(amounts(found)[0]).toEqual(["a1", "1240.18", "USD"]);
  });

  it("keeps every sentence short", () => {
    const one = `Your booking for ${"a very long description of the room ".repeat(20)} begins on 4 March 2027 and ${"continues ".repeat(40)}.`;
    const [found] = spotCandidates(one);
    expect(found!.sentence.length).toBeLessThanOrEqual(200);
    expect(found!.sentence).toContain("4 March 2027");
  });
});

describe("nothing to judge", () => {
  it("no dates and no amounts: no candidates", () => {
    expect(spotCandidates("Great to see you! Here are the photos from the weekend. Talk soon.")).toEqual([]);
    expect(spotCandidates("")).toEqual([]);
  });

  it("an amount with no currency, a clock alone and a year alone are not candidates", () => {
    expect(spotCandidates("Table for 4 at 19:30, about 45.00 each, since 2019.")).toEqual([]);
  });
});
