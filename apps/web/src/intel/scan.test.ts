import { describe, expect, it } from "vitest";
import { scanForFacts } from "./scan";

const base = { name: "policy.pdf", mime: "application/pdf" };

describe("scanForFacts", () => {
  it("reads facts out of extracted text with no file present", async () => {
    const out = await scanForFacts({
      ...base,
      text: "Certificate of Motor Insurance\nValid until 2027-04-30",
    });
    expect(out.facts.find((f) => f.kind === "expiry")).toMatchObject({
      value: "2027-04-30",
      document: "insurance",
      source: "label",
    });
  });

  it("marks every fact unconfirmed, whatever it came from", async () => {
    const out = await scanForFacts({ ...base, text: "Expires 2027-04-30" });
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.facts.every((f) => !f.confirmed)).toBe(true);
  });

  it("prefers the machine-readable zone over a date printed beside it", async () => {
    const zone =
      "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n" +
      "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
    const out = await scanForFacts({ ...base, text: `Expires 15 April 2012\n${zone}` });
    const expiry = out.facts.find((f) => f.kind === "expiry");
    expect(expiry).toMatchObject({ value: "2012-04-15", source: "mrz", confidence: 1 });
  });

  it("keeps the full reference number out of the summary and puts it in evidence", async () => {
    const out = await scanForFacts({
      ...base,
      text: "Policy number AB1234567890\nExpires 2027-04-30",
    });
    const id = out.facts.find((f) => f.kind === "identifier");
    expect(id).toBeDefined();
    expect(id!.value).toBe("7890");
    expect(id!.masked).toBe("7890");
    // Nothing anywhere in the summary may carry the whole number.
    expect(JSON.stringify(out.facts)).not.toContain("AB1234567890");
    expect(out.evidence.find((e) => e.id === id!.id)!.full).toBe("AB1234567890");
  });

  it("discards a value the document does not actually contain", async () => {
    // Grounding is exercised through the real pipeline, not only in isolation.
    const out = await scanForFacts({ ...base, text: "This document mentions no dates." });
    expect(out.facts.filter((f) => f.kind === "expiry")).toEqual([]);
  });

  it("reads the form that exposed the vocabulary's limit", async () => {
    const out = await scanForFacts({
      name: "benefits-statement.pdf",
      mime: "application/pdf",
      text: "Enrollment Record Number: X90000012B3\nEnrollment/Issued Date: 2027 April 12\nCoverage Class: R2\nBenefit End Date: 2027 October 19",
    });
    // The controlling date, read by what its label means and kept under
    // the document's own words.
    expect(out.facts.find((f) => f.kind === "expiry")).toMatchObject({
      value: "2027-10-19",
      label: "Benefit End Date",
    });
    expect(out.facts.some((f) => f.kind === "dated")).toBe(false);
    expect(out.facts.find((f) => f.kind === "issued")?.value).toBe("2027-04-12");
    expect(out.facts.find((f) => f.kind === "identifier")?.masked).toBe("12B3");
  });

  it("keeps a moment whose clock is written with one digit for the hour", async () => {
    const moments = async (text: string) => (await scanForFacts({ ...base, text })).facts.filter((f) => f.kind === "event").map((f) => [f.value, f.time]);
    expect(await moments("Exam date: 12 June 2027\nTime: 9:00")).toEqual([["2027-06-12", "09:00"]]);
    expect(await moments("Course starts: 6 September 2027\nRoom: B12\nTime: 9:15")).toEqual([["2027-09-06", "09:15"]]);
    expect(await moments("Your appointment is on 3 March 2027 at 9:30 with Dr. Lee.")).toEqual([["2027-03-03", "09:30"]]);
  });

  it("reads a form line by what its label means, from the shipped table", async () => {
    const dated = async (text: string) =>
      (await scanForFacts({ ...base, text })).facts.filter((f) => f.kind !== "identifier" && f.kind !== "amount").map((f) => [f.kind, f.value]);
    // A statement's own day is nobody's business; a deadline on the same line stays.
    expect(await dated("Statement date: 3 February 2027")).toEqual([]);
    expect(await dated("Statement date: 3 Feb 2027, pay by 20 Feb 2027")).toEqual([["due", "2027-02-20"]]);
    // A label the table knows is typed; one it does not hold is kept with its own words.
    expect(await dated("Cover ends: 30 November 2027")).toEqual([["expiry", "2027-11-30"]]);
    expect(await dated("Ledger folio: 12 March 2027")).toEqual([["dated", "2027-03-12"]]);
  });

  it("returns nothing at all for a file with no text and no bytes", async () => {
    const out = await scanForFacts({ name: "a.zip", mime: "application/zip" });
    expect(out.facts).toEqual([]);
    expect(out.evidence).toEqual([]);
    expect(out.decoded).toEqual([]);
  });

  it("never carries more facts than a file is allowed", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Ref AB${i}00000${i}`).join("\n");
    const out = await scanForFacts({ ...base, text: many });
    expect(out.facts.length).toBeLessThanOrEqual(12);
  });

  describe("a priced package email and the limit on a file's facts", () => {
    const leg = (number: string, from: string, to: string, day: string, price?: string) => ({
      "@type": "FlightReservation",
      reservationNumber: "ZK8Q2P",
      reservationFor: {
        "@type": "Flight",
        flightNumber: number,
        airline: { iataCode: "TP" },
        departureAirport: { iataCode: from },
        arrivalAirport: { iataCode: to },
        departureTime: `${day}T08:00:00+00:00`,
        arrivalTime: `${day}T11:00:00+00:00`,
      },
      ...(price ? { totalPrice: price, priceCurrency: "USD" } : {}),
    });
    const hotel = {
      "@type": "LodgingReservation",
      reservationNumber: "CR77419C1D",
      reservationFor: { name: "Casa do Rio" },
      checkinTime: "2026-11-13T15:00:00+00:00",
      checkoutTime: "2026-11-16T11:00:00+00:00",
      totalPrice: "652.00",
      priceCurrency: "EUR",
    };
    const scan = async (nodes: unknown[]) =>
      (await scanForFacts({ name: "Your trip.email", mime: "application/vnd.engram.email+json", raw: `<html><script type="application/ld+json">${JSON.stringify(nodes)}</script></html>` })).facts;
    const count = (facts: { kind: string }[], kind: string) => facts.filter((f) => f.kind === kind).length;

    it("four legs and a hotel keep every date, reference and price", async () => {
      const facts = await scan([
        leg("236", "SFO", "JFK", "2026-11-12", "1184.00"),
        leg("237", "JFK", "LIS", "2026-11-13", "1184.00"),
        leg("238", "LIS", "JFK", "2026-11-16", "1184.00"),
        leg("239", "JFK", "SFO", "2026-11-17", "1184.00"),
        hotel,
      ]);
      expect([count(facts, "event"), count(facts, "identifier"), count(facts, "amount")]).toEqual([10, 2, 2]);
    });

    it("past thirty-two exact facts, dates are kept first, then references, then prices", async () => {
      // Fourteen legs and a hotel: thirty dates, two references and two prices.
      const legs = Array.from({ length: 14 }, (_, i) => leg(String(300 + i), "SFO", "LIS", `2026-10-${String(i + 1).padStart(2, "0")}`, "1184.00"));
      const facts = await scan([...legs, hotel]);
      expect([count(facts, "event"), count(facts, "identifier"), count(facts, "amount")]).toEqual([30, 2, 0]);
    });

    it("the codes printed around a booking are still held to twelve", async () => {
      const raw = `<html><script type="application/ld+json">${JSON.stringify([leg("236", "SFO", "LIS", "2026-11-12", "1184.00"), hotel])}</script></html>`;
      const text = Array.from({ length: 40 }, (_, i) => `Ref AB${i}00000${i}`).join("\n");
      const { facts } = await scanForFacts({ name: "Your trip.email", mime: "application/vnd.engram.email+json", raw, text });
      expect(facts.filter((f) => f.confidence === 1)).toHaveLength(8);
      expect(facts.filter((f) => f.confidence < 1)).toHaveLength(12);
    });

    it("a booking that fits keeps its prices too", async () => {
      const facts = await scan([leg("236", "SFO", "LIS", "2026-11-12", "1184.00"), leg("237", "LIS", "SFO", "2026-11-16", "1184.00"), hotel]);
      expect([count(facts, "event"), count(facts, "identifier"), count(facts, "amount")]).toEqual([6, 2, 2]);
    });
  });

  it("reads a saved confirmation's own reservation data, zones intact", async () => {
    const raw = `<html><script type="application/ld+json">{
      "@type": "LodgingReservation",
      "reservationNumber": "LRK-449022",
      "reservationFor": { "name": "The Larkspur Hotel" },
      "checkinTime": "2027-03-04T15:00:00-05:00"
    }</script></html>`;
    const out = await scanForFacts({ name: "confirmation.html", mime: "text/html", raw });
    expect(out.facts.find((f) => f.kind === "event")).toMatchObject({
      value: "2027-03-04",
      time: "15:00",
      zone: "-05:00",
      source: "jsonld",
    });
    // The confirmation number is an identifier like any other: masked in the
    // summary, whole only in the evidence.
    const id = out.facts.find((f) => f.kind === "identifier");
    expect(id!.value).toBe("9022");
    expect(JSON.stringify(out.facts)).not.toContain("LRK-449022");
    expect(out.evidence.find((e) => e.id === id!.id)!.full).toBe("LRK-449022");
  });

  it("an exact booking time is accepted on arrival", async () => {
    const raw = `<script type="application/ld+json">{"@type":"LodgingReservation",
      "checkinTime":"2027-03-04T15:00:00-05:00","reservationFor":{"name":"The Larkspur Hotel"}}</script>`;
    const out = await scanForFacts({ name: "stay.html", mime: "text/html", raw });
    expect(out.facts.find((f) => f.kind === "event")!.accepted).toBe("exact");
  });

  it("a label-rule date is not accepted on its own", async () => {
    const out = await scanForFacts({ ...base, text: "Benefit End Date: 19 October 2027" });
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.facts.every((f) => f.accepted === undefined)).toBe(true);
  });

  it("reads invoice data from an email record's HTML", async () => {
    const raw = `<html><script type="application/ld+json">{
      "@type": "Invoice",
      "paymentDueDate": "2027-04-10",
      "totalPaymentDue": { "price": "65.00", "priceCurrency": "USD" }
    }</script><p>Your bill is ready.</p></html>`;
    const out = await scanForFacts({ name: "Your bill.email", mime: "application/vnd.engram.email+json", raw });
    expect(out.facts.find((f) => f.kind === "due")).toMatchObject({ value: "2027-04-10", source: "jsonld" });
    expect(out.facts.find((f) => f.kind === "amount")).toMatchObject({ value: "65.00", unit: "USD" });
  });

  it("grounds nothing away from a reservation, which is structured", async () => {
    const raw = `<html><script type="application/ld+json">{
      "@type": "LodgingReservation",
      "reservationFor": { "name": "Inn" },
      "checkinTime": "2027-03-04T15:00:00"
    }</script></html>`;
    // The page's visible text never mentions the date; the fact survives.
    const out = await scanForFacts({ name: "c.html", mime: "text/html", raw, text: "Thanks!" });
    expect(out.facts.some((f) => f.kind === "event" && f.value === "2027-03-04")).toBe(true);
  });

  it("keeps one statement when the reservation and the text agree", async () => {
    const raw = `<script type="application/ld+json">{"@type":"LodgingReservation",
      "reservationFor":{"name":"The Larkspur Hotel"},
      "checkinTime":"2027-03-04T15:00:00-05:00"}</script>`;
    const out = await scanForFacts({
      name: "c.html",
      mime: "text/html",
      raw,
      text: "The Larkspur Hotel\nCheck-in: March 04, 2027 from 15:00",
    });
    const events = out.facts.filter((f) => f.kind === "event" && f.value === "2027-03-04");
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("jsonld");
  });

  it("a date with no year is read in mail, from when the mail was written, and nowhere else", async () => {
    const text = "Your order has shipped.\nArriving Thursday, November 12";
    const mail = await scanForFacts({ name: "Shipped.email", mime: "application/vnd.engram.email+json", text, writtenAt: Date.parse("2026-11-09T12:00:00Z") });
    expect(mail.facts.filter((f) => f.kind === "event")).toEqual([expect.objectContaining({ value: "2026-11-12", assumedYear: true, confidence: 0.5 })]);
    expect(mail.facts.find((f) => f.kind === "event")!.accepted).toBeUndefined();
    // The same words in a stored letter: no telling which year they mean.
    const letter = await scanForFacts({ ...base, text });
    expect(letter.facts.filter((f) => ["event", "due", "expiry", "dated"].includes(f.kind))).toEqual([]);
  });

  it("a date written with an ordinal survives the whole scan", async () => {
    const read = async (text: string) => (await scanForFacts({ ...base, text })).facts.filter((f) => f.kind === "expiry").map((f) => f.value);
    expect(await read("Valid until November 12th, 2026")).toEqual(["2026-11-12"]);
    expect(await read("Valid until 2nd March 2027")).toEqual(["2027-03-02"]);
  });

  it("a date written with a short month name survives the whole scan", async () => {
    const read = async (text: string) => (await scanForFacts({ ...base, text })).facts.filter((f) => f.kind === "expiry" || f.kind === "event").map((f) => [f.value, f.time]);
    expect(await read("Valid until 14 Nov 2026")).toEqual([["2026-11-14", undefined]]);
    expect(await read("Valid until Nov 14, 2026")).toEqual([["2026-11-14", undefined]]);
    expect(await read("Valid until 4 Sept. 2026")).toEqual([["2026-09-04", undefined]]);
    expect(await read("Sat 14 Nov 2026, doors 7:00 PM")).toEqual([["2026-11-14", "19:00"]]);
  });

  it("a bill's amount due is one fact, named, not a second unlabelled copy", async () => {
    const out = await scanForFacts({ ...base, text: "Water bill\nAmount due $84.20\nDue date: November 20, 2026" });
    expect(out.facts.filter((f) => f.kind === "amount")).toEqual([
      expect.objectContaining({ value: "84.20", unit: "USD", label: "Amount due", source: "label", confidence: 0.7 }),
    ]);
    expect(out.facts.find((f) => f.kind === "amount")!.accepted).toBeUndefined();
  });

  it("a check-in written as 3pm keeps its hour through the whole pipeline", async () => {
    const out = await scanForFacts({ ...base, text: "Harbor House\nCheck-in: 12 March 2027 from 3pm." });
    expect(out.facts.find((f) => f.kind === "event")).toMatchObject({ value: "2027-03-12", time: "15:00", label: "Check-in" });
  });

  it("carries a travel event with its time through the whole pipeline", async () => {
    const out = await scanForFacts({
      ...base,
      text: "Boarding pass\nDeparture: 4 March 2027 09:40",
    });
    expect(out.facts.find((f) => f.kind === "event")).toMatchObject({
      value: "2027-03-04",
      time: "09:40",
      document: "boarding-pass",
      label: "Departure",
    });
  });
});
