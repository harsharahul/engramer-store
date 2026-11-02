#!/usr/bin/env node
/**
 * Writes a synthetic mailbox for checking the Timeline against its
 * design: an ordinary September (a dinner, a concert, deliveries, bills, a
 * renewal notice waiting for a yes) and a November trip to Lisbon (flights,
 * a hotel, a museum, two dinners), plus a date-only trip to Chicago (a
 * hotel email and a conference invite). Bookings carry schema.org data the
 * way airline, hotel and shop emails do, so importing the mailbox runs the
 * real reading pipeline. Every name, number and address is invented.
 *
 * Usage: node apps/web/scripts/timeline-fixture.mjs [out.mbox] [--shift-days N]
 * Default output: .playwright-mcp/timeline-fixture.mbox (ignored by git).
 *
 * --shift-days moves every date and time in the mailbox by N days, offsets
 * as written, so a check in the real app (which runs on the real clock) can
 * find the trip under way today: the Lisbon stay's second night is 14 Nov
 * 2026, so N is the days from then to the day of the check.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const shiftAt = args.indexOf("--shift-days");
const shiftDays = shiftAt >= 0 ? Number(args[shiftAt + 1]) : 0;
if (!Number.isInteger(shiftDays)) {
  console.error("--shift-days takes a whole number of days");
  process.exit(1);
}
const shiftValueAt = shiftAt >= 0 ? shiftAt + 1 : -1;
const out = args.find((arg, i) => !arg.startsWith("--") && i !== shiftValueAt) ?? ".playwright-mcp/timeline-fixture.mbox";

/** "2026-11-12" moved by `shiftDays`; the time and offset beside it stay as written. */
function shiftDay(y, m, d) {
  const moved = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)) + shiftDays * 86_400_000);
  return [moved.getUTCFullYear(), String(moved.getUTCMonth() + 1).padStart(2, "0"), String(moved.getUTCDate()).padStart(2, "0")];
}

/** Every ISO date (booking data, headers) and every compact invite date (DTSTART:20261112T...) moved. */
function shifted(value) {
  if (shiftDays === 0) {
    return value;
  }
  const text = JSON.stringify(value)
    // Digit lookarounds, not \b: "2026-11-12T18:10" has no word boundary before the T.
    .replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (_, y, m, d) => shiftDay(y, m, d).join("-"))
    .replace(/(?<!\d)(\d{4})(\d{2})(\d{2})(T\d{6})/g, (_, y, m, d, rest) => `${shiftDay(y, m, d).join("")}${rest}`);
  return JSON.parse(text);
}

const flight = (number, from, departs, to, arrives) => ({
  "@type": "Flight",
  flightNumber: number,
  airline: { "@type": "Airline", iataCode: "TP", name: "TAP Air Portugal" },
  departureAirport: { "@type": "Airport", iataCode: from },
  departureTime: departs,
  arrivalAirport: { "@type": "Airport", iataCode: to },
  arrivalTime: arrives,
});

