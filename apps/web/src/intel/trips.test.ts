import { describe, expect, it } from "vitest";
import type { Fact } from "./facts";
import { assembleItinerary, departureAdvice, suggestTrips, tripTag, tripTitle, type TripFile } from "./trips";

const NOW = Date.UTC(2027, 1, 1); // 1 Feb 2027, ahead of the trips below.

let seq = 0;
const event = (value: string, label: string, over: Partial<Fact> = {}): Fact => ({
  id: `event:${value} ${label.toLowerCase()} ${seq++}`,
  kind: "event",
  document: "itinerary",
  value,
  label,
  source: "jsonld",
  confidence: 1,
  ...over,
});

const ref = (masked: string, over: Partial<Fact> = {}): Fact => ({
  id: `identifier:${masked}:${seq++}`,
  kind: "identifier",
  document: "itinerary",
  value: masked,
  masked,
  label: "Confirmation number",
  source: "jsonld",
  confidence: 1,
  ...over,
});

const flight = (): TripFile => ({
  id: "f-flight",
  name: "aquila-confirmation.html",
  facts: [
    event("2027-03-04", "Flight AQ 214 departs SFO", { time: "09:40", zone: "-08:00" }),
    event("2027-03-04", "Flight AQ 214 arrives JFK", { time: "18:05", zone: "-05:00" }),
    ref("2Q2P"),
  ],
});

const hotel = (): TripFile => ({
  id: "f-hotel",
  name: "larkspur-confirmation.html",
  facts: [
    event("2027-03-04", "Check-in: The Larkspur Hotel", {
      time: "15:00",
      document: "hotel-booking",
    }),
    event("2027-03-09", "Check-out: The Larkspur Hotel", {
      time: "11:00",
      document: "hotel-booking",
    }),
    ref("9022", { document: "hotel-booking" }),
  ],
});

describe("suggestTrips", () => {
  it("clusters a flight and an overlapping stay into one trip to the city", async () => {
    const trips = await suggestTrips([flight(), hotel()], NOW);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      start: "2027-03-04",
      end: "2027-03-09",
      destination: "New York",
    });
    expect([...trips[0]!.fileIds].sort()).toEqual(["f-flight", "f-hotel"]);
  });

  it("leaves an unrelated document out, even in the same week", async () => {
    const invoice: TripFile = {
      id: "f-invoice",
      name: "invoice.pdf",
      facts: [
        {
          id: "due:2027-03-05",
          kind: "due",
          document: "invoice",
          value: "2027-03-05",
          source: "label",
          confidence: 0.7,
          confirmed: true,
        },
      ],
    };
    const trips = await suggestTrips([flight(), hotel(), invoice], NOW);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.fileIds).not.toContain("f-invoice");
  });

  it("joins date-separated legs that share a reference", async () => {
    const homebound: TripFile = {
      id: "f-return",
      name: "return.html",
      facts: [event("2027-03-25", "Flight AQ 215 departs JFK"), ref("2Q2P")],
    };
    const trips = await suggestTrips([flight(), homebound], NOW);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.why.join(" ")).toContain("2Q2P");
  });

  it("suggests nothing for one file, or for a trip long past", async () => {
    expect(await suggestTrips([flight()], NOW)).toEqual([]);
    expect(await suggestTrips([flight(), hotel()], Date.UTC(2028, 0, 1))).toEqual([]);
  });

  it("never clusters on an unconfirmed soft fact, and never reads trash", async () => {
    const soft: TripFile = {
      id: "f-soft",
      name: "note.txt",
      facts: [event("2027-03-05", "Check-in", { source: "label", confidence: 0.7 })],
    };
    const trashed: TripFile = { ...hotel(), id: "f-gone", trashed: true };
    const trips = await suggestTrips([flight(), hotel(), soft, trashed], NOW);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.fileIds).not.toContain("f-soft");
    expect(trips[0]!.fileIds).not.toContain("f-gone");
  });

  it("is stable: the same library yields the same suggestion identity", async () => {
    const a = await suggestTrips([flight(), hotel()], NOW);
    const b = await suggestTrips([hotel(), flight()], NOW);
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(tripTag(a[0]!)).toBe("trip:new-york-2027-03");
  });
});

describe("assembleItinerary", () => {
  it("sorts the legs as printed and speaks in city names", async () => {
    const legs = await assembleItinerary([hotel(), flight()]);
    expect(legs.map((leg) => leg.kind)).toEqual(["flight", "stay", "flight", "stay"]);
    expect(legs[0]!.title).toContain("San Francisco (SFO)");
    expect(legs[2]!.title).toContain("New York (JFK)");
    expect(legs.map((leg) => leg.at)).toEqual([
      "2027-03-04",
      "2027-03-04",
      "2027-03-04",
      "2027-03-09",
    ]);
    expect(legs[1]).toMatchObject({ time: "15:00", fileId: "f-hotel" });
  });

  it("keeps unconfirmed soft events out of the itinerary too", async () => {
    const padded: TripFile = {
      ...flight(),
      facts: [...flight().facts, event("2027-03-06", "Arrival", { source: "label", confidence: 0.7 })],
    };
    const legs = await assembleItinerary([padded]);
    expect(legs.some((leg) => leg.title === "Arrival")).toBe(false);
  });
});

describe("departureAdvice", () => {
  it("advises a domestic departure two hours ahead, from both legs' codes", async () => {
    const legs = await assembleItinerary([flight()]);
    const advice = await departureAdvice(legs);
    expect(advice!.text).toBe("Domestic departure, so be at the airport by 07:40.");
  });

  it("advises an international departure three hours ahead", async () => {
    const abroad: TripFile = {
      id: "f-abroad",
      name: "abroad.html",
      facts: [
        event("2027-05-02", "Flight AQ 88 departs SFO", { time: "18:30" }),
        event("2027-05-03", "Flight AQ 88 arrives LHR", { time: "12:45" }),
      ],
    };
    const advice = await departureAdvice(await assembleItinerary([abroad]));
    expect(advice!.text).toBe("International departure, so be at the airport by 15:30.");
  });

  it("stays quiet when the airports cannot be placed", async () => {
    const legs = await assembleItinerary([
      {
        id: "f-x",
        name: "x.txt",
        facts: [event("2027-03-04", "Flight 1 departs QQQ", { time: "09:40" })],
      },
    ]);
    expect(await departureAdvice(legs)).toBeNull();
  });
});

describe("tripTitle", () => {
  it("renders a tag back into words", () => {
    expect(tripTitle("trip:new-york-2027-03")).toBe("New York, Mar 2027");
  });
});
