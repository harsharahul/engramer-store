/**
 * The held-out eval set: sixty invented messages and documents, written
 * without sight of the readers. Each case names what a careful reader finds.
 * Its figures are the ones the app trusts; no case here is ever used to
 * tune a rule or an instruction.
 */

import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

export const HELDOUT_CASES: readonly EvalCase[] = [
  // ---- Appointments (7) ----
  // No year in the email: the next 3 December on or after 16 Nov 2026 is 2026 (a Thursday).
  {
    id: "h-dentist-cleaning",
    name: "Your cleaning appointment.email",
    mime: EMAIL,
    from: "Harbor Dental",
    writtenAt: Date.UTC(2026, 10, 16, 9),
    mailKind: "booking",
    text:
      "Hello Maya,\n\n" +
      "This is a friendly reminder about your teeth cleaning with Dr. Osei. " +
      "We have you down for Thursday, December 3 at 10:15 AM. " +
      "Your last visit with us was on 4 June 2026. " +
      "Please arrive ten minutes early and bring your insurance card.\n\n" +
      "Harbor Dental, 14 Quay Lane. Reply to this message if you need to move the visit.",
    expected: [{ kind: "event", value: "2026-12-03", time: "10:15" }],
  },
  {
    id: "h-vet-booster",
    name: "Biscuit is booked in for a booster.email",
    mime: EMAIL,
    from: "Maple Paws Vet",
    writtenAt: Date.UTC(2027, 0, 11, 14),
    mailKind: "booking",
    text:
      "Hi Jordan,\n\n" +
      "Thanks for calling today. Biscuit's annual booster is booked for 2027-02-04 at 14:30 with Dr. Hale. " +
      "Please keep Biscuit on a lead in the waiting room. " +
      "If you need to cancel, let us know a day ahead.\n\n" +
      "The team at Maple Paws Vet",
    expected: [{ kind: "event", value: "2027-02-04", time: "14:30" }],
  },
  // No year: Saturday, March 20 after 15 March 2027 is 2027.
  {
    id: "h-haircut-saturday",
    name: "Haircut confirmed.email",
    mime: EMAIL,
    from: "Studio Lark Salon",
    writtenAt: Date.UTC(2027, 2, 15, 10),
    mailKind: "booking",
    text:
      "Hi Priya! You are all set. Your cut and colour with Noor is on Saturday, March 20 at 11am. " +
      "Allow about ninety minutes. " +
      "We booked this for you on Monday, thanks for choosing Studio Lark. " +
      "Free parking is behind the building.",
    expected: [{ kind: "event", value: "2027-03-20", time: "11:00" }],
  },
  {
    id: "h-car-service-dropoff",
    name: "Service booking for your hatchback.email",
    mime: EMAIL,
    from: "Northgate Auto Care",
    writtenAt: Date.UTC(2027, 3, 26, 8),
    mailKind: "booking",
    text:
      "Dear customer,\n\n" +
      "Your 30,000 km service has been scheduled. Please bring the car to our workshop at 8:00 AM on Wednesday 12 May 2027. " +
      "We will text you when it is ready for collection. " +
      "The booking was made online on 26 April 2027.\n\n" +
      "Northgate Auto Care\nOpen Monday to Saturday",
    expected: [{ kind: "event", value: "2027-05-12", time: "08:00" }],
  },
  // No year: Thursday, May 13 after 3 May 2027 is 2027.
  {
    id: "h-bank-advisor",
    name: "Meeting with your advisor.email",
    mime: EMAIL,
    from: "Cedar Credit Union",
    writtenAt: Date.UTC(2027, 4, 3, 11),
    mailKind: "booking",
    text:
      "Hello,\n\n" +
      "We have reserved time for you to talk with Ms. Lindqvist about your savings plan. " +
      "The meeting is on Thu May 13 at 3pm at our Main Street branch. " +
      "You have been a member since 2019, and we are glad to help. " +
      "Please bring a photo ID.\n\n" +
      "Cedar Credit Union",
    expected: [{ kind: "event", value: "2027-05-13", time: "15:00" }],
  },
  {
    id: "h-school-conference",
    name: "parent-teacher-conference.pdf",
    mime: "application/pdf",
    text:
      "Fairmont Elementary School\n" +
      "Parent-Teacher Conference Confirmation\n\n" +
      "Student: Ari Delacroix\n" +
      "Teacher: Mr. Bennett\n" +
      "Date: March 9, 2027\n" +
      "Time: 4:40 PM\n" +
      "Room: 12\n\n" +
      "Printed on February 22, 2027. Conferences last fifteen minutes.",
    expected: [{ kind: "event", value: "2027-03-09", time: "16:40" }],
  },
  {
    id: "h-physio-card",
    name: "physio-appointment-card.pdf",
    mime: "application/pdf",
    text:
      "Riverside Physio\n" +
      "APPOINTMENT CARD\n" +
      "Patient: S. Karlsen\n" +
      "Next visit: 2027-06-22 at 08:45\n" +
      "Therapist: A. Mbeki\n" +
      "Please give 24 hours notice if you cannot attend.\n" +
      "Clinic hours: Mon-Fri 8 to 5.",
    expected: [{ kind: "event", value: "2027-06-22", time: "08:45" }],
  },

  // ---- Bills (7) ----
  {
    id: "h-electric-bill",
    name: "Your January electricity bill.email",
    mime: EMAIL,
    from: "Brightline Power",
    writtenAt: Date.UTC(2027, 0, 18, 7),
    mailKind: "bill",
    text:
      "Hello,\n\n" +
      "Your latest bill is ready. Statement date: 15 January 2027.\n" +
      "Previous balance: $41.10 (paid, thank you)\n" +
      "Electricity charges: $89.23\n" +
      "Tax: $7.12\n" +
      "Amount due: $96.35\n\n" +
      "Please pay by 5 February 2027 to avoid a late fee. You can pay on our website or by bank transfer.",
    expected: [
      { kind: "due", value: "2027-02-05" },
      { kind: "amount", value: "96.35" },
    ],
  },
  {
    id: "h-mobile-invoice",
    name: "Invoice for January.email",
    mime: EMAIL,
    from: "Tallis Mobile",
    writtenAt: Date.UTC(2027, 1, 8, 6),
    mailKind: "bill",
    text:
      "Hi Chloe,\n\n" +
      "Your invoice for January is attached. It totals £48.00, which includes £6.00 for extra data. " +
      "We will collect it by direct debit on 1 March 2027, so there is nothing to do. " +
      "You joined Tallis Mobile in 2023.\n\n" +
      "Tallis Mobile customer care",
    expected: [
      { kind: "due", value: "2027-03-01" },
      { kind: "amount", value: "48.00" },
    ],
  },
  {
    id: "h-card-statement",
    name: "Your statement is ready.email",
    mime: EMAIL,
    from: "Meridian Card Services",
    writtenAt: Date.UTC(2027, 2, 2, 12),
    mailKind: "bill",
    text:
      "Your February statement is ready to view.\n\n" +
      "Statement closing date: February 27, 2027\n" +
      "Statement balance: $1,284.56\n" +
      "Minimum payment: $35.00\n" +
      "Payment due date: March 26, 2027\n\n" +
      "Paying the statement balance in full avoids interest charges.",
    expected: [
      { kind: "due", value: "2027-03-26" },
      { kind: "amount", value: "1284.56" },
    ],
  },
  {
    id: "h-rent-reminder",
    name: "May rent reminder.email",
    mime: EMAIL,
    from: "Oakline Properties",
    writtenAt: Date.UTC(2027, 3, 20, 9),
    mailKind: "bill",
    text:
      "Dear tenant,\n\n" +
      "Rent of USD 2,400.00 for May is due on 1 May 2027. " +
      "A late fee of USD 60.00 applies if payment arrives after the grace period. " +
      "Your lease started on 1 June 2026.\n\n" +
      "Oakline Properties, Resident Services",
    expected: [
      { kind: "due", value: "2027-05-01" },
      { kind: "amount", value: "2400.00" },
    ],
  },
  {
    id: "h-tuition-invoice",
    name: "Autumn term tuition invoice.email",
    mime: EMAIL,
    from: "Westmere Academy",
    writtenAt: Date.UTC(2027, 4, 24, 15),
    mailKind: "bill",
    text:
      "Dear parent or guardian,\n\n" +
      "The invoice for the autumn term is ready. Tuition for the term: CAD 4,200.00. " +
      "Payment is due on 15 July 2027. " +
      "An early payment discount of CAD 210.00 is shown on the attached schedule. " +
      "Last term's invoice was settled on 9 January 2027, thank you.\n\n" +
      "Westmere Academy Finance Office",
    expected: [
      { kind: "due", value: "2027-07-15" },
      { kind: "amount", value: "4200.00" },
    ],
  },
  {
    id: "h-property-tax",
    name: "property-tax-notice.pdf",
    mime: "application/pdf",
    text:
      "Town of Ashgrove\n" +
      "PROPERTY TAX NOTICE\n\n" +
      "Mailed: 1 February 2027\n" +
      "Tax year: 2027\n" +
      "Assessed value: $412,000.00\n" +
      "Amount payable: $1,700.00\n" +
      "Due date: 30 June 2027\n\n" +
      "Payments received after the due date accrue interest.",
    expected: [
      { kind: "due", value: "2027-06-30" },
      { kind: "amount", value: "1700.00" },
    ],
  },
  // Coverage ending is read as an expiry; the pay-by date is a due date.
  {
    id: "h-insurance-premium",
    name: "home-insurance-premium-notice.pdf",
    mime: "application/pdf",
    text:
      "Pennant Home Insurance\n" +
      "PREMIUM NOTICE\n\n" +
      "Annual premium: £1,250.00\n" +
      "Please pay by 14 December 2026.\n" +
      "Coverage ends: 31 December 2027\n\n" +
      "Customer since 2021. Questions? Write to the address on your policy.",
    expected: [
      { kind: "due", value: "2026-12-14" },
      { kind: "expiry", value: "2027-12-31" },
      { kind: "amount", value: "1250.00" },
    ],
  },

  // ---- Renewals and expiries (6) ----
  {
    id: "h-streaming-renewal",
    name: "Your annual plan renews soon.email",
    mime: EMAIL,
    from: "Lumen Stream",
    writtenAt: Date.UTC(2027, 1, 15, 10),
    mailKind: "bill",
    text:
      "Hi there,\n\n" +
      "Your annual plan renews on April 3, 2027, and we will charge $119.88 to your saved payment method. " +
      "You have been with us since 2024. " +
      "If you would rather not continue, you can turn off renewal in your account settings before then.\n\n" +
      "The Lumen Stream team",
    expected: [
      { kind: "due", value: "2027-04-03" },
      { kind: "amount", value: "119.88" },
    ],
  },
  {
    id: "h-domain-expiry",
    name: "Your domain is about to expire.email",
    mime: EMAIL,
    from: "Quillhost Domains",
    writtenAt: Date.UTC(2027, 4, 10, 8),
    mailKind: "other",
    text:
      "Hello,\n\n" +
      "The domain example-bakery.example.org is registered to your account and expires on 2027-07-08. " +
      "Auto-renew is switched off. After that day the site and any email on the domain will stop working. " +
      "You registered the domain in 2023.\n\n" +
      "Quillhost Domains support",
    expected: [{ kind: "expiry", value: "2027-07-08" }],
  },
  {
    id: "h-gym-membership",
    name: "Your membership is ending.email",
    mime: EMAIL,
    from: "Ironvale Fitness",
    writtenAt: Date.UTC(2026, 11, 7, 9),
    mailKind: "other",
    text:
      "Hi Tomasz,\n\n" +
      "Just a note that your membership expires on 31 January 2027. " +
      "You can renew at the front desk or online. " +
      "Member since 2022, and we love seeing you at the early classes.\n\n" +
      "Ironvale Fitness",
    expected: [{ kind: "expiry", value: "2027-01-31" }],
  },
  {
    id: "h-passport-notice",
    name: "Passport validity notice.email",
    mime: EMAIL,
    from: "Civic Records Office",
    writtenAt: Date.UTC(2027, 2, 1, 9),
    mailKind: "other",
    text:
      "Dear resident,\n\n" +
      "Our records show that your passport expires on 14 September 2027. " +
      "Many countries ask for at least six months of validity on arrival, so you may wish to renew early. " +
      "Applications take several weeks.\n\n" +
      "This notice was generated on 1 March 2027.",
    expected: [{ kind: "expiry", value: "2027-09-14" }],
  },
  // Purchase date is not expected; issue date and validity end are.
  {
    id: "h-blender-warranty",
    name: "blender-warranty-certificate.pdf",
    mime: "application/pdf",
    text:
      "KORVIN HOME APPLIANCES\n" +
      "Warranty Certificate\n\n" +
      "Product: Korvin blender KB-200\n" +
      "Date of purchase: 3 December 2026\n" +
      "Date of issue: 5 December 2026\n" +
      "Warranty valid until: 2028-12-04\n\n" +
      "Keep this certificate with your receipt. The warranty covers faults in materials and workmanship.",
    expected: [
      { kind: "issued", value: "2026-12-05" },
      { kind: "expiry", value: "2028-12-04" },
    ],
  },
  {
    id: "h-software-licence",
    name: "software-licence-certificate.pdf",
    mime: "application/pdf",
    text:
      "Calderon Software Ltd\n" +
      "LICENCE CERTIFICATE\n\n" +
      "Licensee: Fernwood Studio\n" +
      "Product: Calderon Layout Pro, 5 seats\n" +
      "Issued on 1 November 2026\n" +
      "Valid until 31 October 2027\n\n" +
      "A renewal invoice will be sent about a month before the end of the term.",
    expected: [
      { kind: "issued", value: "2026-11-01" },
      { kind: "expiry", value: "2027-10-31" },
    ],
  },

  // ---- Shipping and delivery (6) ----
  // No year: Thursday, November 26 after 23 Nov 2026 is 2026.
  {
    id: "h-parcel-arriving",
    name: "Your parcel is on its way.email",
    mime: EMAIL,
    from: "Swiftbox Couriers",
    writtenAt: Date.UTC(2026, 10, 23, 8),
    mailKind: "delivery",
    text:
      "Good news!\n\n" +
      "Your parcel from Pinecone Outfitters is arriving on Thursday, November 26, with a delivery window of 1pm to 5pm. " +
      "The order was placed on November 20. " +
      "If nobody is home, the driver will leave it in a safe place.\n\n" +
      "Swiftbox Couriers",
    expected: [{ kind: "event", value: "2026-11-26" }],
  },
  {
    id: "h-order-shipped",
    name: "Your order has shipped.email",
    mime: EMAIL,
    from: "Pinecone Outfitters",
    writtenAt: Date.UTC(2026, 11, 1, 16),
    mailKind: "delivery",
    text:
      "Hi Ellis,\n\n" +
      "We packed your order today and handed it to the carrier. " +
      "Estimated delivery: Tue 8 Dec 2026. " +
      "You will get another message when it is out for delivery. " +
      "Your order total of $73.90 was charged when you checked out on 29 November.\n\n" +
      "Pinecone Outfitters",
    expected: [{ kind: "event", value: "2026-12-08" }],
  },
  // No year: Friday, February 12 after 2 Feb 2027 is 2027.
  {
    id: "h-delivery-delayed",
    name: "A delay with your delivery.email",
    mime: EMAIL,
    from: "Swiftbox Couriers",
    writtenAt: Date.UTC(2027, 1, 2, 9),
    mailKind: "delivery",
    text:
      "We are sorry, but a storm closed our regional depot and your delivery has been delayed. " +
      "New expected delivery: Friday, February 12. " +
      "You do not need to do anything. " +
      "Your parcel left the sender on January 29.",
    expected: [{ kind: "event", value: "2027-02-12" }],
  },
  {
    id: "h-locker-pickup",
    name: "Your parcel is waiting in a locker.email",
    mime: EMAIL,
    from: "Hollis Parcel Lockers",
    writtenAt: Date.UTC(2027, 2, 22, 13),
    mailKind: "delivery",
    text:
      "Hello,\n\n" +
      "A parcel is waiting for you in locker 14 at the Elm Street station. " +
      "Please collect it by 29 March 2027, after which it goes back to the sender. " +
      "Use the code in the app to open the door.\n\n" +
      "Hollis Parcel Lockers",
    expected: [{ kind: "due", value: "2027-03-29" }],
  },
  {
    id: "h-sofa-delivery",
    name: "Delivery of your sofa.email",
    mime: EMAIL,
    from: "Alder & Oak Furniture",
    writtenAt: Date.UTC(2027, 3, 5, 10),
    mailKind: "delivery",
    text:
      "Dear Mr. Okafor,\n\n" +
      "Your three-seat sofa is scheduled for delivery on 17 April 2027. " +
      "Your delivery slot starts at 9:30 AM, and two people will carry it in. " +
      "You ordered it on 14 March 2027. " +
      "Please make sure the doorway and stairs are clear.\n\n" +
      "Alder & Oak Furniture",
    expected: [{ kind: "event", value: "2027-04-17", time: "09:30" }],
  },
  {
    id: "h-parcel-duty-notice",
    name: "parcel-held-notice.pdf",
    mime: "application/pdf",
    text:
      "Marlow Postal Depot\n" +
      "NOTICE: PARCEL HELD\n\n" +
      "Your parcel has been held at this depot since 2 June 2027 pending payment of import duty.\n" +
      "Duty payable: GBP 18.40\n" +
      "Pay by 16 June 2027 or the parcel will be returned to the sender.",
    expected: [
      { kind: "due", value: "2027-06-16" },
      { kind: "amount", value: "18.40" },
    ],
  },

  // ---- Travel in plain words (7) ----
  {
    id: "h-flight-lisbon",
    name: "Your trip to Lisbon.email",
    mime: EMAIL,
    from: "Skyward Air",
    writtenAt: Date.UTC(2027, 2, 1, 9),
    mailKind: "booking",
    text:
      "Hello Rosa,\n\n" +
      "You are flying with us soon. Flight SW 212 leaves SFO on Friday 19 March 2027 at 21:40 " +
      "and lands in LIS on Saturday 20 March at 16:25. " +
      "Please be at the airport three hours before departure. " +
      "We hope you have a smooth journey.\n\n" +
      "Skyward Air",
    expected: [
      { kind: "event", value: "2027-03-19", time: "21:40", role: "depart" },
      { kind: "event", value: "2027-03-20", time: "16:25", role: "arrive" },
    ],
  },
  {
    id: "h-train-fare",
    name: "Your train booking.email",
    mime: EMAIL,
    from: "Linden Rail",
    writtenAt: Date.UTC(2027, 4, 17, 12),
    mailKind: "booking",
    text:
      "Thank you for booking with Linden Rail.\n\n" +
      "Your train leaves Gareth Central at 08:12 on 3 June 2027 and reaches Linden Park at 10:47. " +
      "Seat 31, coach C. " +
      "Total fare: 52.00 USD. " +
      "Your ticket was issued today, so there is nothing to print.",
    expected: [
      { kind: "event", value: "2027-06-03", time: "08:12", role: "depart" },
      { kind: "event", value: "2027-06-03", time: "10:47", role: "arrive" },
      { kind: "amount", value: "52.00" },
    ],
  },
  // No year: Saturday, June 19 after 7 June 2027 is 2027. Arrival not stated.
  {
    id: "h-coach-trip",
    name: "Bus trip details.email",
    mime: EMAIL,
    from: "Coastline Coaches",
    writtenAt: Date.UTC(2027, 5, 7, 18),
    mailKind: "booking",
    text:
      "Hi Dev,\n\n" +
      "Your coach to the coast departs on Saturday, June 19 at 7:05 AM from Bay 4 of the central bus station. " +
      "Please arrive fifteen minutes early. " +
      "Bags go under the coach; keep valuables with you.\n\n" +
      "Coastline Coaches",
    expected: [{ kind: "event", value: "2027-06-19", time: "07:05", role: "depart" }],
  },
  // The return trip states no arrival time, so no arrival is expected for it.
  {
    id: "h-ferry-sailings",
    name: "Your ferry crossing.email",
    mime: EMAIL,
    from: "Isle Passage Ferries",
    writtenAt: Date.UTC(2027, 3, 12, 11),
    mailKind: "booking",
    text:
      "Dear passenger,\n\n" +
      "Your booking is confirmed.\n" +
      "Outbound: sails 24 April 2027 at 10:30, arrives 12:15.\n" +
      "Return: sails 1 May 2027 at 17:00.\n" +
      "Foot passengers should check in 30 minutes before sailing.\n" +
      "Total paid: €86,00. Booked on 12 April 2027.",
    expected: [
      { kind: "event", value: "2027-04-24", time: "10:30", role: "depart" },
      { kind: "event", value: "2027-04-24", time: "12:15", role: "arrive" },
      { kind: "event", value: "2027-05-01", time: "17:00", role: "depart" },
      { kind: "amount", value: "86.00" },
    ],
  },
  // Informal guesthouse note: "from 3pm" is the check-in time; "by 11am" the check-out time.
  {
    id: "h-guesthouse-welcome",
    name: "We are looking forward to seeing you.email",
    mime: EMAIL,
    from: "Casa Azulejo",
    writtenAt: Date.UTC(2027, 1, 22, 17),
    mailKind: "booking",
    text:
      "Hi Sam!\n\n" +
      "We are so happy you are staying with us. You arrive on Friday 12 March and leave on Monday 15 March. " +
      "Check-in is from 3pm, and please check out by 11am on your last day. " +
      "Breakfast is on the terrace if the weather is kind. " +
      "Ring the blue bell when you arrive.\n\n" +
      "Marta at Casa Azulejo",
    expected: [
      { kind: "event", value: "2027-03-12", time: "15:00", role: "check-in" },
      { kind: "event", value: "2027-03-15", time: "11:00", role: "check-out" },
    ],
  },
  {
    id: "h-hotel-verdant",
    name: "hotel-verdant-confirmation.pdf",
    mime: "application/pdf",
    text:
      "HOTEL VERDANT\n" +
      "Reservation Confirmation\n\n" +
      "Arrival: 2027-08-09\n" +
      "Departure: 2027-08-12\n" +
      "Check-in after 14:00. Check-out before 11:00.\n" +
      "Rate: $180.00 per night, 3 nights\n" +
      "Total including tax: $540.00\n" +
      "Reservation made on 2 July 2027.",
    expected: [
      { kind: "event", value: "2027-08-09", time: "14:00", role: "check-in" },
      { kind: "event", value: "2027-08-12", time: "11:00", role: "check-out" },
      { kind: "amount", value: "540.00" },
    ],
  },
  // Pick-up is an ordinary event; "by 16:00" on the drop-off day is a return-by deadline.
  {
    id: "h-car-hire-voucher",
    name: "car-hire-voucher.pdf",
    mime: "application/pdf",
    text:
      "DUNMORE RENTALS\n" +
      "Car Hire Voucher\n\n" +
      "Pick-up: 11 September 2027 at 10:00, Terminal 2 desk\n" +
      "Return: 18 September 2027 by 16:00\n" +
      "Vehicle: compact, automatic\n" +
      "Total prepaid: USD 412.30\n\n" +
      "Show this voucher and your driving licence at the desk.",
    expected: [
      { kind: "event", value: "2027-09-11", time: "10:00" },
      { kind: "due", value: "2027-09-18", time: "16:00" },
      { kind: "amount", value: "412.30" },
    ],
  },

  // ---- Events (6) ----
  // No year: Saturday, January 23 after 14 Dec 2026 is 2027. Doors time left out on purpose.
  {
    id: "h-concert-tickets",
    name: "Your tickets for the Saturday show.email",
    mime: EMAIL,
    from: "Foxglove Hall",
    writtenAt: Date.UTC(2026, 11, 14, 19),
    mailKind: "booking",
    text:
      "Thanks for your order!\n\n" +
      "You have two tickets for the Juniper Quartet on Saturday, January 23. The show starts at 8pm. " +
      "Total charged: $128.00 (tickets $116.00, service fee $12.00). " +
      "Tickets can be shown on your phone at the door.\n\n" +
      "Foxglove Hall box office",
    expected: [
      { kind: "event", value: "2027-01-23", time: "20:00" },
      { kind: "amount", value: "128.00" },
    ],
  },
  {
    id: "h-pottery-class",
    name: "Welcome to Beginner Pottery.email",
    mime: EMAIL,
    from: "Kiln & Co Studio",
    writtenAt: Date.UTC(2027, 0, 25, 10),
    mailKind: "booking",
    text:
      "Hello Annika,\n\n" +
      "We are excited to have you in the six-week beginner class. " +
      "The first session is on Tuesday, February 9 at 6:30 PM, and the group meets weekly after that. " +
      "Wear clothes you do not mind getting muddy. " +
      "Course fee paid: $210.00.\n\n" +
      "Kiln & Co Studio",
    expected: [
      { kind: "event", value: "2027-02-09", time: "18:30" },
      { kind: "amount", value: "210.00" },
    ],
  },
  {
    id: "h-wedding-invitation",
    name: "Save the date and RSVP.email",
    mime: EMAIL,
    from: "Elena Marsh",
    writtenAt: Date.UTC(2027, 3, 5, 20),
    mailKind: "personal",
    text:
      "Dear Hana,\n\n" +
      "Tomas and I are getting married on Saturday 5 June 2027 at 4pm at the Old Orchard, and we would love you to be there. " +
      "Dinner and dancing follow. " +
      "Please reply by 1 May 2027 so we can plan the seating. " +
      "We met in 2019 and cannot wait to celebrate.\n\n" +
      "With love, Elena",
    expected: [
      { kind: "event", value: "2027-06-05", time: "16:00" },
      { kind: "due", value: "2027-05-01" },
    ],
  },
  {
    id: "h-conference-registration",
    name: "Registration confirmed for NorthBeam Summit.email",
    mime: EMAIL,
    from: "NorthBeam Summit",
    writtenAt: Date.UTC(2027, 5, 14, 14),
    mailKind: "booking",
    text:
      "You are registered!\n\n" +
      "NorthBeam Summit takes place on 21 October 2027 at Harbor Convention Hall. Doors open at 9:00 AM. " +
      "Registration fee: $495.00 (an early-bird discount of $50.00 has already been applied). " +
      "Your badge will be waiting at the front desk.\n\n" +
      "NorthBeam Summit organisers",
    expected: [
      { kind: "event", value: "2027-10-21", time: "09:00" },
      { kind: "amount", value: "495.00" },
    ],
  },
  // No year: Sunday, April 11 after 15 Feb 2027 is 2027.
  {
    id: "h-match-day",
    name: "Home match this April.email",
    mime: EMAIL,
    from: "Riverbend FC",
    writtenAt: Date.UTC(2027, 1, 15, 12),
    mailKind: "booking",
    text:
      "Dear season ticket holder,\n\n" +
      "Mark your diary: our home match against Harlow United is on Sunday, April 11, with kick-off at 3pm. " +
      "Gates open ninety minutes before. " +
      "Your season ticket has been valid since 2025 and works at the usual turnstile.\n\n" +
      "Riverbend FC ticket office",
    expected: [{ kind: "event", value: "2027-04-11", time: "15:00" }],
  },
  {
    id: "h-residents-meeting",
    name: "residents-association-notice.pdf",
    mime: "application/pdf",
    text:
      "OAKFIELD RESIDENTS' ASSOCIATION\n" +
      "Notice of Annual Meeting\n\n" +
      "Date: Wednesday, 17 November 2027\n" +
      "Time: 7:30 PM\n" +
      "Place: Oakfield Community Hall\n" +
      "Agenda: treasurer's report, park repairs, election of officers.\n" +
      "Last year's meeting was held on 18 November 2026.",
    expected: [{ kind: "event", value: "2027-11-17", time: "19:30" }],
  },

  // ---- Deadlines (5) ----
  {
    id: "h-return-window",
    name: "How to return your order.email",
    mime: EMAIL,
    from: "Pinecone Outfitters",
    writtenAt: Date.UTC(2027, 0, 4, 9),
    mailKind: "delivery",
    text:
      "Hi Ellis,\n\n" +
      "We hope you like your new jacket. If it is not right, you can send it back unworn with the tags on. " +
      "Items must be returned by 28 January 2027 to be eligible for a refund. " +
      "Your order was placed on 20 December 2026 and arrived today.\n\n" +
      "Pinecone Outfitters customer care",
    expected: [{ kind: "due", value: "2027-01-28" }],
  },
  {
    id: "h-workshop-reply",
    name: "Please confirm your seat.email",
    mime: EMAIL,
    from: "Aldous Reed",
    writtenAt: Date.UTC(2027, 2, 8, 9),
    mailKind: "other",
    text:
      "Dear colleague,\n\n" +
      "I am holding a seat for you at the spring workshop on archival methods. " +
      "Please reply by Friday, March 12 to confirm, as there is a waiting list. " +
      "I look forward to hearing from you.\n\n" +
      "Best wishes,\nAldous Reed",
    expected: [{ kind: "due", value: "2027-03-12" }],
  },
  {
    id: "h-scholarship-closing",
    name: "Scholarship applications close soon.email",
    mime: EMAIL,
    from: "Fernhill Scholarship Fund",
    writtenAt: Date.UTC(2027, 1, 1, 8),
    mailKind: "other",
    text:
      "Hello,\n\n" +
      "This is a reminder that applications for the Fernhill Scholarship close on 15 March 2027 at 11:59 PM. " +
      "Awards of up to $5,000 are made each year. " +
      "Late applications cannot be accepted. " +
      "The fund was founded in 1998.\n\n" +
      "Fernhill Scholarship Fund",
    expected: [{ kind: "due", value: "2027-03-15", time: "23:59" }],
  },
  {
    id: "h-library-loans",
    name: "Items due back soon.email",
    mime: EMAIL,
    from: "Millbrook Public Library",
    writtenAt: Date.UTC(2027, 4, 24, 7),
    mailKind: "other",
    text:
      "Dear reader,\n\n" +
      "The following items are due back on 14 June 2027: \"The Salt Road\" and \"Notes on Bread\". " +
      "You can renew them online if no one is waiting. " +
      "Overdue items cost $0.25 per day. " +
      "You borrowed them on 24 May 2027.\n\n" +
      "Millbrook Public Library",
    expected: [{ kind: "due", value: "2027-06-14" }],
  },
  {
    id: "h-permit-form",
    name: "parking-permit-renewal-form.pdf",
    mime: "application/pdf",
    text:
      "CITY PERMITS OFFICE\n" +
      "Parking Permit Renewal Form (version 2026)\n\n" +
      "Completed forms must be handed in to the Permits Office by 30 April 2027.\n" +
      "Attach proof of address and a copy of your vehicle registration.\n" +
      "Office hours: Mon-Fri 9 to 4.",
    expected: [{ kind: "due", value: "2027-04-30" }],
  },

  // ---- Receipts (4) ----
  {
    id: "h-cafe-receipt",
    name: "Your receipt from Tiller Coffee.email",
    mime: EMAIL,
    from: "Tiller Coffee",
    writtenAt: Date.UTC(2027, 0, 19, 8),
    mailKind: "receipt",
    text:
      "Thanks for your purchase on 18 January 2027.\n\n" +
      "Oat latte and almond croissant\n" +
      "Subtotal: $11.00\n" +
      "Tax: $0.88\n" +
      "Total: $11.88\n\n" +
      "Paid by card. See you again soon.",
    expected: [{ kind: "amount", value: "11.88" }],
  },
  {
    id: "h-course-receipt",
    name: "Payment received.email",
    mime: EMAIL,
    from: "Brightpath Learning",
    writtenAt: Date.UTC(2027, 2, 3, 13),
    mailKind: "receipt",
    text:
      "Hello,\n\n" +
      "We received your payment on March 3, 2027. Amount paid: 84.20 USD, which includes VAT of 14.03 USD. " +
      "Your course access is active now and does not expire. " +
      "Keep this email as your receipt.\n\n" +
      "Brightpath Learning",
    expected: [{ kind: "amount", value: "84.20" }],
  },
  {
    id: "h-hardware-receipt",
    name: "hardware-store-receipt.pdf",
    mime: "application/pdf",
    text:
      "ASHFORD HARDWARE\n" +
      "Receipt\n" +
      "2027-02-20 14:12\n\n" +
      "Claw hammer 18.50\n" +
      "Box of screws 7.80\n" +
      "Paint roller set 16.00\n" +
      "Subtotal 42.30\n" +
      "Tax 3.38\n" +
      "Total 45.68\n\n" +
      "Thank you for shopping with us.",
    expected: [{ kind: "amount", value: "45.68" }],
  },
  {
    id: "h-restaurant-receipt",
    name: "restaurant-bill.pdf",
    mime: "application/pdf",
    text:
      "Osteria Fennel\n" +
      "Date: 14/05/2027\n" +
      "Table 6\n" +
      "Food and drink €58,00\n" +
      "Service €6,00\n" +
      "Total paid €64,00\n\n" +
      "Grazie e a presto.",
    expected: [{ kind: "amount", value: "64.00" }],
  },

  // ---- States nothing for the reader (12) ----
  {
    id: "h-garden-newsletter",
    name: "Spring planting tips.email",
    mime: EMAIL,
    from: "Greenleaf Gardening Weekly",
    writtenAt: Date.UTC(2027, 2, 1, 7),
    mailKind: "newsletter",
    text:
      "This week in Greenleaf:\n\n" +
      "Start your tomato seeds indoors, choose compost with care, and learn why mulch matters. " +
      "Readers have asked about slugs again, so we answer that too. " +
      "You are receiving this because you subscribed in 2024.\n\n" +
      "Copyright 2027 Greenleaf Gardening Weekly. Unsubscribe at any time.",
    expected: [],
  },
  {
    id: "h-spring-sale-ad",
    name: "Our biggest spring sale.email",
    mime: EMAIL,
    from: "Pinecone Outfitters",
    writtenAt: Date.UTC(2027, 2, 15, 8),
    mailKind: "newsletter",
    text:
      "SPRING SALE!\n\n" +
      "The Spring Sale runs from 20 March to 28 March 2027. Take 30% off jackets, boots and packs, with free shipping over $50.00. " +
      "Stock is limited, so shop early.\n\n" +
      "You can opt out of marketing messages at any time.",
    expected: [],
  },
  {
    id: "h-friend-note",
    name: "Thinking of you.email",
    mime: EMAIL,
    from: "Dana",
    writtenAt: Date.UTC(2027, 1, 2, 21),
    mailKind: "personal",
    text:
      "Hey you,\n\n" +
      "I saw a film last weekend that reminded me of our road trip in 2019 and I laughed all the way home. " +
      "We should catch up properly sometime soon, maybe over a long dinner. " +
      "Tell me how the new job is going.\n\n" +
      "Love, Dana",
    expected: [],
  },
  {
    id: "h-password-reset",
    name: "Reset your password.email",
    mime: EMAIL,
    from: "Quillhost Accounts",
    writtenAt: Date.UTC(2027, 4, 10, 9),
    mailKind: "other",
    text:
      "Hello,\n\n" +
      "We received a request on 2027-05-10 to reset the password for your account. " +
      "Use the button below within 30 minutes to choose a new one. " +
      "If you did not ask for this, you can safely ignore this message.\n\n" +
      "Quillhost Accounts",
    expected: [],
  },
  // Codes that look like dates are batch and route codes, not dates.
  {
    id: "h-shipping-label",
    name: "shipping-label.pdf",
    mime: "application/pdf",
    text:
      "SHIP TO: R. Okonkwo, 22 Birch Row\n" +
      "Tracking: 2027-0412-8830-1155\n" +
      "Batch 20270412 | Lot 12/03/27\n" +
      "Route code 1503-2027\n" +
      "Weight 1.2 kg | Zone C\n" +
      "Handle with care",
    expected: [],
  },
  {
    id: "h-forum-digest",
    name: "Your weekly digest.email",
    mime: EMAIL,
    from: "Hobbyists Forum",
    writtenAt: Date.UTC(2027, 0, 11, 6),
    mailKind: "newsletter",
    text:
      "Top threads this week:\n\n" +
      "1. Best glue for balsa wood (42 replies)\n" +
      "2. Show us your workbench (31 replies)\n" +
      "3. A lathe question, started 5 January (18 replies)\n\n" +
      "You joined the forum in 2020. Change how often you get this digest in your settings.",
    expected: [],
  },
  {
    id: "h-privacy-update",
    name: "We have updated our privacy policy.email",
    mime: EMAIL,
    from: "Lumen Stream",
    writtenAt: Date.UTC(2027, 4, 3, 10),
    mailKind: "other",
    text:
      "Hello,\n\n" +
      "We have made our privacy policy easier to read and added more detail about how long we keep viewing history. " +
      "You do not need to take any action. The full text is in your account settings.\n\n" +
      "Copyright 2027 Lumen Stream.",
    expected: [],
  },
  {
    id: "h-survey-invite",
    name: "Tell us how we are doing.email",
    mime: EMAIL,
    from: "Millbrook Public Library",
    writtenAt: Date.UTC(2027, 5, 7, 12),
    mailKind: "other",
    text:
      "Dear reader,\n\n" +
      "We would value your opinion. Our three-minute survey asks about opening hours, the book collection and the study rooms. " +
      "Your answers are anonymous and help us plan.\n\n" +
      "Thank you,\nMillbrook Public Library",
    expected: [],
  },
  {
    id: "h-thank-you-note",
    name: "Thank you for the scarf.email",
    mime: EMAIL,
    from: "Aunt Priya",
    writtenAt: Date.UTC(2026, 11, 28, 18),
    mailKind: "personal",
    text:
      "Dearest Nina,\n\n" +
      "Thank you so much for the lovely blue scarf. It was the best gift I unwrapped on Christmas Day, and I have worn it every morning since. " +
      "It was so good to see you all. Give the little ones a hug from me.\n\n" +
      "Love always, Priya",
    expected: [],
  },
  {
    id: "h-job-advert",
    name: "New role: community coordinator.email",
    mime: EMAIL,
    from: "Tallis Careers",
    writtenAt: Date.UTC(2027, 0, 12, 9),
    mailKind: "newsletter",
    text:
      "A job you might like:\n\n" +
      "Community Coordinator at Oakfield Arts Trust. Salary range $60,000 to $70,000. " +
      "You will run workshops, manage volunteers and speak for the Trust in the neighbourhood. " +
      "Applications are reviewed on a rolling basis. Posted 2027-01-12.\n\n" +
      "Tallis Careers job alerts",
    expected: [],
  },
  {
    id: "h-lemon-bread-recipe",
    name: "lemon-bread-recipe.pdf",
    mime: "application/pdf",
    text:
      "LEMON LOAF\n" +
      "Serves 8. Prep 15 minutes.\n\n" +
      "Mix 200 g flour, 150 g sugar and the zest of two lemons. Stir in 120 ml milk, 2 eggs and 90 g melted butter. " +
      "Bake at 180 C for 50 minutes. Rest for 10 minutes before turning out.\n" +
      "Adapted from a family recipe, 1987.",
    expected: [],
  },
  {
    id: "h-board-minutes",
    name: "board-meeting-minutes.pdf",
    mime: "application/pdf",
    text:
      "FERNWOOD STUDIO BOARD\n" +
      "Minutes of the meeting held on 10 November 2026\n\n" +
      "Present: A. Lund, K. Sato, R. Mbeki.\n" +
      "1. The previous minutes were approved.\n" +
      "2. The treasurer reported a surplus of $3,210.00 for the quarter.\n" +
      "3. The board agreed to repaint the studio.\n" +
      "Minutes recorded by K. Sato.",
    expected: [],
  },
];
