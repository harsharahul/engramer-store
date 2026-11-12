// Rows read local days and times; pin the zone of the ordinary day below.
process.env.TZ = "America/Los_Angeles";

/**
 * What the Timeline shows for each kind of everyday document, from the
 * document as stored to its rows, through the real readers. One line per
 * kind: the input, and each row it must give (or none). A row that says
 * "asks" waits for the owner's yes; every other row counts on its own.
 */
import { describe, expect, it } from "vitest";
import { rowsOf, type AgendaRow, type RowContext, type RowFile } from "./agendarows";
import { scanForFacts } from "./scan";

const EMAIL = "application/vnd.engram.email+json";
// Mon 9 Nov 2026, 08:40 in San Francisco.
const NOW = Date.UTC(2026, 10, 9, 16, 40);
// Every message below was written, and every file stored, that morning at 04:00.
const WRITTEN = Date.UTC(2026, 10, 9, 12);
const none: RowContext = { plans: [], dismissed: new Set(), excluded: new Set(), assembling: true };

const ld = (...nodes: unknown[]) => `<html><script type="application/ld+json">${JSON.stringify(nodes)}</script></html>`;

/** kind, tag, day, time, title, amount, and "asks" when the row waits for a yes. */
type Row = [string, string, string, string, string, string, string];
const row = (kind: string, tag: string, day: string, time: string, title: string, amount = "", asks = ""): Row => [kind, tag, day, time, title, amount, asks];

interface Line {
  what: string;
  /** A message when it has a subject, else a stored PDF. */
  subject?: string;
  text?: string;
  raw?: string;
  /** Each row it must give, in order; none when it states nothing. */
  rows: Row[];
}

const flight = (extra: Record<string, unknown> = {}) => ({
  "@type": "FlightReservation",
  reservationNumber: "ZK8Q2P",
  reservationFor: {
    "@type": "Flight",
    flightNumber: "236",
    airline: { iataCode: "TP" },
    departureAirport: { iataCode: "SFO" },
    arrivalAirport: { iataCode: "LIS" },
    departureTime: "2026-11-12T18:10:00-08:00",
    arrivalTime: "2026-11-13T14:05:00+00:00",
  },
  ...extra,
});
const hotel = (extra: Record<string, unknown> = {}) => ({
  "@type": "LodgingReservation",
  reservationNumber: "CR77419C1D",
  reservationFor: { name: "Casa do Rio" },
  checkinTime: "2026-11-13T15:00:00+00:00",
  checkoutTime: "2026-11-16T11:00:00+00:00",
  ...extra,
});
const parcel = { "@type": "ParcelDelivery", trackingNumber: "TRK99887766", expectedArrivalFrom: "2026-11-12T10:00:00-08:00", expectedArrivalUntil: "2026-11-12T14:00:00-08:00" };
const order = (extra: Record<string, unknown> = {}) => ({ "@type": "Order", orderNumber: "EX-20391", price: "148.00", priceCurrency: "USD", ...extra });

