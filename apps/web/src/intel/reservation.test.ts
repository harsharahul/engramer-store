import { describe, expect, it } from "vitest";
import { reservationFacts, structuredDataFacts } from "./reservation";

// Synthetic throughout: invented airline, hotel, codes, dates.
const FLIGHT_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context": "http://schema.org",
  "@type": "FlightReservation",
  "reservationNumber": "ZK8Q2P",
  "underName": { "@type": "Person", "name": "Jordan Rivers" },
  "reservationFor": {
    "@type": "Flight",
    "flightNumber": "214",
    "airline": { "@type": "Airline", "name": "Aquila Airways", "iataCode": "AQ" },
    "departureAirport": { "@type": "Airport", "name": "San Francisco", "iataCode": "SFO" },
    "arrivalAirport": { "@type": "Airport", "name": "New York JFK", "iataCode": "JFK" },
    "departureTime": "2027-03-04T09:40:00-08:00",
    "arrivalTime": "2027-03-04T18:05:00-05:00"
  }
}
</script></head><body>Your booking is confirmed.</body></html>`;

const HOTEL_HTML = `<html><body>
<script type='application/ld+json'>
[{
  "@type": "LodgingReservation",
  "reservationNumber": "LRK-449022",
  "reservationFor": { "@type": "LodgingBusiness", "name": "The Larkspur Hotel" },
  "checkinTime": "2027-03-04T15:00:00-05:00",
  "checkoutTime": "2027-03-09T11:00:00-05:00"
}]
</script></body></html>`;

describe("reservationFacts", () => {
  it("reads a flight reservation into zoned events and an identifier", () => {
    const facts = reservationFacts(FLIGHT_HTML);
    const depart = facts.find((f) => f.kind === "event" && f.label!.includes("departs"));
    expect(depart).toMatchObject({
      value: "2027-03-04",
      time: "09:40",
      zone: "-08:00",
      source: "jsonld",
      confidence: 1,
      document: "itinerary",
    });
    expect(depart!.label).toContain("AQ 214");
    expect(depart!.label).toContain("SFO");
    const arrive = facts.find((f) => f.kind === "event" && f.label!.includes("arrives"));
    expect(arrive).toMatchObject({ value: "2027-03-04", time: "18:05", zone: "-05:00" });
    expect(facts.find((f) => f.kind === "identifier")).toMatchObject({
      value: "ZK8Q2P",
      source: "jsonld",
      confidence: 1,
    });
  });

  it("reads a lodging reservation with its hotel named", () => {
    const facts = reservationFacts(HOTEL_HTML);
    expect(facts.find((f) => f.label === "Check-in: The Larkspur Hotel")).toMatchObject({
      value: "2027-03-04",
      time: "15:00",
      zone: "-05:00",
      document: "hotel-booking",
    });
    expect(facts.find((f) => f.label === "Check-out: The Larkspur Hotel")).toMatchObject({
      value: "2027-03-09",
      time: "11:00",
    });
    expect(facts.find((f) => f.kind === "identifier")!.value).toBe("LRK-449022");
  });

  it("keeps a zoneless timestamp honest and a date-only stamp timeless", () => {
    const html = `<script type="application/ld+json">{"@type":"LodgingReservation",
      "reservationFor":{"name":"Inn"},"checkinTime":"2027-03-04T15:00:00",
      "checkoutTime":"2027-03-06"}</script>`;
    const facts = reservationFacts(html);
    expect(facts[0]).toMatchObject({ value: "2027-03-04", time: "15:00" });
    expect(facts[0]!.zone).toBeUndefined();
    expect(facts[1]).toMatchObject({ value: "2027-03-06" });
    expect(facts[1]!.time).toBeUndefined();
  });

  it("survives pages with no data, broken data, and graph roots", () => {
    expect(reservationFacts("<html><body>plain page</body></html>")).toEqual([]);
    expect(reservationFacts('<script type="application/ld+json">{broken</script>')).toEqual([]);
    const graph = `<script type="application/ld+json">{"@graph":[{"@type":"LodgingReservation",
      "reservationFor":{"name":"Inn"},"checkinTime":"2027-04-01"}]}</script>`;
    expect(reservationFacts(graph)).toHaveLength(1);
  });
});

const ld = (node: Record<string, unknown>) =>
  `<html><script type="application/ld+json">${JSON.stringify(node)}</script></html>`;

describe("more reservation types", () => {
  it("reads an event ticket", () => {
    const facts = reservationFacts(
      ld({
        "@type": "EventReservation",
        reservationNumber: "EVT-5521",
        reservationFor: {
          "@type": "MusicEvent",
          name: "Harbor Lights Concert",
          startDate: "2027-05-12T19:30:00-07:00",
          endDate: "2027-05-12T22:00:00-07:00",
        },
      }),
    );
    expect(facts.find((f) => f.label === "Harbor Lights Concert")).toMatchObject({
      kind: "event",
      document: "event-ticket",
      value: "2027-05-12",
      time: "19:30",
      zone: "-07:00",
      source: "jsonld",
      confidence: 1,
    });
    expect(facts.find((f) => f.label === "Harbor Lights Concert ends")?.time).toBe("22:00");
    expect(facts.find((f) => f.kind === "identifier")?.value).toBe("EVT-5521");
  });

  it("reads a dinner reservation", () => {
    const facts = reservationFacts(
      ld({
        "@type": "FoodEstablishmentReservation",
        startTime: "2027-05-13T20:00:00+01:00",
        reservationFor: { "@type": "Restaurant", name: "Casa Verde" },
      }),
    );
    expect(facts).toEqual([
      expect.objectContaining({
        kind: "event",
        document: "dining",
        value: "2027-05-13",
        time: "20:00",
        label: "Table at Casa Verde",
      }),
    ]);
  });

  it("reads a bus departure and arrival", () => {
    const facts = reservationFacts(
      ld({
        "@type": "BusReservation",
        reservationFor: {
          "@type": "BusTrip",
          provider: { name: "Coastline Coaches" },
          departureBusStop: { name: "Central Station" },
          arrivalBusStop: { name: "Seaside" },
          departureTime: "2027-06-01T08:15:00+02:00",
          arrivalTime: "2027-06-01T11:40:00+02:00",
        },
      }),
    );
    expect(facts.map((f) => [f.label, f.time, f.document])).toEqual([
      ["Bus Coastline Coaches departs Central Station", "08:15", "itinerary"],
      ["Bus Coastline Coaches arrives Seaside", "11:40", "itinerary"],
    ]);
  });

  it("reads a boat departure", () => {
    const facts = reservationFacts(
      ld({
        "@type": "BoatReservation",
        reservationFor: {
          "@type": "BoatTrip",
          provider: { name: "Island Ferries" },
          departureBoatTerminal: { name: "North Pier" },
          departureTime: "2027-06-03T07:00:00+02:00",
        },
      }),
    );
    expect(facts.map((f) => f.label)).toEqual(["Boat Island Ferries departs North Pier"]);
  });

  it("keeps time zones as written", () => {
    const facts = reservationFacts(
      ld({
        "@type": "FoodEstablishmentReservation",
        startTime: "2027-05-13T20:00:00Z",
        reservationFor: { name: "Casa Verde" },
      }),
    );
    expect(facts[0]).toMatchObject({ time: "20:00", zone: "UTC" });
  });

  it("reads a type written with its schema.org address", () => {
    const facts = reservationFacts(
      ld({
        "@type": "http://schema.org/LodgingReservation",
        checkinTime: "2027-03-04T15:00:00-05:00",
        reservationFor: { name: "The Larkspur Hotel" },
      }),
    );
    expect(facts[0]).toMatchObject({ label: "Check-in: The Larkspur Hotel", document: "hotel-booking" });
  });

  it("a type name that only shares a prefix is not read", () => {
    expect(
      reservationFacts(ld({ "@type": "BusinessEvent", startDate: "2027-05-12T09:00:00Z", name: "Expo" })),
    ).toEqual([]);
  });
});

describe("invoices and deliveries", () => {
  it("reads an invoice's due date and amount", () => {
    const facts = structuredDataFacts(
      ld({
        "@type": "Invoice",
        confirmationNumber: "INV-20270410",
        paymentDueDate: "2027-04-10",
        totalPaymentDue: { "@type": "PriceSpecification", price: "1,065.40", priceCurrency: "USD" },
        provider: { name: "Example Power" },
      }),
    );
    expect(facts.find((f) => f.kind === "due")).toMatchObject({
      value: "2027-04-10",
      document: "invoice",
      label: "Payment due",
      source: "jsonld",
      confidence: 1,
    });
    expect(facts.find((f) => f.kind === "identifier")?.value).toBe("INV-20270410");
  });

  it("an invoice amount carries its currency", () => {
    const facts = structuredDataFacts(
      ld({ "@type": "Invoice", totalPaymentDue: { price: 65, priceCurrency: "EUR" } }),
    );
    expect(facts.find((f) => f.kind === "amount")).toMatchObject({
      value: "65.00",
      unit: "EUR",
      label: "Amount due",
      document: "invoice",
    });
  });

  it("reads a delivery window", () => {
    const facts = structuredDataFacts(
      ld({
        "@type": "ParcelDelivery",
        trackingNumber: "TRK99887766",
        expectedArrivalFrom: "2027-04-02T09:00:00-07:00",
        expectedArrivalUntil: "2027-04-02T17:00:00-07:00",
      }),
    );
    expect(facts.filter((f) => f.kind === "event").map((f) => [f.label, f.time, f.document])).toEqual([
      ["Delivery window opens", "09:00", "delivery"],
      ["Delivery expected by", "17:00", "delivery"],
    ]);
    expect(facts.find((f) => f.kind === "identifier")).toMatchObject({ value: "TRK99887766", label: "Tracking number" });
  });

  const order = (extra: Record<string, unknown> = {}) => ({
    "@type": "Order",
    orderNumber: "EX-20391",
    price: "148.00",
    priceCurrency: "USD",
    ...extra,
  });
  const parcel = (extra: Record<string, unknown> = {}) => ({
    "@type": "ParcelDelivery",
    trackingNumber: "TRK99887766",
    expectedArrivalFrom: "2027-04-02T09:00:00-07:00",
    expectedArrivalUntil: "2027-04-02T17:00:00-07:00",
    ...extra,
  });

  it("an order gives its total, its number and its delivery", () => {
    const facts = structuredDataFacts(ld(order({ orderDelivery: parcel() })));
    expect(facts.find((f) => f.kind === "amount")).toMatchObject({ value: "148.00", unit: "USD", label: "Order total", source: "jsonld", confidence: 1, document: "delivery" });
    expect(facts.filter((f) => f.kind === "identifier").map((f) => [f.label, f.value])).toEqual([
      ["Order number", "EX-20391"],
      ["Tracking number", "TRK99887766"],
    ]);
    expect(facts.filter((f) => f.kind === "event").map((f) => [f.label, f.time, f.document])).toEqual([
      ["Delivery window opens", "09:00", "delivery"],
      ["Delivery expected by", "17:00", "delivery"],
    ]);
  });

  it("an order with several parcels reads each delivery", () => {
    const facts = structuredDataFacts(
      ld(order({ orderDelivery: [parcel(), parcel({ trackingNumber: "TRK11223344", expectedArrivalFrom: "2027-04-05T09:00:00-07:00", expectedArrivalUntil: "2027-04-05T17:00:00-07:00" })] })),
    );
    expect(facts.filter((f) => f.kind === "event").map((f) => f.value)).toEqual(["2027-04-02", "2027-04-02", "2027-04-05", "2027-04-05"]);
  });

  it("an order with no delivery is a receipt", () => {
    const facts = structuredDataFacts(ld(order()));
    expect(facts.find((f) => f.kind === "amount")).toMatchObject({ value: "148.00", document: "invoice", label: "Order total" });
    expect(facts.some((f) => f.kind === "event")).toBe(false);
  });

  it("an order priced only by its one offer takes that price, and one with no price states no amount", () => {
    const offered = structuredDataFacts(ld(order({ price: undefined, priceCurrency: undefined, acceptedOffer: { "@type": "Offer", price: "59.90", priceCurrency: "EUR" } })));
    expect(offered.find((f) => f.kind === "amount")).toMatchObject({ value: "59.90", unit: "EUR" });
    expect(structuredDataFacts(ld(order({ price: undefined }))).some((f) => f.kind === "amount")).toBe(false);
  });

  it("an order and a delivery that names it state each fact once", () => {
    const raw = `<html><script type="application/ld+json">${JSON.stringify([order({ orderDelivery: parcel() }), parcel({ partOfOrder: { "@type": "Order", orderNumber: "EX-20391" } })])}</script></html>`;
    const facts = structuredDataFacts(raw);
    expect(facts.filter((f) => f.kind === "event")).toHaveLength(2);
    expect(facts.filter((f) => f.kind === "identifier")).toHaveLength(2);
    expect(facts.filter((f) => f.kind === "amount")).toHaveLength(1);
  });

  it("refuses a due date that does not exist", () => {
    const facts = structuredDataFacts(ld({ "@type": "Invoice", paymentDueDate: "2027-02-31" }));
    expect(facts.filter((f) => f.kind === "due")).toEqual([]);
  });

  it("still reads reservations, once each", () => {
    const facts = structuredDataFacts(FLIGHT_HTML + FLIGHT_HTML);
    expect(facts.filter((f) => f.kind === "event")).toHaveLength(2);
  });
});

// Synthetic: invented airline, hotel, address, reference, passenger.
const RICH_HTML = `<html><head><script type="application/ld+json">
[{
  "@type": "FlightReservation",
  "reservationNumber": "TQ4XRM",
  "underName": { "@type": "Person", "name": "Avery Stone" },
  "boardingGroup": "4",
  "boardingTime": "2027-03-04T09:00:00-08:00",
  "checkinUrl": "https://checkin.example.com/?ref=TQ4XRM&name=STONE",
  "reservedTicket": { "@type": "Ticket", "ticketedSeat": { "@type": "Seat", "seatNumber": "14A" } },
  "reservationFor": {
    "@type": "Flight",
    "flightNumber": "AQ0214",
    "airline": { "@type": "Airline", "name": "Aquila Airways", "iataCode": "AQ" },
    "departureAirport": { "@type": "Airport", "name": "San Francisco", "iataCode": "SFO" },
    "arrivalAirport": { "@type": "Airport", "name": "New York JFK", "iataCode": "JFK" },
    "departureGate": "B12",
    "departureTime": "2027-03-04T09:40:00-08:00",
    "arrivalTime": "2027-03-04T18:05:00-05:00"
  }
}, {
  "@type": "LodgingReservation",
  "reservationNumber": "LRK-449022",
  "reservationFor": {
    "@type": "LodgingBusiness",
    "name": "The Larkspur Hotel",
    "address": { "@type": "PostalAddress", "streetAddress": "12 Harbor Street", "postalCode": "10001", "addressLocality": "New York" }
  },
  "checkinTime": "2027-03-04T15:00:00-05:00",
  "checkoutTime": "2027-03-09T11:00:00-05:00"
}]
</script></head><body>Your trip is booked.</body></html>`;

describe("what each date is about", () => {
  it("a flight booking says depart and arrive, with carrier, number and airports", () => {
    const facts = reservationFacts(FLIGHT_HTML);
    const depart = facts.find((f) => f.label === "Flight AQ 214 departs SFO");
    const arrive = facts.find((f) => f.label === "Flight AQ 214 arrives JFK");
    expect(depart!.subject).toEqual({ role: "depart", mode: "flight", carrier: "AQ", number: "214", code: "SFO", place: "San Francisco", reservation: 0 });
    expect(arrive!.subject).toEqual({ role: "arrive", mode: "flight", carrier: "AQ", number: "214", code: "JFK", place: "New York JFK", reservation: 0 });
    expect(facts.find((f) => f.kind === "identifier")!.subject).toEqual({ role: "reference", reservation: 0 });
  });

  it("a hotel booking keeps its name and address", () => {
    const facts = reservationFacts(RICH_HTML);
    expect(facts.find((f) => f.label === "Check-in: The Larkspur Hotel")!.subject).toEqual({
      role: "check-in",
      place: "The Larkspur Hotel",
      address: "12 Harbor Street, 10001 New York",
      reservation: 1,
    });
    expect(facts.find((f) => f.label === "Check-out: The Larkspur Hotel")!.subject).toMatchObject({ role: "check-out", reservation: 1 });
  });

  it("seat, gate and boarding time are kept when the booking gives them", () => {
    const facts = reservationFacts(RICH_HTML);
    const depart = facts.find((f) => f.kind === "event" && f.subject?.role === "depart");
    expect(depart!.subject).toMatchObject({ number: "214", seat: "14A", gate: "B12", boardingGroup: "4", boardingTime: "09:00" });
    const arrive = facts.find((f) => f.kind === "event" && f.subject?.role === "arrive");
    expect(arrive!.subject!.seat).toBeUndefined();
  });

  it("labels and ids are unchanged", () => {
    expect(reservationFacts(FLIGHT_HTML).map((f) => [f.id, f.label])).toEqual([
      ["event:2027-03-04 flight aq 214 departs sfo", "Flight AQ 214 departs SFO"],
      ["event:2027-03-04 flight aq 214 arrives jfk", "Flight AQ 214 arrives JFK"],
      ["identifier:ZK8Q2P", "Confirmation number"],
    ]);
    expect(reservationFacts(HOTEL_HTML).map((f) => f.id)).toEqual([
      "event:2027-03-04 check-in: the larkspur hotel",
      "event:2027-03-09 check-out: the larkspur hotel",
      "identifier:LRK-449022",
    ]);
  });

  it("the check-in link goes to evidence and never to metadata", async () => {
    const { scanForFacts } = await import("./scan");
    const result = await scanForFacts({ name: "booking.html", mime: "text/html", raw: RICH_HTML, text: "Your trip is booked." });
    const stored = JSON.stringify(result.facts);
    expect(stored).not.toContain("checkin.example.com");
    expect(stored).not.toContain("STONE");
    expect(stored).not.toContain("Avery");
    const depart = result.facts.find((f) => f.subject?.role === "depart");
    expect(result.evidence).toContainEqual({ id: depart!.id, link: "https://checkin.example.com/?ref=TQ4XRM&name=STONE" });
  });
});

describe("service numbers", () => {
  const booking = (node: Record<string, unknown>) => `<script type="application/ld+json">${JSON.stringify(node)}</script>`;

  it("a booking that names its airline without a code keys its flight by the code in its number", () => {
    const facts = reservationFacts(
      booking({
        "@type": "FlightReservation",
        reservationFor: {
          "@type": "Flight",
          flightNumber: "TP236",
          airline: { "@type": "Airline", name: "TAP Air Portugal" },
          departureAirport: { "@type": "Airport", iataCode: "SFO" },
          arrivalAirport: { "@type": "Airport", iataCode: "LIS" },
          departureTime: "2026-11-12T18:10:00-08:00",
          arrivalTime: "2026-11-13T14:05:00+00:00",
        },
      }),
    );
    expect(facts.map((f) => [f.label, f.subject?.carrier, f.subject?.number])).toEqual([
      ["Flight TAP Air Portugal TP236 departs SFO", "TP", "236"],
      ["Flight TAP Air Portugal TP236 arrives LIS", "TP", "236"],
    ]);
  });

  it("a train number with letters keeps its letters as the operator", () => {
    const facts = reservationFacts(
      booking({
        "@type": "TrainReservation",
        reservationFor: {
          "@type": "TrainTrip",
          trainNumber: "ICE 597",
          departureStation: { "@type": "TrainStation", name: "Berlin Hbf" },
          arrivalStation: { "@type": "TrainStation", name: "Hamburg Hbf" },
          departureTime: "2027-06-01T07:12:00+02:00",
          arrivalTime: "2027-06-01T09:00:00+02:00",
        },
      }),
    );
    expect(facts.map((f) => [f.subject?.carrier, f.subject?.number, f.subject?.place])).toEqual([
      ["ICE", "597", "Berlin Hbf"],
      ["ICE", "597", "Hamburg Hbf"],
    ]);
  });
});

describe("cancellations", () => {
  it("a cancelled reservation states no dates", () => {
    const cancelled = FLIGHT_HTML.replace('"reservationNumber": "ZK8Q2P",', '"reservationNumber": "ZK8Q2P", "reservationStatus": "http://schema.org/ReservationCancelled",');
    expect(cancelled).toContain("ReservationCancelled");
    expect(reservationFacts(cancelled)).toEqual([]);
    expect(reservationFacts(FLIGHT_HTML.replace('"reservationNumber": "ZK8Q2P",', '"reservationNumber": "ZK8Q2P", "reservationStatus": "ReservationConfirmed",'))).toHaveLength(3);
  });
});

describe("what a booking cost", () => {
  const flight = (extra: Record<string, unknown> = {}, number = "214", day = "2027-03-04") => ({
    "@type": "FlightReservation",
    reservationNumber: "ZK8Q2P",
    reservationFor: {
      "@type": "Flight",
      flightNumber: number,
      airline: { iataCode: "AQ" },
      departureAirport: { iataCode: "SFO" },
      arrivalAirport: { iataCode: "JFK" },
      departureTime: `${day}T09:40:00-08:00`,
      arrivalTime: `${day}T18:05:00-05:00`,
    },
    ...extra,
  });
  const all = (nodes: unknown[]) => `<html><script type="application/ld+json">${JSON.stringify(nodes)}</script></html>`;
  const amounts = (raw: string) => reservationFacts(raw).filter((f) => f.kind === "amount");

  it("a booking's price is read as its total", () => {
    expect(amounts(ld(flight({ totalPrice: "1184.00", priceCurrency: "USD" })))).toEqual([
      expect.objectContaining({ value: "1184.00", unit: "USD", label: "Total", source: "jsonld", confidence: 1, document: "itinerary" }),
    ]);
  });

  it("a price written as a number, with thousands commas, or nested with its currency reads the same", () => {
    expect(amounts(ld(flight({ totalPrice: 1184, priceCurrency: "usd" })))[0]).toMatchObject({ value: "1184.00", unit: "USD" });
    expect(amounts(ld(flight({ totalPrice: "1,184.50", priceCurrency: "USD" })))[0]).toMatchObject({ value: "1184.50" });
    expect(amounts(ld(flight({ totalPrice: { "@type": "PriceSpecification", price: "652.00", priceCurrency: "EUR" } })))[0]).toMatchObject({ value: "652.00", unit: "EUR" });
    expect(amounts(ld(flight({ price: "99.00", priceCurrency: "GBP" })))[0]).toMatchObject({ value: "99.00", unit: "GBP" });
  });

  it("a price repeated on each leg counts once, and two totals are both kept", () => {
    const priced = { totalPrice: "1184.00", priceCurrency: "USD" };
    expect(amounts(all([flight(priced), flight(priced, "215", "2027-03-09")]))).toHaveLength(1);
    const two = amounts(all([flight({ totalPrice: "592.00", priceCurrency: "USD" }), flight({ totalPrice: "610.00", priceCurrency: "USD" }, "215", "2027-03-09")]));
    expect(two.map((f) => f.value)).toEqual(["592.00", "610.00"]);
  });

  it("a price with no currency, or of zero, is not an amount", () => {
    expect(amounts(ld(flight({ totalPrice: "1184.00" })))).toEqual([]);
    expect(amounts(ld(flight({ totalPrice: "0", priceCurrency: "USD" })))).toEqual([]);
    expect(amounts(ld(flight({ totalPrice: "free", priceCurrency: "USD" })))).toEqual([]);
  });

  it("a cancelled booking states no price", () => {
    expect(amounts(ld(flight({ totalPrice: "1184.00", priceCurrency: "USD", reservationStatus: "ReservationCancelled" })))).toEqual([]);
  });
});
