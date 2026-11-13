/**
 * Development cases with distractors: thirty invented messages and
 * documents in which the date or amount that matters stands among others
 * that do not (an order day, a statement date, a subtotal, a fee). Part of
 * the first eval set: the readers' instructions are written against it.
 */

import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

export const DISTRACTOR_CASES: readonly EvalCase[] = [
  // Distractors: past visit date, booking day, cancellation fee, office hours.
  {
    id: "x-clinic-followup",
    name: "Your follow-up visit.email",
    mime: EMAIL,
    from: "Harbor Dental",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "booking",
    text: `Hello,

This note confirms your follow-up visit at Harbor Dental on Tuesday, December 1 at 10:15 AM. The hygienist will check the filling placed at your last visit on 14 September 2026, so please arrive ten minutes early to update your forms.

You booked this slot with our front desk on 2 November 2026. If you cannot come, tell us at least one working day ahead; a late cancellation fee of $45.00 applies otherwise. Our office hours are Monday to Friday, 8am to 5pm.

See you soon,
Harbor Dental`,
    expected: [{ kind: "event", value: "2026-12-01", time: "10:15" }],
  },

  // Distractors: previous session date, per-session price, future holiday closure.
  {
    id: "x-physio-session",
    name: "Physio session reminder.email",
    mime: EMAIL,
    from: "Northgate Physio",
    writtenAt: Date.UTC(2027, 0, 14, 11),
    mailKind: "booking",
    text: `Dear patient,

Your next physiotherapy session is on Wednesday 27 January 2027 at 3pm. Please wear loose clothing and bring the exercise sheet from your last session on 6 January 2027.

Your plan covers six sessions at $60.00 per session, billed after each visit. Please note that the clinic will be closed on Monday 18 January for the public holiday, so calls will be answered again from Tuesday.

Kind regards,
Northgate Physio reception`,
    expected: [{ kind: "event", value: "2027-01-27", time: "15:00" }],
  },

  // Distractors: booked-on date, last exam date, reschedule fee, practice hours.
  {
    id: "x-eye-exam",
    name: "Eye exam booking.email",
    mime: EMAIL,
    from: "Clearview Optometry",
    writtenAt: Date.UTC(2027, 1, 10, 8),
    mailKind: "booking",
    text: `Your appointment details

Appointment: 2027-02-23 09:30
Booked on: 2027-02-09
Last exam: 2025-02-18
Practice hours: Tue to Sat, 9:00 to 17:30
Reschedule fee: $25.00 within 24 hours

Please bring your current glasses and a list of any medication you take.`,
    expected: [{ kind: "event", value: "2027-02-23", time: "09:30" }],
  },

  // Distractors: previous visit, deposit already paid, future closure day.
  {
    id: "x-vet-checkup",
    name: "Checkup for Biscuit.email",
    mime: EMAIL,
    from: "Maple Grove Animal Clinic",
    writtenAt: Date.UTC(2027, 2, 15, 10),
    mailKind: "booking",
    text: `Hi,

We have Biscuit down for a dental checkup on Thursday, March 18 at 4:30 PM with Dr. Alder. Please do not feed him after 8 in the morning that day.

His last visit was on 20 November 2026, when the nurse trimmed his nails. The deposit of $30.00 you paid when booking will be taken off the final bill, which we estimate at $120.00 to $180.00.

We are closed on Monday, April 5 for the spring break. Thank you!

Maple Grove Animal Clinic`,
    expected: [{ kind: "event", value: "2027-03-18", time: "16:30" }],
  },

  // Distractors: billing period, statement date, previous balance and payment day, late fee, next statement date (future).
  {
    id: "x-electric-bill",
    name: "Your January electricity bill.email",
    mime: EMAIL,
    from: "Riverside Power",
    writtenAt: Date.UTC(2027, 1, 3, 7),
    mailKind: "bill",
    text: `Your bill is ready.

Amount due: $142.60
Due date: 24 February 2027
Billing period: 1 January 2027 to 31 January 2027
Statement date: 3 February 2027
Previous balance: $118.00, paid in full on 12 January 2027
Late payment fee: $15.00 after the due date

Your next statement will be issued on 3 March 2027. You can pay by card, by bank transfer or at any post office counter.`,
    expected: [
      { kind: "due", value: "2027-02-24" },
      { kind: "amount", value: "142.60" },
    ],
  },

  // Distractors: bill generation date, plan and equipment line items, future price change date and price.
  {
    id: "x-internet-bill",
    name: "Internet invoice ready.email",
    mime: EMAIL,
    from: "Fiberlane Home",
    writtenAt: Date.UTC(2027, 2, 1, 9),
    mailKind: "bill",
    text: `Hello,

Your invoice was generated on 28 February 2027. It covers your plan (USD 59.99) and the router rental (USD 20.00), which comes to a total of USD 79.99, payable by Fri 12 Mar 2027. Autopay customers need do nothing.

Good to know: from April 1 2027 the plan price goes up to USD 64.99, so the total on your next invoice will be USD 84.99. Your last payment, USD 79.99, reached us on 11 February 2027. Thank you for staying with us.`,
    expected: [
      { kind: "due", value: "2027-03-12" },
      { kind: "amount", value: "79.99" },
    ],
  },

  // Distractors: statement date, previous balance, minimum payment, credit limit, last payment date.
  {
    id: "x-card-statement",
    name: "Your April statement is ready.email",
    mime: EMAIL,
    from: "Lakeside Card Services",
    writtenAt: Date.UTC(2027, 3, 6, 6),
    mailKind: "bill",
    text: `Dear cardholder,

Your statement dated 5 April 2027 is now available online. Your statement balance is £1,250.00. To avoid interest, pay the full balance by 28 April 2027. The minimum payment is £35.00, but paying only the minimum means interest is charged.

Previous balance: £980.40
Last payment received: 20 March 2027
Credit limit: £5,000.00

You can pay from the app or by standing order.`,
    expected: [
      { kind: "due", value: "2027-04-28" },
      { kind: "amount", value: "1250.00" },
    ],
  },

  // Distractors: invoice date, meter read day, usage and sewer line items, previous payment day, late surcharge.
  {
    id: "x-water-bill",
    name: "water-invoice-march.pdf",
    mime: "application/pdf",
    text: `Valley Water Services
Invoice date: 2 March 2027
Meter read on: 1 March 2027
Usage charge: $48.30
Sewer charge: $22.10
Total due: $70.40
Please pay by 30 March 2027. A surcharge of 5% is added to late payments.
Your previous payment was received on 11 February 2027. Thank you.`,
    expected: [
      { kind: "due", value: "2027-03-30" },
      { kind: "amount", value: "70.40" },
    ],
  },

  // Distractors: date printed, service date, gross charges, insurance adjustment, billing office hours.
  {
    id: "x-medical-statement",
    name: "patient-statement-january.pdf",
    mime: "application/pdf",
    text: `Lakeview Family Clinic
Patient statement
Date printed: 9 January 2027
Services on 18 December 2026: consultation and tests
Total charges: CAD 320.00
Insurance adjustment: -CAD 190.00
Patient balance: CAD 130.00
Payment is due on or before February 8, 2027.
The billing office is open Monday to Friday from 9am to 4pm.`,
    expected: [
      { kind: "due", value: "2027-02-08" },
      { kind: "amount", value: "130.00" },
    ],
  },

  // Distractors: policy start date, instalment rate, excess amount, customer since.
  {
    id: "x-home-policy",
    name: "home-insurance-schedule.pdf",
    mime: "application/pdf",
    text: `Hearth & Oak Insurance Ltd
Home insurance schedule
Date of issue: 14 October 2026
Policy period: from 1 December 2026 until 30 November 2027
Annual premium: $1,180.00
Monthly instalment option: $98.33 per month
Excess on any claim: $500.00
Customer since 2019
Cover for the buildings and contents described below ends on the last day of the policy period. We will write to you about renewal before then.`,
    expected: [
      { kind: "issued", value: "2026-10-14" },
      { kind: "expiry", value: "2027-11-30" },
      { kind: "amount", value: "1180.00" },
    ],
  },

  // Distractors: purchase date, add-on price, manufacture month, service line hours.
  {
    id: "x-appliance-warranty",
    name: "dishwasher-warranty-certificate.pdf",
    mime: "application/pdf",
    text: `Certificate of warranty
Product: dishwasher, model DW-5
Purchase date: 3 August 2026
Manufactured: May 2026
This warranty is valid until 2 August 2028 and covers parts and labour for faults in normal home use.
Optional extended care add-on: $79.00 (not purchased)
Service line hours: Monday to Saturday, 8am to 6pm
Keep this certificate with your proof of purchase.`,
    expected: [{ kind: "expiry", value: "2028-08-02" }],
  },

  // Distractors: signing date, start date, monthly rent, deposit paid on a past day.
  {
    id: "x-lease-term",
    name: "lease-summary.pdf",
    mime: "application/pdf",
    text: `Residential lease summary
Agreement signed: 20 June 2026
Term: 12 months commencing 1 September 2026
The lease ends on 31 August 2027 unless renewed in writing.
Rent: $1,650.00 per month, due on the first of each month
Security deposit: $1,650.00, paid on 25 June 2026
Notice of non-renewal must be given 60 days before the end of the term.`,
    expected: [{ kind: "expiry", value: "2027-08-31" }],
  },

  // Distractors: order day, dispatch day, shipping fee, item subtotal.
  {
    id: "x-parcel-eta",
    name: "Your parcel is on its way.email",
    mime: EMAIL,
    from: "Brightway Parcels",
    writtenAt: Date.UTC(2027, 1, 17, 8),
    mailKind: "delivery",
    text: `Good news, your parcel is on its way.

Ordered: 14 February 2027
Left our Eastgate depot: 16 February 2027
Expected delivery: Friday, February 19
Items: $62.40, shipping: $6.00

No signature is needed. If nobody is home, the courier will leave the parcel in your safe place.`,
    expected: [{ kind: "event", value: "2027-02-19" }],
  },

  // Distractors: order date, deposit paid, optional assembly fee, future holiday closure.
  {
    id: "x-furniture-delivery",
    name: "Your sofa delivery.email",
    mime: EMAIL,
    from: "Oakline Home",
    writtenAt: Date.UTC(2027, 2, 22, 12),
    mailKind: "delivery",
    text: `Hello,

Thank you for ordering from Oakline Home. Your sofa will arrive on Tuesday 6 April 2027, and our team will carry it to the room you chose.

You placed the order on 8 March 2027 and your deposit of $300.00 was received on the same day. Assembly is not needed, but if you would like it, the optional fee is $49.00.

Our warehouse is closed on Monday, March 29 for the holiday, so please do not call that day.`,
    expected: [{ kind: "event", value: "2027-04-06" }],
  },

  // Distractors: order date, charge made on that date, store hours, future promotion end date.
  {
    id: "x-pickup-ready",
    name: "Your order is ready to collect.email",
    mime: EMAIL,
    from: "Pinecrest Hardware",
    writtenAt: Date.UTC(2027, 3, 20, 13),
    mailKind: "delivery",
    text: `Your order is ready to collect at the Pinecrest Hardware desk. We will hold it for you until Friday, April 30, after which it goes back on the shelf.

You placed the order online on 17 April 2027 and $38.50 was charged to your card that day. Bring this email or your photo ID.

Store hours: Monday to Friday 7am to 7pm, Saturday 9am to 5pm. Spring sale prices on garden tools end on May 3.`,
    expected: [{ kind: "due", value: "2027-04-30" }],
  },

  // Distractors: booking day, nightly rate, deposit, reception hours.
  {
    id: "x-hotel-confirmation",
    name: "Booking confirmed at Cedar Point Lodge.email",
    mime: EMAIL,
    from: "Cedar Point Lodge",
    writtenAt: Date.UTC(2027, 3, 12, 10),
    mailKind: "booking",
    text: `Thank you for choosing Cedar Point Lodge.

Check-in: Friday 14 May 2027, from 3pm
Check-out: Monday 17 May 2027, by 11am
Room: lakeside double, 3 nights at $140.00 per night
Taxes: $33.60
Total for your stay: $453.60
A deposit of $100.00 was taken when you booked on 10 April 2027 and will be deducted at check-out.
Reception is open from 7am to 10pm every day.`,
    expected: [
      { kind: "event", value: "2027-05-14", time: "15:00", role: "check-in" },
      { kind: "event", value: "2027-05-17", time: "11:00", role: "check-out" },
      { kind: "amount", value: "453.60" },
    ],
  },

  // Distractors: booking day, base fare and railcard discount lines, ticket office hours, future engineering works.
  {
    id: "x-train-ticket",
    name: "Your train ticket.email",
    mime: EMAIL,
    from: "Eastline Trains",
    writtenAt: Date.UTC(2027, 4, 4, 15),
    mailKind: "booking",
    text: `Your e-ticket is attached.

Journey: Eastbridge to Marlow Central, one way
Date: Saturday 15 May 2027
Departs Eastbridge 08:42, arrives Marlow Central 10:05
Fare: £33.00, railcard discount: -£5.50
Total paid: £27.50
Booked on 2 May 2027.

The ticket office is open 6am to 8pm. Engineering works will close the line on 22 and 23 May 2027.`,
    expected: [
      { kind: "event", value: "2027-05-15", time: "08:42", role: "depart" },
      { kind: "event", value: "2027-05-15", time: "10:05", role: "arrive" },
      { kind: "amount", value: "27.50" },
    ],
  },

  // Distractors: booking day, optional seat fee, miles earned, future check-in opening day.
  {
    id: "x-flight-booking",
    name: "Your flight to Lisbon.email",
    mime: EMAIL,
    from: "Skyward Air",
    writtenAt: Date.UTC(2027, 5, 2, 18),
    mailKind: "booking",
    text: `Thanks for booking with Skyward Air on 1 June 2027.

Flight SW 412
Departs AMS at 14:20 on Thursday 17 June 2027
Arrives LIS at 16:35 the same day (local times)
Total fare: €213,40
Optional seat selection: €12,00 per seat
Miles earned on this trip: 1,240

Online check-in opens on 16 June 2027. Please arrive at the airport two hours before departure.`,
    expected: [
      { kind: "event", value: "2027-06-17", time: "14:20", role: "depart" },
      { kind: "event", value: "2027-06-17", time: "16:35", role: "arrive" },
      { kind: "amount", value: "213.40" },
    ],
  },

  // Distractors: booking day, vehicle and passenger line items, timetable season, check-in rule.
  {
    id: "x-ferry-itinerary",
    name: "ferry-booking-summary.pdf",
    mime: "application/pdf",
    text: `Isle Crossings booking summary
Booking made: 18 May 2027
Outbound: Saturday 3 July 2027
Departs Port Alder 07:30, arrives Fenmouth 09:45
Vehicle: $140.00
Passenger: $46.00
Total fare: $186.00
Check-in closes 45 minutes before departure.
Summer timetable valid from 1 April 2027 to 30 September 2027.`,
    expected: [
      { kind: "event", value: "2027-07-03", time: "07:30", role: "depart" },
      { kind: "event", value: "2027-07-03", time: "09:45", role: "arrive" },
      { kind: "amount", value: "186.00" },
    ],
  },

  // Distractors: registration day, fee paid, studio closure (future), kiln fee, previous term end.
  {
    id: "x-pottery-class",
    name: "Welcome to the winter pottery class.email",
    mime: EMAIL,
    from: "Clayworks Studio",
    writtenAt: Date.UTC(2027, 0, 20, 17),
    mailKind: "booking",
    text: `Welcome to the six-week beginners pottery class.

Your first session is on Tuesday 2 February 2027 at 6:30 PM. Bring an apron and your hair tied back. The studio supplies clay and tools.

You registered on 12 January 2027 and the course fee of $210.00 was charged that day. A kiln firing fee of $15.00 per piece may apply later. Our last term ended on 11 December 2026, and the studio will be closed on Monday January 25.

See you in the studio!`,
    expected: [{ kind: "event", value: "2027-02-02", time: "18:30" }],
  },

  // Distractors: purchase day, doors time, ticket and service fee amounts, presale window, another show on sale from a future day.
  {
    id: "x-concert-tickets",
    name: "Your tickets for Saturday.email",
    mime: EMAIL,
    from: "Hollow Hall Tickets",
    writtenAt: Date.UTC(2027, 4, 10, 12),
    mailKind: "booking",
    text: `Your tickets are confirmed.

Event: The Lantern Quartet live
Date: Saturday, 5 June 2027
Doors: 7:00 PM
Show starts: 8:00 PM
Tickets: 2 x $55.00, service fees: $11.00

You bought them on 9 May 2027 during the presale, which ran from 1 to 7 May. The quartet's second show goes on sale from May 20.`,
    expected: [{ kind: "event", value: "2027-06-05", time: "20:00" }],
  },

  // Distractors: form date, receipt date of the application, fee already paid, office hours, a closure day.
  {
    id: "x-form-deadline",
    name: "Permit form reminder.email",
    mime: EMAIL,
    from: "Eastfield Community Council",
    writtenAt: Date.UTC(2027, 2, 9, 9),
    mailKind: "other",
    text: `Dear resident,

Thank you for your street party permit application, which we received on 24 February 2027. Your application fee of $35.00 was received at the same time.

Please return the signed permit form (dated 1 March 2027) to the council office by Friday, April 2, otherwise the application lapses. The office is open Tuesday to Friday, 10am to 3pm, and is closed on Monday March 29.

Regards,
Permits team`,
    expected: [{ kind: "due", value: "2027-04-02" }],
  },

  // Distractors: letter date, tax year, office hours, helpline hours.
  {
    id: "x-records-request",
    name: "records-request-letter.pdf",
    mime: "application/pdf",
    text: `Revenue Review Office
Date of letter: 4 February 2027
Subject: request for supporting records, tax year 2025

We are reviewing your return for the tax year 2025. Please send copies of the records listed below no later than 15 March 2027. If you do not reply by then, we may adjust the return without further notice.

Office hours: Monday to Friday, 9am to 5pm
Helpline: open 8am to 8pm on weekdays`,
    expected: [{ kind: "due", value: "2027-03-15" }],
  },

  // Distractors: purchase day, line items, tax, loyalty points, future promotion end date.
  {
    id: "x-cafe-receipt",
    name: "Your Juniper Bakery receipt.email",
    mime: EMAIL,
    from: "Juniper Bakery",
    writtenAt: Date.UTC(2027, 1, 26, 8),
    mailKind: "receipt",
    text: `Thank you for your purchase on 25 February 2027.

Coffee beans: $12.00
Croissants x 3: $9.50
Subtotal: $21.50
Tax: $1.72
Total paid: $23.22

You earned 23 points today and now have 140 points. Show this receipt before 31 March 2027 for 10% off a loaf.`,
    expected: [{ kind: "amount", value: "23.22" }],
  },

  // Distractors: sale dates, sale and old prices, free delivery threshold and end date, store opening time.
  {
    id: "x-ad-spring-sale",
    name: "Spring Sale starts Friday.email",
    mime: EMAIL,
    from: "Fernwood Furnishings",
    writtenAt: Date.UTC(2027, 2, 8, 6),
    mailKind: "newsletter",
    text: `Spring Sale at Fernwood Furnishings!

Take 20% off everything from 12 March to 21 March 2027. Sofas from $799.00 (was $999.00), dining sets from $649.00, rugs from $89.00.

Free delivery on orders over $500.00 until 31 March 2027. Stores open at 9am every day during the sale. Prices exclude clearance items.`,
    expected: [],
  },

  // Distractors: public event dates and times, ticket price, library closure period.
  {
    id: "x-city-events-roundup",
    name: "What is on in town this month.email",
    mime: EMAIL,
    from: "Town Notes",
    writtenAt: Date.UTC(2026, 11, 2, 9),
    mailKind: "newsletter",
    text: `This month in town

Winter market: Saturday 12 December 2026, 10am to 4pm, free entry.
Lantern walk: Friday 18 December 2026 at 7pm, tickets $8.00.
New Year's Day swim: 1 January 2027 at 11:00 at the lakeshore.
The library is closed from 24 December 2026 to 2 January 2027.

Thanks for reading. Town Notes is published by volunteers.`,
    expected: [],
  },

  // Distractors: future fee start date and fee amounts, statement date, branch hours.
  {
    id: "x-bank-fee-notice",
    name: "Changes to our account fees.email",
    mime: EMAIL,
    from: "Ashford Savings",
    writtenAt: Date.UTC(2027, 0, 12, 10),
    mailKind: "other",
    text: `Dear customer,

We are writing to let you know about changes to some fees. From 1 April 2027 the monthly maintenance fee will rise from $4.00 to $6.00. The ATM fee at other banks will be $2.50, and the overdraft fee stays at $30.00.

This is for your information only. You do not need to do anything. Your statement dated 31 December 2026 is already available online. Branches are open Monday to Friday, 9am to 4pm.

Ashford Savings`,
    expected: [],
  },

  // Distractors: points statement date, balance and value, member since, next statement date, bonus weekend.
  {
    id: "x-loyalty-points",
    name: "Your points statement.email",
    mime: EMAIL,
    from: "Greenleaf Rewards",
    writtenAt: Date.UTC(2027, 3, 3, 9),
    mailKind: "newsletter",
    text: `Your Greenleaf Rewards statement

Statement as of 31 March 2027
Points balance: 4,820 (worth $48.20)
Points earned in March: 640
Member since: 14 June 2019

Look out for double points on 10 and 11 April 2027. Your next statement arrives on 3 May 2027.`,
    expected: [],
  },

  // Distractors: effective date of new terms, last-updated date, older terms version date, unchanged price, copyright year.
  {
    id: "x-terms-update",
    name: "We are updating our terms of service.email",
    mime: EMAIL,
    from: "Pine Notes",
    writtenAt: Date.UTC(2027, 1, 5, 12),
    mailKind: "other",
    text: `Hello,

We have updated our terms of service. The new terms take effect on 1 March 2027 and were last edited on 1 February 2027. They replace the version dated 12 May 2025.

Your subscription price of $4.99 per month is unchanged. No action is required; by continuing to use Pine Notes after the effective date you accept the new terms.

Copyright 2027 Pine Notes Ltd.`,
    expected: [],
  },

  // Distractors: statement period, dated transactions, balances, preparation date, interest amount.
  {
    id: "x-year-end-summary",
    name: "annual-account-summary-2026.pdf",
    mime: "application/pdf",
    text: `Ridgeway Savings
Annual account summary
Statement period: 1 January 2026 to 31 December 2026
Prepared on: 8 January 2027

Opening balance: $4,210.00
Deposit, 15 March 2026: $1,500.00
Withdrawal, 2 June 2026: $350.00
Deposit, 30 September 2026: $900.00
Withdrawal, 12 December 2026: $620.00
Interest earned in 2026: $41.18
Closing balance: $5,681.18

This summary is for your records and requires no action.`,
    expected: [],
  },
];
