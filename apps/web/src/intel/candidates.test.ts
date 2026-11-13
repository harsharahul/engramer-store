import { describe, expect, it } from "vitest";
import { spotCandidates, type Candidate } from "./candidates";
import { settledNowhere } from "./labels";
import { lexiconFrom } from "./lexicon";

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

describe("a date that was over before a message was sent", () => {
  const text = "You ordered on 8 March 2027. Your sofa will arrive on 6 April 2027. Our records were updated on 21 March 2027 and again on 22 March 2027.";

  it("is not a candidate: nothing can still happen then; the sending day and the day before it are", () => {
    // Sent early on 22 March in UTC: still 21 March further west.
    const found = spotCandidates(text, { writtenAt: Date.UTC(2027, 2, 22, 2) });
    expect(found.map((c) => [c.key, c.value])).toEqual([
      ["d1", "2027-04-06"],
      ["d2", "2027-03-21"],
      ["d3", "2027-03-22"],
    ]);
  });

  it("a stored file is read the same way from the day it was kept", () => {
    expect(spotCandidates(text, undefined, { keptAt: Date.UTC(2027, 2, 22, 2) }).map((c) => c.value)).toEqual(["2027-04-06", "2027-03-21", "2027-03-22"]);
  });

  it("a text with no known day keeps every date", () => {
    expect(spotCandidates(text).map((c) => c.value)).toEqual(["2027-03-08", "2027-04-06", "2027-03-21", "2027-03-22"]);
  });

  it("days that are over do not use up the ten", () => {
    const statement = `${Array.from({ length: 14 }, (_, i) => `Payment received on ${i + 1} January 2027.`).join("\n")}\nYour next payment is due on 28 April 2027.`;
    expect(spotCandidates(statement, { writtenAt: Date.UTC(2027, 2, 22, 12) }).map((c) => c.value)).toEqual(["2027-04-28"]);
  });
});

