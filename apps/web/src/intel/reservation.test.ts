import { describe, expect, it } from "vitest";
import { reservationFacts } from "./reservation";

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
