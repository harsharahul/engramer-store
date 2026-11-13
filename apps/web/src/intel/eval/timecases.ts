/**
 * Development cases for time language: clocks written in many ways, ranges
 * of hours, a show's doors beside its start, a clock on the line under its
 * date, and days said in words in mail. Part of the first eval set: the
 * readers' rules are written against it.
 */

import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

export const TIME_CASES: readonly EvalCase[] = [
  // t-01: the booking day and the box office hours are not events.
  {
    id: "t-01",
    name: "Your tickets for Example Quartet.email",
    mime: EMAIL,
    from: "Harbour Theatre Example",
    writtenAt: Date.UTC(2026, 10, 2, 9),
    mailKind: "booking",
    text: `Your tickets are confirmed. Booking REF-48213, made on 2 November 2026.

Example Quartet in concert
Saturday 14 November 2026
Doors: 7:00 PM
Show starts: 8:00 PM

Box office open 10:00 to 16:00 on weekdays.`,
    expected: [{ kind: "event", value: "2026-11-14", time: "20:00" }],
  },
  // t-02: the order day and the bar closing hint are not events.
  {
    id: "t-02",
    name: "Order confirmation Lantern Players.email",
    mime: EMAIL,
    from: "Lantern Players Example",
    writtenAt: Date.UTC(2026, 10, 3, 10),
    mailKind: "booking",
    text: `Thank you for your order of 3 November 2026.

The Lantern Players present A Winter Example
Friday 20 November 2026, doors 7pm, show 8pm.

The bar stays open until 11:30 after the show.`,
    expected: [{ kind: "event", value: "2026-11-20", time: "20:00" }],
  },
  // t-03: the doors time and the print day are not the event.
  {
    id: "t-03",
    name: "ticket-hall-example.pdf",
    mime: "application/pdf",
    text: `ADMIT TWO
Palace Hall Example
Saturday 21 November 2026
Doors open 18:45
Curtain up 19:30
Seats A12 and A13
Printed 9 November 2026`,
    expected: [{ kind: "event", value: "2026-11-21", time: "19:30" }],
  },
  // t-04: gates opening and the purchase day are not the match.
  {
    id: "t-04",
    name: "Match tickets Example United.email",
    mime: EMAIL,
    from: "Example United Tickets",
    writtenAt: Date.UTC(2026, 10, 5, 8),
    mailKind: "booking",
    text: `Your match ticket (bought 5 November 2026)

Example United v Sample Rovers
Sunday 22 November 2026
Kick-off: 3pm
Gates open at 1pm
Stand B, row 12`,
    expected: [{ kind: "event", value: "2026-11-22", time: "15:00" }],
  },
  // t-05: the early bird deadline text is not a calendar item.
  {
    id: "t-05",
    name: "Comedy night booking.email",
    mime: EMAIL,
    from: "Example Laughs Club",
    writtenAt: Date.UTC(2026, 10, 6, 11),
    mailKind: "booking",
    text: `You are booked in for Comedy Night at Example Laughs Club.

Thursday 3 December 2026
Doors: 6:30 PM
Show: 8:30 PM

Booked on 6 November 2026.`,
    expected: [{ kind: "event", value: "2026-12-03", time: "20:30" }],
  },
  // t-06: registration desk time is not the start of the talk.
  {
    id: "t-06",
    name: "Talk reminder Example Society.email",
    mime: EMAIL,
    from: "Example Society",
    writtenAt: Date.UTC(2026, 10, 9, 8),
    mailKind: "booking",
    text: `Reminder: Dr Sample speaks on Tide Tables at the Example Society.

Wednesday 25 November 2026
Registration from 17:30
Talk begins 18:00
Room 4, Annex Building`,
    expected: [{ kind: "event", value: "2026-11-25", time: "18:00" }],
  },
  // t-07: only doors are given, so the doors time is the event; the booking day is not.
  {
    id: "t-07",
    name: "Gig ticket Sample Brass Band.email",
    mime: EMAIL,
    from: "Brass Cellar Example",
    writtenAt: Date.UTC(2026, 10, 4, 9),
    mailKind: "booking",
    text: `Ticket confirmed (ordered 4 November 2026).

Sample Brass Band
Saturday 5 December 2026
Doors: 7:30 PM

No re-entry after 10:00 PM.`,
    expected: [{ kind: "event", value: "2026-12-05", time: "19:30" }],
  },
  // t-08: only doors are given; the cloakroom hours are not events.
  {
    id: "t-08",
    name: "club-night-entry-example.pdf",
    mime: "application/pdf",
    text: `Example Cellar Club
Entry pass, one person
Saturday 12 December 2026
Doors open 6pm
Cloakroom closes at 2am
Pass REF-77120, issued 1 December 2026`,
    expected: [{ kind: "event", value: "2026-12-12", time: "18:00" }],
  },
  // t-09: the order day is not an event.
  {
    id: "t-09",
    name: "Pottery class Example Studio.email",
    mime: EMAIL,
    from: "Example Clay Studio",
    writtenAt: Date.UTC(2026, 10, 9, 9),
    mailKind: "booking",
    text: `Your place is booked (order of 9 November 2026).

Beginners pottery
Wednesday 18 November 2026
7:00-9:00 PM
Bring an apron.`,
    expected: [{ kind: "event", value: "2026-11-18", time: "19:00" }],
  },
  // t-10: the office hours are not events.
  {
    id: "t-10",
    name: "Choir rehearsal notice.email",
    mime: EMAIL,
    from: "Example Community Choir",
    writtenAt: Date.UTC(2026, 10, 10, 8),
    mailKind: "other",
    text: `Hello singers,

Rehearsal this week is on Thursday 19 November 2026, 7-9pm, in the parish hall.
The office is open 9-5 on weekdays if you have questions.`,
    expected: [{ kind: "event", value: "2026-11-19", time: "19:00" }],
  },
  // t-11: the dispatch day is not the delivery.
  {
    id: "t-11",
    name: "Your parcel is on its way.email",
    mime: EMAIL,
    from: "Sample Parcels",
    writtenAt: Date.UTC(2026, 10, 12, 7),
    mailKind: "delivery",
    text: `Your parcel REF-90417 was dispatched on 12 November 2026.

Delivery day: Tuesday 17 November 2026
Delivery window: between 10:00 and 14:00

Someone must be home to sign.`,
    expected: [{ kind: "event", value: "2026-11-17", time: "10:00" }],
  },
  // t-12: the registration day is not an event.
  {
    id: "t-12",
    name: "Open morning Example School.email",
    mime: EMAIL,
    from: "Example Primary School",
    writtenAt: Date.UTC(2026, 10, 11, 9),
    mailKind: "other",
    text: `Thank you for registering on 11 November 2026.

Open morning: Tuesday 24 November 2026, 11am to 1pm.
Parking is available behind the sports hall.`,
    expected: [{ kind: "event", value: "2026-11-24", time: "11:00" }],
  },
  // t-13: the invoice-style reference is not a date.
  {
    id: "t-13",
    name: "workshop-programme-example.pdf",
    mime: "application/pdf",
    text: `Sample Skills Workshop
Programme ref REF-31550

Tuesday 1 December 2026
Workshop 14:00 to 17:30
Tea and coffee provided
Programme printed 20 November 2026`,
    expected: [{ kind: "event", value: "2026-12-01", time: "14:00" }],
  },
  // t-14: the sign-up day is not an event.
  {
    id: "t-14",
    name: "Yoga session booked.email",
    mime: EMAIL,
    from: "Example Yoga Room",
    writtenAt: Date.UTC(2026, 10, 9, 10),
    mailKind: "booking",
    text: `You signed up on 9 November 2026.

Morning flow
Friday 27 November 2026
9:30-11:00
Mats are provided.`,
    expected: [{ kind: "event", value: "2026-11-27", time: "09:30" }],
  },
  // t-15: the price 14.30 is not a clock; the booking day is not an event.
  {
    id: "t-15",
    name: "Lunch table booked.email",
    mime: EMAIL,
    from: "Garden Kitchen Example",
    writtenAt: Date.UTC(2026, 10, 10, 9),
    mailKind: "booking",
    text: `Table for two booked on 10 November 2026.

Thursday 26 November 2026 at noon
Lunch break menu: soup and bread.
Total: 14.30

Please arrive a few minutes early.`,
    expected: [{ kind: "event", value: "2026-11-26", time: "12:00" }],
  },
  // t-16: the reply-by remark is not a reminder; midday lunch is background.
  {
    id: "t-16",
    name: "Site visit Example Builders.email",
    mime: EMAIL,
    from: "Example Builders",
    writtenAt: Date.UTC(2026, 10, 11, 8),
    mailKind: "other",
    text: `Hello,

The site visit is on Wednesday 2 December 2026 at 9 o'clock sharp.
Lunch will be served at midday in the cabin.

Sent on 11 November 2026.`,
    expected: [{ kind: "event", value: "2026-12-02", time: "09:00" }],
  },
  // t-17: a promotion; the sale times are not events and 19.00 is a price.
  {
    id: "t-17",
    name: "Weekend sale at Sample Shoes.email",
    mime: EMAIL,
    from: "Sample Shoes",
    writtenAt: Date.UTC(2026, 10, 13, 6),
    mailKind: "newsletter",
    text: `Boots from EUR 19.00 while stocks last.
Click and collect from 15h00 in store.
Offer ends 15h30 on Friday.
Unsubscribe at any time.`,
    expected: [],
  },
  // t-18: half past seven is out of scope, so the day has no clock.
  {
    id: "t-18",
    name: "Book club evening.email",
    mime: EMAIL,
    from: "Example Book Club",
    writtenAt: Date.UTC(2026, 10, 9, 12),
    mailKind: "other",
    text: `Hello readers,

We meet on Friday 4 December 2026 at half past seven in the library annex.
Please finish the first six chapters.

Minutes of the last meeting were sent on 9 November 2026.`,
    expected: [{ kind: "event", value: "2026-12-04" }],
  },
  // t-19: midnight is out of scope, so the day has no clock; the order day is not an event.
  {
    id: "t-19",
    name: "New Year party tickets.email",
    mime: EMAIL,
    from: "Example Events Hall",
    writtenAt: Date.UTC(2026, 10, 12, 10),
    mailKind: "booking",
    text: `Your order of 12 November 2026 is confirmed.

New Year's Eve party
Thursday 31 December 2026, countdown at midnight
Dress code: smart.`,
    expected: [{ kind: "event", value: "2026-12-31" }],
  },
  // t-20: a promotion; midnight and 14.30 style prices are not events.
  {
    id: "t-20",
    name: "This weekend free delivery.email",
    mime: EMAIL,
    from: "Sample Grocer",
    writtenAt: Date.UTC(2026, 10, 13, 6),
    mailKind: "newsletter",
    text: `This weekend: free delivery on orders over EUR 19.00.
Order before midnight on Sunday.
Fresh bread from 7am daily.`,
    expected: [],
  },
  // t-21: the booking day is not an event; the clock below the date belongs to it.
  {
    id: "t-21",
    name: "Seats confirmed.email",
    mime: EMAIL,
    from: "Harbour Theatre Example",
    writtenAt: Date.UTC(2026, 10, 1, 9),
    mailKind: "booking",
    text: `Booked on 1 November 2026. Reference REF-48213.

Harbour Theatre Example
Sat 14 Nov 2026
8:00 PM
Stalls, row C`,
    expected: [{ kind: "event", value: "2026-11-14", time: "20:00" }],
  },
  // t-22: the print day is not an event.
  {
    id: "t-22",
    name: "admission-example.pdf",
    mime: "application/pdf",
    text: `Example Lecture Series
Thursday 3 December 2026
19:30
Great Hall
Printed 20 November 2026`,
    expected: [{ kind: "event", value: "2026-12-03", time: "19:30" }],
  },
  // t-23: the order day is not an event.
  {
    id: "t-23",
    name: "Cinema seats Example Screen.email",
    mime: EMAIL,
    from: "Example Screen",
    writtenAt: Date.UTC(2026, 10, 10, 9),
    mailKind: "booking",
    text: `Order placed 10 November 2026.

Friday 27 November 2026
6:45 PM
Screen 2, seats F5 and F6`,
    expected: [{ kind: "event", value: "2026-11-27", time: "18:45" }],
  },
  // t-24: a blank line separates the clock from the date, so the clock is not the date's.
  {
    id: "t-24",
    name: "Open day notice.email",
    mime: EMAIL,
    from: "Example Museum",
    writtenAt: Date.UTC(2026, 10, 9, 9),
    mailKind: "other",
    text: `Open day

Saturday 21 November 2026

8:00 PM is when the evening lecture series moves to its new room.
Sent 9 November 2026.`,
    expected: [{ kind: "event", value: "2026-11-21" }],
  },
  // t-25: Monday 2026-11-09, so tomorrow is Tuesday 2026-11-10.
  {
    id: "t-25",
    name: "Dinner?.email",
    mime: EMAIL,
    from: "Sam Example",
    writtenAt: Date.UTC(2026, 10, 9, 9),
    mailKind: "personal",
    text: `Hi,

Dinner tomorrow at 7pm? I found a place near the station.
Let me know.

Sam`,
    expected: [{ kind: "event", value: "2026-11-10", time: "19:00" }],
  },
  // t-26: Tuesday 2026-11-10, so this Saturday is 2026-11-14.
  {
    id: "t-26",
    name: "Saturday plans.email",
    mime: EMAIL,
    from: "Alex Sample",
    writtenAt: Date.UTC(2026, 10, 10, 8),
    mailKind: "personal",
    text: `Morning,

See you this Saturday at 10:30 at the market entrance.
Bring a bag.

Alex`,
    expected: [{ kind: "event", value: "2026-11-14", time: "10:30" }],
  },
  // t-27: Thursday 2026-11-12; Friday 13th is tomorrow, so next Friday is 2026-11-20.
  {
    id: "t-27",
    name: "Meeting next week.email",
    mime: EMAIL,
    from: "Robin Example",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "personal",
    text: `Hello,

Can we meet next Friday at 9am to go over the plans?
I will bring the drawings.

Robin`,
    expected: [{ kind: "event", value: "2026-11-20", time: "09:00" }],
  },
  // t-28: Wednesday 2026-11-11; the 5th of December is named in full.
  {
    id: "t-28",
    name: "Christmas lights evening.email",
    mime: EMAIL,
    from: "Jo Example",
    writtenAt: Date.UTC(2026, 10, 11, 9),
    mailKind: "personal",
    text: `Hi all,

The lights switch-on is on the 5th of December at 18:00.
Meet by the fountain. Hot drinks afterwards.

Jo`,
    expected: [{ kind: "event", value: "2026-12-05", time: "18:00" }],
  },
  // t-29: Friday 2026-11-13; the next 5th that is a Saturday is 2026-12-05.
  {
    id: "t-29",
    name: "Cake sale.email",
    mime: EMAIL,
    from: "Pat Sample",
    writtenAt: Date.UTC(2026, 10, 13, 9),
    mailKind: "personal",
    text: `Hello,

The cake sale is on Saturday the 5th, from 4pm in the village hall.
Please bring a cake if you can.

Pat`,
    expected: [{ kind: "event", value: "2026-12-05", time: "16:00" }],
  },
  // t-30: "tomorrow" appears only in the quoted part, so nothing here is a plan of its own.
  {
    id: "t-30",
    name: "Re: Dinner.email",
    mime: EMAIL,
    from: "Sam Example",
    writtenAt: Date.UTC(2026, 10, 13, 9),
    mailKind: "personal",
    text: `Thanks, noted.

On Mon, 9 Nov 2026 at 09:00, Alex Sample wrote:
> Dinner tomorrow at 7pm?
> I found a place near the station.
> Let me know.`,
    expected: [],
  },
];
