/**
 * Development cases for dates that are not the reader's own business (an
 * offer inside a booking, a record of what already happened, a list of
 * public events) beside dates that are, and for days that hold more than
 * one clock. Part of the first eval set: the readers' rules and the model's
 * instructions are written against it.
 */

import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

export const PROMPT_CASES: readonly EvalCase[] = [
  // p-01: a dental appointment beside a whitening offer and a flu clinic's open days.
  {
    id: "p-01",
    name: "Your appointment on 14 January.email",
    mime: EMAIL,
    from: "Example Dental Practice",
    writtenAt: Date.UTC(2026, 11, 10, 9),
    mailKind: "booking",
    text: `Dear Priya,

This confirms your check-up with Dr Ada.

Thursday 14 January 2027 at 09:30
Example Dental Practice, 2nd floor

Treat yourself: 20% off whitening until 31 January 2027.
Our flu clinic is open until 26 February 2027, no booking needed.

Please bring your insurance card.

Kind regards,
Reception`,
    expected: [{ kind: "event", value: "2027-01-14", time: "09:30" }],
  },
  // p-02: a physiotherapy visit; the free-cancellation day and a possible fee are not events.
  {
    id: "p-02",
    name: "Physiotherapy appointment confirmed.email",
    mime: EMAIL,
    from: "Example Physio Clinic",
    writtenAt: Date.UTC(2026, 11, 16, 11),
    mailKind: "booking",
    text: `Hello Sam,

Your physiotherapy appointment is booked.

Date: Wednesday 13 January 2027
Time: 16:20
With: Jo, Room 3

You can cancel free of charge until 11 January 2027.
A missed-visit fee of GBP 25.00 applies after that.

Wear loose clothing, please.

Example Physio Clinic`,
    expected: [{ kind: "event", value: "2027-01-13", time: "16:20" }],
  },
  // p-03: minutes of a meeting that already took place; nothing is still to come.
  {
    id: "p-03",
    name: "residents-minutes-january.pdf",
    mime: "application/pdf",
    text: `Example Gardens Residents' Association
Minutes of the general meeting held on 12 January 2027

Present: Anna (chair), Tom, Ruth, Dev and nine residents.

The meeting opened at 19:00 and closed at 20:40.

1. The minutes of the last meeting (held 10 November 2026) were approved.
2. The bin store repairs were discussed and a quote was accepted.
3. The hedge along the east path was reported as trimmed.
4. The treasurer reported a balance in line with the budget.

Signed as a true record.`,
    expected: [],
  },
  // p-04: a town's list of public events; the reader has no place at any of them.
  {
    id: "p-04",
    name: "Example Town: what's on in December.email",
    mime: EMAIL,
    from: "Example Town Council",
    writtenAt: Date.UTC(2026, 11, 1, 8),
    mailKind: "newsletter",
    text: `What's on in Example Town

Christmas market: Saturday 12 December 2026 at 11:00, Market Square.
Carols on the green: Sunday 13 December 2026 at 15:30.
Lantern walk: Friday 18 December 2026 at 17:00 from the library.
Pantomime for all ages: Tuesday 22 December 2026 at 14:00, Town Hall.

Enter the prize draw by 16 December 2026 for a chance to win a hamper.

All events are free and open to the public.

Example Town Council, Communications`,
    expected: [],
  },
  // p-05: a music night ticket; the doors and the curfew are not the event time.
  {
    id: "p-05",
    name: "Your ticket for Example Quartet.email",
    mime: EMAIL,
    from: "Riverside Hall Example",
    writtenAt: Date.UTC(2027, 0, 12, 14),
    mailKind: "booking",
    text: `Your ticket is confirmed, Sam.

Example Quartet, a night of music
Saturday 13 February 2027
Riverside Hall Example, seat B14

Doors 7:00 pm
Music from 8:00 pm
Curfew 11:00 pm

Please have this mail ready at the door.`,
    expected: [{ kind: "event", value: "2027-02-13", time: "20:00" }],
  },
  // p-06: an eye test; the clinic's opening hours are not events.
  {
    id: "p-06",
    name: "Eye test booking.email",
    mime: EMAIL,
    from: "Example Opticians",
    writtenAt: Date.UTC(2027, 0, 12, 10),
    mailKind: "booking",
    text: `Dear Priya,

Your eye test is booked for Tuesday 9 February 2027 at 10:15.

The clinic is open 08:00 to 18:00, Monday to Friday.
Please arrive 10 minutes early.

If you wear contact lenses, bring your glasses too.

See you soon,
The team at Example Opticians`,
    expected: [{ kind: "event", value: "2027-02-09", time: "10:15" }],
  },
  // p-07: a notice of a new price; nothing to do and nothing to pay now.
  {
    id: "p-07",
    name: "A change to your plan.email",
    mime: EMAIL,
    from: "Example Streaming",
    writtenAt: Date.UTC(2027, 0, 26, 7),
    mailKind: "other",
    text: `Hi Sam,

We are writing to tell you about a change to your plan.

From 1 March 2027 your plan costs GBP 14.99 a month (it was GBP 12.99).

You do not need to do anything. Your plan carries on as before.

You can read more about our prices on our help pages.

The Example Streaming team`,
    expected: [],
  },
  // p-08: a gym record of past visits; only the end of the membership still lies ahead.
  {
    id: "p-08",
    name: "gym-membership-record.pdf",
    mime: "application/pdf",
    text: `Example Fitness Club
Member record for Priya

Recent visits (date, time in, time out)
12 January 2027  07:05  08:00
19 January 2027  18:10  19:20
2 February 2027  07:00  07:50
23 February 2027  18:30  19:30
9 March 2027  07:15  08:10
23 March 2027  18:00  19:05

Your membership ends on 30 June 2027.`,
    expected: [{ kind: "expiry", value: "2027-06-30" }],
  },
  // p-09: a training day with a workshop and a dinner, both on the one printed date.
  {
    id: "p-09",
    name: "Your training day.email",
    mime: EMAIL,
    from: "Example Learning Group",
    writtenAt: Date.UTC(2027, 1, 9, 13),
    mailKind: "booking",
    text: `Hello Sam,

Thank you for booking. Here is your day.

Thursday 11 March 2027

Your workshop: 10:00, Room 2
Course dinner: 19:30 at Example Bistro (your place is reserved)

Lunch is provided between sessions.
Please tell us about any dietary needs before the day.

Example Learning Group`,
    expected: [
      { kind: "event", value: "2027-03-11", time: "10:00" },
      { kind: "event", value: "2027-03-11", time: "19:30" },
    ],
  },
  // p-10: a coach trip told in sentences, with a journey out and a journey back.
  {
    id: "p-10",
    name: "Your coach trip to Example City.email",
    mime: EMAIL,
    from: "Example Coaches",
    writtenAt: Date.UTC(2027, 3, 6, 9),
    mailKind: "booking",
    text: `Dear Priya,

Thank you for booking your coach trip to Example City.

On Friday 7 May 2027 your coach leaves Example Town at 07:40 and arrives at Example City at 09:55.

For the way back, on Monday 10 May 2027 the coach leaves Example City at 18:20 and arrives at Example Town at 20:35.

Please be at the stop 15 minutes before it leaves.

Safe travels,
Example Coaches`,
    expected: [
      { kind: "event", value: "2027-05-07", time: "07:40", role: "depart" },
      { kind: "event", value: "2027-05-07", time: "09:55", role: "arrive" },
      { kind: "event", value: "2027-05-10", time: "18:20", role: "depart" },
      { kind: "event", value: "2027-05-10", time: "20:35", role: "arrive" },
    ],
  },
  // p-11: minutes of a meeting already held, with the next meeting named at the end.
  {
    id: "p-11",
    name: "committee-minutes-march.pdf",
    mime: "application/pdf",
    text: `Example Gardening Club
Committee meeting held on 9 March 2027

Present: Mary (chair), Ivan, Lena, Kofi.

The meeting opened at 19:30 and closed at 21:00.

1. Apologies were received from two members.
2. The seed order was agreed.
3. The summer show schedule was reviewed.
4. The treasurer reported the bank balance.

Next meeting: Tuesday 13 April 2027 at 19:00, Example Hall.`,
    expected: [{ kind: "event", value: "2027-04-13", time: "19:00" }],
  },
  // p-12: a club's news with a public talk and a kit sale beside the reader's own course.
  {
    id: "p-12",
    name: "Example Sports Club news for January.email",
    mime: EMAIL,
    from: "Example Sports Club",
    writtenAt: Date.UTC(2027, 0, 19, 8),
    mailKind: "other",
    text: `Hi Priya,

Here is what is happening at the club this month.

Our public talk series on sports nutrition opens on 4 February 2027 in the main hall.

You are booked on the beginners' course: Saturday 20 February 2027 at 10:00.

The kit sale ends on 14 February 2027, with up to half off club shirts.

The pool is closed for cleaning on the first Monday of each month.

Thanks for being part of the club,
Example Sports Club`,
    expected: [{ kind: "event", value: "2027-02-20", time: "10:00" }],
  },
  // p-13: a friend's invitation that reads like a public notice; the reply day has no year.
  {
    id: "p-13",
    name: "Come to our studio opening.email",
    mime: EMAIL,
    from: "Mira",
    writtenAt: Date.UTC(2027, 3, 12, 18),
    mailKind: "personal",
    text: `Dear Sam,

Everyone is welcome!

Join us for the opening of our new studio on Friday 14 May 2027 from 6 pm.
There will be food, music and a first look at the work on the walls.

We would love to see you there. Please reply by 30 April so we know numbers.

Warmly,
Mira and Dan`,
    expected: [
      { kind: "event", value: "2027-05-14", time: "18:00" },
      { kind: "due", value: "2027-04-30" },
    ],
  },
  // p-14: an energy bill in sentences: the period and the letter day are not events.
  {
    id: "p-14",
    name: "energy-bill-december.pdf",
    mime: "application/pdf",
    text: `Example Energy
4 January 2027

Dear Sam,

This letter is about your gas and electricity for the period from 1 December 2026 to 31 December 2026.

Over that time you used 312 units, and the total comes to £64.10.

We need your payment by 25 January 2027. You can pay by card online or by bank transfer, and we will send a receipt once it arrives.

Thank you for choosing Example Energy.`,
    expected: [
      { kind: "due", value: "2027-01-25" },
      { kind: "amount", value: "64.10" },
    ],
  },
  // p-15: a guesthouse stay in sentences, with reception hours that are not events.
  {
    id: "p-15",
    name: "Your stay at Example Guesthouse.email",
    mime: EMAIL,
    from: "Example Guesthouse",
    writtenAt: Date.UTC(2027, 1, 15, 12),
    mailKind: "booking",
    text: `Dear Priya,

We look forward to welcoming you to Example Guesthouse.

Check-in is from 15:00 on Friday 19 March 2027; the reception desk is staffed until 22:00. Check-out is by 11:00 on Sunday 21 March 2027.

Breakfast is served in the garden room each morning.
Parking is free for guests.

If you plan to arrive late, please let us know.

Best wishes,
Example Guesthouse`,
    expected: [
      { kind: "event", value: "2027-03-19", time: "15:00", role: "check-in" },
      { kind: "event", value: "2027-03-21", time: "11:00", role: "check-out" },
    ],
  },
  // p-16: a membership renewal with a charge day, beside an upgrade offer.
  {
    id: "p-16",
    name: "Your membership renewal.email",
    mime: EMAIL,
    from: "Example Plus",
    writtenAt: Date.UTC(2027, 0, 6, 10),
    mailKind: "bill",
    text: `Hi Sam,

Your Example Plus membership renews on 3 February 2027 and we will charge GBP 79.00 to your card.

You do not need to do anything to keep your benefits.

Upgrade to Family before 31 January 2027 and save 20%.

You can change your card details in your account at any time.

Thanks,
Example Plus`,
    expected: [
      { kind: "due", value: "2027-02-03" },
      { kind: "amount", value: "79.00" },
    ],
  },
];
