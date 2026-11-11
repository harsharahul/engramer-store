import { describe, expect, it } from "vitest";
import { guessDocumentKind, harvestFacts, labelledFacts, structuralDatedFacts } from "./labels";
import { subjectOf } from "./subject";

describe("labelledFacts", () => {
  it("reads an expiry behind its label", () => {
    const [fact] = labelledFacts("Policy holder: H R\nExpires 12 March 2029");
    expect(fact).toMatchObject({ kind: "expiry", value: "2029-03-12", source: "label" });
  });

  it("reads the variants people actually print", () => {
    for (const label of [
      "Valid until",
      "Valid through",
      "Date of expiry",
      "Expiry date",
      "Expiration date",
      "Renewal date",
      "Good through",
    ]) {
      expect(labelledFacts(`${label}: 2029-03-12`)[0]?.kind).toBe("expiry");
    }
  });

  it("separates a payment due date from an expiry", () => {
    const [fact] = labelledFacts("Payment due 2026-09-01");
    expect(fact).toMatchObject({ kind: "due", value: "2026-09-01" });
  });

  it("reads an issue date", () => {
    expect(labelledFacts("Date of issue: 2021-08-24")[0]?.kind).toBe("issued");
  });

  it("carries ambiguity through from the date reader", () => {
    const [fact] = labelledFacts("Expires 03/04/2028");
    expect(fact!.ambiguous).toBe(true);
    expect(fact!.confidence).toBeLessThan(0.7);
  });

  it("is more confident about a date that could only be read one way", () => {
    expect(labelledFacts("Expires 2029-03-12")[0]!.confidence).toBe(0.7);
  });

  it("ignores a label with no date anywhere near it", () => {
    expect(labelledFacts("Expires when the policy is cancelled.")).toEqual([]);
  });

  it("does not reach across a paragraph for its date", () => {
    const text = `Expires\n\n${"filler line\n".repeat(12)}2029-03-12`;
    expect(labelledFacts(text)).toEqual([]);
  });

  it("gives two facts with the same value distinct identities by kind", () => {
    const facts = labelledFacts("Issued 2029-03-12. Expires 2029-03-12.");
    const ids = new Set(facts.map((f) => f.id));
    expect(ids.size).toBe(facts.length);
  });

  it("finds every label in a document, not only the first", () => {
    const facts = labelledFacts("Expires 2029-03-12\nPayment due 2026-09-01");
    expect(facts.map((f) => f.kind).sort()).toEqual(["due", "expiry"]);
  });
});

describe("structuralDatedFacts", () => {
  // The shape that exposed the vocabulary's limit, recreated with synthetic values.
  const STATEMENT = `Enrollment Record Number: X90000012B3
Enrollment/Issued Date: 2027 April 12
Coverage Class: R2
Benefit End Date: 2027 October 19
Details provided on the enrollment form:`;

  it("surfaces a labelled date the vocabulary does not know, label attached", () => {
    const facts = structuralDatedFacts(STATEMENT, new Set());
    const admit = facts.find((f) => f.value === "2027-10-19");
    expect(admit).toMatchObject({
      kind: "dated",
      label: "Benefit End Date",
      source: "label",
    });
  });

  it("skips a value the vocabulary already claimed, so nothing appears twice", () => {
    expect(
      structuralDatedFacts("Valid until: 2027-04-30", new Set(["2027-04-30"])),
    ).toEqual([]);
  });

  it("refuses a date of birth outright", () => {
    expect(structuralDatedFacts("Date of Birth: 1978-01-31", new Set())).toEqual([]);
  });

  it("refuses print and generation stamps, which describe the paper", () => {
    expect(structuralDatedFacts("Printed on: 2026-01-02", new Set())).toEqual([]);
    expect(structuralDatedFacts("Generated: 2026-01-02", new Set())).toEqual([]);
  });

  it("ignores a field whose value holds no date", () => {
    expect(structuralDatedFacts("Coverage Class: R2", new Set())).toEqual([]);
  });

  it("carries ambiguity through, so the card can ask which reading", () => {
    const [fact] = structuralDatedFacts("Fecha de vencimiento: 03/04/2028", new Set());
    expect(fact).toMatchObject({ kind: "dated", ambiguous: true });
  });
});