describe("what a reader already settled is not a candidate", () => {
  const text =
    "Flight UA 123 departs SFO 10:15 AM on March 4, 2027, arrives JFK 6:45 PM. Your dental check-up is on 22 July 2027 at 09:30. Amount due: $84.20. Pay by 30 June 2027.";

  it("a day and clock a reader gave a meaning is left out; another clock that day, and every other date, stays", () => {
    const found = spotCandidates(text, undefined, { read: [{ value: "2027-03-04", time: "10:15" }, { value: "2027-06-30" }] });
    expect(found.filter((c) => c.what === "date").map((c) => [c.key, c.value, c.time])).toEqual([
      ["d1", "2027-03-04", "18:45"],
      ["d2", "2027-07-22", "09:30"],
    ]);
    expect(found.filter((c) => c.what === "amount").map((c) => c.value)).toEqual(["84.20"]);
  });

  it("a day read with no clock covers that day whatever clock stands beside it", () => {
    const found = spotCandidates(text, undefined, { read: [{ value: "2027-07-22" }] });
    expect(found.filter((c) => c.what === "date").map((c) => c.value)).toEqual(["2027-03-04", "2027-03-04", "2027-06-30"]);
  });

  it("a total a reader already named leaves no amount to ask about", () => {
    const found = spotCandidates(text, undefined, { total: true });
    expect(found.some((c) => c.what === "amount")).toBe(false);
    expect(found.filter((c) => c.what === "date")).toHaveLength(4);
  });

  it("a date on a line that is nobody's business is not a candidate, and does not use up the ten", () => {
    const text = "Statement date: 3 February 2027\nYour dental check-up is on 22 July 2027 at 09:30.\nBooked on: 10 February 2027";
    const line = (words: string) => ({ at: text.indexOf(words), end: text.indexOf(words) + words.length });
    const skip = [line("Statement date: 3 February 2027"), line("Booked on: 10 February 2027")];
    expect(spotCandidates(text, undefined, { skip }).map((c) => [c.key, c.value])).toEqual([["d1", "2027-07-22"]]);
    // Twelve such lines and one real date: the real one is still asked about.
    const many = Array.from({ length: 12 }, (_, i) => `Statement date: ${i + 1} February 2027`);
    const long = `${many.join("\n")}\nYour dental check-up is on 22 July 2027 at 09:30.`;
    const spans = many.map((words) => ({ at: long.indexOf(words), end: long.indexOf(words) + words.length }));
    expect(spotCandidates(long, undefined, { skip: spans }).map((c) => c.value)).toEqual(["2027-07-22"]);
    // The same day stated again in a sentence of its own is still a candidate.
    const twice = "Statement date: 3 February 2027\nPlease pay by 3 February 2027.";
    expect(spotCandidates(twice, undefined, { skip: [{ at: 0, end: 31 }] }).map((c) => [c.value, c.sentence])).toEqual([["2027-02-03", "Please pay by 3 February 2027."]]);
  });

  it("a second date on such a line is still asked about: only the line's own date is nobody's business", () => {
    const table = lexiconFrom([
      ["statement", "none"],
      ["invoice", "none"],
      ["booked", "none"],
    ]);
    const asked = (words: string) =>
      spotCandidates(words, undefined, { skip: settledNowhere(words, table) })
        .filter((c) => c.what === "date")
        .map((c) => c.value);
    expect(asked("Statement date: 3 Feb 2027, please pay before 20 Feb 2027")).toEqual(["2027-02-20"]);
    // Two columns that the text extraction put on one line.
    expect(asked("Invoice date: 1 Feb 2027    Due: 15 Feb 2027")).toEqual(["2027-02-15"]);
    expect(asked("Booked on: 10 Feb 2027   Travel date: 12 Apr 2027")).toEqual(["2027-04-12"]);
    // A line of this kind that states no date keeps nothing from being asked.
    expect(settledNowhere("Statement date: see overleaf", table)).toEqual([]);
  });

  it("what is left out does not use up the ten", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Payment due: ${i + 1} May 2027.`);
    const statement = `${lines.join("\n")}\nYour dental check-up is on 22 July 2027 at 09:30.`;
    const read = Array.from({ length: 12 }, (_, i) => ({ value: `2027-05-${String(i + 1).padStart(2, "0")}` }));
    expect(spotCandidates(statement, undefined, { read }).map((c) => c.value)).toEqual(["2027-07-22"]);
  });
});

describe("the amounts a document holds", () => {
  it("each amount with its currency is a candidate", () => {
    expect(amounts(spotCandidates("Your water bill for the quarter is USD 64.10. Please pay by 15 May 2027."))).toEqual([["a1", "64.10", "USD"]]);
    expect(amounts(spotCandidates("Trattoria Sole\n2 x Pasta 32.00\n1 x Wine 18.00\nTotal EUR 50.00\nThank you"))).toEqual([["a1", "50.00", "EUR"]]);
  });

  it("an amount written with a decimal comma is a candidate, read as written", () => {
    const text = "Total fare: €213,40\nOptional seat selection: €12,00\nBalance: EUR 1.250,00\nA rug costs $2,480.00.";
    // The lines that say total or balance come first, then the rest as they stand.
    expect(spotCandidates(text).map((c) => [c.value, c.unit])).toEqual([
      ["213.40", "EUR"],
      ["1250.00", "EUR"],
      ["12.00", "EUR"],
      ["2480.00", "USD"],
    ]);
    // Full stops between the thousands are not a decimal point.
    expect(spotCandidates("Balance: €1.250,00").map((c) => c.value)).toEqual(["1250.00"]);
    // Thousands with no decimals could be read two ways, and are not read.
    expect(spotCandidates("The car costs €1,250 or so.")).toEqual([]);
  });

  it("a rate and a deposit are never a document's total, so they are not candidates", () => {
    const text = [
      "Room: lakeside double, 3 nights at $140.00 per night",
      "Total for your stay: $453.60",
      "A deposit of $100.00 was taken when you booked.",
      "Rent: $1,650.00 per month",
      "Security deposit: $1,700.00, paid on 25 June 2026",
      "Your plan covers six sessions at $60.00 per session.",
      "Seat selection: $12.00 a seat. Overdue items cost $0.25 per day.",
    ].join("\n");
    expect(spotCandidates(text).filter((c) => c.what === "amount").map((c) => c.value)).toEqual(["453.60"]);
    // A total that only mentions a deposit is still the total.
    expect(spotCandidates("Total due after your deposit: $353.60").map((c) => c.value)).toEqual(["353.60"]);
    // A year's price is the whole price of the year.
    expect(spotCandidates("Your new premium is USD 412.00 a year.").map((c) => c.value)).toEqual(["412.00"]);
    expect(spotCandidates("The plan renews for USD 99.00 per year.").map((c) => c.value)).toEqual(["99.00"]);
  });

  it("a total printed again on the card line keeps its place as the total", () => {
    const receipt = [
      "Coffee $4.50",
      "Tea $3.20",
      "Bagel $2.80",
      "Juice $5.10",
      "Muffin $2.90",
      "Cookie $1.50",
      "Subtotal $20.00",
      "Tax $1.60",
      "TOTAL $21.60",
      "VISA **** 1234 $21.60",
    ].join("\n");
    const amounts = spotCandidates(receipt).filter((c) => c.what === "amount");
    // The line that says total comes first, inside the six-amount cap, and
    // the sentence shown for 21.60 is the one that calls it the total.
    expect(amounts).toHaveLength(6);
    expect(amounts[0]).toMatchObject({ key: "a1", value: "21.60" });
    expect(amounts[0]!.sentence).toContain("TOTAL $21.60");
  });

  it("a deposit that was paid is still a deposit, and the balance after it is the total", () => {
    const booking = "Deposit paid: $100.00\nBalance due on arrival: $353.60";
    expect(spotCandidates(booking).map((c) => c.value)).toEqual(["353.60"]);
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
