/**
 * Development cases for amounts: the whole amount of a document against its
 * parts, amounts written with the currency after the number, and labels on
 * the line above. Part of the first eval set: the readers' rules are written
 * against it.
 */

import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

export const AMOUNT_CASES: readonly EvalCase[] = [
  // a-01: the usage part, the standing charge part and the statement day are not expected.
  {
    id: "a-01",
    name: "Your electricity bill.email",
    mime: EMAIL,
    from: "Northfield Power Example",
    writtenAt: Date.UTC(2027, 1, 26, 7),
    mailKind: "bill",
    text: `Electricity bill
Statement date: 26 February 2027
Usage charge 56.00 GBP
Standing charge 30.40 GBP
Amount due: 86.40 GBP
Payment due date: 12 March 2027`,
    expected: [
      { kind: "due", value: "2027-03-12" },
      { kind: "amount", value: "86.40" },
    ],
  },
  // a-02: the premium and the policy fee are parts; the issue day is not expected.
  {
    id: "a-02",
    name: "home-insurance-invoice.pdf",
    mime: "application/pdf",
    text: `Home insurance invoice
Issued: 2 April 2027
Annual premium 1.100,00 EUR
Policy fee 134,50 EUR
Total to pay 1.234,50 EUR
Please pay by 30 April 2027`,
    expected: [
      { kind: "due", value: "2027-04-30" },
      { kind: "amount", value: "1234.50" },
    ],
  },
  // a-03: the plan price and the tax are parts.
  {
    id: "a-03",
    name: "Your subscription receipt.email",
    mime: EMAIL,
    from: "Sample Streams",
    writtenAt: Date.UTC(2027, 4, 5, 9),
    mailKind: "receipt",
    text: `Thank you for your payment.
Plan 24,99 €
Tax 5,00 €
Total charged: 29,99 €
Card ending 4242`,
    expected: [{ kind: "amount", value: "29.99" }],
  },
  // a-04: the monthly fee and the connection fee are parts; the invoice day is not expected.
  {
    id: "a-04",
    name: "fibre-invoice-example.pdf",
    mime: "application/pdf",
    text: `Fibre Example invoice
Invoice date: 26 May 2027
Monthly fee 43.50€
Connection fee 5.00€
Amount payable 48.50€
Pay by 9 June 2027`,
    expected: [
      { kind: "due", value: "2027-06-09" },
      { kind: "amount", value: "48.50" },
    ],
  },
  // a-05: the nights and the cleaning fee are parts; the day of booking is not an event.
  {
    id: "a-05",
    name: "Your cabin booking.email",
    mime: EMAIL,
    from: "Lakeside Cabins Example",
    writtenAt: Date.UTC(2027, 3, 3, 10),
    mailKind: "booking",
    text: `Your stay is booked (made on 3 April 2027).
Arrival: 14 May 2027
2 nights at 200.00 CAD
Cleaning fee 50.00 CAD
Total for your stay: 450.00 CAD`,
    expected: [
      { kind: "event", value: "2027-05-14" },
      { kind: "amount", value: "450.00" },
    ],
  },
  // a-06: the subtotal and the VAT are parts; the invoice day is not expected.
  {
    id: "a-06",
    name: "consulting-invoice-example.pdf",
    mime: "application/pdf",
    text: `Consulting invoice
Invoice date: 11 June 2027
Subtotal 120.00 GBP  VAT 24.00 GBP
Invoice total 144.00 GBP
Payment due: 25 June 2027`,
    expected: [
      { kind: "due", value: "2027-06-25" },
      { kind: "amount", value: "144.00" },
    ],
  },
  // a-07: the subtotal, the tax, the shipping and the order day are not expected.
  {
    id: "a-07",
    name: "Your order receipt.email",
    mime: EMAIL,
    from: "Garden Supplies Example",
    writtenAt: Date.UTC(2027, 4, 4, 12),
    mailKind: "receipt",
    text: `Order date: 4 May 2027
Subtotal: $54.00
Tax: $4.32
Shipping: $6.99
Grand total: $65.31`,
    expected: [{ kind: "amount", value: "65.31" }],
  },
  // a-08: the subtotal, the discount and the tax are not expected.
  {
    id: "a-08",
    name: "shop-receipt-example.pdf",
    mime: "application/pdf",
    text: `Sample Outfitters
Receipt REF-60218
Subtotal   $112.50
Discount   -$12.50
Tax   $8.00
Total paid   $108.00`,
    expected: [{ kind: "amount", value: "108.00" }],
  },
  // a-09: the subtotal and the delivery charge are not expected.
  {
    id: "a-09",
    name: "Thanks for your purchase.email",
    mime: EMAIL,
    from: "Book Barn Example",
    writtenAt: Date.UTC(2027, 5, 8, 15),
    mailKind: "receipt",
    text: `Your purchase
Subtotal: £35.00
Delivery: £4.50
Amount charged: £39.50`,
    expected: [{ kind: "amount", value: "39.50" }],
  },
  // a-10: the subtotal and the VAT are not expected; the invoice day is not expected.
  {
    id: "a-10",
    name: "design-invoice-example.pdf",
    mime: "application/pdf",
    text: `Studio Example invoice
Invoice date: 4 June 2027
Subtotal €200.00
VAT 20%   €40.00
Total (incl. VAT)   €240.00
Payment due: 18 June 2027`,
    expected: [
      { kind: "due", value: "2027-06-18" },
      { kind: "amount", value: "240.00" },
    ],
  },
  // a-11: the subtotal, the GST and the discount are not expected; the invoice day is not expected.
  {
    id: "a-11",
    name: "Invoice for May services.email",
    mime: EMAIL,
    from: "Outback Services Example",
    writtenAt: Date.UTC(2027, 5, 18, 8),
    mailKind: "bill",
    text: `Invoice date: 18 June 2027
Subtotal: AUD 600.00
GST: AUD 60.00
Discount   -AUD 20.00
Invoice total: AUD 640.00
Due: 2 July 2027`,
    expected: [
      { kind: "due", value: "2027-07-02" },
      { kind: "amount", value: "640.00" },
    ],
  },
  // a-12: the subtotal, the shipping and the discount are not expected.
  {
    id: "a-12",
    name: "webshop-order-example.pdf",
    mime: "application/pdf",
    text: `Alpine Goods Example
Order REF-33071
Subtotal   CHF 88.00
Shipping: CHF 9.00
Discount   -CHF 7.00
Total to pay: CHF 90.00`,
    expected: [{ kind: "amount", value: "90.00" }],
  },
  // a-13: the previous balance, the payment received and the bill day are not expected.
  {
    id: "a-13",
    name: "Your water bill.email",
    mime: EMAIL,
    from: "Riverbend Water Example",
    writtenAt: Date.UTC(2027, 5, 29, 6),
    mailKind: "bill",
    text: `Bill date: 29 June 2027
Previous balance: $64.10
Payments received: -$64.10
New charges: $92.35
Amount due: $92.35
Payment due date: 15 July 2027`,
    expected: [
      { kind: "due", value: "2027-07-15" },
      { kind: "amount", value: "92.35" },
    ],
  },
  // a-14: the previous balance, the payment received and the print day are not expected.
  {
    id: "a-14",
    name: "gas-bill-august.pdf",
    mime: "application/pdf",
    text: `Gas bill
Date printed: 22 July 2027
Previous balance   £120.00
Payments received   -£120.00
New charges   £47.80
Balance due   £47.80
Please pay by 5 August 2027`,
    expected: [
      { kind: "due", value: "2027-08-05" },
      { kind: "amount", value: "47.80" },
    ],
  },
  // a-15: the carried balance, the payment received and the new charges are parts; the bill day is not expected.
  {
    id: "a-15",
    name: "Your phone bill.email",
    mime: EMAIL,
    from: "Bluebird Mobile Example",
    writtenAt: Date.UTC(2027, 6, 30, 7),
    mailKind: "bill",
    text: `Bill date: 30 July 2027
Previous balance: €30,00
Payments received: -€10,00
New charges: €55,20
Total due: €75,20
Pay by: 20 August 2027`,
    expected: [
      { kind: "due", value: "2027-08-20" },
      { kind: "amount", value: "75.20" },
    ],
  },
  // a-16: the previous balance, the payment received and the issue day are not expected.
  {
    id: "a-16",
    name: "internet-bill-example.pdf",
    mime: "application/pdf",
    text: `Internet bill
Issued: 16 August 2027
Previous balance   CAD 15.00
Payments received   -CAD 15.00
New charges   CAD 129.99
Amount payable   CAD 129.99
Payment due: 1 September 2027`,
    expected: [
      { kind: "due", value: "2027-09-01" },
      { kind: "amount", value: "129.99" },
    ],
  },
  // a-17: the subtotal and the sales tax are not expected.
  {
    id: "a-17",
    name: "service-bill-flat.pdf",
    mime: "application/pdf",
    text: `Account summary
Subtotal
$50.00
Sales tax
$4.00
Amount due
$54.00
Payment due
3 October 2027`,
    expected: [
      { kind: "due", value: "2027-10-03" },
      { kind: "amount", value: "54.00" },
    ],
  },
  // a-18: the subtotal and the service charge are not expected; the bill day is not expected.
  {
    id: "a-18",
    name: "Invoice for your event hire.email",
    mime: EMAIL,
    from: "Marquee Hire Example",
    writtenAt: Date.UTC(2027, 9, 28, 9),
    mailKind: "bill",
    text: `Bill date
28 October 2027
Subtotal
£210.00
Service charge
£21.00
Total due
£231.00
Due date
11 November 2027`,
    expected: [
      { kind: "due", value: "2027-11-11" },
      { kind: "amount", value: "231.00" },
    ],
  },
  // a-19: the fare and the booking fee are not expected.
  {
    id: "a-19",
    name: "coach-booking-example.pdf",
    mime: "application/pdf",
    text: `Coach booking REF-72094
Fare
€88.00
Booking fee
€4.50
Total paid
€92.50`,
    expected: [{ kind: "amount", value: "92.50" }],
  },
  // a-20: the items and the delivery charge are not expected.
  {
    id: "a-20",
    name: "Your furniture invoice.email",
    mime: EMAIL,
    from: "Oak and Pine Example",
    writtenAt: Date.UTC(2027, 6, 16, 10),
    mailKind: "bill",
    text: `Invoice
Items
$131.00
Delivery charge
$9.00
Balance due
$140.00
Payment due
30 July 2027`,
    expected: [
      { kind: "due", value: "2027-07-30" },
      { kind: "amount", value: "140.00" },
    ],
  },
  // a-21: only a late fee is named, so there is no whole amount.
  {
    id: "a-21",
    name: "About late payments.email",
    mime: EMAIL,
    from: "Hillside Storage Example",
    writtenAt: Date.UTC(2027, 7, 2, 9),
    mailKind: "other",
    text: `Hello,

A reminder about our terms: a late fee of $25.00 is added to any account that is not settled on time.
If you need more time, please contact us before your payment is late.

Hillside Storage Example`,
    expected: [],
  },
  // a-22: a price list has several prices and no whole amount.
  {
    id: "a-22",
    name: "rate-card-example.pdf",
    mime: "application/pdf",
    text: `Salon Example rate card
Haircut £28.00
Colour £65.00
Blow dry £22.00
Prices are per visit and may change.`,
    expected: [],
  },
  // a-23: only a delivery charge and a deposit already paid are named; no delivery day is given.
  {
    id: "a-23",
    name: "About your sofa delivery.email",
    mime: EMAIL,
    from: "Home Furnishings Example",
    writtenAt: Date.UTC(2027, 7, 10, 8),
    mailKind: "delivery",
    text: `Your sofa is ready to leave the warehouse.
Delivery charge: €12,00
Deposit already paid: €50,00
We will call you to agree a delivery day.`,
    expected: [],
  },
  // a-24: only a change fee per person is named, so there is no whole amount.
  {
    id: "a-24",
    name: "Changes to your booking.email",
    mime: EMAIL,
    from: "Mountain Tours Example",
    writtenAt: Date.UTC(2027, 7, 12, 11),
    mailKind: "booking",
    text: `Booking REF-55120

Any change to your booking carries a change fee of CAD 35.00 per person.
Reply to this message if you would like to make a change.`,
    expected: [],
  },
  // a-25: the total charges and the insurance payment are not expected.
  {
    id: "a-25",
    name: "clinic-statement-example.pdf",
    mime: "application/pdf",
    text: `Clinic Example patient statement
Total charges   $820.00
Insurance paid   -$640.00
Patient balance   $180.00
Please pay by 14 July 2027`,
    expected: [
      { kind: "due", value: "2027-07-14" },
      { kind: "amount", value: "180.00" },
    ],
  },
  // a-26: the invoice total and the amount already paid are not expected.
  {
    id: "a-26",
    name: "Invoice 2041 balance.email",
    mime: EMAIL,
    from: "Fenwick Builders Example",
    writtenAt: Date.UTC(2027, 7, 26, 9),
    mailKind: "bill",
    text: `Invoice total: £500.00
Amount paid: £200.00
Balance due: £300.00
Due date: 9 September 2027`,
    expected: [
      { kind: "due", value: "2027-09-09" },
      { kind: "amount", value: "300.00" },
    ],
  },
  // a-27: the order total and the gift card are not expected.
  {
    id: "a-27",
    name: "order-slip-example.pdf",
    mime: "application/pdf",
    text: `Sample Home Store
Order total: $80.00
Gift card: -$30.00
Total due: $50.00`,
    expected: [{ kind: "amount", value: "50.00" }],
  },
  // a-28: the ticket price and the service fees are not expected; the booking day is not an event.
  {
    id: "a-28",
    name: "Your tickets are confirmed.email",
    mime: EMAIL,
    from: "Harbour Theatre Example",
    writtenAt: Date.UTC(2027, 6, 20, 14),
    mailKind: "booking",
    text: `Your booking was made on 20 July 2027.
Show date: 21 August 2027
Tickets: 2 x $55.00
Service fees: $11.00
Total paid: $121.00`,
    expected: [
      { kind: "event", value: "2027-08-21" },
      { kind: "amount", value: "121.00" },
    ],
  },
  // a-29: the fare and the railcard discount are not expected.
  {
    id: "a-29",
    name: "rail-receipt-example.pdf",
    mime: "application/pdf",
    text: `Rail receipt REF-81532
Fare: £33.00, railcard discount: -£5.50
Total paid: £27.50`,
    expected: [{ kind: "amount", value: "27.50" }],
  },
  // a-30: the nightly rate, the city tax and the deposit are not expected.
  {
    id: "a-30",
    name: "hotel-folio-example.pdf",
    mime: "application/pdf",
    text: `Grand Hotel Example folio
Room rate per night USD 150.00
3 nights
City tax USD 12.00
Deposit paid USD 100.00
Total stay USD 462.00`,
    expected: [{ kind: "amount", value: "462.00" }],
  },
];
