/**
 * Development cases with structure: eighteen HTML mails (tables of cells,
 * label and value rows, a quoted reply, a footer, a hidden preheader) and
 * twelve stored files whose text holds column tables. Part of the first
 * eval set: the readers' rules are written against it.
 */

import { mailBodyText } from "../htmltext";
import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

/** An HTML mail: the body rides as `raw`, as the app passes it, and its text is what the app's own step makes of it. */
const mail = (c: Omit<EvalCase, "mime" | "text" | "raw"> & { html: string }): EvalCase => ({
  ...c,
  mime: EMAIL,
  text: mailBodyText({ html: c.html }),
  raw: c.html,
});

export const STRUCTURE_CASES: readonly EvalCase[] = [
  // Not expected: booking date, the offer end in the footer, subtotal, VAT, discount.
  mail({
    id: "s-01",
    name: "Your stay at Harbour Guest House.email",
    from: "Harbour Guest House Example",
    writtenAt: Date.UTC(2027, 1, 20, 9),
    mailKind: "booking",
    html: `<html><body>
<table width="600" align="center"><tr><td>
<h2>Booking confirmed</h2>
<p>Thank you for booking with Harbour Guest House. Reference REF-48213.</p>
<table border="1">
<tr><th>Check-in</th><th>Check-out</th><th>Nights</th></tr>
<tr><td>Fri 12 March 2027, from 15:00</td><td>Mon 15 March 2027, by 11:00</td><td>3</td></tr>
</table>
<p>Booking date: 20 February 2027</p>
<table>
<tr><td>Room (3 nights)</td><td>&pound;390.00</td></tr>
<tr><td>Subtotal</td><td>&pound;390.00</td></tr>
<tr><td>VAT</td><td>&pound;78.00</td></tr>
<tr><td>Discount</td><td>-&pound;39.00</td></tr>
<tr><td><b>Total</b></td><td><b>&pound;429.00</b></td></tr>
</table>
<p>We look forward to welcoming you.</p>
</td></tr>
<tr><td>
<p style="font-size:11px">You received this email because you booked online. Book again before 30 April 2027 and save 15%.
Unsubscribe | Terms and conditions | &copy; 2027 Harbour Guest House Example</p>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-03-12", time: "15:00", role: "check-in" },
      { kind: "event", value: "2027-03-15", time: "11:00", role: "check-out" },
      { kind: "amount", value: "429.00" },
    ],
  }),
  // Not expected: the preheader offer date, booking date, the nightly rate.
  mail({
    id: "s-02",
    name: "Reservation REF-77120.email",
    from: "Lindenhof Hotel Example",
    writtenAt: Date.UTC(2027, 2, 28, 18),
    mailKind: "booking",
    html: `<html><body>
<span style="display:none;max-height:0;overflow:hidden">Member offer: 2 nights free if you stay before 1 September 2027. Prices from &euro;60,00.</span>
<table width="600"><tr><td>
<h1>Your reservation</h1>
<table>
<tr><td>Hotel</td><td>Lindenhof Hotel Example, Linden Strasse</td></tr>
<tr><td>Check-in</td><td>Fri 7 May 2027, from 14:00</td></tr>
<tr><td>Check-out</td><td>Sun 9 May 2027, until 10:30</td></tr>
<tr><td>Booking date</td><td>28 March 2027</td></tr>
<tr><td>Rate per night</td><td>&euro;88,50</td></tr>
<tr><td>Total price</td><td>&euro;177,00</td></tr>
</table>
<p>Free cancellation is not included in this rate.</p>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-05-07", time: "14:00", role: "check-in" },
      { kind: "event", value: "2027-05-09", time: "10:30", role: "check-out" },
      { kind: "amount", value: "177.00" },
    ],
  }),
  // Not expected: the fare parts, subtotal, discount, the offer end in the footer.
  mail({
    id: "s-03",
    name: "Your sailing tickets.email",
    from: "Channel Crossings Example",
    writtenAt: Date.UTC(2027, 3, 2, 12),
    mailKind: "booking",
    html: `<html><body>
<table width="600"><tr><td>
<h2>Ferry booking REF-30417</h2>
<table border="1">
<tr><th>Sailing</th><th>Date</th><th>Departs</th><th>Arrives</th></tr>
<tr><td>Outward: Dover to Calais</td><td>10 June 2027</td><td>08:15</td><td>11:45</td></tr>
<tr><td>Return: Calais to Dover</td><td>14 June 2027</td><td>17:00</td><td>20:30</td></tr>
</table>
<table>
<tr><th align="left">Fare</th><th>Qty</th><th>Amount (GBP)</th></tr>
<tr><td>Adult</td><td>2</td><td>108.00</td></tr>
<tr><td>Car</td><td>1</td><td>62.00</td></tr>
<tr><td>Subtotal</td><td></td><td>170.00</td></tr>
<tr><td>Discount</td><td></td><td>-10.00</td></tr>
<tr><td><b>Total paid</b></td><td></td><td><b>160.00</b></td></tr>
</table>
</td></tr>
<tr><td><p style="font-size:11px">Unsubscribe. Summer deals end 31 May 2027. Terms and conditions apply.</p></td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-06-10", time: "08:15", role: "depart" },
      { kind: "event", value: "2027-06-10", time: "11:45", role: "arrive" },
      { kind: "event", value: "2027-06-14", time: "17:00", role: "depart" },
      { kind: "event", value: "2027-06-14", time: "20:30", role: "arrive" },
      { kind: "amount", value: "160.00" },
    ],
  }),
  // Not expected: the preheader offer (date and price), the order date.
  mail({
    id: "s-04",
    name: "E-ticket REF-91544.email",
    from: "Skyline Air Example",
    writtenAt: Date.UTC(2027, 2, 1, 8),
    mailKind: "booking",
    html: `<html><body>
<div style="font-size:0;opacity:0">Fly more: fares from USD 89.00 if you book by 20 March 2027.</div>
<table width="600"><tr><td>
<h2>Your flights are booked</h2>
<p>Order date: 1 March 2027</p>
<table>
<tr><td><b>Flight</b></td><td><b>Date</b></td><td><b>Departs</b></td><td><b>Arrives</b></td></tr>
<tr><td>SX 204 London to Boston</td><td>2 July 2027</td><td>10:05</td><td>13:40</td></tr>
<tr><td>SX 205 Boston to London</td><td>16 July 2027</td><td>18:20</td><td>21:55</td></tr>
</table>
<p>Total fare including taxes: USD 1,180.00</p>
<p>Check in online from 24 hours before departure.</p>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-07-02", time: "10:05", role: "depart" },
      { kind: "event", value: "2027-07-02", time: "13:40", role: "arrive" },
      { kind: "event", value: "2027-07-16", time: "18:20", role: "depart" },
      { kind: "event", value: "2027-07-16", time: "21:55", role: "arrive" },
      { kind: "amount", value: "1180.00" },
    ],
  }),
  // Not expected: booking date, the daily rate, tax, the quoted earlier quote.
  mail({
    id: "s-05",
    name: "Car hire confirmation.email",
    from: "Roadway Rentals Example",
    writtenAt: Date.UTC(2027, 2, 30, 10),
    mailKind: "booking",
    html: `<html><body>
<table width="600"><tr><td>
<h2>Your car is reserved</h2>
<table>
<tr><td>Booking date</td><td>30 March 2027</td></tr>
<tr><td>Pick-up</td><td>Wed 14 April 2027, 10:00</td></tr>
<tr><td>Drop-off</td><td>Sat 17 April 2027, 16:00</td></tr>
<tr><td>Vehicle</td><td>Compact, 5 doors</td></tr>
</table>
<table>
<tr><td>Daily rate (3 days)</td><td>$60.00</td></tr>
<tr><td>Tax</td><td>$14.50</td></tr>
<tr><td>Promo discount</td><td>-$10.00</td></tr>
<tr><td><b>Total due at pick-up</b></td><td><b>$214.50</b></td></tr>
</table>
<blockquote>On 25 March 2027 you wrote: please quote me for 12 April 2027, estimated $199.00.</blockquote>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-04-14", time: "10:00" },
      { kind: "event", value: "2027-04-17", time: "16:00" },
      { kind: "amount", value: "214.50" },
    ],
  }),
  // Not expected: doors time on its own, order date, the fee line, presale end in the preheader.
  mail({
    id: "s-06",
    name: "Your tickets for Riverside Live.email",
    from: "Riverside Arena Example",
    writtenAt: Date.UTC(2027, 4, 1, 13),
    mailKind: "receipt",
    html: `<html><body>
<span style="display:none;max-height:0;overflow:hidden">Presale for autumn shows ends 15 May 2027.</span>
<table width="600"><tr><td>
<h2>Order REF-55206</h2>
<table>
<tr><td>Order date</td><td>1 May 2027</td></tr>
<tr><td>Event</td><td>Riverside Live: The Harbour Band</td></tr>
<tr><td>Date</td><td>Sat 19 June 2027</td></tr>
<tr><td>Doors</td><td>19:00</td></tr>
<tr><td>Show starts</td><td>20:00</td></tr>
</table>
<table>
<tr><th>Item</th><th>Qty</th><th>Price (GBP)</th></tr>
<tr><td>Standing ticket</td><td>2</td><td>64.00</td></tr>
<tr><td>Booking fee</td><td>1</td><td>4.00</td></tr>
<tr><td><b>Total</b></td><td></td><td><b>68.00</b></td></tr>
</table>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-06-19", time: "20:00" },
      { kind: "amount", value: "68.00" },
    ],
  }),
  // Not expected: booking date, the offer end in the footer, the per-ticket price.
  mail({
    id: "s-07",
    name: "Tickets confirmed.email",
    from: "Old Mill Theatre Example",
    writtenAt: Date.UTC(2027, 5, 1, 9),
    mailKind: "receipt",
    html: `<html><body>
<table width="600"><tr><td>
<h2>See you at the theatre</h2>
<table border="1">
<tr><th>Event</th><th>Date</th><th>Time</th><th>Seats</th></tr>
<tr><td>A Night in the Orchard</td><td>3 July 2027</td><td>19:30</td><td>Stalls D12, D13</td></tr>
</table>
<p>Booking date: 1 June 2027. Price per seat &euro;22,50.</p>
<p>Total paid: &euro;45,00</p>
</td></tr>
<tr><td><p style="font-size:11px">You received this email because you booked tickets. Book by 15 June 2027 and save &euro;5,00 per seat.
Terms and conditions | Unsubscribe | &copy; 2027 Old Mill Theatre Example</p></td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-07-03", time: "19:30" },
      { kind: "amount", value: "45.00" },
    ],
  }),
  // Not expected: invoice date, the billing period, the charge lines, the direct debit offer end in the footer.
  mail({
    id: "s-08",
    name: "Your electricity bill.email",
    from: "Northfield Power Example",
    writtenAt: Date.UTC(2027, 3, 1, 7),
    mailKind: "bill",
    html: `<html><body>
<table width="600"><tr><td>
<h2>Your bill is ready</h2>
<table>
<tr><td>Invoice date</td><td>1 April 2027</td></tr>
<tr><td>Account</td><td>ACC-6620</td></tr>
<tr><td>Payment due</td><td>19 April 2027</td></tr>
</table>
<table border="1">
<tr><th>Description</th><th>Period</th><th>Amount (GBP)</th></tr>
<tr><td>Electricity used</td><td>1 Mar - 31 Mar 2027</td><td>98.40</td></tr>
<tr><td>Standing charge</td><td>1 Mar - 31 Mar 2027</td><td>22.00</td></tr>
<tr><td>VAT</td><td></td><td>6.00</td></tr>
<tr><td><b>Amount due</b></td><td></td><td><b>126.40</b></td></tr>
</table>
</td></tr>
<tr><td><p style="font-size:11px">Pay by direct debit before 30 April 2027 and get a 10.00 credit. Unsubscribe. Terms and conditions.</p></td></tr></table>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-19" },
      { kind: "amount", value: "126.40" },
    ],
  }),
  // Not expected: issued date, the hidden upgrade offer, the plan and data charges.
  mail({
    id: "s-09",
    name: "Your mobile bill.email",
    from: "Brightline Mobile Example",
    writtenAt: Date.UTC(2027, 4, 3, 6),
    mailKind: "bill",
    html: `<html><body>
<span style="display:none;max-height:0;overflow:hidden">Upgrade offer ends 31 May 2027: a new handset for $0.</span>
<table width="600"><tr><td>
<h2>Your May bill</h2>
<table>
<tr><td>Issued</td><td>3 May 2027</td></tr>
<tr><td>Number</td><td>07700 900123</td></tr>
<tr><td>Pay by</td><td>Mon 24 May 2027</td></tr>
</table>
<table>
<tr><td>Plan</td><td>$40.00</td></tr>
<tr><td>Extra data</td><td>$12.00</td></tr>
<tr><td>Taxes and fees</td><td>$6.20</td></tr>
<tr><td><b>Total to pay</b></td><td><b>$58.20</b></td></tr>
</table>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-24" },
      { kind: "amount", value: "58.20" },
    ],
  }),
  // Not expected: statement date, the transactions, minimum payment, statement balance, the rate change in the footer.
  mail({
    id: "s-10",
    name: "Your card statement.email",
    from: "Meridian Card Example",
    writtenAt: Date.UTC(2027, 2, 5, 7),
    mailKind: "bill",
    html: `<html><body>
<table width="600"><tr><td>
<h2>Statement ready</h2>
<table>
<tr><td>Statement date</td><td>5 March 2027</td></tr>
<tr><td>Statement balance</td><td>$812.33</td></tr>
<tr><td>Minimum payment</td><td>$35.00</td></tr>
<tr><td>Payment due</td><td>30 March 2027</td></tr>
</table>
<table border="1">
<tr><th>Date</th><th>Merchant</th><th>Amount (USD)</th></tr>
<tr><td>12 Feb 2027</td><td>Corner Grocer</td><td>41.20</td></tr>
<tr><td>19 Feb 2027</td><td>Fuel Stop</td><td>58.00</td></tr>
<tr><td>27 Feb 2027</td><td>Book Barn</td><td>23.15</td></tr>
</table>
</td></tr>
<tr><td><p style="font-size:11px">Your rate changes from 1 June 2027. Terms and conditions. Unsubscribe.</p></td></tr></table>
</body></html>`,
    expected: [{ kind: "due", value: "2027-03-30" }],
  }),
  // Not expected: order date, the item lines, subtotal, discount, delivery charge, the sale end in the footer.
  mail({
    id: "s-11",
    name: "Order REF-20871 confirmed.email",
    from: "Greenfield Goods Example",
    writtenAt: Date.UTC(2027, 3, 9, 15),
    mailKind: "delivery",
    html: `<html><body>
<table width="600"><tr><td>
<h2>Thanks for your order</h2>
<p>Order date: 9 April 2027</p>
<table border="1">
<tr><th>Item</th><th>Qty</th><th>Price (GBP)</th></tr>
<tr><td>Garden shears</td><td>1</td><td>34.95</td></tr>
<tr><td>Plant pots, set of 6</td><td>2</td><td>47.00</td></tr>
</table>
<table>
<tr><td>Subtotal</td><td>&pound;81.95</td></tr>
<tr><td>Discount</td><td>-&pound;8.20</td></tr>
<tr><td>Delivery</td><td>&pound;9.70</td></tr>
<tr><td><b>Order total</b></td><td><b>&pound;83.45</b></td></tr>
</table>
<p>Estimated delivery: Thu 15 April 2027</p>
</td></tr>
<tr><td><p style="font-size:11px">Spring sale ends 25 April 2027. Unsubscribe. Terms and conditions.</p></td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-04-15" },
      { kind: "amount", value: "83.45" },
    ],
  }),
  // Not expected: the preheader offer, the dispatch date, the date in the quoted earlier message.
  mail({
    id: "s-12",
    name: "Your parcel is on its way.email",
    from: "SwiftPost Example",
    writtenAt: Date.UTC(2027, 6, 12, 11),
    mailKind: "delivery",
    html: `<html><body>
<div style="font-size:0;opacity:0">Free returns until 30 September 2027.</div>
<table width="600"><tr><td>
<h2>Parcel REF-83309</h2>
<table>
<tr><td>Dispatched</td><td>12 July 2027</td></tr>
<tr><td>Delivery day</td><td>Wed 21 July 2027, between 09:00 and 13:00</td></tr>
<tr><td>Deliver to</td><td>12 High Street</td></tr>
</table>
<p>Someone must be home to sign for it.</p>
<p>On 10 Jul 2027 Alex wrote:</p>
<blockquote>Can you deliver on 19 July 2027 instead?</blockquote>
</td></tr></table>
</body></html>`,
    expected: [{ kind: "event", value: "2027-07-21" }],
  }),
  // Not expected: booking date, the offer in the footer, the fee.
  mail({
    id: "s-13",
    name: "Appointment confirmed.email",
    from: "Elm Park Clinic Example",
    writtenAt: Date.UTC(2027, 1, 1, 10),
    mailKind: "booking",
    html: `<html><body>
<table width="600"><tr><td>
<h2>Your appointment</h2>
<table border="1">
<tr><th>Appointment</th><th>Date</th><th>Time</th><th>Room</th></tr>
<tr><td>Dental check-up</td><td>Wed 17 February 2027</td><td>09:40</td><td>Room 3</td></tr>
</table>
<p>Booking date: 1 February 2027. Fee: &pound;25.00 payable at reception.</p>
</td></tr>
<tr><td><p style="font-size:11px">You received this email because you made a booking. Whitening offer: book before 31 March 2027 and save &pound;40.00. Unsubscribe.</p></td></tr></table>
</body></html>`,
    expected: [{ kind: "event", value: "2027-02-17", time: "09:40" }],
  }),
  // Not expected: enrolment date, the preheader early-bird date, the line prices.
  mail({
    id: "s-14",
    name: "Enrolment confirmed.email",
    from: "Millbrook Evening School Example",
    writtenAt: Date.UTC(2027, 0, 10, 20),
    mailKind: "booking",
    html: `<html><body>
<span style="display:none;max-height:0;overflow:hidden">Early bird for the summer term ends 1 April 2027.</span>
<table width="600"><tr><td>
<h2>Welcome to Pottery for Beginners</h2>
<p>Enrolled on: 10 January 2027</p>
<table border="1">
<tr><th>Session</th><th>Date</th><th>Time</th><th>Room</th></tr>
<tr><td>1</td><td>2 February 2027</td><td>18:30</td><td>Studio B</td></tr>
<tr><td>2</td><td>9 February 2027</td><td>18:30</td><td>Studio B</td></tr>
<tr><td>3</td><td>16 February 2027</td><td>18:30</td><td>Studio B</td></tr>
</table>
<table>
<tr><td>Course fee</td><td>&pound;215.00</td></tr>
<tr><td>Materials</td><td>&pound;25.00</td></tr>
<tr><td><b>Total paid</b></td><td><b>&pound;240.00</b></td></tr>
</table>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "event", value: "2027-02-02", time: "18:30" },
      { kind: "event", value: "2027-02-09", time: "18:30" },
      { kind: "event", value: "2027-02-16", time: "18:30" },
      { kind: "amount", value: "240.00" },
    ],
  }),
  // Not expected: quote date, cover start date, the preheader offer, the cover parts.
  mail({
    id: "s-15",
    name: "Your home insurance renewal.email",
    from: "Anchor Insurance Example",
    writtenAt: Date.UTC(2027, 7, 2, 9),
    mailKind: "other",
    html: `<html><body>
<div style="font-size:0;opacity:0">Add travel cover before 15 August 2027 for 20% off.</div>
<table width="600"><tr><td>
<h2>Time to renew</h2>
<table>
<tr><td>Policy</td><td>POL-1190-27</td></tr>
<tr><td>Quote date</td><td>2 August 2027</td></tr>
<tr><td>Renewal starts</td><td>1 September 2027</td></tr>
<tr><td>Current cover ends</td><td>31 August 2027</td></tr>
</table>
<table border="1">
<tr><th>Cover</th><th>Premium (GBP)</th></tr>
<tr><td>Buildings</td><td>180.00</td></tr>
<tr><td>Contents</td><td>132.00</td></tr>
<tr><td><b>Renewal premium</b></td><td><b>312.00</b></td></tr>
</table>
</td></tr></table>
</body></html>`,
    expected: [
      { kind: "expiry", value: "2027-08-31" },
      { kind: "amount", value: "312.00" },
    ],
  }),
  // Expects nothing: sale dates and prices in an offers table, the preheader and the footer.
  mail({
    id: "s-16",
    name: "This week's picks.email",
    from: "Cobble Street Shop Example",
    writtenAt: Date.UTC(2027, 3, 12, 6),
    mailKind: "newsletter",
    html: `<html><body>
<span style="display:none;max-height:0;overflow:hidden">Big spring sale: up to 40% off until 30 April 2027.</span>
<table width="600"><tr><td>
<h1>This week's picks</h1>
<table border="1">
<tr><th>Product</th><th>Was</th><th>Now</th><th>Offer ends</th></tr>
<tr><td>Canvas bag</td><td>&pound;30.00</td><td>&pound;18.00</td><td>20 April 2027</td></tr>
<tr><td>Ceramic mug</td><td>&pound;12.00</td><td>&pound;7.50</td><td>22 April 2027</td></tr>
<tr><td>Wool scarf</td><td>&pound;45.00</td><td>&pound;29.00</td><td>30 April 2027</td></tr>
</table>
<p>Spend &pound;50.00 and delivery is free.</p>
</td></tr>
<tr><td><p style="font-size:11px">You received this email because you subscribed. Unsubscribe | Terms and conditions | &copy; 2027 Cobble Street Shop Example. Prices valid until 1 May 2027.</p></td></tr></table>
</body></html>`,
    expected: [],
  }),
  // Expects nothing: event dates and ticket prices in a listings table, a closing-date line.
  mail({
    id: "s-17",
    name: "What's on in June.email",
    from: "City Arts Guide Example",
    writtenAt: Date.UTC(2027, 4, 25, 8),
    mailKind: "newsletter",
    html: `<html><body>
<table width="600"><tr><td>
<h1>What's on in June</h1>
<table>
<tr><td><b>Show</b></td><td><b>Date</b></td><td><b>Tickets (EUR)</b></td></tr>
<tr><td>Jazz on the Quay</td><td>5 June 2027</td><td>25,00</td></tr>
<tr><td>Open Air Cinema</td><td>12 June 2027</td><td>12,00</td></tr>
<tr><td>Food Market</td><td>19 June 2027</td><td>free</td></tr>
</table>
<p>Sign up for the newsletter prize draw by 31 May 2027.</p>
</td></tr>
<tr><td><p style="font-size:11px">Unsubscribe. You received this email because you joined our list. Terms and conditions.</p></td></tr></table>
</body></html>`,
    expected: [],
  }),
  // Not expected: the booking in the quoted message (check-in, check-out, total); only the reply's own plan counts.
  mail({
    id: "s-18",
    name: "Re: Weekend plans.email",
    from: "Alex Example",
    writtenAt: Date.UTC(2027, 4, 25, 16),
    mailKind: "personal",
    html: `<html><body>
<table width="600"><tr><td>
<p>Hi, dinner is on. Let's meet on Friday 4 June 2027 at 19:00 at the usual place.</p>
<p>Thanks for sending the hotel details.</p>
<p>On 24 May 2027 Sam wrote:</p>
<blockquote>
<table>
<tr><td>Check-in</td><td>Fri 11 June 2027, from 15:00</td></tr>
<tr><td>Check-out</td><td>Sun 13 June 2027, by 10:00</td></tr>
<tr><td>Total</td><td>&pound;240.00</td></tr>
</table>
</blockquote>
</td></tr></table>
</body></html>`,
    expected: [{ kind: "event", value: "2027-06-04", time: "19:00" }],
  }),
  // Not expected: statement date, billing period rows, the charge lines, the next reading date.
  {
    id: "s-19",
    name: "electricity-statement-april.pdf",
    mime: "application/pdf",
    text: `Northfield Power Example
Statement date | 2 April 2027
Account | ACC-6620
Description | Period | Units | Amount (GBP)
Electricity | 1 Mar 2027 - 31 Mar 2027 | 512 | 98.40
Standing charge | 1 Mar 2027 - 31 Mar 2027 | 31 days | 22.00
Total amount due | 120.40
Pay by | 20 April 2027
Next meter reading | 1 May 2027`,
    expected: [
      { kind: "due", value: "2027-04-20" },
      { kind: "amount", value: "120.40" },
    ],
  },
  // Not expected: bill date, the period, the usage and sewer lines, the previous payment.
  {
    id: "s-20",
    name: "water-bill.pdf",
    mime: "application/pdf",
    text: `Clearwater Utilities Example
Bill date | 14 May 2027
Billing period | 1 Jan 2027 to 30 Apr 2027
Charge | Volume | Rate | Amount (USD)
Water supply | 41 m3 | 1.92 | 78.72
Sewerage | 41 m3 | 1.55 | 63.55
Last payment received | 12 Jan 2027 | 70.00
Amount due | 142.27
Payment due date | 4 June 2027`,
    expected: [
      { kind: "due", value: "2027-06-04" },
      { kind: "amount", value: "142.27" },
    ],
  },
  // Not expected: statement date, every transaction row, the closing balance.
  {
    id: "s-21",
    name: "card-statement-june.pdf",
    mime: "application/pdf",
    text: `Meridian Card Example
Statement date | 5 June 2027
Date | Description | Amount (USD)
18 May 2027 | Corner Grocer | 41.20
24 May 2027 | Fuel Stop | 58.00
2 Jun 2027 | Book Barn | 23.15
Closing balance | 122.35
Payment due date | 30 June 2027
Total amount due | 122.35`,
    expected: [
      { kind: "due", value: "2027-06-30" },
      { kind: "amount", value: "122.35" },
    ],
  },
  // Not expected: the booking date, the printed date, the fare table has no total.
  {
    id: "s-22",
    name: "train-itinerary.pdf",
    mime: "application/pdf",
    text: `Rail itinerary REF-60418
Booking date | 3 May 2027
Date | Departs | Arrives | Route
Tue 8 June 2027 | 09:12 | 12:40 | London to Leeds
Fri 11 June 2027 | 17:30 | 20:55 | Leeds to London
Printed 3 May 2027`,
    expected: [
      { kind: "event", value: "2027-06-08", time: "09:12", role: "depart" },
      { kind: "event", value: "2027-06-08", time: "12:40", role: "arrive" },
      { kind: "event", value: "2027-06-11", time: "17:30", role: "depart" },
      { kind: "event", value: "2027-06-11", time: "20:55", role: "arrive" },
    ],
  },
  // Not expected: the issue date, the ticket price rows; the date row has no departure time so only the dated rows count.
  {
    id: "s-23",
    name: "ferry-itinerary.pdf",
    mime: "application/pdf",
    text: `Island Ferries Example
Issued | 20 June 2027
Date | Departs | Arrives
5 August 2027 | 07:45 | 09:10
12 August 2027 | 18:20 | 19:45
Fare | Qty | Amount
Foot passenger | 2 | 36.00`,
    expected: [
      { kind: "event", value: "2027-08-05", time: "07:45", role: "depart" },
      { kind: "event", value: "2027-08-05", time: "09:10", role: "arrive" },
      { kind: "event", value: "2027-08-12", time: "18:20", role: "depart" },
      { kind: "event", value: "2027-08-12", time: "19:45", role: "arrive" },
    ],
  },
  // Not expected: the folio print date, the nightly charge lines, tax.
  {
    id: "s-24",
    name: "hotel-folio.pdf",
    mime: "application/pdf",
    text: `Lindenhof Hotel Example
Folio printed | 16 October 2027
Check-in | Check-out | Nights
13 Oct 2027 | 16 Oct 2027 | 3
Description | Date | Amount (EUR)
Room | 13 Oct 2027 | 95.00
Room | 14 Oct 2027 | 95.00
Room | 15 Oct 2027 | 95.00
Tax | | 28.50
Total | | 313.50`,
    expected: [
      { kind: "event", value: "2027-10-13", role: "check-in" },
      { kind: "event", value: "2027-10-16", role: "check-out" },
      { kind: "amount", value: "313.50" },
    ],
  },
  // Not expected: the invoice date next to the address, the issue date, the line amounts.
  {
    id: "s-25",
    name: "invoice-1042.pdf",
    mime: "application/pdf",
    text: `Invoice 1042
12 High Street | Invoice date: 3 Feb 2027
Riverside Road | Due date: 17 Feb 2027
Mapleton | Customer: CUST-310
Description | Qty | Amount (GBP)
Garden design | 1 | 450.00
Planting | 2 | 120.00
Total due | | 570.00`,
    expected: [
      { kind: "due", value: "2027-02-17" },
      { kind: "amount", value: "570.00" },
    ],
  },
  // Not expected: the timetable issue date.
  {
    id: "s-26",
    name: "course-timetable.pdf",
    mime: "application/pdf",
    text: `Spring course timetable
Issued 12 January 2027
Date | Time | Room
Mon 1 Feb 2027 | 10:00 | Room 4
Mon 8 Feb 2027 | 10:00 | Room 4
Mon 15 Feb 2027 | 14:00 | Room 7`,
    expected: [
      { kind: "event", value: "2027-02-01", time: "10:00" },
      { kind: "event", value: "2027-02-08", time: "10:00" },
      { kind: "event", value: "2027-02-15", time: "14:00" },
    ],
  },
  // Expects nothing: past payment dates and amounts in a history table, a balance.
  {
    id: "s-27",
    name: "payment-history.pdf",
    mime: "application/pdf",
    text: `Payment history
Date | Description | Amount
4 Jan 2027 | Direct debit | 60.00
4 Feb 2027 | Direct debit | 60.00
4 Mar 2027 | Direct debit | 60.00
Balance carried forward | 0.00
Printed 20 March 2027`,
    expected: [],
  },
  // Expects nothing: prices and a price-valid-until date in a list.
  {
    id: "s-28",
    name: "price-list.pdf",
    mime: "application/pdf",
    text: `Cobble Street Shop Example
Product | Size | Price
Canvas bag | One size | 18.00
Ceramic mug | 300 ml | 7.50
Wool scarf | 180 cm | 29.00
Prices valid until 30 September 2027`,
    expected: [],
  },
  // Not expected: the cover start date, the quote date, the excess row.
  {
    id: "s-29",
    name: "policy-schedule.pdf",
    mime: "application/pdf",
    text: `Anchor Insurance Example
Policy schedule POL-1190-27
Quote date | 14 December 2026
Cover starts | 1 January 2027
Cover ends | 31 December 2027
Excess | £250.00
Total premium | £412.00`,
    expected: [
      { kind: "expiry", value: "2027-12-31" },
      { kind: "amount", value: "412.00" },
    ],
  },
  // Not expected: the order date, the item prices.
  {
    id: "s-30",
    name: "delivery-schedule.pdf",
    mime: "application/pdf",
    text: `Hartley Furniture Example
Order date | 2 March 2027
Delivery date | Slot | Item
Tue 16 March 2027 | Morning | Wardrobe
Thu 18 March 2027 | Afternoon | Bed frame
Fri 19 March 2027 | Morning | Chest of drawers`,
    expected: [
      { kind: "event", value: "2027-03-16" },
      { kind: "event", value: "2027-03-18" },
      { kind: "event", value: "2027-03-19" },
    ],
  },
];
