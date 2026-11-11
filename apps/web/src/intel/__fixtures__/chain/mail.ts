/**
 * One synthetic trip, as raw mail: invented passenger, references, hotel,
 * guesthouse and address. The airline booking states its flights as data;
 * the guesthouse writes in plain words, so only a model reads it; the
 * boarding pass is the barcode's own text.
 */

const ld = (nodes: unknown[]) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(nodes)}</script></head><body><p>Your trip to Lisbon is booked.</p></body></html>`;

const flight = (number: string, from: string, to: string, departs: string, arrives: string) => ({
  "@type": "FlightReservation",
  reservationNumber: "4F2KQ7",
  underName: { "@type": "Person", name: "Avery Morgan" },
  reservationFor: {
    "@type": "Flight",
    flightNumber: number,
    airline: { "@type": "Airline", name: "TAP Air Portugal", iataCode: "TP" },
    departureAirport: { "@type": "Airport", iataCode: from },
    arrivalAirport: { "@type": "Airport", iataCode: to },
    departureTime: departs,
    arrivalTime: arrives,
  },
});

const FLIGHTS = [
  flight("236", "SFO", "LIS", "2026-11-12T18:10:00-08:00", "2026-11-13T14:05:00+00:00"),
  flight("237", "LIS", "SFO", "2026-11-16T13:20:00+00:00", "2026-11-16T17:05:00-08:00"),
];

const HOTEL = {
  "@type": "LodgingReservation",
  reservationNumber: "CR77419C1D",
  reservationFor: {
    "@type": "LodgingBusiness",
    name: "Casa do Rio",
    address: { "@type": "PostalAddress", streetAddress: "Rua das Flores 12", postalCode: "1200-195", addressLocality: "Lisboa" },
  },
  checkinTime: "2026-11-13T15:00:00+00:00",
  checkoutTime: "2026-11-16T11:00:00+00:00",
};

/** Flights and a hotel, all as booking data in one email. */
export const BOOKING_WITH_HOTEL = ld([...FLIGHTS, HOTEL]);

/** The same flights alone; the stay is booked by plain email below. */
export const BOOKING_FLIGHTS_ONLY = ld(FLIGHTS);

/** The flights with what they cost, the total repeated on each leg as airlines write it. */
export const FLIGHTS_PRICED = ld(FLIGHTS.map((leg) => ({ ...leg, totalPrice: "1184.00", priceCurrency: "USD" })));

/** The hotel's own email, with its price in its own currency. */
export const HOTEL_PRICED = ld([{ ...HOTEL, totalPrice: "652.00", priceCurrency: "EUR" }]);

/** One package email: the flights priced in dollars and the hotel in euros. */
export const PACKAGE_PRICED = ld([...FLIGHTS.map((leg) => ({ ...leg, totalPrice: "1184.00", priceCurrency: "USD" })), { ...HOTEL, totalPrice: "652.00", priceCurrency: "EUR" }]);

export const GUESTHOUSE_TEXT =
  "Hello! Your room at Casa Azulejo is ready from 15:00 on 13 November 2026. Please leave the key at the desk by 11:00 on 16 November 2026. See you soon.";

/** What the on-device model answers for the guesthouse email. */
export const GUESTHOUSE_READING = {
  document: "hotel-booking",
  facts: [
    { kind: "event", label: "Room ready", value: "2026-11-13", time: "15:00", role: "check-in", place: "Casa Azulejo" },
    { kind: "event", label: "Key at the desk", value: "2026-11-16", time: "11:00", role: "check-out", place: "Casa Azulejo" },
  ],
};

/** The boarding pass barcode: TP 236 from SFO to LIS on day 316 (12 Nov). */
export const PASS_PAYLOAD = "M1MORGAN/AVERY        E4F2KQ7 SFOLISTP 0236 316Y014C0041 100";
export const PASS_STORED_AT = Date.UTC(2026, 10, 10);