const messages = [
  {
    from: "Cedar & Salt <tables@cedar-and-salt.example>",
    subject: "Your table is booked",
    date: "2026-08-30T12:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "FoodEstablishmentReservation",
      reservationNumber: "CS-2210",
      startTime: "2026-09-08T19:30:00-07:00",
      reservationFor: { "@type": "FoodEstablishment", name: "Cedar & Salt" },
    },
  },
  {
    from: "Ticket desk <tickets@greek-theatre.example>",
    subject: "Your tickets",
    date: "2026-08-20T10:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "EventReservation",
      reservationNumber: "GT-88412",
      reservationFor: { "@type": "Event", name: "Concert at the Greek Theatre", startDate: "2026-09-12T19:00:00-07:00" },
      totalPrice: "148.00",
      priceCurrency: "USD",
    },
  },
  {
    from: "Northline Shipping <track@northline.example>",
    subject: "Your order has shipped",
    date: "2026-09-05T16:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "ParcelDelivery",
      trackingNumber: "NL7731904455",
      expectedArrivalFrom: "2026-09-09T10:00:00-07:00",
      expectedArrivalUntil: "2026-09-09T14:00:00-07:00",
    },
  },
  {
    from: "Fogline Fiber <billing@fogline.example>",
    subject: "Your September bill",
    date: "2026-09-01T07:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "Invoice",
      confirmationNumber: "FF-0931-2207",
      paymentDueDate: "2026-09-10",
      totalPaymentDue: { "@type": "PriceSpecification", price: "65.00", priceCurrency: "USD" },
    },
  },
  {
    from: "Bay Power <statements@baypower.example>",
    subject: "Your November statement",
    date: "2026-10-24T09:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "Invoice",
      confirmationNumber: "BP-1124-5508",
      paymentDueDate: "2026-11-20",
      totalPaymentDue: { "@type": "PriceSpecification", price: "84.20", priceCurrency: "USD" },
    },
  },
  {
    from: "Motor Vehicles <notices@dmv.example>",
    subject: "Registration renewal notice",
    date: "2026-08-30T09:00:00-07:00",
    text: "Your vehicle registration expires soon.\n\nRenewal due: September 30, 2026\nRenewal fee: USD 212.00\n",
  },
  {
    from: "TAP Air Portugal <bookings@tap.example>",
    subject: "Your booking confirmation",
    date: "2026-09-18T20:14:00-07:00",
    data: [
      {
        "@context": "https://schema.org",
        "@type": "FlightReservation",
        reservationNumber: "QX4F2K",
        reservationFor: flight("236", "SFO", "2026-11-12T18:10:00-08:00", "LIS", "2026-11-13T14:05:00+00:00"),
      },
      {
        "@context": "https://schema.org",
        "@type": "FlightReservation",
        reservationNumber: "QX4F2K",
        reservationFor: flight("237", "LIS", "2026-11-16T13:20:00+00:00", "SFO", "2026-11-16T17:05:00-08:00"),
      },
    ],
  },
  {
    from: "Casa do Rio <stay@casadorio.example>",
    subject: "Your reservation is confirmed",
    date: "2026-10-03T11:05:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "LodgingReservation",
      reservationNumber: "CR-7741-9C1D",
      checkinTime: "2026-11-13T15:00:00+00:00",
      checkoutTime: "2026-11-16T11:00:00+00:00",
      reservationFor: { "@type": "LodgingBusiness", name: "Casa do Rio", address: "Rua das Flores 12, Lisboa" },
    },
  },
  {
    from: "Museus e Monumentos <bilhetes@museus.example>",
    subject: "Your museum tickets",
    date: "2026-10-22T09:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "EventReservation",
      reservationNumber: "MN-30551",
      reservationFor: { "@type": "Event", name: "Museu Nacional do Azulejo", startDate: "2026-11-14T10:00:00+00:00" },
    },
  },
  {
    from: "Adega Velha <reservas@adegavelha.example>",
    subject: "Your table is booked",
    date: "2026-10-12T09:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "FoodEstablishmentReservation",
      reservationNumber: "AV-1188",
      startTime: "2026-11-14T21:00:00+00:00",
      reservationFor: { "@type": "FoodEstablishment", name: "Adega Velha" },
    },
  },
  {
    from: "Cervejaria do Largo <mesa@cervejaria.example>",
    subject: "Reservation confirmed",
    date: "2026-10-14T09:00:00-07:00",
    data: {
      "@context": "https://schema.org",
      "@type": "FoodEstablishmentReservation",
      reservationNumber: "CL-0420",
      startTime: "2026-11-15T20:30:00+00:00",
      reservationFor: { "@type": "FoodEstablishment", name: "Cervejaria do Largo" },
    },
  },
  {
    from: "The Loop Hotel <stay@loophotel.example>",
    subject: "Your stay in Chicago",
    date: "2026-11-05T09:00:00-08:00",
    data: {
      "@context": "https://schema.org",
      "@type": "LodgingReservation",
      reservationNumber: "LH-55120",
      checkinTime: "2026-12-18T15:00:00-06:00",
      checkoutTime: "2026-12-21T11:00:00-06:00",
      reservationFor: { "@type": "LodgingBusiness", name: "The Loop Hotel" },
    },
  },
  {
    from: "Data Conference <hello@dataconf.example>",
    subject: "Your conference invitation",
    date: "2026-11-05T10:00:00-08:00",
    text: "We look forward to seeing you in Chicago.\n",
    ics: [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Fixture//Timeline//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:dataconf-2026@fixture.example",
      "DTSTAMP:20261105T180000Z",
      "DTSTART;TZID=America/Chicago:20261219T090000",
      "DTEND;TZID=America/Chicago:20261219T170000",
      "SUMMARY:Data conference",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  },
];

/** One RFC 822 message: text, an HTML part carrying the booking data, and an invite when there is one. */
function message(spec, index) {
  const boundary = `fixture-${index}`;
  const plain = spec.text ?? `${spec.subject}.\n`;
  const html = `<html><body><p>${spec.subject}.</p>${
    spec.data ? `<script type="application/ld+json">${JSON.stringify(spec.data)}</script>` : ""
  }</body></html>`;
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}`,
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`,
  ];
  if (spec.ics) {
    parts.push(
      `--${boundary}\r\nContent-Type: text/calendar; charset=utf-8; method=REQUEST\r\nContent-Disposition: attachment; filename="invite.ics"\r\n\r\n${spec.ics}`,
    );
  }
  return [
    `From: ${spec.from}`,
    "To: Alex Morgan <alex@example.com>",
    `Subject: ${spec.subject}`,
    `Date: ${new Date(spec.date).toUTCString()}`,
    `Message-ID: <timeline-fixture-${index}@fixture.example>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `${parts.join("\r\n")}\r\n--${boundary}--`,
    "",
  ].join("\r\n");
}

const mbox = shifted(messages)
  .map((spec, index) => `From fixture@example.com Thu Jan  1 00:00:00 1970\n${message(spec, index).replace(/^From /gm, ">From ")}\n`)
  .join("");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, mbox);
console.log(`wrote ${messages.length} messages to ${out}`);