describe("the whole statement, end to end through the readers", () => {
  const STATEMENT = `Enrollment Record Number: X90000012B3
Enrollment/Issued Date: 2027 April 12
Coverage Class: R2
Benefit End Date: 2027 October 19`;

  it("types what it knows and quotes what it does not", () => {
    const typed = labelledFacts(STATEMENT);
    // "Enrollment/Issued Date" carries a label the vocabulary knows.
    expect(typed.find((f) => f.kind === "issued")?.value).toBe("2027-04-12");
    const claimed = new Set(typed.map((f) => f.value));
    const generic = structuralDatedFacts(STATEMENT, claimed);
    // The controlling date surfaces with the document's own words, even
    // though nothing here knows what a benefits statement is.
    expect(generic).toHaveLength(1);
    expect(generic[0]).toMatchObject({ value: "2027-10-19", label: "Benefit End Date" });
  });
});

describe("harvestFacts", () => {
  it("finds a currency amount and marks it low confidence", () => {
    const [fact] = harvestFacts("Total due: $410.00");
    expect(fact).toMatchObject({
      kind: "amount",
      value: "410.00",
      unit: "USD",
      source: "pattern",
    });
    expect(fact!.confidence).toBeLessThan(0.5);
  });

  it("reads a currency written as a code", () => {
    expect(harvestFacts("Amount: EUR 1250.50")[0]).toMatchObject({
      value: "1250.50",
      unit: "EUR",
    });
  });

  it("never proposes a bare date with no label as an expiry", () => {
    expect(harvestFacts("Printed 2026-01-02").some((f) => f.kind === "expiry")).toBe(false);
  });

  it("masks a reference number rather than carrying it whole", () => {
    const id = harvestFacts("Policy number AB1234567890").find((f) => f.kind === "identifier");
    expect(id!.masked).toBe("7890");
    expect(id!.value).toBe("AB1234567890");
  });

  it("does not treat an ordinary word as a reference number", () => {
    expect(harvestFacts("thank you for your business")).toEqual([]);
  });

  it("a timestamp is not a reference number", () => {
    const text = "DTSTART;TZID=America/New_York:20261201T140000\nDTEND:20261201T150000Z\nSent 2027-03-04T10:15:00-08:00\nBooking ref ZK8Q2P";
    expect(harvestFacts(text).filter((f) => f.kind === "identifier").map((f) => f.value)).toEqual(["ZK8Q2P"]);
  });

  it("a reference number that only looks a little like a timestamp is kept", () => {
    // Eight digits and a T, but no clock after it.
    const text = "Policy 20261201TX and order 2027-03-04TKT";
    expect(harvestFacts(text).filter((f) => f.kind === "identifier").map((f) => f.value)).toEqual(["20261201TX", "2027-03-04TKT"]);
  });
});

describe("guessDocumentKind", () => {
  it("recognizes the documents the rules care about", () => {
    expect(guessDocumentKind("UNITED STATES PASSPORT")).toBe("passport");
    expect(guessDocumentKind("DRIVER LICENSE  CLASS C")).toBe("drivers-license");
    expect(guessDocumentKind("Certificate of Motor Insurance")).toBe("insurance");
    expect(guessDocumentKind("Limited Warranty")).toBe("warranty");
    expect(guessDocumentKind("INVOICE #2231")).toBe("invoice");
    expect(guessDocumentKind("Residence Permit")).toBe("residence-permit");
  });

  it("says other rather than inventing a kind", () => {
    expect(guessDocumentKind("a shopping list")).toBe("other");
  });
});

