import { describe, expect, it } from "vitest";
import { amountLines, fieldLines, guessDocumentKind, harvestFacts, labelledFacts, moneyEvery, settledNowhere, structuralDatedFacts } from "./labels";
import { lexiconFrom } from "./lexicon";
import { subjectOf } from "./subject";
import shipped from "./tables/labels.json";

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

describe("how far the newer words reach", () => {
  const WRITTEN = Date.parse("2026-11-09T12:00:00Z");
  const read = (text: string) => labelledFacts(text, WRITTEN).map((f) => [f.label ?? f.kind, f.value, f.time]);

  it("a date before its label on the same line wins over any line below", () => {
    expect(read("Sat 14 Nov 2026, doors 7:00 PM\nReturns accepted to 10 Nov 2026")).toEqual([["Doors", "2026-11-14", "19:00"]]);
    expect(read("12 November 2026 - appointment with Dr. Lee at 3pm\nBooked on 2 November 2026")).toEqual([["Appointment", "2026-11-12", "15:00"]]);
  });

  it("a newer word with no date on its own line claims nothing from the lines below", () => {
    for (const text of [
      "Your order has shipped.\nArriving Thursday\nOrder placed Nov 9",
      "Your order has shipped.\nArriving Thursday\nShip to: Sam Lee, 5 June Avenue",
      "Your order has shipped.\nArriving soon\nShip to: Sam Lee, 12 March Road",
      "The deadline is Friday.\nPosted Monday, November 9, 2026 10:15 AM",
      "Sounds good about the appointment\nOn Tue, Nov 10, 2026 at 3:04 PM Sam wrote:",
      "Re: Appointment request\nWritten November 9, 2026 at 10:15:30 AM PST",
      "Please reply by\nFriday, November 13",
      "Your plan renews on\n2026-12-01",
    ]) {
      expect(read(text), text).toEqual([]);
    }
  });

  it("a date with no year is claimed only from the label's own line, whatever the label", () => {
    expect(read("Check-out\nThursday, November 12")).toEqual([]);
    expect(read("Check-out: Thursday, November 12")).toEqual([["Check-out", "2026-11-12", undefined]]);
  });

  it("an expiry never takes a date with no year: documents print the year, offers do not", () => {
    expect(read("Offer valid thru December 31.")).toEqual([]);
    expect(read("Expires November 30")).toEqual([]);
  });

  it("EXP reads only a date that follows it at once", () => {
    for (const text of [
      "VISA XXXXXXXXXXXX4321\nEXP: XX/XX\nDATE: 11/09/26 TIME: 14:03",
      "VISA ****4321 EXP **/** AUTH 012345 11/09/2026",
      "Card ending 4321 EXP 08/29\nStatement date 2026-11-09",
      "5 yrs EXP\nStart date 2026-12-01",
      "EXP 08/29 11/09/2026",
    ]) {
      expect(labelledFacts(text).filter((f) => f.kind === "expiry"), text).toEqual([]);
    }
    expect(labelledFacts("EXP: 15 Aug 2029")[0]).toMatchObject({ kind: "expiry", value: "2029-08-15" });
    expect(labelledFacts("EXP. 2029-08-15")[0]).toMatchObject({ kind: "expiry", value: "2029-08-15" });
  });

  it("an invitation to book an appointment is not an appointment", () => {
    for (const text of ["Book your appointment online: Tuesday, December 1 or later.", "Book an appointment before 31 Dec 2026 and save.", "To schedule an appointment, call before 5 January 2027."]) {
      expect(read(text), text).toEqual([]);
    }
  });

  it("a sale that ends is not a document that expires; a lease and cover are", () => {
    expect(read("Our biggest sale ends on November 30, 2026. Shop now!")).toEqual([]);
    expect(read("Your lease ends on 31 March 2028.")).toEqual([["expiry", "2028-03-31", undefined]]);
    expect(read("Limited warranty. Coverage ends 20 March 2028.")).toEqual([["expiry", "2028-03-20", undefined]]);
  });

  it("a shop's newsletter, read as mail, asks about its one real event and nothing else", () => {
    const news = [
      "Our winter sale ends on Monday, November 30. Shop now!",
      "Live music: Saturday, December 5, doors 7pm.",
      "Book your appointment online: Tuesday, December 1 or later.",
      "Offer valid thru December 31.",
    ].join("\n");
    expect(read(news)).toEqual([["Doors", "2026-12-05", "19:00"]]);
  });

  it("a range of days is not its last day", () => {
    expect(read("Appointment: 5-7 June")).toEqual([]);
  });
});

describe("a date before its label", () => {
  const WRITTEN = Date.parse("2026-11-09T12:00:00Z");
  const labels = (text: string) => labelledFacts(text, WRITTEN).map((f) => [f.label, f.value, f.time]);

  it("belongs to the label only inside the label's own sentence", () => {
    // A shop's flyer: the doors' day is not the day of an appointment nobody booked.
    expect(labels("Doors open at 6 AM on November 27. Book your appointment for a free fitting.")).toEqual([["Doors", "2026-11-27", "06:00"]]);
    expect(labels("Offer valid to 30 Nov 2026! Book an appointment today.").filter((f) => f[0] === "Appointment")).toEqual([]);
  });

  it("is still read on a poster's line, with a short weekday or month before it", () => {
    expect(labels("Sat 14 Nov 2026, doors 7:00 PM")).toEqual([["Doors", "2026-11-14", "19:00"]]);
    expect(labels("Sat. Nov. 14, 2026, doors 7:00 PM")).toEqual([["Doors", "2026-11-14", "19:00"]]);
  });
});

