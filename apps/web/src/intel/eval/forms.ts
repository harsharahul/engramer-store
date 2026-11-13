/**
 * Development cases laid out as forms: forty invented messages and
 * documents in which nearly every date and amount stands on a labelled
 * line, and most labels name a date that is nobody's business. Part of the
 * first eval set: the readers' rules and tables are written against it.
 */

import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

export const FORM_CASES: readonly EvalCase[] = [
  // Not the reader's: statement date, billing period, previous reading date, meter read date, subtotal, VAT, next statement date.
  {
    id: "f-gas-statement",
    name: "Your gas statement.email",
    mime: EMAIL,
    from: "Northfield Gas Example",
    writtenAt: Date.UTC(2027, 1, 1, 7),
    mailKind: "bill",
    text: `Gas statement
Statement date: 1 February 2027
Billing period: 1 January 2027 to 31 January 2027
Previous reading date: 31 December 2026
Meter read date: 31 January 2027
Gas used: 312 kWh
Subtotal £118.40
VAT £5.92
Total to pay: £124.32
Payment due date: 22 February 2027
Next statement date: 1 March 2027`,
    expected: [
      { kind: "due", value: "2027-02-22" },
      { kind: "amount", value: "124.32" },
    ],
  },
  // Not the reader's: date printed, billing period row, last payment date, next meter reading, rate, standing charge.
  {
    id: "f-electric-bill",
    name: "electric-bill-march.pdf",
    mime: "application/pdf",
    text: `Electricity bill
Date printed: 4 March 2027
Billing period | Units | Rate | Charge
01 Feb 2027 to 28 Feb 2027 | 401 | 0.19 | 76.19
Standing charge, 28 days 9.81
Total this bill USD 86.00
Direct debit date: 18 March 2027
Last payment date: 16 February 2027
Next meter reading: 1 April 2027`,
    expected: [
      { kind: "due", value: "2027-03-18" },
      { kind: "amount", value: "86.00" },
    ],
  },
  // Not the reader's: bill date, billing cycle, member since, monthly plan rate, installment, taxes and fees.
  {
    id: "f-mobile-invoice",
    name: "Your mobile bill is ready.email",
    mime: EMAIL,
    from: "Bluebird Mobile Example",
    writtenAt: Date.UTC(2027, 3, 5, 8),
    mailKind: "bill",
    text: `Your plan bill
Bill date: 5 April 2027
Billing cycle: Mar 5 to Apr 4
Member since: March 2024
Plan, Unlimited 40: $45.00
Device installment: $15.00
Taxes and fees: $3.60
Total due: $63.60
Pay by: April 20`,
    expected: [
      { kind: "due", value: "2027-04-20" },
      { kind: "amount", value: "63.60" },
    ],
  },
  // Not the reader's: date generated, previous balance, last payment date, next reading window. Label and value on separate lines.
  {
    id: "f-water-bill",
    name: "water-sewer-bill.pdf",
    mime: "application/pdf",
    text: `Water and Sewer Services
Date generated
12 May 2027
Previous balance
$0.00
Current charges
$57.45
Payment due
3 June 2027
Last payment date
2 April 2027
Next reading window
1 July 2027 to 7 July 2027`,
    expected: [
      { kind: "due", value: "2027-06-03" },
      { kind: "amount", value: "57.45" },
    ],
  },
  // Not the reader's: invoice date, service period, contract start date, router rental, plan charge.
  {
    id: "f-broadband-bill",
    name: "Broadband invoice for May.email",
    mime: EMAIL,
    from: "Linkway Broadband Example",
    writtenAt: Date.UTC(2027, 4, 2, 6),
    mailKind: "bill",
    text: `Invoice date: 2 May 2027
Service period: 2 May 2027 to 1 June 2027
Contract start date: 2 March 2025
Monthly plan €39,99
Router rental €5,00
Amount to collect: €44,99
Collection date: 16/05/2027`,
    expected: [
      { kind: "due", value: "2027-05-16" },
      { kind: "amount", value: "44.99" },
    ],
  },
  // Not the reader's: statement date, statement period, previous balance, payments received (with its date), new purchases, credit limit, minimum payment.
  {
    id: "f-card-statement",
    name: "card-statement-june.pdf",
    mime: "application/pdf",
    text: `Card statement
Statement date: 28 June 2027
Statement period: 29 May 2027 to 28 June 2027
Previous balance 1,204.10
Payments received 1,204.10 on 14 June 2027
New purchases 842.77
Credit limit 5,000.00
Minimum payment due 25.00
New balance: $842.77
Payment due date: 23 July 2027`,
    expected: [
      { kind: "due", value: "2027-07-23" },
      { kind: "amount", value: "842.77" },
    ],
  },
  // Not the reader's: statement date, date opened, last payment date, balance, interest rate.
  {
    id: "f-loan-statement",
    name: "Loan statement for January.email",
    mime: EMAIL,
    from: "Greenfield Credit Union Example",
    writtenAt: Date.UTC(2027, 0, 4, 9),
    mailKind: "bill",
    text: `Loan account statement
Statement date: January 4, 2027
Date opened: 15 June 2025
Loan balance: $8,420.00
Interest rate: 6.1%
Last payment date: December 15, 2026
Next payment due: January 15, 2027
Payment amount: $310.00`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "amount", value: "310.00" },
    ],
  },
  // Not the reader's: statement closing date, next statement closing date, minimum payment, points earned.
  {
    id: "f-card-autopay",
    name: "Autopay scheduled for your card.email",
    mime: EMAIL,
    from: "Maple Card Services Example",
    writtenAt: Date.UTC(2027, 7, 26, 6),
    mailKind: "bill",
    text: `Autopay is on
Statement closing date: Aug 24, 2027
Statement balance: CAD 615.40
Minimum payment: CAD 20.00
Rewards points earned: 615
Autopay date: Sep 14, 2027
Next statement closing date: Sep 24, 2027`,
    expected: [
      { kind: "due", value: "2027-09-14" },
      { kind: "amount", value: "615.40" },
    ],
  },
  // Not the reader's: invoice date, reference that looks like a date, line items, subtotal, tax, payment terms.
  {
    id: "f-invoice-design",
    name: "invoice-logo-design.pdf",
    mime: "application/pdf",
    text: `INVOICE
Invoice date: 8 September 2027
Reference: 20270908-14
Description  Qty  Unit  Amount
Logo design  1  900.00  900.00
Revisions  3  50.00  150.00
Subtotal 1,050.00
Tax (10%) 105.00
TOTAL DUE USD 1,155.00
Payment terms: Net 30
Due date: 8 October 2027`,
    expected: [
      { kind: "due", value: "2027-10-08" },
      { kind: "amount", value: "1155.00" },
    ],
  },
  // Not the reader's: date of service (past), invoice date, labour, parts, warranty length.
  {
    id: "f-invoice-plumber",
    name: "Invoice 0310 from Harbor Plumbing.email",
    mime: EMAIL,
    from: "Harbor Plumbing Example",
    writtenAt: Date.UTC(2027, 2, 9, 10),
    mailKind: "bill",
    text: `Invoice date: 9 March 2027
Date of service: 6 March 2027
Labour 180.00
Parts 42.50
Total £222.50
Warranty on work: 12 months
Please pay by: Friday 26 March 2027`,
    expected: [
      { kind: "due", value: "2027-03-26" },
      { kind: "amount", value: "222.50" },
    ],
  },
  // Not the reader's: invoice date, registered on, course fee, materials. Class date and clock on separate lines.
  {
    id: "f-invoice-class",
    name: "pottery-class-invoice.pdf",
    mime: "application/pdf",
    text: `Pottery Evening Class
Invoice date: 5 October 2027
Registered on: 28 September 2027
Course fee 60.00
Materials 5.00
Total CAD 65.00
Amount due by: 19 October 2027
Class begins: Tuesday 2 November 2027
Class time: 6:30 PM`,
    expected: [
      { kind: "event", value: "2027-11-02", time: "18:30" },
      { kind: "due", value: "2027-10-19" },
      { kind: "amount", value: "65.00" },
    ],
  },
  // Not the reader's: purchased date, date printed, booking reference that looks like a date.
  {
    id: "f-train-form",
    name: "train-ticket-marlow.pdf",
    mime: "application/pdf",
    text: `Rail ticket, standard class
Purchased: 2 April 2027
Date printed: 14 May 2027
Booking reference: 150527AB
From: Marlow Central
To: Kestrel Cross
Date: Saturday 15 May 2027
Departs: 08:42
Arrives: 11:05
Fare: £48.50`,
    expected: [
      { kind: "event", value: "2027-05-15", time: "08:42", role: "depart" },
      { kind: "event", value: "2027-05-15", time: "11:05", role: "arrive" },
      { kind: "amount", value: "48.50" },
    ],
  },
  // Not the reader's: booked on, points earned, passenger.
  {
    id: "f-flight-itinerary",
    name: "Your itinerary LHR to AMS.email",
    mime: EMAIL,
    from: "Skyline Example Air",
    writtenAt: Date.UTC(2027, 1, 10, 12),
    mailKind: "booking",
    text: `Booked on: 10 Feb 2027
Passenger: A. Example
Outbound: Mon 12 Apr 2027, LHR to AMS
Departs 14:20
Arrives 16:45
Return: Fri 16 Apr 2027, AMS to LHR
Departs 18:10
Arrives 18:35
Points earned: 640
Total fare: EUR 212.80`,
    expected: [
      { kind: "event", value: "2027-04-12", time: "14:20", role: "depart" },
      { kind: "event", value: "2027-04-12", time: "16:45", role: "arrive" },
      { kind: "event", value: "2027-04-16", time: "18:10", role: "depart" },
      { kind: "event", value: "2027-04-16", time: "18:35", role: "arrive" },
      { kind: "amount", value: "212.80" },
    ],
  },
  // Not the reader's: booking date, amendment fee, boarding rule.
  {
    id: "f-ferry-booking",
    name: "Ferry booking summary.email",
    mime: EMAIL,
    from: "Tidewater Ferries Example",
    writtenAt: Date.UTC(2027, 5, 14, 15),
    mailKind: "booking",
    text: `Booking date: 14 June 2027
Vehicle: car, 1 passenger
Sailing | Date | Departs | Arrives
Outbound | 2 July 2027 | 07:30 | 10:45
Return | 9 July 2027 | 16:00 | 19:15
Boarding closes 30 minutes before departure
Amendment fee: £15.00
Total paid: £186.00`,
    expected: [
      { kind: "event", value: "2027-07-02", time: "07:30", role: "depart" },
      { kind: "event", value: "2027-07-02", time: "10:45", role: "arrive" },
      { kind: "event", value: "2027-07-09", time: "16:00", role: "depart" },
      { kind: "event", value: "2027-07-09", time: "19:15", role: "arrive" },
      { kind: "amount", value: "186.00" },
    ],
  },
  // Not the reader's: purchase date.
  {
    id: "f-coach-ticket",
    name: "coach-ticket-fenwick.pdf",
    mime: "application/pdf",
    text: `Coach ticket, passenger copy
Route: Fenwick to Ardale
Purchase date: 3 November 2027
Leaves: 21 Nov 2027 at 6:50 AM
Arrives: 21 Nov 2027 at 9:30 AM
Open return valid to: 21 Feb 2028
Total fare $29.00`,
    expected: [
      { kind: "event", value: "2027-11-21", time: "06:50", role: "depart" },
      { kind: "event", value: "2027-11-21", time: "09:30", role: "arrive" },
      { kind: "expiry", value: "2028-02-21" },
      { kind: "amount", value: "29.00" },
    ],
  },
  // Not the reader's: order date, pass price, reservation fee. Date and clocks on separate lines.
  {
    id: "f-rail-pass-email",
    name: "Your rail pass and seat.email",
    mime: EMAIL,
    from: "Continental Rail Example",
    writtenAt: Date.UTC(2026, 11, 1, 9),
    mailKind: "booking",
    text: `Order date: 1 December 2026
Pass: 7 day flexi pass USD 310.00
Reservation fee USD 20.00
Total paid: USD 330.00
Valid until: 31 March 2027
Seat reservation, train 9142
Date: 14/12/2026
Departure: 09:15
Arrival: 12:40`,
    expected: [
      { kind: "expiry", value: "2027-03-31" },
      { kind: "event", value: "2026-12-14", time: "09:15", role: "depart" },
      { kind: "event", value: "2026-12-14", time: "12:40", role: "arrive" },
      { kind: "amount", value: "330.00" },
    ],
  },
  // Not the reader's: booked on, rate per night, city tax. Free cancellation deadline is a real deadline.
  {
    id: "f-hotel-confirmation",
    name: "Booking confirmation, Harbour View Hotel.email",
    mime: EMAIL,
    from: "Harbour View Hotel Example",
    writtenAt: Date.UTC(2027, 2, 1, 11),
    mailKind: "booking",
    text: `Booked on: 1 March 2027
Arrival date: 19 April 2027
Check-in time: from 3 PM
Departure date: 22 April 2027
Check-out time: by 11:00
Rate per night: €120,00
Nights: 3
City tax: €6,00
Free cancellation until: 12 April 2027
Total price: €366,00`,
    expected: [
      { kind: "event", value: "2027-04-19", time: "15:00", role: "check-in" },
      { kind: "event", value: "2027-04-22", time: "11:00", role: "check-out" },
      { kind: "due", value: "2027-04-12" },
      { kind: "amount", value: "366.00" },
    ],
  },
  // Not the reader's: date printed, reservation made, room rate per night, deposit paid, nights.
  {
    id: "f-hotel-folio",
    name: "stay-summary-lakeside.pdf",
    mime: "application/pdf",
    text: `Stay summary
Date printed: 2 November 2027
Reservation made: 20 September 2027
Check-in | Check-out | Nights
Thu 11 Nov 2027 | Sun 14 Nov 2027 | 3
Room rate per night USD 150.00
Deposit paid USD 100.00
Total stay USD 450.00`,
    expected: [
      { kind: "event", value: "2027-11-11", role: "check-in" },
      { kind: "event", value: "2027-11-14", role: "check-out" },
      { kind: "amount", value: "450.00" },
    ],
  },
  // Not the reader's: booking date, daily rate, insurance excess.
  {
    id: "f-car-hire-email",
    name: "Car hire confirmation.email",
    mime: EMAIL,
    from: "Roadside Rentals Example",
    writtenAt: Date.UTC(2027, 6, 8, 13),
    mailKind: "booking",
    text: `Booking date: 8 July 2027
Pick-up date: Fri 23 July 2027
Pick-up time: 10:00
Return by: Fri 30 July 2027 17:00
Daily rate: USD 58.94
Insurance excess: USD 1,000.00
Total: USD 412.60`,
    expected: [
      { kind: "event", value: "2027-07-23", time: "10:00" },
      { kind: "due", value: "2027-07-30", time: "17:00" },
      { kind: "amount", value: "412.60" },
    ],
  },
  // Not the reader's: voucher printed date, deposit at desk, fuel rule.
  {
    id: "f-car-hire-voucher",
    name: "rental-voucher-prepaid.pdf",
    mime: "application/pdf",
    text: `Rental voucher
Voucher printed on: 20 December 2027
Pick-up: 4 January 2028 at 9:30 AM
Return by: 8 January 2028 at 6:00 PM
Fuel policy: full to full
Deposit at desk: €300,00
Prepaid: €240,00`,
    expected: [
      { kind: "event", value: "2028-01-04", time: "09:30" },
      { kind: "due", value: "2028-01-08", time: "18:00" },
      { kind: "amount", value: "240.00" },
    ],
  },
  // Not the reader's: ticket price, booking fee, date printed. Doors line is not the event start.
  {
    id: "f-concert-ticket",
    name: "concert-ticket-saturday.pdf",
    mime: "application/pdf",
    text: `ADMIT ONE
Date printed: 29 October 2027
Date: Saturday 6 November 2027
Doors: 7:00 PM
Show starts: 8:00 PM
Ticket price $64.00
Booking fee $8.50
Total $72.50`,
    expected: [
      { kind: "event", value: "2027-11-06", time: "20:00" },
      { kind: "amount", value: "72.50" },
    ],
  },
  // Not the reader's: order placed, member since, subtotal, booking fee.
  {
    id: "f-theatre-email",
    name: "Your tickets for The Lantern Players.email",
    mime: EMAIL,
    from: "Lantern Players Example",
    writtenAt: Date.UTC(2027, 1, 15, 14),
    mailKind: "booking",
    text: `Order placed: Feb 15, 2027
Member since: 2022
Performance: Fri 5 Mar 2027, 7:30 PM
Seats: row C, 4 and 5
Subtotal £40.00
Booking fee £3.00
Total £43.00`,
    expected: [
      { kind: "event", value: "2027-03-05", time: "19:30" },
      { kind: "amount", value: "43.00" },
    ],
  },
  // Not the reader's: registered on, ticket price, end time. Date has no year in an email.
  {
    id: "f-workshop-email",
    name: "Workshop confirmation.email",
    mime: EMAIL,
    from: "Weaving Hall Example",
    writtenAt: Date.UTC(2027, 0, 20, 17),
    mailKind: "booking",
    text: `Registered on: January 20
Workshop: Natural dyes
Date: Sat Feb 6
Starts: 10:15 AM
Ends: 1:00 PM
Tickets: 2 x $35.00
Total: $70.00`,
    expected: [
      { kind: "event", value: "2027-02-06", time: "10:15" },
      { kind: "amount", value: "70.00" },
    ],
  },
  // Not the reader's: order date, dispatched date, subtotal, shipping, opening hours. Return deadline is a real deadline.
  {
    id: "f-delivery-note",
    name: "delivery-note-0603.pdf",
    mime: "application/pdf",
    text: `Delivery note
Order date: 3 June 2027
Dispatched: 4 June 2027
Estimated delivery: Tue 8 Jun 2027
Items: 2 shelf brackets, 1 lamp
Subtotal £80.00
Shipping £8.00
Order total £88.00
Return by: 8 July 2027
Helpline open Mon to Fri 9:00 to 17:00`,
    expected: [
      { kind: "event", value: "2027-06-08" },
      { kind: "due", value: "2027-07-08" },
      { kind: "amount", value: "88.00" },
    ],
  },
  // Not the reader's: order placed, shipped date, subtotal, shipping. Arriving has no year.
  {
    id: "f-order-shipped",
    name: "Your order has shipped.email",
    mime: EMAIL,
    from: "Cedar Home Store Example",
    writtenAt: Date.UTC(2027, 8, 14, 10),
    mailKind: "delivery",
    text: `Order placed: 12 Sep 2027
Shipped: 14 Sep 2027
Arriving: Fri, Sep 17
1 x Desk lamp
Subtotal $35.00
Shipping $4.90
Order total $39.90`,
    expected: [
      { kind: "event", value: "2027-09-17" },
      { kind: "amount", value: "39.90" },
    ],
  },
  // Not the reader's: order date, line items, subtotal, tax.
  {
    id: "f-receipt-stationery",
    name: "Receipt for your order.email",
    mime: EMAIL,
    from: "Paper and Pen Example",
    writtenAt: Date.UTC(2027, 10, 23, 16),
    mailKind: "receipt",
    text: `Order date: 23 November 2027
Item  Qty  Price
Notebook set  2  12.00
Ink pen  1  8.00
Subtotal 20.00
Tax 1.60
TOTAL $21.60
Card ending 1111 $21.60
Delivery by: Thursday 25 November 2027`,
    expected: [
      { kind: "event", value: "2027-11-25" },
      { kind: "amount", value: "21.60" },
    ],
  },
  // Not the reader's: order date, ready-on date, opening hours.
  {
    id: "f-pickup-notice",
    name: "ready-for-collection.pdf",
    mime: "application/pdf",
    text: `Click and collect
Order date: 1 March 2028
Ready on: 6 March 2028
Collect by: Sat 11 March 2028
Store hours: Mon to Sat 9:00 to 18:00
Total paid USD 154.30`,
    expected: [
      { kind: "due", value: "2028-03-11" },
      { kind: "amount", value: "154.30" },
    ],
  },
  // Not the reader's: policy start date, next renewal notice, excess, no claims discount.
  {
    id: "f-policy-schedule",
    name: "home-policy-schedule.pdf",
    mime: "application/pdf",
    text: `Policy schedule
Date of issue: 1 December 2026
Policy start date: 1 December 2026
Cover ends: 30 November 2027
Excess: £250.00
No claims discount: 65%
Next renewal notice: 1 November 2027
Annual premium: £312.00`,
    expected: [
      { kind: "issued", value: "2026-12-01" },
      { kind: "expiry", value: "2027-11-30" },
      { kind: "amount", value: "312.00" },
    ],
  },
  // Not the reader's: purchase date, warranty term, registered on.
  {
    id: "f-warranty-card",
    name: "warranty-certificate-washer.pdf",
    mime: "application/pdf",
    text: `Extended warranty certificate
Product: Washer WX-200
Purchase date: 9 March 2027
Registered on: 10 March 2027
Warranty term: 18 months
Expiry date: 8 September 2028
Price paid: $129.00`,
    expected: [
      { kind: "expiry", value: "2028-09-08" },
      { kind: "amount", value: "129.00" },
    ],
  },
  // Not the reader's: quote date, cover starts, policy number that looks like a date, medical limit, excess.
  {
    id: "f-travel-insurance",
    name: "Your travel cover.email",
    mime: EMAIL,
    from: "Wayfarer Cover Example",
    writtenAt: Date.UTC(2027, 4, 10, 9),
    mailKind: "other",
    text: `Policy number: TI-100527-77
Quote date: 10 May 2027
Cover starts: 1 June 2027
Cover ends: 15 June 2027
Medical cover up to $500,000.00
Excess: $100.00
Premium: USD 48.60`,
    expected: [
      { kind: "expiry", value: "2027-06-15" },
      { kind: "amount", value: "48.60" },
    ],
  },
  // Not the reader's: last visit, cancellation fee. Label and value on separate lines.
  {
    id: "f-dental-card",
    name: "appointment-card-dental.pdf",
    mime: "application/pdf",
    text: `Appointment card
Dentist
Dr. Example
Last visit
8 June 2027
Next appointment
Tue 14 Dec 2027
Time
2:45 PM
Late cancellation fee 40.00 within 24 hours`,
    expected: [{ kind: "event", value: "2027-12-14", time: "14:45" }],
  },
  // Not the reader's: date printed, date referred, arrive-by clock (the appointment time is the fact).
  {
    id: "f-clinic-letter",
    name: "Appointment letter.email",
    mime: EMAIL,
    from: "Riverside Clinic Example",
    writtenAt: Date.UTC(2027, 0, 11, 8),
    mailKind: "other",
    text: `Date printed: 11 January 2027
Date referred: 2 December 2026
Appointment: Wednesday 20 January 2027
Arrive by: 09:20
Appointment time: 09:40
Please confirm by: 15 January 2027`,
    expected: [
      { kind: "event", value: "2027-01-20", time: "09:40" },
      { kind: "due", value: "2027-01-15" },
    ],
  },
  // Nothing for the reader: year end date, statement generated, opening and closing balances, next statement date.
  {
    id: "f-year-end-summary",
    name: "year-end-account-summary.pdf",
    mime: "application/pdf",
    text: `Year end account summary
Year end date: 31 December 2027
Statement generated on: 4 January 2028
Opening balance 4,980.00
Interest earned 41.20
Deposits 189.80
Closing balance 5,211.00
Next statement date: 4 February 2028`,
    expected: [],
  },
  // Nothing for the reader: past payment rows, balance.
  {
    id: "f-payment-history",
    name: "Payment history for your account.email",
    mime: EMAIL,
    from: "Brightwater Utilities Example",
    writtenAt: Date.UTC(2027, 2, 2, 9),
    mailKind: "bill",
    text: `Payment history
Date | Amount | Status
3 Jan 2027 | $50.00 | Paid
2 Feb 2027 | $50.00 | Paid
1 Mar 2027 | $50.00 | Paid
Current balance: $0.00
Last payment date: 1 March 2027`,
    expected: [],
  },
  // Nothing for the reader: points balance, member since, last activity, points earned.
  {
    id: "f-points-statement",
    name: "Your points summary.email",
    mime: EMAIL,
    from: "Orchard Rewards Example",
    writtenAt: Date.UTC(2027, 2, 1, 7),
    mailKind: "newsletter",
    text: `Points summary
Member since: June 2022
Last activity: 18 Feb 2027
Points earned this period: 420
Points redeemed: 100
Points balance: 3,860
Tier review date: 1 July 2027`,
    expected: [],
  },
  // Nothing for the reader: past order dates and totals.
  {
    id: "f-order-history",
    name: "order-history-2027.pdf",
    mime: "application/pdf",
    text: `Order history
Order date  Order no  Total
12 Jan 2027  A-1041  $23.50
2 Mar 2027  A-1187  $61.00
19 May 2027  A-1342  $14.99
Orders in 2027: 3
Date printed: 1 June 2027`,
    expected: [],
  },
  // Nothing for the reader: version date, effective price date, prices.
  {
    id: "f-price-list",
    name: "price-list-2027.pdf",
    mime: "application/pdf",
    text: `Price list
Version date: 2 January 2027
Haircut: $28.00
Colour: $85.00
Beard trim: $15.00
Price change effective: 1 February 2027
New haircut price: $30.00
Opening hours: Tue to Sat 9:00 to 17:00`,
    expected: [],
  },
  // Nothing for the reader: effective date of a notice, monthly fee change.
  {
    id: "f-new-terms-notice",
    name: "Changes to our terms.email",
    mime: EMAIL,
    from: "Streamly Example",
    writtenAt: Date.UTC(2027, 1, 8, 10),
    mailKind: "other",
    text: `Notice of new terms
Effective date: 1 April 2027
Current monthly fee: $9.00
New monthly fee: $11.00
Terms version: 8 February 2027
No action is needed.`,
    expected: [],
  },
  // Nothing for the reader: past meeting date, approval date, budget figure.
  {
    id: "f-meeting-record",
    name: "minutes-board-october.pdf",
    mime: "application/pdf",
    text: `Meeting record
Meeting date: 12 October 2027
Attendees: 7
Chair: R. Example
Budget noted: $4,500.00
Minutes approved: 9 November 2027
Document version: 2 of 2`,
    expected: [],
  },
  // Nothing for the reader: purchase date, registered on, serial number.
  {
    id: "f-product-registration",
    name: "Product registration record.email",
    mime: EMAIL,
    from: "Kitchenware Example",
    writtenAt: Date.UTC(2027, 3, 12, 12),
    mailKind: "other",
    text: `Product registration record
Product: Blender BL-9
Serial number: 0412-7731
Date of purchase: 3 April 2027
Registered on: 12 April 2027
Retailer: Example Store`,
    expected: [],
  },
];