describe("travel vocabulary", () => {
  it("types a check-in date as an event and carries its time", () => {
    const [fact] = labelledFacts("The Larkspur Hotel\nCheck-in: March 04, 2027 from 15:00");
    expect(fact).toMatchObject({ kind: "event", value: "2027-03-04", time: "15:00" });
    expect(fact!.label).toBe("Check-in");
  });

  it("a check-in line keeps its hour when the clock has no colon", () => {
    const [fact] = labelledFacts("Check-in: 12 March 2027 from 3pm.");
    expect(fact).toMatchObject({ kind: "event", value: "2027-03-12", time: "15:00", label: "Check-in" });
  });

  it("types departure and boarding, keeping labels as written", () => {
    const facts = labelledFacts("Departure: 4 March 2027 09:40\nBoarding time: 4 March 2027 09:10");
    expect(facts.map((f) => f.label)).toEqual(["Departure", "Boarding time"]);
    expect(facts.every((f) => f.kind === "event")).toBe(true);
    expect(facts.map((f) => f.time)).toEqual(["09:40", "09:10"]);
  });

  it("keeps two same-day events apart", () => {
    const facts = labelledFacts("Check-in: 4 March 2027\nCheck-out: 4 March 2027");
    expect(facts).toHaveLength(2);
  });

  it("emits nothing for an event label with no date in reach", () => {
    expect(labelledFacts("Check-in desk is on level 2")).toEqual([]);
  });

  it("does not mistake the words boarding pass for a boarding time", () => {
    const facts = labelledFacts("Boarding pass\nDeparture: 4 March 2027 09:40");
    expect(facts.map((f) => f.label)).toEqual(["Departure"]);
  });

  it("recognizes travel documents by kind", () => {
    expect(guessDocumentKind("BOARDING PASS  Gate C12  Seat 14C")).toBe("boarding-pass");
    expect(guessDocumentKind("Hotel Reservation. Confirmation number LRK-1")).toBe("hotel-booking");
    expect(guessDocumentKind("Car Rental Agreement")).toBe("car-rental");
    expect(guessDocumentKind("Your flight itinerary")).toBe("itinerary");
  });
});

describe("more ways a deadline is written", () => {
  const read = (text: string) => labelledFacts(text).map((f) => [f.kind, f.value, f.label]);

  it("a deadline, a book due back, and an answer wanted by a day are due", () => {
    expect(read("Reminder: the filing deadline is 15 April 2028.")).toEqual([["due", "2028-04-15", "Deadline"]]);
    expect(read("The book you borrowed is due back on 9 June 2027.")).toEqual([["due", "2027-06-09", "Due back on"]]);
    expect(read("Let us know by 31 January 2028 whether you plan to renew.")).toEqual([["due", "2028-01-31", "Let us know by"]]);
  });

  it("the day a payment will be taken is due", () => {
    expect(read("Your mobile bill is USD 38.25 and will be collected on 3 May 2027.")).toEqual([["due", "2027-05-03", "Will be collected on"]]);
    expect(read("Your card will be charged on 1 July 2027.")).toEqual([["due", "2027-07-01", "Will be charged on"]]);
  });

  it("cover that ends, and a lease that ends on a day, expire then", () => {
    expect(read("Limited warranty. Coverage ends 20 March 2028.")).toEqual([["expiry", "2028-03-20", undefined]]);
    expect(read("Your lease ends on 31 March 2028.")).toEqual([["expiry", "2028-03-31", undefined]]);
  });

  it("an amount that is due on a day is the bill's amount", () => {
    const facts = labelledFacts("A reminder that rent of USD 2,400.00 is due on 1 September 2027.");
    expect(facts.map((f) => [f.kind, f.value, f.label])).toEqual([
      ["due", "2027-09-01", undefined],
      ["amount", "2400.00", "Amount due"],
    ]);
    // A fee that would be due under a condition is not the bill.
    expect(labelledFacts("A late fee of $5.00 applies after the due date.").filter((f) => f.kind === "amount")).toEqual([]);
  });
});

describe("a field line", () => {
  const fields = (text: string) => structuralDatedFacts(text, new Set()).map((f) => [f.label, f.value]);

  it("is a label, a colon and a value", () => {
    expect(fields("Benefit End Date: 2027 October 19")).toEqual([["Benefit End Date", "2027-10-19"]]);
    expect(fields("Row 12: 4 March 2027")).toEqual([["Row 12", "2027-03-04"]]);
  });

  it("is not a sentence that happens to hold a clock", () => {
    expect(fields("Your room is ready for you from 15:00 on 8 April 2027.")).toEqual([]);
    expect(fields("Doors at 19:30, show on 14 Nov 2026")).toEqual([]);
  });
});