describe("a field line", () => {
  const fields = (text: string) => structuralDatedFacts(text, new Set()).map((f) => [f.label, f.value]);

  it("is not the header of a forwarded or quoted message", () => {
    expect(fields("-----Original Message-----\nFrom: Pat Lee\nSent: Monday, November 9, 2026 10:15 AM\nTo: Team\nSubject: Schedule")).toEqual([]);
    expect(fields("Received: 9 November 2026")).toEqual([]);
    expect(fields("From: Pat Lee\nDate: November 9, 2026 at 10:15:30 AM PST\nSubject: Re: Appointment request")).toEqual([]);
    // A ticket's own Date line, with no mail header beside it, is still read.
    expect(fields("Harbor Hall\nDate: 14 November 2026\nVenue: Main stage")).toEqual([["Date", "2026-11-14"]]);
  });

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

  it("an arrival with no date and a clock before its departure's is not given a day", () => {
    expect(flown("Flight UA 900 departs SFO 10:10 PM on March 4, 2027, arrives JFK 6:45 AM").map((f) => f[2])).toEqual(["Flight UA 900 departs SFO"]);
    // A day the line does not print is not stated, whatever "+1" suggests.
    expect(flown("Flight UA 900 departs SFO 10:10 PM on March 4, 2027, arrives JFK 6:45 AM +1").map((f) => f[2])).toEqual(["Flight UA 900 departs SFO"]);
  });

  it("each flight on a line keeps its own number", () => {
    expect(flown("Flight UA 123 departs SFO 10:15 AM on March 4, 2027; Flight UA 456 departs JFK 8:00 PM on March 4, 2027").map((f) => f[2])).toEqual([
      "Flight UA 123 departs SFO",
      "Flight UA 456 departs JFK",
    ]);
  });

  it("a clock, a gate and a train are not a flight number", () => {
    for (const text of ["FLIGHT AT 2 PM departs SFO on March 4, 2027", "Gate B12 departs SFO 10:15 AM on March 4, 2027", "Train IC 512 departs AMS 10:15 on March 4, 2027"]) {
      expect(labelledFacts(text).map((f) => f.subject), text).toEqual([undefined]);
    }
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

  it("the bill's amount says it is the amount due", () => {
    expect(due("Amount due $84.20\nDue date: November 20, 2026")[0]).toMatchObject({ sum: "due" });
  });

  it("a statement with a minimum and a balance names no single amount", () => {
    expect(due("Minimum payment due $35.00. New balance $1,240.18")).toEqual([]);
    expect(due("Minimum amount due $35.00\nTotal amount due $1,240.18")).toEqual([]);
  });

  it("two amounts on the line, or two lines that disagree, name none", () => {
    expect(due("Total due $84.20 (includes a late fee of $5.00)")).toEqual([]);
    expect(due("Total due $84.20\nBalance due $100.00")).toEqual([]);
  });

  it("a minimum on its own line beside a balance still names no single amount", () => {
    expect(due("Minimum due $35.00\nBalance due $1,240.18\nPayment due date: November 20, 2026")).toEqual([]);
    expect(due("Min. payment $35.00\nTotal due $1,240.18")).toEqual([]);
  });

  it("nothing due, a prize, and a line that only says something is due are not the bill's amount", () => {
    expect(due("Amount due $0.00\nDue date: November 20, 2026")).toEqual([]);
    expect(due("Your feedback is due! Win a $50.00 gift card.")).toEqual([]);
    expect(due("Amount due $84.20\nPayment is due by November 20, 2026")[0]).toMatchObject({ value: "84.20", label: "Amount due" });
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

describe("a date line and the clock lines under it", () => {
  const moments = (text: string, writtenAt?: number) =>
    labelledFacts(text, writtenAt)
      .filter((fact) => fact.kind === "event")
      .map((fact) => [fact.value, fact.time, subjectOf(fact)?.role ?? fact.label])
      .sort();

  it("a clock line belongs to the date line above it, never to the next fact's date", () => {
    const itinerary = [
      "Booked on: 10 Feb 2027",
      "Outbound: Mon 12 Apr 2027, LHR to AMS",
      "Departs 14:20",
      "Arrives 16:45",
      "Return: Fri 16 Apr 2027, AMS to LHR",
      "Departs 18:10",
      "Arrives 18:35",
    ].join("\n");
    expect(moments(itinerary)).toEqual([
      ["2027-04-12", "14:20", "depart"],
      ["2027-04-12", "16:45", "arrive"],
      ["2027-04-16", "18:10", "depart"],
      ["2027-04-16", "18:35", "arrive"],
    ]);
  });

  it("a ticket's date line gives its day to the departure and the arrival under it", () => {
    const ticket = "From: Marlow Central\nTo: Kestrel Cross\nDate: Saturday 15 May 2027\nDeparts: 08:42\nArrives: 11:05\nFare: £48.50";
    expect(moments(ticket)).toEqual([
      ["2027-05-15", "08:42", "depart"],
      ["2027-05-15", "11:05", "arrive"],
    ]);
  });

  it("a time line takes its own fact's day, and a day to act by keeps its clock", () => {
    const hire = "Pick-up date: Fri 23 July 2027\nPick-up time: 10:00\nReturn by: Fri 30 July 2027 17:00\nDaily rate: USD 58.94";
    expect(moments(hire)).toEqual([["2027-07-23", "10:00", "pick-up"]]);
    const due = labelledFacts(hire).find((fact) => fact.kind === "due");
    expect(due).toMatchObject({ value: "2027-07-30", time: "17:00" });
  });

  it("a check-in time under an arrival date is that day's check-in, once", () => {
    const stay = "Arrival date: 19 April 2027\nCheck-in time: from 3 PM\nDeparture date: 22 April 2027\nCheck-out time: by 11:00\nNights: 3";
    expect(moments(stay)).toEqual([
      ["2027-04-19", "15:00", "check-in"],
      ["2027-04-22", "11:00", "check-out"],
    ]);
  });

  it("an appointment's own time line gives the appointment its clock", () => {
    const letter = "Appointment: Wednesday 20 January 2027\nArrive by: 09:20\nAppointment time: 09:40\nPlease confirm by: 15 January 2027";
    expect(moments(letter)).toEqual([["2027-01-20", "09:40", "start"]]);
  });

  it("a date with no year on the line above is read the way the message's other dates are", () => {
    const workshop = "Workshop: Natural dyes\nDate: Sat Feb 6\nCheck-in: 10:15 AM";
    expect(moments(workshop, Date.UTC(2027, 0, 20, 17))).toEqual([["2027-02-06", "10:15", "check-in"]]);
    // In a stored file no year is known, so there is no day to give.
    expect(moments(workshop)).toEqual([]);
  });

  it("a blank line ends the block: a clock line under it has no day", () => {
    const apart = "Outbound: Mon 12 Apr 2027\n\nDeparts 14:20";
    expect(moments(apart)).toEqual([]);
  });

  it("a clock in a sentence is not a form's clock line: it takes no day from the line above", () => {
    const prose = "We received your form on 3 March 2027.\nYour check-in is at 2:30 PM, and we look forward to seeing you.";
    expect(moments(prose)).toEqual([]);
  });

  it("a day to act by keeps the clock that stands straight before it", () => {
    const due = (text: string) => labelledFacts(text).find((fact) => fact.kind === "due");
    expect(due("Pay by: 5pm, 5 February 2027")).toMatchObject({ value: "2027-02-05", time: "17:00" });
    expect(due("Pay by 5pm on Friday 5 February 2027")).toMatchObject({ value: "2027-02-05", time: "17:00" });
    expect(due("Payment due: by 11:59 PM on March 3, 2027")).toMatchObject({ value: "2027-03-03", time: "23:59" });
    // Words between the clock and the day make it another matter.
    expect(due("Pay by: 5pm cut-off applies; 5 February 2027")?.time).toBeUndefined();
    // A clock after the day still wins.
    expect(due("Return by: 9am, Fri 30 July 2027 17:00")).toMatchObject({ value: "2027-07-30", time: "17:00" });
  });

  it("a day to pay is stated outright where the label says due or pay and its date stands straight after it", () => {
    const due = (text: string) => labelledFacts(text).find((fact) => fact.kind === "due");
    // Only joining words, a weekday, a clock or a sum may stand between.
    for (const text of [
      "Due date: 12 March 2027",
      "Payment due on or before Friday 12 March 2027",
      "Pay by | 5pm, 12 March 2027",
      "Amount due by\n12 March 2027",
      "Payment due date is no later than Fri, 12 Mar 2027",
      "Your balance must be paid by 12 March 2027.",
    ]) {
      expect({ text, fact: due(text) }).toMatchObject({ fact: { value: "2027-03-12", toPay: true } });
    }
  });

  it("a day read under a label that names another matter is not stated as a day to pay", () => {
    const due = (text: string) => labelledFacts(text).find((fact) => fact.kind === "due");
    for (const text of [
      "Your cover renews on: 12 March 2027",
      "Next billing date: 12 March 2027",
      "Please reply by 12 March 2027.",
      "Return by: 12 March 2027",
      "The instalment will be collected on 12 March 2027.",
    ]) {
      expect({ text, fact: due(text) }).toMatchObject({ fact: { value: "2027-03-12" } });
      expect({ text, toPay: due(text)?.toPay }).toEqual({ text, toPay: undefined });
    }
  });

  it("other words between a label and the date: the date may be theirs, and is not stated as the day to pay", () => {
    const due = (text: string) => labelledFacts(text).find((fact) => fact.kind === "due");
    // The day interest starts.
    const interest = due("Interest applies to amounts not paid by the due date, from 22 April 2027.");
    expect(interest).toMatchObject({ value: "2027-04-22" });
    expect(interest?.toPay).toBeUndefined();
    // The statement's own day.
    const statement = due("Payment due upon receipt. Statement date: 3 March 2027");
    expect(statement).toMatchObject({ value: "2027-03-03" });
    expect(statement?.toPay).toBeUndefined();
    // A second label that states the same day as its own settles it.
    const both = "A late fee applies once the due date, which is shown below as 12 March 2027, is over.\nPay by: 12 March 2027";
    expect(due(both)).toMatchObject({ value: "2027-03-12", toPay: true });
    // A second label that names another matter does not: the day interest
    // starts is not a day to pay because a cover renews, or a form is due
    // back, on that day.
    for (const second of ["Your cover renews on 22 April 2027", "Return by 22 April 2027"]) {
      const text = `Interest applies to amounts not paid by the due date, from 22 April 2027.\n${second}`;
      expect({ second, fact: due(text) }).toMatchObject({ fact: { value: "2027-04-22" } });
      expect({ second, toPay: due(text)?.toPay }).toEqual({ second, toPay: undefined });
    }
  });

  it("a day to pay in a clause about a court, a hearing or a filing is not stated outright: a wrong one would cost much", () => {
    const due = (text: string) => labelledFacts(text).find((fact) => fact.kind === "due");
    const fine = due("Your court fine of $200 is due on 22 April 2027.");
    expect(fine).toMatchObject({ value: "2027-04-22" });
    expect(fine?.toPay).toBeUndefined();
    expect(due("Hearing fee: payment due 22 April 2027")?.toPay).toBeUndefined();
    // Another line of the same mail is its own clause.
    expect(due("If unpaid we may refer the debt to the county court.\nDue date: 22 April 2027")).toMatchObject({ toPay: true });
  });

  it("a label inside a clause about missing the day only refers to it", () => {
    const due = (text: string) => labelledFacts(text).find((fact) => fact.kind === "due");
    // The day the late fee starts, printed straight after the words "due date".
    const fee = due("Assessments not received by the 15th day after the due date (12/15/2026) will carry a late fee.");
    expect(fee).toBeDefined();
    expect(fee?.toPay).toBeUndefined();
    const conditional = due("If we have no payment by the due date 12 March 2027, a fee is added.");
    expect(conditional).toMatchObject({ value: "2027-03-12" });
    expect(conditional?.toPay).toBeUndefined();
    // A sentence that asks for the payment states it, whatever it says about fees.
    expect(due("To avoid a late fee, please pay by 12 March 2027.")).toMatchObject({ toPay: true });
    // The clause ends with its sentence, its line or its cell.
    expect(due("We have not received it. Pay by 12 March 2027.")).toMatchObject({ toPay: true });
    expect(due("If paid late: $35.00 fee | Due date: 12 March 2027")).toMatchObject({ toPay: true });
    expect(due("After that we add interest.\nDue date: 12 March 2027")).toMatchObject({ toPay: true });
  });

  it("a clock that only stands on the same line as a day to act by is not its clock", () => {
    const notice = "Reply by 12 March 2027. Our office is open 9:00 to 17:00.";
    expect(labelledFacts(notice).find((fact) => fact.kind === "due")).toMatchObject({ value: "2027-03-12" });
    expect(labelledFacts(notice).find((fact) => fact.kind === "due")?.time).toBeUndefined();
  });
});

describe("a show's start and its doors", () => {
  const moments = (text: string) =>
    labelledFacts(text)
      .filter((fact) => fact.kind === "event")
      .map((fact) => [fact.value, fact.time]);

  it("the start outranks the doors: one moment, at the start", () => {
    expect(moments("Example Quartet\nSaturday 14 November 2026\nDoors: 7:00 PM\nShow starts: 8:00 PM")).toEqual([["2026-11-14", "20:00"]]);
    expect(moments("Friday 20 November 2026, doors 7pm, show 8pm.")).toEqual([["2026-11-20", "20:00"]]);
    expect(moments("Saturday 21 November 2026\nDoors open 18:45\nCurtain up 19:30")).toEqual([["2026-11-21", "19:30"]]);
    expect(moments("Thursday 3 December 2026\nDoors: 6:30 PM\nShow: 8:30 PM")).toEqual([["2026-12-03", "20:30"]]);
  });

  it("a start said alone is the moment", () => {
    expect(moments("Example United v Sample Town\nSunday 22 November 2026\nKick-off: 3pm")).toEqual([["2026-11-22", "15:00"]]);
    expect(moments("Wednesday 25 November 2026\nTalk begins 18:00")).toEqual([["2026-11-25", "18:00"]]);
  });

  it("doors alone keep the doors time", () => {
    expect(moments("Saturday 5 December 2026\nDoors: 7:30 PM")).toEqual([["2026-12-05", "19:30"]]);
    expect(moments("Sat 14 Nov 2026, doors 7:00 PM")).toEqual([["2026-11-14", "19:00"]]);
  });

  it("showing an ID or buying a curtain is no show", () => {
    expect(moments("Please show 1 photo ID when collecting on 14 November 2026")).toEqual([]);
    expect(moments("Blackout curtain 140x230, delivery 14 November 2026")).toEqual([]);
    expect(moments("Show this pass at the door on 14 November 2026")).toEqual([]);
    // The words still read when they say when.
    expect(moments("Thursday 3 December 2026\nDoors: 6:30 PM\nShow 8:30 PM")).toEqual([["2026-12-03", "20:30"]]);
    expect(moments("Saturday 21 November 2026\nCurtain: 19:30")).toEqual([["2026-11-21", "19:30"]]);
  });

  it("a sale or a season that starts is no show", () => {
    expect(moments("Sale starts Friday 20 November 2026 at 9am")).toEqual([]);
    expect(moments("The season starts on 1 December 2026.")).toEqual([]);
  });
});

describe("a form line read by what its label means", () => {
  // A small table, as the shipped one is shaped: normalized label to meaning.
  const table = lexiconFrom([
    ["statement", "none"],
    ["booked", "none"],
    ["order", "none"],
    ["date processed", "none"],
    ["cover ends", "expiry"],
    ["good through", "expiry"],
    ["direct debit", "due"],
    ["class begins", "event"],
    ["delivery", "event"],
    ["sailing", "depart"],
    ["certificate issued", "issued"],
  ]);
  const read = (text: string, writtenAt?: number, claimed: string[] = []) =>
    structuralDatedFacts(text, new Set(claimed), { lexicon: table, ...(writtenAt !== undefined ? { writtenAt } : {}) }).map((fact) => [
      fact.kind,
      fact.value,
      fact.time,
      fact.label,
      fact.confidence,
    ]);

  it("a statement's own day is nobody's business: nothing is read from its line", () => {
    expect(read("Statement date: 3 February 2027\nBooked on: 10 Feb 2027\nOrder date: 12 January 2027")).toEqual([]);
  });

  it("a label the table knows is a typed reading, under the document's own words", () => {
    expect(read("Cover ends: 30 November 2027")).toEqual([["expiry", "2027-11-30", undefined, "Cover ends", 0.7]]);
    expect(read("Direct debit date: 18 March 2027")).toEqual([["due", "2027-03-18", undefined, "Direct debit date", 0.7]]);
    expect(read("Class begins: Tuesday 2 November 2027 at 6:30 PM")).toEqual([["event", "2027-11-02", "18:30", "Class begins", 0.7]]);
  });

  it("a day under a known label is stated as a day to pay where the label says due or pay and the date starts its value", () => {
    const words = lexiconFrom([
      ["balance due", "due"],
      ["direct debit", "due"],
      ["renewal premium due", "due"],
    ]);
    const one = (text: string) => structuralDatedFacts(text, new Set(), { lexicon: words })[0];
    expect(one("Balance due: Thursday 18 March 2027")).toMatchObject({ kind: "due", value: "2027-03-18", toPay: true });
    // Other words start the value: the date may be theirs.
    const loose = one("Balance due: see your statement, issued 18 March 2027");
    expect(loose).toMatchObject({ kind: "due", value: "2027-03-18" });
    expect(loose?.toPay).toBeUndefined();
    // A label that names another matter, or a renewal.
    expect(one("Direct debit date: 18 March 2027")).toMatchObject({ kind: "due", value: "2027-03-18" });
    expect(one("Direct debit date: 18 March 2027")?.toPay).toBeUndefined();
    expect(one("Renewal premium due: 18 March 2027")).toMatchObject({ kind: "due", value: "2027-03-18" });
    expect(one("Renewal premium due: 18 March 2027")?.toPay).toBeUndefined();
  });

  it("an end of a journey or a stay carries its role", () => {
    const [sailing] = structuralDatedFacts("Sailing date: 2 July 2027, 07:30", new Set(), { lexicon: table });
    expect(sailing).toMatchObject({ kind: "event", value: "2027-07-02", time: "07:30", label: "Sailing date" });
    expect(subjectOf(sailing!)).toMatchObject({ role: "depart" });
  });

  it("a label the table does not hold is kept with its own words, as before", () => {
    expect(read("Boarding group: 12 March 2027")).toEqual([["dated", "2027-03-12", undefined, "Boarding group", 0.4]]);
    // And with no table at all, every line is read as before.
    expect(structuralDatedFacts("Statement date: 3 February 2027", new Set()).map((fact) => [fact.kind, fact.label])).toEqual([["dated", "Statement date"]]);
  });

  it("a line that is nobody's business and also states a deadline keeps the deadline", () => {
    const text = "Statement date: 3 Feb 2027, pay by 20 Feb 2027";
    const typed = labelledFacts(text);
    expect(typed.map((fact) => [fact.kind, fact.value])).toEqual([["due", "2027-02-20"]]);
    expect(read(text, undefined, typed.map((fact) => fact.value))).toEqual([]);
  });

  it("a date with no year on a typed line in a message is read; an expiry never, and an unknown label never", () => {
    const sent = Date.UTC(2026, 10, 9, 12);
    expect(read("Delivery: Thursday, November 12", sent)).toEqual([["event", "2026-11-12", undefined, "Delivery", 0.5]]);
    expect(read("Good through: November 12", sent)).toEqual([]);
    expect(read("Boarding group: November 12", sent)).toEqual([]);
    // A day of issue is behind the message, never the next such day after it.
    expect(read("Certificate issued: November 12", sent)).toEqual([]);
    expect(read("Certificate issued: 12 November 2026", sent)).toEqual([["issued", "2026-11-12", undefined, "Certificate issued", 0.7]]);
    // In a stored file no year is known.
    expect(read("Delivery: Thursday, November 12")).toEqual([]);
    // A day said with "of" keeps the year written after it.
    expect(read("Direct debit: the 5th of December 2028", sent)).toEqual([["due", "2028-12-05", undefined, "Direct debit", 0.7]]);
  });

  it("one date, one reading: a typed line wins over a line that only names the same day, and a claimed day is not read again", () => {
    expect(read("Renewal reminder: 30 November 2027\nCover ends: 30 November 2027")).toEqual([["expiry", "2027-11-30", undefined, "Cover ends", 0.7]]);
    expect(read("Cover ends: 30 November 2027", undefined, ["2027-11-30"])).toEqual([]);
  });

  it("a hundred lines of past processing give nothing, in one pass", () => {
    const statement = Array.from({ length: 100 }, (_, i) => `Date processed: ${(i % 28) + 1} ${["January", "February", "March", "April"][i % 4]} 2027`).join("\n");
    const started = performance.now();
    expect(read(statement)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("names the lines that are nobody's business, so nothing else asks about them either", () => {
    const text = "Statement date: 3 February 2027\nCover ends: 30 November 2027\nBooked on: 10 Feb 2027";
    const spans = settledNowhere(text, table);
    expect(spans.map((span) => text.slice(span.at, span.end))).toEqual(["Statement date: 3 February 2027", "Booked on: 10 Feb 2027"]);
  });

  it("a clock line does not take the day of a line that is nobody's business", () => {
    const moments = (text: string) => labelledFacts(text, undefined, table).filter((fact) => fact.kind === "event").map((fact) => [fact.value, fact.time]);
    expect(moments("Booked on: 10 Feb 2027\nDeparts: 14:20")).toEqual([]);
    // The day of the journey stands further up, past the booking line.
    expect(moments("Outbound: Mon 12 Apr 2027\nBooked on: 10 Feb 2027\nDeparts: 14:20")).toEqual([["2027-04-12", "14:20"]]);
  });

  it("a clock line under a typed line gives the moment its clock", () => {
    expect(read("Class begins: Tuesday 2 November 2027\nClass time: 6:30 PM")).toEqual([["event", "2027-11-02", "18:30", "Class begins", 0.7]]);
    // Past a line that says nothing of time.
    expect(read("Class begins: 2 November 2027\nRoom: Studio 4\nTime: 18:30")).toEqual([["event", "2027-11-02", "18:30", "Class begins", 0.7]]);
  });

  it("a clock that is not the moment's own lends nothing", () => {
    const bare = [["event", "2027-11-02", undefined, "Class begins", 0.7]];
    // The table gives the clock line a meaning of its own.
    expect(read("Class begins: 2 November 2027\nDirect debit: 9:00 AM")).toEqual(bare);
    // Past a blank line the block is over.
    expect(read("Class begins: 2 November 2027\n\nTime: 18:30")).toEqual(bare);
    // Hours are a span, not a moment; a sentence is no clock line.
    expect(read("Class begins: 2 November 2027\nOffice open: 9:00 to 17:00")).toEqual(bare);
    expect(read("Class begins: 2 November 2027\nPlease arrive by 6:15 PM to set up.")).toEqual(bare);
    // A clock said of something else (when to arrive, when the desk opens) is not the moment's.
    expect(read("Class begins: 2 November 2027\nArrive by: 6:15 PM")).toEqual(bare);
    expect(read("Class begins: 2 November 2027\nRegistration: 6:00 PM")).toEqual(bare);
    // Past such a line, the moment's own clock is still found.
    expect(read("Class begins: 2 November 2027\nRegistration: 6:00 PM\nClass time: 6:30 PM")).toEqual([["event", "2027-11-02", "18:30", "Class begins", 0.7]]);
    // A clock under another date line is that line's.
    expect(read("Class begins: 2 November 2027\nCover ends: 30 November 2027\nTime: 18:30")).toEqual([
      bare[0],
      ["expiry", "2027-11-30", undefined, "Cover ends", 0.7],
    ]);
  });
});

describe("fieldLines", () => {
  it("gives each form line its label, its value and its place", () => {
    const text = "Rail ticket\nDate: Saturday 15 May 2027\n  Fare :  £48.50\nfrom 15:00 on 8 April 2027";
    const lines = fieldLines(text);
    expect(lines.map((line) => [line.label, line.value])).toEqual([
      ["Date", "Saturday 15 May 2027"],
      ["Fare", "£48.50"],
    ]);
    expect(text.slice(lines[0]!.at, lines[0]!.end)).toBe("Date: Saturday 15 May 2027");
  });

  it("leaves out what the reader never read: a birth date, a print stamp, and a quoted message's header block", () => {
    expect(fieldLines("Date of birth: 3 March 1990\nPrinted: 4 March 2027").map((line) => line.label)).toEqual([]);
    expect(fieldLines("From: a@example.com\nDate: 3 March 2027\nSubject: hello").map((line) => line.label)).toEqual([]);
    // A lone Date line is a ticket's.
    expect(fieldLines("Rail ticket\nDate: 3 March 2027").map((line) => line.label)).toEqual(["Date"]);
  });
});

describe("money as documents write it", () => {
  const read = (text: string) => moneyEvery(text).map((amount) => `${amount.unit} ${amount.value}${amount.minus ? " minus" : ""}`);

  it("reads the currency before the number, as a symbol or a code, with either decimal mark", () => {
    expect(read("Total $1,250.50")).toEqual(["USD 1250.50"]);
    expect(read("Total: EUR 1.250,00")).toEqual(["EUR 1250.00"]);
    expect(read("Total fare: €213,40")).toEqual(["EUR 213.40"]);
    expect(read("USD12.00 and CHF 9.00")).toEqual(["USD 12.00", "CHF 9.00"]);
  });

  it("reads the currency after the number, as a code or a symbol", () => {
    expect(read("Amount due: 86.40 GBP")).toEqual(["GBP 86.40"]);
    expect(read("Total to pay 1.234,50 EUR")).toEqual(["EUR 1234.50"]);
    expect(read("Total charged: 29,99 €")).toEqual(["EUR 29.99"]);
    expect(read("Amount payable 48.50€")).toEqual(["EUR 48.50"]);
    expect(read("450.00 CAD")).toEqual(["CAD 450.00"]);
  });

  it("gives each number one currency, and each currency to one number", () => {
    expect(read("Subtotal 10.00 GBP  VAT 12.00 EUR")).toEqual(["GBP 10.00", "EUR 12.00"]);
    expect(read("GBP 10.00 EUR 12.00")).toEqual(["GBP 10.00", "EUR 12.00"]);
    expect(read("120.00 GBP 24.00 GBP 144.00 GBP")).toEqual(["GBP 120.00", "GBP 24.00", "GBP 144.00"]);
    // The code between the two numbers is the first one's; the second has none.
    expect(read("Total 12.00 EUR 13.00")).toEqual(["EUR 12.00"]);
    // A currency on the line above is not the number's.
    expect(read("Subtotal 72.00\nUSD 14.40")).toEqual(["USD 14.40"]);
    // A symbol glued to the next number is that number's, never the one before it.
    expect(read("Hours 2.50 £40.00 £100.00")).toEqual(["GBP 40.00", "GBP 100.00"]);
    expect(read("Unleaded 45.20 £62.15")).toEqual(["GBP 62.15"]);
    expect(read("Consulting 10.00 $150.00 $1,500.00")).toEqual(["USD 150.00", "USD 1500.00"]);
    expect(read("Credit 10.00 $-5.00")).toEqual(["USD 5.00 minus"]);
    // A symbol that stands free after a number still closes it.
    expect(read("29,99 € 15,00 €")).toEqual(["EUR 29.99", "EUR 15.00"]);
  });

  it("takes the code after a dollar amount as its currency", () => {
    expect(read("Total: $35.00 CAD")).toEqual(["CAD 35.00"]);
    expect(read("$35.00 CAD $4.90 CAD")).toEqual(["CAD 35.00", "CAD 4.90"]);
    expect(read("£12.00 GBP")).toEqual(["GBP 12.00"]);
  });

  it("reads no amount from a clock, a weight, a version or a number with no currency", () => {
    expect(read("Doors at 12.00 PM")).toEqual([]);
    expect(read("Weight 3.50 kg")).toEqual([]);
    expect(read("Total: 14.30")).toEqual([]);
    expect(read("Firmware v2.10 USB")).toEqual([]);
    expect(read("Paid USD 0.00")).toEqual([]);
  });

  it("marks an amount with a minus sign on it, and no other", () => {
    expect(read("Discount: -£5.50")).toEqual(["GBP 5.50 minus"]);
    expect(read("Insurance adjustment: -CAD 190.00")).toEqual(["CAD 190.00 minus"]);
    expect(read("Insurance adjustment: \u2212CAD 190.00")).toEqual(["CAD 190.00 minus"]);
    expect(read("Credit $-12.50")).toEqual(["USD 12.50 minus"]);
    expect(read("Refund -20,00 €")).toEqual(["EUR 20.00 minus"]);
    // A range, a dash between a label and its amount, and brackets are not a minus.
    expect(read("Tickets £10.00-£20.00")).toEqual(["GBP 10.00", "GBP 20.00"]);
    expect(read("Shipping - $4.90")).toEqual(["USD 4.90"]);
    expect(read("your plan (USD 59.99)")).toEqual(["USD 59.99"]);
  });

  it("says where each amount stands, from its currency to its last character", () => {
    const text = "Fare: £33.00, total 27.50 GBP.";
    expect(moneyEvery(text).map((amount) => text.slice(amount.at, amount.end))).toEqual(["£33.00", "27.50 GBP"]);
  });
});

describe("an amount with its label and what the label means", () => {
  // A small table, as the shipped one is shaped: normalized label to meaning.
  const table = lexiconFrom(
    [],
    [
      ["subtotal", "part"],
      ["vat", "part"],
      ["service fees", "part"],
      ["railcard discount", "part"],
      ["sales tax", "part"],
      ["items total", "part"],
      ["delivery total", "part"],
      ["total", "total"],
      ["total to pay", "due"],
      ["amount due", "due"],
      ["total stay", "total"],
      ["total paid", "total"],
      ["total incl vat", "total"],
    ],
  );
  const read = (text: string) => amountLines(text, table).map((amount) => [amount.value, amount.label, amount.meaning]);

  it("a comma parts a label from the words before it, whatever those words and the label make together", () => {
    // "Items total" and "Delivery total" are parts; a total named after a comma is not.
    expect(read("3 items, total: $45.00")).toEqual([["45.00", "total", "total"]]);
    expect(read("Delivery, total $45.00")).toEqual([["45.00", "total", "total"]]);
    expect(read("Return trip, total paid: $80.00")).toEqual([["80.00", "total paid", "total"]]);
  });

  it("the label is the words before the amount on its line, and the table says what they mean", () => {
    expect(read("Subtotal £118.40\nVAT £5.92\nTotal to pay: £124.32")).toEqual([
      ["118.40", "Subtotal", "part"],
      ["5.92", "VAT", "part"],
      ["124.32", "Total to pay", "due"],
    ]);
    expect(read("Total stay USD 450.00")).toEqual([["450.00", "Total stay", "total"]]);
    expect(read("Subtotal ........ $35.00")).toEqual([["35.00", "Subtotal", "part"]]);
    expect(read("Total (incl. VAT)   €240.00")).toEqual([["240.00", "Total (incl. VAT)", "total"]]);
    expect(read("VAT 20%   €40.00")).toEqual([["40.00", "VAT 20%", "part"]]);
  });

  it("two amounts on one line have a label each", () => {
    expect(read("Fare: £33.00, railcard discount: -£5.50")).toEqual([
      ["33.00", "Fare", undefined],
      ["5.50", "railcard discount", "part"],
    ]);
    expect(read("Subtotal 120.00 GBP  VAT 24.00 GBP")).toEqual([
      ["120.00", "Subtotal", "part"],
      ["24.00", "VAT", "part"],
    ]);
  });

  it("an amount alone on its line takes the label on the line above", () => {
    expect(read("Subtotal\n$50.00\nSales tax\n$4.00\nAmount due\n$54.00")).toEqual([
      ["50.00", "Subtotal", "part"],
      ["4.00", "Sales tax", "part"],
      ["54.00", "Amount due", "due"],
    ]);
    // Words the table does not hold, an amount above, or an empty line above give no meaning.
    expect(read("Thank you\n$57.45")).toEqual([["57.45", "Thank you", undefined]]);
    expect(read("Amount due $10.00\n$57.45")).toEqual([
      ["10.00", "Amount due", "due"],
      ["57.45", undefined, undefined],
    ]);
    expect(read("Amount due\n\n$57.45")).toEqual([["57.45", undefined, undefined]]);
    // An amount with words behind it on its line is not alone.
    expect(read("Amount due\n$57.45 was paid")).toEqual([["57.45", undefined, undefined]]);
  });

  it("a minus, a rate, a deposit and a price for one of several are parts, whatever the table holds", () => {
    expect(read("Total paid: -$20.00")).toEqual([["20.00", "Total paid", "part"]]);
    expect(read("Room rate per night USD 150.00")[0]![2]).toBe("part");
    expect(read("Total paid: $140.00 per night")[0]![2]).toBe("part");
    expect(read("A deposit of $100.00 holds your booking.")[0]![2]).toBe("part");
    expect(read("Deposit paid: $100.00")[0]![2]).toBe("part");
    expect(read("Tickets: 2 x $55.00, service fees: $11.00")).toEqual([
      ["55.00", "Tickets: 2 x", "part"],
      ["11.00", "service fees", "part"],
    ]);
    // The total that is left after a deposit is not the deposit.
    expect(read("Total due after your deposit: $353.60")[0]![2]).toBeUndefined();
  });

  it("a sentence is not a label", () => {
    expect(read("Any change to your booking carries a change fee of CAD 35.00 and more words.")).toEqual([["35.00", undefined, undefined]]);
  });

  it("with no table, only what the amount itself shows is known", () => {
    const bare = amountLines("Subtotal £118.40\nDiscount -£5.00\nTotal to pay: £113.40").map((amount) => [amount.value, amount.label, amount.meaning]);
    expect(bare).toEqual([
      ["118.40", "Subtotal", undefined],
      ["5.00", "Discount", "part"],
      ["113.40", "Total to pay", undefined],
    ]);
  });
});

describe("the whole amount of a document, by its label", () => {
  const table = lexiconFrom(shipped.dates, shipped.amounts);
  const whole = (text: string) =>
    labelledFacts(text, undefined, table)
      .filter((fact) => fact.kind === "amount")
      .map((fact) => [fact.value, fact.unit, fact.sum, fact.label]);

  it("the amount a label calls due is the bill's amount, in the document's own words", () => {
    expect(whole("Subtotal £118.40\nVAT £5.92\nTotal to pay: £124.32")).toEqual([["124.32", "GBP", "due", "Total to pay"]]);
    expect(whole("Usage charge 56.00 GBP\nStanding charge 30.40 GBP\nAmount due: 86.40 GBP")).toEqual([["86.40", "GBP", "due", "Amount due"]]);
    expect(whole("Subtotal\n$50.00\nSales tax\n$4.00\nAmount due\n$54.00")).toEqual([["54.00", "USD", "due", "Amount due"]]);
  });

  it("with nothing due, the amount a label calls the total is the document's amount", () => {
    expect(whole("Fare: £33.00, railcard discount: -£5.50\nTotal paid: £27.50")).toEqual([["27.50", "GBP", "total", "Total paid"]]);
    expect(whole("Vehicle: $140.00\nPassenger: $46.00\nTotal fare: $186.00")).toEqual([["186.00", "USD", "total", "Total fare"]]);
    expect(whole("Room rate per night USD 150.00\nDeposit paid USD 100.00\nTotal stay USD 450.00")).toEqual([["450.00", "USD", "total", "Total stay"]]);
    expect(whole("Subtotal $35.00\nShipping $4.90\nOrder total $39.90")).toEqual([["39.90", "USD", "total", "Order total"]]);
  });

  it("what is still due stands before what it all came to", () => {
    expect(whole("Total charges: CAD 320.00\nInsurance adjustment: -CAD 190.00\nPatient balance: CAD 130.00")).toEqual([
      ["130.00", "CAD", "due", "Patient balance"],
    ]);
    expect(whole("Invoice total: £500.00\nAmount paid: £200.00\nBalance due: £300.00")).toEqual([["300.00", "GBP", "due", "Balance due"]]);
    // Nothing is due any more: the total is what the document came to.
    expect(whole("Total: $80.00\nAmount paid: $80.00\nBalance due: $0.00")).toEqual([["80.00", "USD", "total", "Total"]]);
  });

  it("a total printed twice with one value is one amount, under its first name", () => {
    expect(whole("Total: $65.31\nAmount charged: $65.31")).toEqual([["65.31", "USD", "total", "Total"]]);
    expect(whole("Amount due $84.20\nTotal due: $84.20")).toEqual([["84.20", "USD", "due", "Amount due"]]);
  });

  it("two totals that differ, or two amounts due that differ, are not guessed between", () => {
    expect(whole("Total fare: €213,40\nTotal paid: €225,40")).toEqual([]);
    expect(whole("Amount due: $50.00\nBalance due: $75.00")).toEqual([]);
  });

  it("a part is never the whole, alone or beside a sum", () => {
    expect(whole("Reschedule fee: $25.00")).toEqual([]);
    expect(whole("Items: $62.40, shipping: $6.00")).toEqual([]);
    expect(whole("Previous balance due: $64.10")).toEqual([]);
    expect(whole("Previous balance due: $64.10\nAmount due: $92.35")).toEqual([["92.35", "USD", "due", "Amount due"]]);
  });

  it("a statement with a minimum beside its balance still names no single amount", () => {
    expect(whole("Minimum payment due $35.00\nNew balance $1,240.18")).toEqual([]);
    expect(whole("Statement balance: CAD 615.40\nMinimum payment: CAD 20.00")).toEqual([]);
    // A minimum whose label stands on the line above, or is closed by a colon, is a minimum still.
    expect(whole("Amount due\n$1,234.56\nMinimum payment\n$35.00")).toEqual([]);
    expect(whole("Minimum payment\n$35.00\nAmount due\n$1,234.56")).toEqual([]);
    expect(whole("Amount due $1,234.56\nMinimum: $35.00")).toEqual([]);
    // A word that only begins like it is none.
    expect(whole("Parking: 45 minutes\nTotal paid: $6.00")).toEqual([["6.00", "USD", "total", "Total paid"]]);
  });

  it("a payslip's total and a bank account's totals are not a bill's whole amount", () => {
    expect(whole("Payslip for November\nBasic £3,000.00\nTotal £3,000.00\nNet pay £2,400.00")).toEqual([]);
    expect(whole("Current account\nOpening balance £1,000.00\nWithdrawals\nTotal £5,000.00\nClosing balance £1,200.00")).toEqual([]);
    expect(whole("Paid in\n£2,400.00\nPaid out\n£500.00")).toEqual([]);
    // A bill that shows where its balance came from still asks for its amount.
    expect(whole("Opening balance £30.00\nPayments -£30.00\nNew charges £55.20\nTotal due £55.20")).toEqual([["55.20", "GBP", "due", "Total due"]]);
  });

  it("an amount a sentence says is due is still read, under the reader's own name for it", () => {
    expect(whole("Rent of USD 2,400.00 is due on 1 May 2027.")).toEqual([["2400.00", "USD", "due", "Amount due"]]);
  });

  it("with no table, only a line that says an amount is due is read, as before", () => {
    const bare = (text: string) => labelledFacts(text).filter((fact) => fact.kind === "amount").map((fact) => [fact.value, fact.sum, fact.label]);
    expect(bare("Subtotal £118.40\nVAT £5.92\nAmount due: £124.32")).toEqual([["124.32", "due", "Amount due"]]);
    expect(bare("Fare: £33.00\nTotal paid: £27.50")).toEqual([]);
  });
});

describe("a table read by its rows, each cell under the header of its column", () => {
  const table = lexiconFrom(shipped.dates, shipped.amounts);
  const lines = (...text: string[]) => text.join("\n");
  // The two label passes, as a scan runs them: the word rules, then the form lines.
  const read = (text: string, writtenAt?: number) => {
    const typed = labelledFacts(text, writtenAt, table);
    return [...typed, ...structuralDatedFacts(text, new Set(typed.map((fact) => fact.value)), { lexicon: table, ...(writtenAt !== undefined ? { writtenAt } : {}) })];
  };
  const dated = (text: string) =>
    read(text)
      .filter((fact) => fact.kind !== "amount" && fact.kind !== "identifier")
      .map((fact) => [fact.kind, fact.value, fact.time, subjectOf(fact)?.role])
      .sort();
  const whole = (text: string) => read(text).filter((fact) => fact.kind === "amount").map((fact) => [fact.value, fact.unit, fact.sum, fact.label]);

  it("a timetable: each clock is a moment on its row's day, by its column; the header row gives nothing", () => {
    expect(dated(lines("Tidewater Ferries Example", "", "Sailing | Date | Departs | Arrives", "Outbound | 2 July 2027 | 07:30 | 10:45", "Return | 9 July 2027 | 16:00 | 19:15"))).toEqual([
      ["event", "2027-07-02", "07:30", "depart"],
      ["event", "2027-07-02", "10:45", "arrive"],
      ["event", "2027-07-09", "16:00", "depart"],
      ["event", "2027-07-09", "19:15", "arrive"],
    ]);
  });

  it("a stay: the day under Check-in and the day under Check-out, each once, with the clock its own cell states", () => {
    expect(dated(lines("Check-in | Check-out | Nights", "11 Nov 2027 | 14 Nov 2027 | 3"))).toEqual([
      ["event", "2027-11-11", undefined, "check-in"],
      ["event", "2027-11-14", undefined, "check-out"],
    ]);
    expect(dated(lines("Check-in | Check-out | Nights", "Fri 12 March 2027, from 15:00 | Mon 15 March 2027, by 11:00 | 3"))).toEqual([
      ["event", "2027-03-12", "15:00", "check-in"],
      ["event", "2027-03-15", "11:00", "check-out"],
    ]);
  });

  it("a header row is never a label for the line under it", () => {
    // Before, Departs and Arrives both took the first date of the next line.
    expect(dated(lines("Departs | Arrives", "2 July 2027 07:30 | 2 July 2027 10:45", "9 July 2027 16:00 | 9 July 2027 19:15"))).toEqual([
      ["event", "2027-07-02", "07:30", "depart"],
      ["event", "2027-07-02", "10:45", "arrive"],
      ["event", "2027-07-09", "16:00", "depart"],
      ["event", "2027-07-09", "19:15", "arrive"],
    ]);
  });

  it("a day and one clock in a row are one moment, whatever the columns are called", () => {
    expect(dated(lines("Spring course timetable", "Date | Time | Room", "Mon 1 Feb 2027 | 10:00 | Room 4", "Mon 8 Feb 2027 | 14:00 | Room 7"))).toEqual([
      ["event", "2027-02-01", "10:00", undefined],
      ["event", "2027-02-08", "14:00", undefined],
    ]);
  });

  it("a list of payments with a time of day is no timetable: its rows hold amounts, and give nothing", () => {
    const statement = lines(
      "Payment due: 23 November 2026",
      "",
      "Date | Time | Merchant | Amount (GBP)",
      ...Array.from({ length: 30 }, (_, i) => `${(i % 28) + 1} Oct 2026 | 08:${String(i).padStart(2, "0")} | Shop ${i} | ${i + 1}.50`),
    );
    expect(dated(statement)).toEqual([["due", "2026-11-23", undefined, undefined]]);
  });

  it("a day and a clock are a moment only under columns that say so: a first row of words is no such header", () => {
    expect(dated(lines("Outbound | BA 123 | London Heathrow", "Departs | 2 July 2027 | 07:30", "Arrives | 2 July 2027 | 10:45"))).toEqual([
      ["event", "2027-07-02", "07:30", "depart"],
      ["event", "2027-07-02", "10:45", "arrive"],
    ]);
  });

  it("a row with a cell missing is not read under the header: its clock could be either column's", () => {
    expect(dated(lines("Date | Departs | Arrives", "2 July 2027 | 07:30 | 10:45", "9 July 2027 | 19:15"))).toEqual([
      ["event", "2027-07-02", "07:30", "depart"],
      ["event", "2027-07-02", "10:45", "arrive"],
    ]);
  });

  it("labels and values in two cells are form lines: the table types them or says they are nobody's business", () => {
    expect(dated(lines("Statement date | 2 November 2026", "Account | REF-48213", "Payment due | 23 November 2026"))).toEqual([["due", "2026-11-23", undefined, undefined]]);
    expect(dated(lines("Issued | 3 May 2027", "Number | 07700 900123", "Pay by | Mon 24 May 2027")).filter(([kind]) => kind === "due")).toEqual([
      ["due", "2027-05-24", undefined, undefined],
    ]);
  });

  it("a field in one cell of a page set in two columns is read from its own cell", () => {
    expect(dated(lines("12 High Street | Invoice date: 3 Feb 2027", "Lakeside LK1 2AB | Payment due: 23 Feb 2027"))).toEqual([["due", "2027-02-23", undefined, undefined]]);
    expect(fieldLines("12 High Street | Invoice date: 3 Feb 2027").map((line) => [line.label, line.value])).toEqual([["Invoice date", "3 Feb 2027"]]);
  });

  it("a history of payments gives nothing: a cell under a name the table does not hold is no form line", () => {
    const history = lines("Date | Description | Amount", ...Array.from({ length: 100 }, (_, i) => `${(i % 28) + 1} March 2027 | Card payment ${i} | £${i + 1}.50`));
    read(history);
    const started = performance.now();
    expect(dated(history)).toEqual([]);
    // A wide limit, for a shared test machine.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(whole(history)).toEqual([]);
  });

  it("an amount alone in its cell takes the currency its column names, and its row's name says what it is", () => {
    const bill = lines("Description | Period | Amount (GBP)", "Electricity | 1 Oct to 31 Oct | 52.10", "Gas | 1 Oct to 31 Oct | 34.25", "Total | | 86.35");
    expect(whole(bill)).toEqual([["86.35", "GBP", "total", "Total"]]);
    expect(amountLines(bill, table).map((amount) => [amount.value, amount.unit, amount.label, amount.meaning])).toEqual([
      ["52.10", "GBP", "Electricity", undefined],
      ["34.25", "GBP", "Gas", undefined],
      ["86.35", "GBP", "Total", "total"],
    ]);
    // Two columns: the first row names the currency.
    expect(whole(lines("Description | Amount (USD)", "Plan | 40.00", "Taxes and fees | 6.20", "Total to pay | 58.20"))).toEqual([["58.20", "USD", "due", "Total to pay"]]);
    // The column's own name says what its amounts are, when the row has no name for them.
    expect(whole(lines("Invoice | Due date | Amount due", "INV-1144 | 23 November 2026 | £292.20"))).toEqual([["292.20", "GBP", "due", "Amount due"]]);
  });

  it("an amount named under a table takes the one currency the document names; a rate inside the table takes none", () => {
    const bill = lines(
      "Charge | Volume | Rate | Amount (USD)",
      "Water supply | 41 m3 | 1.92 | 78.72",
      "Sewerage | 41 m3 | 1.55 | 63.55",
      "Last payment received | 12 Jan 2027 | 70.00",
      "Amount due | 142.27",
      "Payment due date | 4 June 2027",
    );
    expect(whole(bill)).toEqual([["142.27", "USD", "due", "Amount due"]]);
    // The rates (1.92, 1.55) are no amounts; a payment under a name the table knows is one, and is no total.
    expect(amountLines(bill, table).map((amount) => [amount.value, amount.label])).toEqual([
      ["78.72", "Water supply"],
      ["63.55", "Sewerage"],
      ["70.00", "Last payment received"],
      ["142.27", "Amount due"],
    ]);
    // Two currencies named: which one is not known, so the number is no amount.
    expect(whole(lines("Item | Price (USD) | Price (EUR)", "Ticket | 20.00 | 18.00", "Total due | 20.00"))).toEqual([]);
  });

  it("a number with no currency anywhere near is still no amount", () => {
    expect(whole(lines("Fare | Qty | Amount", "Adult | 2 | 108.00", "Total | | 108.00"))).toEqual([]);
  });
});