const LINES: Line[] = [
  // What a sender states as data counts on its own.
  {
    what: "a booked flight with its price",
    subject: "Your booking is confirmed",
    raw: ld(flight({ totalPrice: "1184.00", priceCurrency: "USD" })),
    rows: [row("bill", "BILL", "2026-11-09", "04:00","Your booking is confirmed", "USD 1184.00"), row("flight", "FLIGHT", "2026-11-12", "18:10", "San Francisco to Lisbon")],
  },
  {
    what: "a train",
    subject: "Your train tickets",
    raw: ld({
      "@type": "TrainReservation",
      reservationFor: {
        trainNumber: "IC 512",
        departureStation: { name: "Central" },
        arrivalStation: { name: "Seaside" },
        departureTime: "2026-11-20T07:12:00+01:00",
        arrivalTime: "2026-11-20T09:48:00+01:00",
      },
    }),
    rows: [row("flight", "TRAIN", "2026-11-20", "07:12", "Central to Seaside")],
  },
  {
    what: "a package: a flight in dollars and a hotel in euros",
    subject: "Your trip is booked",
    raw: ld(flight({ totalPrice: "1184.00", priceCurrency: "USD" }), hotel({ totalPrice: "652,00", priceCurrency: "EUR" })),
    rows: [
      row("bill", "BILL", "2026-11-09", "04:00","Your trip is booked", "USD 1184.00"),
      row("bill", "BILL", "2026-11-09", "04:00","Your trip is booked", "EUR 652.00"),
      row("flight", "FLIGHT", "2026-11-12", "18:10", "San Francisco to Lisbon"),
      row("stay", "STAY", "2026-11-13", "15:00", "Check in · Casa do Rio"),
      row("stay", "STAY", "2026-11-16", "11:00", "Check out · Casa do Rio"),
    ],
  },
  {
    what: "a shop order with its delivery",
    subject: "Your order has shipped",
    raw: ld(order({ orderDelivery: parcel })),
    rows: [row("bill", "BILL", "2026-11-09", "04:00","Your order has shipped", "USD 148.00"), row("parcel", "DELIVERY", "2026-11-12", "10:00", "Your order has shipped")],
  },
  { what: "a cancelled order", subject: "Your order was cancelled", raw: ld(order({ orderStatus: "http://schema.org/OrderCancelled", orderDelivery: parcel })), rows: [] },
  {
    what: "an invoice with its due date",
    subject: "Your invoice",
    raw: ld({ "@type": "Invoice", paymentDueDate: "2026-11-20", totalPaymentDue: { "@type": "PriceSpecification", price: "160.84", priceCurrency: "USD" } }),
    rows: [row("due", "DUE", "2026-11-20", "", "Payment due", "USD 160.84")],
  },
  {
    what: "an invite",
    subject: "Invitation: Design review",
    raw: ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:20261111T093000Z-48213@example.com", "DTSTART:20261201T220000Z", "DTEND:20261201T230000Z", "SUMMARY:Design review", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
    // The invite states 22:00 UTC: 14:00 on this device, in San Francisco.
    rows: [row("event", "BOOKED", "2026-12-01", "14:00", "Design review")],
  },
  // What plain words say is shown, and asks.
  {
    what: "a stay in plain words, with a clock written 3pm",
    subject: "Your stay at Harbor House",
    text: "Harbor House\nCheck-in: 12 March 2027 from 3pm\nCheck-out: 15 March 2027 by 11am",
    rows: [row("stay", "STAY", "2027-03-12", "15:00", "Check in", "", "asks"), row("stay", "STAY", "2027-03-15", "11:00", "Check out", "", "asks")],
  },
  {
    what: "a flight in plain words",
    subject: "Your trip to New York",
    text: "Flight UA 123 departs SFO 10:15 AM on March 4, 2027, arrives JFK 6:45 PM",
    rows: [row("flight", "FLIGHT", "2027-03-04", "10:15", "San Francisco to New York", "", "asks")],
  },
  { what: "a licence's EXP", text: "DRIVER LICENSE\nDL D1234567\nEXP 08/15/2029", rows: [row("due", "DUE", "2029-08-15", "", "Driver's licence expiring", "", "asks")] },
  {
    what: "a date to respond by",
    subject: "Your jury summons",
    text: "You must respond by January 15, 2027.",
    rows: [row("due", "DUE", "2027-01-15", "", "Respond by", "", "asks")],
  },
  { what: "a deadline", subject: "Parking permit", text: "The deadline to renew your parking permit is 30 September 2027.", rows: [row("due", "DUE", "2027-09-30", "", "Deadline", "", "asks")] },
  { what: "a plan that renews", subject: "Your plan", text: "Your plan renews on December 1, 2026.", rows: [row("due", "DUE", "2026-12-01", "", "Renews", "", "asks")] },
  {
    what: "a bill with the amount it asks for",
    text: "City Water\nAmount due $84.20\nDue date: November 20, 2026",
    rows: [row("due", "DUE", "2026-11-20", "", "Document due", "USD 84.20", "asks")],
  },
  {
    what: "an appointment",
    subject: "Appointment confirmed",
    text: "Your appointment is on Tuesday, December 8, 2026 at 2:30 PM with Dr. Lee.",
    rows: [row("event", "BOOKED", "2026-12-08", "14:30", "Appointment", "", "asks")],
  },
  { what: "a show's doors", subject: "Your tickets", text: "Sat 14 Nov 2026, doors 7:00 PM", rows: [row("event", "BOOKED", "2026-11-14", "19:00", "Doors", "", "asks")] },
  {
    what: "a parcel's estimated delivery",
    subject: "Your order has shipped",
    text: "Your order has shipped.\nEstimated delivery: November 12, 2026",
    rows: [row("parcel", "DELIVERY", "2026-11-12", "", "Your order has shipped", "", "asks")],
  },
  {
    what: "a parcel arriving on a day with no year, in a message",
    subject: "It is on the way",
    text: "Your order has shipped.\nArriving Thursday, November 12",
    rows: [row("parcel", "DELIVERY", "2026-11-12", "", "It is on the way", "", "asks")],
  },
  // What states nothing shows nothing.
  { what: "the same words in a stored file, where no year is known", text: "Your order has shipped.\nArriving Thursday, November 12", rows: [] },
  {
    what: "a newsletter",
    subject: "Studio news",
    text: "Studio news: book an appointment today and save. Friday night, doors open at 7. The sale ends Friday and your coupon expires soon.",
    rows: [],
  },
  { what: "a note from a friend", subject: "Photos from the weekend", text: "Great to see you! Here are the photos from the weekend. Talk soon.", rows: [] },
  { what: "codes that look like dates and flights", text: "EXPRESS POST. Label EXP123. Card ending 4321, EXP 08/29. Gate B12 is in Terminal T2.", rows: [] },
];

const shown = (row: AgendaRow): Row => [row.kind, row.tag, row.day, row.time ?? "", row.title, row.amount ? `${row.amount.currency} ${row.amount.value}` : "", row.ask ? "asks" : ""];

describe("what the Timeline shows for everyday documents", () => {
  for (const line of LINES) {
    it(line.what, async () => {
      const name = line.subject ? `${line.subject}.email` : "document.pdf";
      const mime = line.subject ? EMAIL : "application/pdf";
      const ics = line.raw?.startsWith("BEGIN:VCALENDAR");
      const { facts } = await scanForFacts({
        name: ics ? "invite.ics" : name,
        mime: ics ? "text/calendar" : mime,
        ...(line.text !== undefined ? { text: line.text } : {}),
        ...(line.raw !== undefined ? { raw: line.raw } : {}),
        ...(line.subject && !ics ? { writtenAt: WRITTEN } : {}),
      });
      const file: RowFile = {
        id: "f",
        name,
        mime,
        mtime: WRITTEN,
        tags: [],
        facts,
        trashed: false,
        ...(line.subject ? { mail: { subject: line.subject, from: "Sender", date: WRITTEN } } : {}),
      };
      const rows = await rowsOf([file], none, NOW);
      expect(rows.map(shown)).toEqual(line.rows);
    });
  }
});