describe("a flight written in words", () => {
  const LINE = "Flight UA 123 departs SFO 10:15 AM on March 4, 2027, arrives JFK 6:45 PM";
  const flown = (text: string) => labelledFacts(text).map((f) => [f.value, f.time, f.label, f.subject]);

  it("keeps its number, airports and both times", () => {
    expect(flown(LINE)).toEqual([
      ["2027-03-04", "10:15", "Flight UA 123 departs SFO", { role: "depart", mode: "flight", carrier: "UA", number: "123", code: "SFO" }],
      ["2027-03-04", "18:45", "Flight UA 123 arrives JFK", { role: "arrive", mode: "flight", carrier: "UA", number: "123", code: "JFK" }],
    ]);
    expect(labelledFacts(LINE).every((f) => f.kind === "event" && f.source === "label" && f.confidence === 0.7 && f.accepted === undefined)).toBe(true);
  });

  it("a line with no flight number names no airport", () => {
    const [fact] = labelledFacts("Departs LAX 10:15 AM on March 4, 2027");
    expect(fact).toMatchObject({ kind: "event", value: "2027-03-04", time: "10:15", label: "Departs" });
    expect(fact!.subject).toBeUndefined();
    expect(subjectOf(fact!)).toEqual({ role: "depart" });
  });

  it("AM and PM are clocks, not airlines, unless the line says Flight", () => {
    expect(labelledFacts("Departs 10:15 AM 12 March 2027 from SFO")[0]!.subject).toBeUndefined();
    expect(flown("Flight AM 15 departs MEX 9:00 AM on March 4, 2027")).toEqual([
      ["2027-03-04", "09:00", "Flight AM 15 departs MEX", { role: "depart", mode: "flight", carrier: "AM", number: "15", code: "MEX" }],
    ]);
  });

  it("two flights on one day are two facts", () => {
    expect(flown("Flight UA 123 departs SFO 7:00 AM on March 4, 2027\nFlight UA 456 departs DEN 1:30 PM on March 4, 2027").map((f) => f[2])).toEqual([
      "Flight UA 123 departs SFO",
      "Flight UA 456 departs DEN",
    ]);
  });

  it("an arrival with its own date keeps it", () => {
    expect(flown("Flight UA 900 departs SFO 10:10 PM on March 4, 2027, arrives JFK 6:45 AM on March 5, 2027").map((f) => [f[0], f[1]])).toEqual([
      ["2027-03-04", "22:10"],
      ["2027-03-05", "06:45"],
    ]);
  });

  it("an arrival with no date and a clock before its departure's is not given the departure's day", () => {
    expect(flown("Flight UA 900 departs SFO 10:10 PM on March 4, 2027, arrives JFK 6:45 AM").map((f) => f[2])).toEqual(["Flight UA 900 departs SFO"]);
    // Unless the line says it is the next day.
    expect(flown("Flight UA 900 departs SFO 10:10 PM on March 4, 2027, arrives JFK 6:45 AM +1").map((f) => [f[0], f[1]])).toEqual([
      ["2027-03-04", "22:10"],
      ["2027-03-05", "06:45"],
    ]);
  });
});

describe("dates with no year, in mail", () => {
  const WRITTEN = Date.parse("2026-11-09T12:00:00Z"); // Monday 9 Nov 2026

  it("a shipping message's arrival day is read from the message's date", () => {
    const [fact] = labelledFacts("Your order has shipped.\nArriving Thursday, November 12", WRITTEN);
    expect(fact).toMatchObject({ kind: "event", value: "2026-11-12", label: "Delivery expected by", document: "delivery", confidence: 0.5, assumedYear: true, source: "label" });
    expect(fact!.ambiguous).toBeUndefined();
  });

  it("a due date and a doors time with no year are read the same way", () => {
    expect(labelledFacts("Please reply by Friday, November 13.", WRITTEN)[0]).toMatchObject({ kind: "due", value: "2026-11-13", confidence: 0.5, assumedYear: true });
    expect(labelledFacts("Sat 14 Nov, doors 7:00 PM", WRITTEN)[0]).toMatchObject({ kind: "event", value: "2026-11-14", time: "19:00", assumedYear: true });
  });

  it("without the message's date, a date with no year is not read", () => {
    expect(labelledFacts("Your order has shipped.\nArriving Thursday, November 12")).toEqual([]);
  });

  it("a date wrapped over two lines keeps the year it states", () => {
    expect(labelledFacts("Valid until 12 March\n2029", WRITTEN)[0]).toMatchObject({ kind: "expiry", value: "2029-03-12", confidence: 0.7 });
    expect(labelledFacts("Valid until 12 March\n2029", WRITTEN)[0]!.assumedYear).toBeUndefined();
  });

  it("a date with no year on the label's line is the label's, not a full date on the line below", () => {
    expect(labelledFacts("Please reply by Friday, November 13.\nSent 2026-11-09", WRITTEN).map((f) => [f.kind, f.value])).toEqual([["due", "2026-11-13"]]);
  });

  it("a date that states its year is as sure as ever", () => {
    expect(labelledFacts("Please reply by November 13, 2026.", WRITTEN)[0]).toMatchObject({ value: "2026-11-13", confidence: 0.7 });
    expect(labelledFacts("Please reply by November 13, 2026.", WRITTEN)[0]!.assumedYear).toBeUndefined();
  });
});

