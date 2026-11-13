import { describe, expect, it } from "vitest";
import type { Fact } from "./facts";
import { cleanSubject, designatorOf, journeyRole, placeNamed, subjectOf } from "./subject";

function event(label: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id: `event:2026-11-12 ${label.toLowerCase()}`,
    kind: "event",
    document: "itinerary",
    value: "2026-11-12",
    label,
    source: "jsonld",
    confidence: 1,
    ...overrides,
  };
}

describe("subjectOf", () => {
  it("each label the readers write maps to its subject", () => {
    const cases: [Fact, ReturnType<typeof subjectOf>][] = [
      [event("Flight TP 236 departs SFO"), { role: "depart", mode: "flight", carrier: "TP", number: "236", code: "SFO" }],
      [event("Flight TP 237 arrives SFO"), { role: "arrive", mode: "flight", carrier: "TP", number: "237", code: "SFO" }],
      [
        event("Flight TAP Air Portugal 236 departs San Francisco International"),
        { role: "depart", mode: "flight", carrier: "TAP Air Portugal", number: "236", place: "San Francisco International" },
      ],
      [event("Train 9431 departs Lisboa Oriente"), { role: "depart", mode: "train", number: "9431", place: "Lisboa Oriente" }],
      [event("Train 9431 arrives"), { role: "arrive", mode: "train", number: "9431" }],
      [event("Bus FlixBus departs Porto"), { role: "depart", mode: "bus", carrier: "FlixBus", place: "Porto" }],
      [
        event("Flight TP 236 SFO to LIS", { document: "boarding-pass", source: "barcode", confidence: 0.6 }),
        { role: "depart", mode: "flight", carrier: "TP", number: "236", code: "SFO", otherEnd: "LIS" },
      ],
      [event("Check-in: Casa do Rio", { document: "hotel-booking" }), { role: "check-in", place: "Casa do Rio" }],
      [event("Check-out: Casa do Rio", { document: "hotel-booking" }), { role: "check-out", place: "Casa do Rio" }],
      [event("Check-in: the stay", { document: "hotel-booking" }), { role: "check-in" }],
      [event("Pick-up: Lisbon Airport", { document: "car-rental" }), { role: "pick-up", place: "Lisbon Airport" }],
      [event("Drop-off: Lisbon Airport", { document: "car-rental" }), { role: "drop-off", place: "Lisbon Airport" }],
      [event("Fado night ends", { source: "ics" }), { role: "end" }],
      [event("Table at Taberna da Rua", { document: "dining" }), { role: "start", place: "Taberna da Rua" }],
      [event("Delivery window opens", { document: "delivery" }), { role: "opens" }],
      [event("Delivery expected by", { document: "delivery" }), { role: "by" }],
      [
        { id: "identifier:CR77419C1D", kind: "identifier", document: "hotel-booking", value: "CR77419C1D", label: "Confirmation number", source: "jsonld", confidence: 1 },
        { role: "reference" },
      ],
      [
        { id: "identifier:ABC123", kind: "identifier", document: "boarding-pass", value: "ABC123", label: "Booking reference", source: "barcode", confidence: 1 },
        { role: "reference" },
      ],
    ];
    for (const [fact, subject] of cases) {
      expect(subjectOf(fact), fact.label).toEqual(subject);
    }
  });

  it("a label that names nothing has no subject", () => {
    expect(subjectOf(event("Museum of Tiles", { source: "ics" }))).toBeUndefined();
    expect(subjectOf({ ...event("Valid until"), kind: "expiry", document: "passport" })).toBeUndefined();
    expect(subjectOf({ id: "identifier:9", kind: "identifier", document: "invoice", value: "9", label: "Invoice number", source: "jsonld", confidence: 1 })).toBeUndefined();
  });

  it("a stored subject wins over the label", () => {
    const fact = event("Check-in: Casa do Rio", {
      subject: { role: "check-in", place: "Casa do Rio", address: "Rua das Flores 12, 1200-195 Lisboa", reservation: 1 },
    });
    expect(subjectOf(fact)).toEqual({ role: "check-in", place: "Casa do Rio", address: "Rua das Flores 12, 1200-195 Lisboa", reservation: 1 });
  });

  it("the model's own words for a check-in read as a check-in", () => {
    for (const label of ["Check-in", "Check in", "Check-in date", "check in"]) {
      expect(subjectOf(event(label, { source: "model", confidence: 0.45 }))?.role, label).toBe("check-in");
    }
    expect(subjectOf(event("Check-out", { source: "model", confidence: 0.45 }))?.role).toBe("check-out");
    expect(subjectOf(event("Departure", { source: "model", confidence: 0.45 }))).toEqual({ role: "depart" });
    expect(subjectOf(event("Arrival date", { source: "model", confidence: 0.45 }))).toEqual({ role: "arrive" });
  });
});