describe("the amount a bill asks for", () => {
  const due = (text: string) => labelledFacts(text).filter((f) => f.kind === "amount");

  it("the one amount on a line that says amount due is the bill's amount", () => {
    expect(due("Amount due $84.20\nDue date: November 20, 2026")).toEqual([
      expect.objectContaining({ id: "amount:84.20", value: "84.20", unit: "USD", label: "Amount due", source: "label", confidence: 0.7 }),
    ]);
    expect(due("Total due: EUR 1,250.50")[0]).toMatchObject({ value: "1250.50", unit: "EUR", label: "Amount due" });
    expect(due("Balance due £12.00")[0]).toMatchObject({ value: "12.00", unit: "GBP" });
    expect(due("Amount payable: USD 99.00")[0]).toMatchObject({ value: "99.00", unit: "USD" });
    expect(due("Amount due $84.20\nTotal due: $84.20")).toHaveLength(1);
  });

  it("a statement with a minimum and a balance names no single amount", () => {
    expect(due("Minimum payment due $35.00. New balance $1,240.18")).toEqual([]);
    expect(due("Minimum amount due $35.00\nTotal amount due $1,240.18")).toEqual([]);
  });

  it("two amounts on the line, or two lines that disagree, name none", () => {
    expect(due("Total due $84.20 (includes a late fee of $5.00)")).toEqual([]);
    expect(due("Total due $84.20\nBalance due $100.00")).toEqual([]);
  });

  it("an amount with no line that says it is due is left to the harvest", () => {
    expect(due("Subtotal $80.00\nTax $4.20\nPaid $84.20")).toEqual([]);
  });
});

describe("how far a label reaches", () => {
  const read = (text: string) => labelledFacts(text).map((f) => [f.label ?? f.kind, f.value, f.time]);

  it("takes the date on its own line, not one written another way on the line below", () => {
    expect(read("Appointment: December 8, 2026 at 2:30 PM\nPick-up: 9 December 2026 10:00")).toEqual([
      ["Pick-up", "2026-12-09", "10:00"],
      ["Appointment", "2026-12-08", "14:30"],
    ]);
    expect(read("Due date: November 20, 2026\nIssued 2026-11-01")).toEqual([
      ["due", "2026-11-20", undefined],
      ["issued", "2026-11-01", undefined],
    ]);
  });

  it("a clock on the next label's line is not this label's", () => {
    expect(read("Check-in: 4 March 2027\nCheck-out: 7 March 2027 11:00")).toEqual([
      ["Check-in", "2027-03-04", undefined],
      ["Check-out", "2027-03-07", "11:00"],
    ]);
  });

  it("a label alone on its line still reads the value below it", () => {
    expect(read("Departure\n4 March 2027 09:40")).toEqual([["Departure", "2027-03-04", "09:40"]]);
  });

  it("a date wrapped over two lines is still read", () => {
    expect(read("Valid until 12 March\n2029")).toEqual([["expiry", "2029-03-12", undefined]]);
  });
});

describe("words of ordinary life", () => {
  const one = (text: string) => {
    const facts = labelledFacts(text);
    expect(facts, text).toHaveLength(1);
    return facts[0]!;
  };

  it("EXP on a licence is its expiry", () => {
    expect(one("DRIVER LICENSE\nDL D1234567\nEXP 08/15/2029")).toMatchObject({ kind: "expiry", value: "2029-08-15", document: "drivers-license", source: "label", confidence: 0.7 });
    expect(one("Valid thru 15 August 2029")).toMatchObject({ kind: "expiry", value: "2029-08-15" });
  });

  it("EXP inside a word or a code, or before a card's month and year, reads nothing", () => {
    for (const text of ["EXPRESS 08/15/2029", "EXP123 2029-08-15", "EXP 08/29", "exp 08/15/2029", "Expedited 08/15/2029"]) {
      expect(labelledFacts(text), text).toEqual([]);
    }
  });

  it("a date to respond, reply or return by is due, in the document's own words", () => {
    expect(one("You must respond by January 15, 2027.")).toMatchObject({ kind: "due", value: "2027-01-15", label: "Respond by", source: "label", confidence: 0.7 });
    expect(one("Please reply by 3 March 2027 to keep your place.")).toMatchObject({ kind: "due", value: "2027-03-03", label: "Reply by" });
    expect(one("Books are due by 9 June 2027.")).toMatchObject({ kind: "due", value: "2027-06-09", label: "Due by" });
    expect(one("Your form must be received by 30 April 2027.")).toMatchObject({ kind: "due", value: "2027-04-30", label: "Must be received by" });
  });

  it("a renewal that charges is due on the day it renews", () => {
    expect(one("Your plan renews on December 1, 2026 for $9.99.")).toMatchObject({ kind: "due", value: "2026-12-01", label: "Renews", source: "label" });
    expect(one("Next billing date: 18 October 2027")).toMatchObject({ kind: "due", value: "2027-10-18", label: "Renews" });
    expect(one("Your subscription auto-renews on 18 October 2027.")).toMatchObject({ kind: "due", value: "2027-10-18", label: "Renews" });
  });

  it("an amount due by a date is still one plain due date", () => {
    expect(one("Amount due by 20 November 2026")).toMatchObject({ kind: "due", value: "2026-11-20" });
    expect(one("Amount due by 20 November 2026").label).toBeUndefined();
  });

  it("an appointment is an event that starts then", () => {
    expect(one("Your appointment is on Tuesday, December 8, 2026 at 2:30 PM with Dr. Lee.")).toMatchObject({
      kind: "event",
      value: "2026-12-08",
      time: "14:30",
      label: "Appointment",
      subject: { role: "start" },
      source: "label",
    });
  });

  it("doors after the date on the same line is the event's start", () => {
    expect(one("Sat 14 Nov 2026, doors 7:00 PM")).toMatchObject({ kind: "event", value: "2026-11-14", time: "19:00", label: "Doors", subject: { role: "start" } });
  });

  it("a date on the line above is not the doors' date", () => {
    expect(labelledFacts("Printed 14 Nov 2026\nDoors open at 7")).toEqual([]);
  });

  it("an estimated delivery is a parcel expected by that day", () => {
    const fact = one("Your order has shipped.\nTracking number: 1Z999AA10123456784\nEstimated delivery: November 12, 2026");
    expect(fact).toMatchObject({ kind: "event", value: "2026-11-12", label: "Delivery expected by", document: "delivery", subject: { role: "by" }, source: "label" });
    // The line says it is a delivery, whatever else the message is called.
    expect(one("INVOICE 2231\nExpected delivery date: 12 November 2026")).toMatchObject({ kind: "event", document: "delivery", subject: { role: "by" } });
  });

  it("arriving is a delivery only in a message about one", () => {
    expect(one("Good news: your order has shipped and should arrive on 6 May 2027.")).toMatchObject({ kind: "event", value: "2027-05-06", label: "Delivery expected by", document: "delivery" });
    expect(labelledFacts("Arriving 13 November 2026 at Lisbon airport.")).toEqual([]);
  });

  it("recognizes a shipping notice by kind, after an invoice", () => {
    expect(guessDocumentKind("Your order has shipped")).toBe("delivery");
    expect(guessDocumentKind("Out for delivery today")).toBe("delivery");
    expect(guessDocumentKind("Tracking number 1Z999AA10123456784")).toBe("delivery");
    expect(guessDocumentKind("INVOICE for your order")).toBe("invoice");
  });

  it("a newsletter that uses the new words asks for little and counts nothing", () => {
    const filler = Array.from({ length: 120 }, (_, i) => `Our studio news, part ${i + 1}: new classes and a fresh menu.`).join(" ");
    const text = [
      filler,
      "Book an appointment before 31 Dec 2026 and save.",
      "Friday night: doors open at 7.",
      "The sale ends Friday, and your coupon expires soon.",
      "Reply by email if you have questions. Free delivery date changes may apply.",
      filler,
    ].join("\n");
    const dated = labelledFacts(text).filter((fact) => ["expiry", "due", "event", "dated"].includes(fact.kind));
    expect(dated.length).toBeLessThanOrEqual(2);
    expect(dated.every((fact) => fact.accepted === undefined && !fact.confirmed && fact.confidence < 1)).toBe(true);
  });
});