describe("cleanSubject", () => {
  it("a malformed or oversized subject is cleaned and the fact is kept", () => {
    expect(cleanSubject(null)).toBeUndefined();
    expect(cleanSubject("depart")).toBeUndefined();
    expect(cleanSubject({ role: "teleport", place: "Lisbon" })).toBeUndefined();
    expect(
      cleanSubject({
        role: "depart",
        mode: "rocket",
        carrier: "TP",
        number: "236",
        code: "lisbon",
        otherEnd: "LIS",
        place: "x".repeat(61),
        address: "y".repeat(121),
        seat: "window",
        gate: "B12",
        boardingGroup: "4",
        boardingTime: "5pm",
        reservation: -1,
        extra: "dropped",
      }),
    ).toEqual({
      role: "depart",
      carrier: "TP",
      number: "236",
      otherEnd: "LIS",
      place: "x".repeat(60),
      address: "y".repeat(120),
      gate: "B12",
      boardingGroup: "4",
    });
    expect(cleanSubject({ role: "depart", seat: "14A", boardingTime: "17:20", reservation: 0 })).toEqual({
      role: "depart",
      seat: "14A",
      boardingTime: "17:20",
      reservation: 0,
    });
  });

  it("a stored subject this version cannot read leaves the label to speak", () => {
    const fact = event("Check-in: Casa do Rio", { subject: { role: "teleport" } as never });
    expect(subjectOf(fact)).toEqual({ role: "check-in", place: "Casa do Rio" });
  });
});

describe("designatorOf", () => {
  it("joins carrier and number, or says nothing", () => {
    expect(designatorOf({ role: "depart", mode: "flight", carrier: "TP", number: "236" })).toBe("TP 236");
    expect(designatorOf({ role: "depart", mode: "train", number: "9431" })).toBe("9431");
    expect(designatorOf({ role: "check-in", place: "Casa do Rio" })).toBeUndefined();
  });
});

describe("ends", () => {
  it("an end that names a check-in is an end", () => {
    expect(subjectOf(event("Check-in: Casa do Rio ends", { source: "ics" }))).toEqual({ role: "end" });
    expect(subjectOf(event("Table at Taberna da Rua ends", { source: "ics" }))).toEqual({ role: "end" });
  });
});

describe("placeNamed", () => {
  it("the role's own word before a place is not part of its name", () => {
    expect(placeNamed("Check-in: Harbor House")).toBe("Harbor House");
    expect(placeNamed("Departs from Porto Campanha")).toBe("Porto Campanha");
    expect(placeNamed("Casa Azulejo")).toBe("Casa Azulejo");
    expect(placeNamed("SFO")).toBe("SFO");
  });

  it("words that still hold a role's word are a phrase about the moment, and name no place", () => {
    expect(placeNamed("Flight UA 123 departs SFO")).toBeUndefined();
    expect(placeNamed("your train leaves Gareth Central")).toBeUndefined();
    expect(placeNamed("Check-in")).toBeUndefined();
  });
});

describe("journeyRole", () => {
  it("a journey's end stands only when the sentence holds a word of it", () => {
    expect(journeyRole("arrive", "Flight SW 212 lands in LIS on Saturday 20 March 2027 at 16:25.")).toBe("arrive");
    expect(journeyRole("depart", "Your coach departs on Saturday, June 19 at 7:05 AM from Bay 4.")).toBe("depart");
    // A show, or a train that only "runs", is no journey's end: a plain event.
    expect(journeyRole("arrive", "The show starts at 8:00 PM on Saturday, November 6, 2027.")).toBeUndefined();
    expect(journeyRole("arrive", "Your train from Leeds to London King's Cross runs on Fri 9 July 2027.")).toBeUndefined();
  });

  it("the sentence's own word decides when it holds only one end", () => {
    expect(journeyRole("arrive", "The ferry sails from Dover at 14:30 on 6 August 2027.")).toBe("depart");
    expect(journeyRole("depart", "Your parcel should reach you on 6 May 2027.")).toBe("arrive");
    // Both ends in one sentence: the reader that saw the clock says which.
    expect(journeyRole("arrive", "Departs SFO 10:15 AM on March 4, 2027, arrives JFK 6:45 PM.")).toBe("arrive");
    expect(journeyRole("depart", "Departs SFO 10:15 AM on March 4, 2027, arrives JFK 6:45 PM.")).toBe("depart");
  });
});

describe("long names", () => {
  it("a long place name or address is cut to fit, not dropped", () => {
    const name = "Hotel Example Grande, A Member of the Synthetic Collection, Lisbon Baixa";
    const subject = cleanSubject({ role: "check-in", place: name, address: "y".repeat(130) });
    expect(subject!.place).toBe(name.slice(0, 60).trim());
    expect(subject!.address).toHaveLength(120);
  });
});
