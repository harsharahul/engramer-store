/**
 * Held-out documents: bills, notices and statements that arrive by mail,
 * written without sight of the readers. No case here is ever used to tune a rule or an instruction.
 */

import { mailBodyText } from "../htmltext";
import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

/** An HTML mail: the body rides as `raw`, as the app passes it, and its text is what the app's own step makes of it. */
const htmlMail = (c: Omit<EvalCase, "mime" | "text" | "raw"> & { html: string }): EvalCase => {
  const { html, ...rest } = c;
  return { ...rest, mime: EMAIL, text: mailBodyText({ html }), raw: html };
};

export const HELDOUT_MAIL_CASES: readonly EvalCase[] = [
  // Not expected: the statement date, the late fee start (December 16), the late fee, the last payment day and sum.
  {
    id: "h5-hoa-quarterly",
    name: "Q4 assessment posted to your account.email",
    mime: EMAIL,
    from: "Maple Ridge Homeowners Association Example",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "bill",
    text: `Dear Homeowner,

Your quarterly assessment for the period October 1 - December 31, 2026 has been posted to your account.

Unit: 14 Lantern Court
Account No.: MR-20418
Statement date: November 12, 2026

Assessment, Q4 2026 ............ $450.00
Last payment received September 28, 2026: $450.00

Amount payable: $450.00
Payment due by: December 1, 2026

Assessments not received after December 16, 2026 carry a late fee of $35.00.

Pay online, by cheque to the address on your coupon, or through your bank's bill pay service.

Maple Ridge Homeowners Association Example
Questions: dues@mapleridge.example.org
You are receiving this because you own a unit at Maple Ridge.`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "450.00" },
    ],
  },
  // Not expected: the date the payment was received, the next bill's issue day.
  {
    id: "h5-payment-confirm",
    name: "We received your payment.email",
    mime: EMAIL,
    from: "Lakeshore Gas Example",
    writtenAt: Date.UTC(2026, 11, 1, 15),
    mailKind: "receipt",
    text: `Hi Dana,

Thank you. We received your payment.

Amount received: $212.40
Received on: November 30, 2026
Confirmation number: LG-88231904

Your next bill will be issued on January 4, 2027. No further payment is needed for this billing cycle.

Lakeshore Gas Example, customer care 1-800-555-0142
Please do not reply to this message.`,
    expected: [{ kind: "amount", value: "212.40" }],
  },
  // Not expected: the statement date, the date of service, the insurance payment day, the total charges, the adjustment, the insurance payment.
  htmlMail({
    id: "h5-medbill-adjusted",
    name: "Your statement from Cedar Valley Medical Group.email",
    from: "Cedar Valley Medical Group Example",
    writtenAt: Date.UTC(2026, 10, 19, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Ms. Okafor,</p>
<p>Your insurance has processed the claim for your visit. Here is what remains on your account.</p>
<table border="1" cellpadding="4">
<tr><td>Statement date</td><td>11/19/2026</td></tr>
<tr><td>Date of service</td><td>10/14/2026</td></tr>
<tr><td>Total charges</td><td>$1,480.00</td></tr>
<tr><td>Insurance contractual adjustment</td><td>-$842.60</td></tr>
<tr><td>Insurance paid (11/02/2026)</td><td>-$425.00</td></tr>
<tr><td><b>Amount you owe</b></td><td><b>$212.40</b></td></tr>
<tr><td>Pay by</td><td>12/19/2026</td></tr>
</table>
<p>Pay online at the patient portal or call billing at 555-0177. If you believe your insurance should have paid more, call us before the due date.</p>
<p style="font-size:11px">Cedar Valley Medical Group Example. This message contains confidential billing information.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-19" },
      { kind: "amount", value: "212.40" },
    ],
  }),
  // Not expected: the day of the earlier reminder, the disconnection day, the past due part, the current charges part.
  {
    id: "h5-gas-final-notice",
    name: "FINAL NOTICE - account 7731-4420.email",
    mime: EMAIL,
    from: "Prairie Gas & Electric Example",
    writtenAt: Date.UTC(2026, 11, 8, 10),
    mailKind: "bill",
    text: `FINAL NOTICE - ACTION REQUIRED

Account 7731-4420

We wrote to you on November 20, 2026 about an unpaid balance. We have not received payment.

Past due balance ......... $119.84
Current charges .......... $111.62
-----------------------------------
Total amount to pay ...... $231.46

PAY BY: December 15, 2026

If we do not receive payment, your service may be disconnected on or after December 22, 2026. A reconnection charge will apply.

To arrange a payment plan call 555-0190 before the date above.

Prairie Gas & Electric Example`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "231.46" },
    ],
  },
  // Not expected: the bill date, the penalty start (2027-02-27), last year's final instalment payment day, the interim total, the annual levy.
  {
    id: "h5-proptax-interim-ca",
    name: "2027 Interim Property Tax Bill - Roll 3417-220-118.email",
    mime: EMAIL,
    from: "Township of Elmbrook Example Tax Office",
    writtenAt: Date.UTC(2027, 1, 2, 8),
    mailKind: "bill",
    text: `Re: 2027 Interim Property Tax Bill
Roll No. 3417-220-118
Bill date: 2027-02-02

Your final 2026 instalment was received on 2026-11-30. Thank you.

The 2027 interim bill is payable in two instalments:

  Instalment 1      due 2027-02-26      $1,284.50
  Instalment 2      due 2027-04-01      $1,284.50

  Interim total                         $2,569.00
  Estimated 2027 annual levy            $5,138.00

A penalty of 1.25% is added to any overdue amount on 2027-02-27 and on the first day of each month after.

The final bill will be issued after the 2027 rates are set. Payments may be made at any bank branch, online, or at the Township office.

Township of Elmbrook Example Tax Office
tax@elmbrook.example.org`,
    expected: [
      { kind: "due", value: "2027-02-26" },
      { kind: "due", value: "2027-04-01" },
      { kind: "amount", value: "1284.50" },
    ],
  },
  // Not expected: the previous bill's day.
  {
    id: "h5-hydro-preauth",
    name: "Your pre-authorized payment is scheduled.email",
    mime: EMAIL,
    from: "Northern Hydro Example",
    writtenAt: Date.UTC(2026, 11, 9, 7),
    mailKind: "bill",
    text: `Your pre-authorized payment is scheduled.

Amount: $186.50
Withdrawal date: 2026-12-15
Bank account ending 4417

Your last withdrawal was taken on 2026-11-14.

To change or cancel, sign in before the withdrawal date.
Northern Hydro Example`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "186.50" },
    ],
  },
  // Not expected: the last payment day, the next statement day, the previous balance.
  {
    id: "h5-rent-statement-noyear",
    name: "Tenant statement - Unit 3B.email",
    mime: EMAIL,
    from: "Harbourview Rentals Example",
    writtenAt: Date.UTC(2026, 10, 27, 12),
    mailKind: "bill",
    text: `Tenant statement - Unit 3B

Rent charge for December: $1,425.00
Last payment received Nov 1: $1,425.00
Previous balance: $0.00

Balance to pay: $1,425.00
Rent due: Dec 1

Your next statement will be sent on Dec 27. Payments are accepted by e-transfer to the address on your lease.

Harbourview Rentals Example
Office hours 9 to 5, Monday to Friday`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "1425.00" },
    ],
  },
  // Not expected: the billing period end, the day the price change starts.
  {
    id: "h5-broadband-sentence",
    name: "Your December invoice from Pinecone Broadband.email",
    mime: EMAIL,
    from: "Pinecone Broadband Example",
    writtenAt: Date.UTC(2026, 11, 28, 9),
    mailKind: "bill",
    text: `Hello Priya,

Your invoice for the period Nov 27, 2026 to Dec 26, 2026 is ready.

Total this month: $79.95

Please make sure your payment reaches us by January 8, 2027 so your internet service is not interrupted. After that date we may limit your speed until the account is current.

On February 1, 2027 our Home 500 plan goes up by $5.00 a month.

Thanks for staying with us,
Pinecone Broadband Example
help@pinecone.example.com | 1-855-555-0118`,
    expected: [
      { kind: "due", value: "2027-01-08" },
      { kind: "amount", value: "79.95" },
    ],
  },
  // Not expected: the bill closing date, the day the new rates start, the subtotal before tax, the autopay discount.
  htmlMail({
    id: "h5-mobile-bill-html",
    name: "Your Westfield Mobile bill is ready.email",
    from: "Westfield Mobile Example",
    writtenAt: Date.UTC(2026, 10, 15, 6),
    mailKind: "bill",
    html: `<html><body>
<h3>Your bill is ready</h3>
<table cellpadding="3">
<tr><td>Bill closing date</td><td>11/12/2026</td></tr>
<tr><td>Plans and add-ons</td><td>$96.00</td></tr>
<tr><td>AutoPay discount</td><td>-$5.00</td></tr>
<tr><td>Subtotal before taxes</td><td>$101.43</td></tr>
<tr><td>Taxes and fees</td><td>$11.24</td></tr>
<tr><td><b>Total due</b></td><td><b>$112.67</b></td></tr>
<tr><td>Payment due</td><td>12/09/2026</td></tr>
</table>
<p>New plan rates take effect January 1, 2027. We will let you know before then if your plan changes.</p>
<p>Westfield Mobile Example | Reply STOP to end text alerts | Manage preferences</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-09" },
      { kind: "amount", value: "112.67" },
    ],
  }),
  // Not expected: the service period end, the previous balance, the payment received, the next meter read.
  htmlMail({
    id: "h5-electric-coop-html",
    name: "Redwood Electric bill for account 20-4417.email",
    from: "Redwood Electric Cooperative Example",
    writtenAt: Date.UTC(2027, 0, 13, 10),
    mailKind: "bill",
    html: `<html><body>
<p>Member account 20-4417</p>
<table border="1" cellpadding="4">
<tr><th>Item</th><th>Detail</th></tr>
<tr><td>Service from</td><td>12/10/2026 to 01/09/2027</td></tr>
<tr><td>Previous balance</td><td>$201.33</td></tr>
<tr><td>Payment received 12/28/2026</td><td>-$201.33</td></tr>
<tr><td>Current charges</td><td>$187.52</td></tr>
<tr><td>Total amount due</td><td>$187.52</td></tr>
</table>
<p>Please pay by <b>02/03/2027</b>.</p>
<p>Next meter read: 02/09/2027. Report outages at 555-0133.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-03" },
      { kind: "amount", value: "187.52" },
    ],
  }),
  // Not expected: the day the sticker is mailed.
  {
    id: "h5-plate-renewal",
    name: "Your licence plate sticker renewal.email",
    mime: EMAIL,
    from: "Provincial Vehicle Registry Example",
    writtenAt: Date.UTC(2027, 0, 5, 9),
    mailKind: "bill",
    text: `Your licence plate sticker renewal is due.

Plate: BKRT 482
Renewal fee: $120.00
Renew by: 2027-02-28

Your new sticker will be mailed by 2027-03-12 once your renewal is processed.

Provincial Vehicle Registry Example`,
    expected: [
      { kind: "due", value: "2027-02-28" },
      { kind: "amount", value: "120.00" },
    ],
  },
  // Not expected: the payment received day, the previous balance, the payment, the next interim bill day.
  htmlMail({
    id: "h5-proptax-zero-html",
    name: "Property tax account statement - roll 2260-118.email",
    from: "City of Aldergrove Example Tax Services",
    writtenAt: Date.UTC(2027, 2, 2, 11),
    mailKind: "bill",
    html: `<html><body>
<p>Account statement for information</p>
<table border="1" cellpadding="4">
<tr><td>Roll number</td><td>2260-118</td></tr>
<tr><td>Previous balance</td><td>$1,125.00</td></tr>
<tr><td>Payment received 2027-02-12</td><td>-$1,125.00</td></tr>
<tr><td><b>Balance owing</b></td><td><b>$0.00</b></td></tr>
</table>
<p>No payment is required. Your next interim bill will be issued on 2027-06-10.</p>
<p>City of Aldergrove Example Tax Services. Do not reply to this automated message.</p>
</body></html>`,
    expected: [],
  }),
  // Not expected: the trip day, the day the fee rises, the toll part, the admin fee part, the higher fee.
  htmlMail({
    id: "h5-toll-notice-html",
    name: "Notice of unpaid tolls.email",
    from: "Eastbridge Toll Authority Example",
    writtenAt: Date.UTC(2027, 0, 20, 13),
    mailKind: "bill",
    html: `<html><body>
<h4>Notice of unpaid tolls</h4>
<table border="1" cellpadding="4">
<tr><th>Trip date</th><th>Plate</th><th>Toll</th></tr>
<tr><td>01/03/2027</td><td>7QXD-902</td><td>$12.75</td></tr>
<tr><td colspan="2">Administrative fee</td><td>$6.00</td></tr>
<tr><td colspan="2"><b>Total to pay</b></td><td><b>$18.75</b></td></tr>
</table>
<p>Pay by: <b>02/10/2027</b></p>
<p>If this notice is still unpaid after 02/25/2027 the amount will increase to $50.00 and may be reported to the registry.</p>
<p>Eastbridge Toll Authority Example, 555-0166</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-10" },
      { kind: "amount", value: "18.75" },
    ],
  }),
  // Not expected: the day of the sender's earlier message, the day owners were first notified.
  {
    id: "h5-hoa-reply-assessment",
    name: "RE: Special assessment notice.email",
    mime: EMAIL,
    from: "Willow Bend Homeowners Association Example",
    writtenAt: Date.UTC(2027, 2, 22, 14),
    mailKind: "bill",
    text: `Hi Marcus,

Following up on the note below. The special assessment of $1,200.00 for the roof project is still open, and the board needs it paid by April 9, 2027 at the latest.

Thank you,
Rita, Treasurer

-----Original Message-----
From: Willow Bend HOA Billing <billing@willowbend.example.org>
Sent: Monday, March 1, 2027 9:02 AM
To: Marcus Webb
Subject: Special assessment notice

Hello, this is a reminder that the special assessment has been billed to unit 22. Owners were first notified on February 8, 2027. The assessment is $1,200.00.`,
    expected: [
      { kind: "due", value: "2027-04-09" },
      { kind: "amount", value: "1200.00" },
    ],
  },
  // Not expected: the invoice date, the credit, the late fee start, the last payment day, the late fee.
  htmlMail({
    id: "h5-daycare-december-html",
    name: "Invoice 3318 from Little Acorn Child Care.email",
    from: "Little Acorn Child Care Example",
    writtenAt: Date.UTC(2026, 10, 24, 17),
    mailKind: "bill",
    html: `<html><body>
<p>Invoice 3318 &nbsp; Invoice date: 11/24/2026</p>
<table border="1" cellpadding="4">
<tr><td>Tuition, December 2026</td><td>$890.00</td></tr>
<tr><td>Sibling credit</td><td>-$25.00</td></tr>
<tr><td><b>Total</b></td><td><b>$865.00</b></td></tr>
<tr><td>Due date</td><td>12/01/2026</td></tr>
</table>
<p>Last payment received 11/03/2026. A late fee of $25.00 is added to accounts unpaid after 12/06/2026.</p>
<p>Thank you for choosing Little Acorn! We are closed December 24 to January 1.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "865.00" },
    ],
  }),
  // Not expected: nothing else printed.
  htmlMail({
    id: "h5-fibre-short-html",
    name: "Your Maplewood Fibre bill is ready.email",
    from: "Maplewood Fibre Example",
    writtenAt: Date.UTC(2027, 1, 8, 7),
    mailKind: "bill",
    html: `<html><body>
<p>Your bill is ready.</p>
<table>
<tr><td>Amount due</td><td>$89.99</td></tr>
<tr><td>Pay by</td><td>Feb 12, 2027</td></tr>
</table>
<p>View it in your account. Maplewood Fibre Example.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "amount", value: "89.99" },
    ],
  }),
  // Not expected: the violation day, the day the penalty is added, the penalty sum.
  {
    id: "h5-parking-citation",
    name: "Parking citation 7720-4481.email",
    mime: EMAIL,
    from: "City of Brookfield Parking Violations Bureau Example",
    writtenAt: Date.UTC(2026, 10, 30, 11),
    mailKind: "bill",
    text: `Parking citation no. 7720-4481

Violation date: 11/22/2026
Location: 400 block of Mill Street
Violation: Expired meter

Fine amount: $65.00
Pay by: 12/21/2026

A penalty of $65.00 is added to unpaid citations after 01/05/2027. You may contest this citation in writing before the pay-by date.

City of Brookfield Parking Violations Bureau Example`,
    expected: [
      { kind: "due", value: "2026-12-21" },
      { kind: "amount", value: "65.00" },
    ],
  },
  // Not expected: the instalment already paid and its day, the total premium, the paid to date, the remaining total.
  htmlMail({
    id: "h5-auto-ins-instalments-html",
    name: "Your remaining installments - policy P-558201.email",
    from: "Summit Auto Insurance Example",
    writtenAt: Date.UTC(2026, 11, 29, 8),
    mailKind: "bill",
    html: `<html><body>
<p>Policy P-558201. Installment 2 was received on 12/15/2026. Here are the installments still to come:</p>
<table border="1" cellpadding="4">
<tr><th>Installment</th><th>Due</th><th>Amount</th></tr>
<tr><td>3</td><td>01/15/2027</td><td>$218.00</td></tr>
<tr><td>4</td><td>02/15/2027</td><td>$218.00</td></tr>
<tr><td>5</td><td>03/15/2027</td><td>$218.00</td></tr>
</table>
<p>Total premium $1,090.00. Paid to date $436.00. Remaining $654.00.</p>
<p>Summit Auto Insurance Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "due", value: "2027-02-15" },
      { kind: "due", value: "2027-03-15" },
      { kind: "amount", value: "218.00" },
    ],
  }),
  // Not expected: the insurance payment day, the procedure total, the estimated insurance part.
  htmlMail({
    id: "h5-dental-patient-portion-html",
    name: "Your balance at Larch Dental Group.email",
    from: "Larch Dental Group Example",
    writtenAt: Date.UTC(2026, 11, 2, 15),
    mailKind: "bill",
    html: `<html><body>
<p>Hello,</p>
<p>Your insurance paid its share on 11/20/2026. The remaining balance is below.</p>
<table border="1" cellpadding="4">
<tr><td>Procedure total</td><td>$310.00</td></tr>
<tr><td>Insurance paid</td><td>$233.50</td></tr>
<tr><td>Patient portion</td><td>$76.50</td></tr>
<tr><td>Due date</td><td>12/30/2026</td></tr>
</table>
<p>Larch Dental Group Example | 555-0112</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-30" },
      { kind: "amount", value: "76.50" },
    ],
  }),
  // Not expected: the day of the first reminder.
  {
    id: "h5-gym-final",
    name: "Final notice - membership fee.email",
    mime: EMAIL,
    from: "Ironside Fitness Club Example",
    writtenAt: Date.UTC(2027, 5, 10, 9),
    mailKind: "bill",
    text: `FINAL NOTICE

Membership fee outstanding: $59.00
Final date to pay: 2027-06-24

We sent a first reminder on 2027-06-01. After the final date your access card is suspended.

Ironside Fitness Club Example`,
    expected: [
      { kind: "due", value: "2027-06-24" },
      { kind: "amount", value: "59.00" },
    ],
  },
  // Not expected: the statement date, the last payment day and sum, the outstanding principal, the next statement day.
  htmlMail({
    id: "h5-student-loan-html",
    name: "Your December student loan statement.email",
    from: "Crestline Student Loan Servicing Example",
    writtenAt: Date.UTC(2026, 11, 3, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Statement date: 12/03/2026</p>
<table border="1" cellpadding="4">
<tr><th>Summary</th><th></th></tr>
<tr><td>Amount due</td><td>$318.77</td></tr>
<tr><td>Due date</td><td>12/28/2026</td></tr>
<tr><td>Last payment received 11/27/2026</td><td>$318.77</td></tr>
<tr><td>Outstanding principal</td><td>$18,442.10</td></tr>
</table>
<p>Your next statement will be available on 01/03/2027. Having trouble paying? Ask about income-driven options.</p>
<p>Crestline Student Loan Servicing Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-28" },
      { kind: "amount", value: "318.77" },
    ],
  }),
  // Not expected: the day the new price applies, the old price, the new price.
  {
    id: "h5-streaming-price-change",
    name: "A small change to your plan price.email",
    mime: EMAIL,
    from: "StreamNest Example",
    writtenAt: Date.UTC(2027, 0, 4, 12),
    mailKind: "other",
    text: `Heads up on pricing

Starting with your billing on or after February 1, 2027, the Plus plan changes from $12.99 to $14.99 per month. You do not need to do anything.

Want to stay on the old price? You can switch to the annual plan in Settings.

StreamNest Example, 1 Harbour Row
Unsubscribe from product updates`,
    expected: [],
  },
  // Not expected: the notice day, the late fee start, the late fee.
  {
    id: "h5-registration-renewal-us",
    name: "Vehicle registration renewal notice.email",
    mime: EMAIL,
    from: "State Motor Vehicles Example",
    writtenAt: Date.UTC(2027, 1, 2, 10),
    mailKind: "bill",
    text: `Vehicle registration renewal notice
Notice date: 02/02/2027

Plate: 4KLM221
Renewal deadline: 03/17/2027
Registration fee: $168.00

Late renewals after 04/15/2027 carry a $25.00 late fee.

State Motor Vehicles Example`,
    expected: [
      { kind: "due", value: "2027-03-17" },
      { kind: "amount", value: "168.00" },
    ],
  },
  // Not expected: the day of the forwarded mail, the policy start day.
  {
    id: "h5-forward-home-premium",
    name: "Fwd: Premium notice - Policy H-440912.email",
    mime: EMAIL,
    from: "Carol Whitfield",
    writtenAt: Date.UTC(2026, 11, 14, 18),
    mailKind: "bill",
    text: `Hi love, can you take care of this one for me? I can't get into the portal. Thanks! Carol

---------- Forwarded message ---------
From: Harbor Mutual Insurance Example <billing@harbormutual.example.com>
Date: Tue, Dec 8, 2026 at 10:15 AM
Subject: Premium notice - Policy H-440912
To: Carol Whitfield

Dear Carol Whitfield,

Premium due: $603.00
Due date: January 8, 2027

Your renewal term starts January 15, 2027.

Harbor Mutual Insurance Example`,
    expected: [
      { kind: "due", value: "2027-01-08" },
      { kind: "amount", value: "603.00" },
    ],
  },
  // Not expected: the annual total, the second half bill day.
  htmlMail({
    id: "h5-county-tax-first-half-html",
    name: "First half property tax - parcel 08-4417-0032.email",
    from: "Marlow County Treasurer Example",
    writtenAt: Date.UTC(2026, 10, 12, 8),
    mailKind: "bill",
    html: `<html><body>
<p>Parcel 08-4417-0032</p>
<table border="1" cellpadding="4">
<tr><td>Annual tax</td><td>$4,280.00</td></tr>
<tr><td>First half amount due</td><td><b>$2,140.00</b></td></tr>
<tr><td>Due</td><td>12/10/2026</td></tr>
</table>
<p>The second half bill will be mailed on or about 04/01/2027.</p>
<p>Marlow County Treasurer Example. Pay online, by mail or in person.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-10" },
      { kind: "amount", value: "2140.00" },
    ],
  }),
  // Not expected: the date of the visit.
  {
    id: "h5-dental-sentence",
    name: "Balance after your visit.email",
    mime: EMAIL,
    from: "Brightside Family Dental Example",
    writtenAt: Date.UTC(2027, 1, 17, 16),
    mailKind: "bill",
    text: `Hi Jo,

After insurance, the balance for your visit on January 27, 2027 is $134.00. Please settle it by March 5, 2027, or call us to set up a plan.

Brightside Family Dental Example`,
    expected: [
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "134.00" },
    ],
  },
  // Not expected: the discount end day, the list price.
  htmlMail({
    id: "h5-reading-club-renewal-html",
    name: "Your membership renews soon.email",
    from: "Cobalt Reading Club Example",
    writtenAt: Date.UTC(2027, 1, 10, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Hello reader,</p>
<p>Your annual membership renews on <b>March 3, 2027</b> and $89.00 will be charged to the card ending 5530.</p>
<p>List price <s>$99.00</s>. Your member rate: $89.00.</p>
<p>Switch to the two-year plan by February 20, 2027 and lock in the member rate until 2029.</p>
<p>Cobalt Reading Club Example | Manage membership</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-03" },
      { kind: "amount", value: "89.00" },
    ],
  }),
  // Not expected: the trip day, the bus part and the museum part.
  htmlMail({
    id: "h5-school-trip-noyear-html",
    name: "Spring trip fees.email",
    from: "Riverside Public School Parent Council Example",
    writtenAt: Date.UTC(2027, 0, 14, 13),
    mailKind: "bill",
    html: `<html><body>
<p>Dear parents,</p>
<table border="1" cellpadding="4">
<tr><td>Bus</td><td>$25.00</td></tr>
<tr><td>Museum entry</td><td>$60.00</td></tr>
<tr><td>Trip fee</td><td>$85.00</td></tr>
<tr><td>Please pay by</td><td>Jan 29</td></tr>
<tr><td>Trip day</td><td>Feb 10</td></tr>
</table>
<p>Pay through the school online store. Riverside Public School Parent Council Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-29" },
      { kind: "amount", value: "85.00" },
    ],
  }),
  // Not expected: the credit on account, the annual dues figure, the annual meeting day.
  {
    id: "h5-hoa-dues-and-form",
    name: "2027 annual dues and compliance form.email",
    mime: EMAIL,
    from: "Stonegate Community Association Example",
    writtenAt: Date.UTC(2027, 0, 8, 10),
    mailKind: "bill",
    text: `Dear Stonegate neighbor,

Your 2027 annual dues are enclosed.

Annual dues ............ $540.00
Credit on account ...... -$20.00
Amount due ............. $520.00

Payment due: January 31, 2027

Please also return the signed architectural compliance form by February 14, 2027. The form is attached to this email.

The annual owners' meeting will be held on March 6, 2027 at the clubhouse.

Stonegate Community Association Example`,
    expected: [
      { kind: "due", value: "2027-01-31" },
      { kind: "due", value: "2027-02-14" },
      { kind: "amount", value: "520.00" },
    ],
  },
  // Not expected: the trip day.
  {
    id: "h5-school-fee-noyear",
    name: "Field trip fee.email",
    mime: EMAIL,
    from: "Oak Hollow Elementary Example",
    writtenAt: Date.UTC(2027, 0, 22, 12),
    mailKind: "bill",
    text: `Hello families,
Field trip fee: $42.00
Due: Feb 5
The trip is on Feb 19.
Oak Hollow Elementary Example office`,
    expected: [
      { kind: "due", value: "2027-02-05" },
      { kind: "amount", value: "42.00" },
    ],
  },
  // Not expected: the service period, the previous balance, the payment received, the next reading day.
  {
    id: "h5-water-quarterly",
    name: "Quarterly water and sewer statement.email",
    mime: EMAIL,
    from: "Clearwater Municipal Water Example",
    writtenAt: Date.UTC(2026, 11, 10, 8),
    mailKind: "bill",
    text: `Quarterly water and sewer statement

Service period: Sept 5, 2026 - Dec 5, 2026
Previous balance .............. $88.10
Payment received Oct 28, 2026 . -$88.10
Current charges ............... $96.34

BALANCE DUE: $96.34
Due by 01/04/2027

Next meter reading is scheduled for 03/05/2027. Late balances may be added to your property tax bill.

Clearwater Municipal Water Example
Customer service 555-0129`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "96.34" },
    ],
  },
  // Not expected: the quote date, the start of work, the subtotal, the tax, the deposit.
  htmlMail({
    id: "h5-roof-quote-html",
    name: "Quote Q-1182 for your roof repair.email",
    from: "Ironwood Roofing Example",
    writtenAt: Date.UTC(2026, 11, 18, 14),
    mailKind: "other",
    html: `<html><body>
<p>Quote Q-1182, prepared December 18, 2026</p>
<table border="1" cellpadding="4">
<tr><td>Materials</td><td>$2,310.00</td></tr>
<tr><td>Labour</td><td>$2,150.00</td></tr>
<tr><td>Subtotal</td><td>$4,460.00</td></tr>
<tr><td>Sales tax</td><td>$400.00</td></tr>
<tr><td><b>Quote total</b></td><td><b>$4,860.00</b></td></tr>
<tr><td>Deposit on acceptance</td><td>$1,000.00</td></tr>
</table>
<p>This quote is valid until January 29, 2027. If accepted, work can begin the week of February 8, 2027.</p>
<p>Ironwood Roofing Example</p>
</body></html>`,
    expected: [
      { kind: "expiry", value: "2027-01-29" },
      { kind: "amount", value: "4860.00" },
    ],
  }),
  // Not expected: the day of the forwarded mail.
  {
    id: "h5-forward-nursery-invoice",
    name: "Fwd: Tuition invoice for February.email",
    mime: EMAIL,
    from: "Tom Alvarez",
    writtenAt: Date.UTC(2027, 0, 19, 20),
    mailKind: "bill",
    text: `Can you pay this one? I'm travelling until the weekend.

> From: Sunbeam Early Learning Example <accounts@sunbeam.example.org>
> Date: Mon, Jan 18, 2027 at 8:00 AM
> Subject: Tuition invoice for February
>
> Tuition invoice for February.
> Amount due: $920.00
> Due date: February 1, 2027`,
    expected: [
      { kind: "due", value: "2027-02-01" },
      { kind: "amount", value: "920.00" },
    ],
  },
  // Not expected: the billing period, the previous balance, the next bill day.
  htmlMail({
    id: "h5-utilities-ca-html",
    name: "Your spring utilities bill.email",
    from: "City of Fairmont Utilities Example",
    writtenAt: Date.UTC(2027, 3, 8, 9),
    mailKind: "bill",
    html: `<html><body>
<table border="1" cellpadding="4">
<tr><td>Billing period</td><td>2027-01-10 to 2027-04-05</td></tr>
<tr><td>Previous balance (paid 2027-03-29)</td><td>$198.60</td></tr>
<tr><td>Amount due</td><td>$214.80</td></tr>
<tr><td>Due date</td><td>Monday, May 3, 2027</td></tr>
<tr><td>Next bill date</td><td>2027-07-12</td></tr>
</table>
<p>City of Fairmont Utilities Example | 311</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-03" },
      { kind: "amount", value: "214.80" },
    ],
  }),
  // Not expected: the statement date, the previous balance, the payment, the minimum payment, the next statement day, the payment received day.
  {
    id: "h5-credit-card-ca",
    name: "Your credit card statement is ready.email",
    mime: EMAIL,
    from: "Northshore Credit Card Services Example",
    writtenAt: Date.UTC(2026, 11, 22, 11),
    mailKind: "bill",
    text: `Statement date: 2026-12-22

Previous balance .............. $1,502.66
Payment received 2026-12-04 ... -$1,502.66
Purchases and fees ............ $1,845.30
New balance ................... $1,845.30

Minimum payment ............... $45.00
Payment due date .............. 2027-01-16

Your next statement date is 2027-01-22.

Northshore Credit Card Services Example
Interest is charged on unpaid balances.`,
    expected: [
      { kind: "due", value: "2027-01-16" },
      { kind: "amount", value: "1845.30" },
    ],
  },
  // Not expected: the original due day, the dues part, the late fee part.
  {
    id: "h5-hoa-past-due",
    name: "Past due dues reminder.email",
    mime: EMAIL,
    from: "Juniper Hills HOA Example",
    writtenAt: Date.UTC(2027, 2, 15, 9),
    mailKind: "bill",
    text: `Our records show your dues of $450.00, originally due March 1, 2027, are unpaid. A late fee of $35.00 has been added.

Total to pay: $485.00
Cure by: March 31, 2027

Juniper Hills HOA Example`,
    expected: [
      { kind: "due", value: "2027-03-31" },
      { kind: "amount", value: "485.00" },
    ],
  },
  // Not expected: the refund amount, the day of the refund.
  {
    id: "h5-refund-notice",
    name: "Your refund has been approved.email",
    mime: EMAIL,
    from: "Provincial Revenue Agency Example",
    writtenAt: Date.UTC(2027, 0, 27, 10),
    mailKind: "other",
    text: `Your refund of $642.10 has been approved and will be issued by February 12, 2027. No action is required.

If your banking details have changed, update them in your online account.
Provincial Revenue Agency Example`,
    expected: [],
  },
  // Not expected: the credit, the fall term end, the charges, the balance label's other figures.
  htmlMail({
    id: "h5-tuition-balance-html",
    name: "Winter term tuition balance.email",
    from: "Northgate College Example",
    writtenAt: Date.UTC(2026, 11, 7, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Student 4471902</p>
<table border="1" cellpadding="4">
<tr><td>Tuition and fees, winter term</td><td>$4,950.00</td></tr>
<tr><td>Scholarship credit</td><td>-$1,500.00</td></tr>
<tr><td>Balance</td><td>$3,450.00</td></tr>
</table>
<p>Your balance must be paid in full by January 15, 2027 or your winter registration will be cancelled. The fall term ends on December 18, 2026.</p>
<p>Northgate College Example, Student Accounts</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "amount", value: "3450.00" },
    ],
  }),
  // Not expected: the device installment.
  {
    id: "h5-wireless-autopay",
    name: "Your Birchtel bill is ready.email",
    mime: EMAIL,
    from: "Birchtel Wireless Example",
    writtenAt: Date.UTC(2026, 11, 12, 8),
    mailKind: "bill",
    text: `Your bill is ready: $64.10 (includes a $22.00 device installment).
AutoPay date: December 20, 2026
Birchtel Wireless Example`,
    expected: [
      { kind: "due", value: "2026-12-20" },
      { kind: "amount", value: "64.10" },
    ],
  },
  // Not expected: the notice day, the return received day, the total tax, the payments, the day interest starts.
  {
    id: "h5-tax-notice-ca",
    name: "Notice of assessment, tax year 2026.email",
    mime: EMAIL,
    from: "Federal Revenue Agency Example",
    writtenAt: Date.UTC(2027, 2, 9, 12),
    mailKind: "bill",
    text: `Notice of assessment, tax year 2026
Return received: February 20, 2027

Total tax ........... $7,810.75
Payments made ....... -$5,500.00
Balance owing ....... $2,310.75

Pay on or before: April 30, 2027

Interest starts to accrue on May 1, 2027 on any unpaid amount.

Federal Revenue Agency Example`,
    expected: [
      { kind: "due", value: "2027-04-30" },
      { kind: "amount", value: "2310.75" },
    ],
  },
  // Not expected: nothing else printed.
  {
    id: "h5-power-short",
    name: "Your Aurora Power bill is ready.email",
    mime: EMAIL,
    from: "Aurora Power Example",
    writtenAt: Date.UTC(2026, 11, 14, 7),
    mailKind: "bill",
    text: `Your bill is ready.
Account 5521
Amount: $142.18
Due: Dec 30, 2026`,
    expected: [
      { kind: "due", value: "2026-12-30" },
      { kind: "amount", value: "142.18" },
    ],
  },
  // Not expected: the last payment day, the remaining principal, the maturity day.
  htmlMail({
    id: "h5-auto-loan-html",
    name: "Auto loan statement.email",
    from: "Keystone Auto Finance Example",
    writtenAt: Date.UTC(2027, 2, 4, 10),
    mailKind: "bill",
    html: `<html><body>
<table border="1" cellpadding="4">
<tr><td>Payment amount</td><td>$412.00</td></tr>
<tr><td>Payment due</td><td>2027-03-20</td></tr>
<tr><td>Past due</td><td>$0.00</td></tr>
<tr><td>Last payment received 2027-02-18</td><td>$412.00</td></tr>
<tr><td>Remaining principal</td><td>$11,980.45</td></tr>
<tr><td>Loan maturity</td><td>2029-08-20</td></tr>
</table>
<p>Keystone Auto Finance Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-20" },
      { kind: "amount", value: "412.00" },
    ],
  }),
  // Not expected: the day the late charge is added, the late charge, the last payment day.
  {
    id: "h5-rent-reminder",
    name: "Rent not received - January.email",
    mime: EMAIL,
    from: "Sycamore Property Management Example",
    writtenAt: Date.UTC(2027, 0, 12, 9),
    mailKind: "bill",
    text: `Hello,

Rent for January 2027 of $1,650.00 has not been received. Your last payment came in on December 2, 2026.

Pay by: January 20, 2027

A late charge of $75.00 will be added on January 25, 2027.

Sycamore Property Management Example`,
    expected: [
      { kind: "due", value: "2027-01-20" },
      { kind: "amount", value: "1650.00" },
    ],
  },
  // Not expected: the offence day.
  {
    id: "h5-bylaw-penalty",
    name: "Penalty notice.email",
    mime: EMAIL,
    from: "City of Westmoor Bylaw Enforcement Example",
    writtenAt: Date.UTC(2026, 11, 21, 10),
    mailKind: "bill",
    text: `Penalty notice
Offence date: 2026-11-29
Penalty: $120.00
Pay or request review by: 2027-01-22
City of Westmoor Bylaw Enforcement Example`,
    expected: [
      { kind: "due", value: "2027-01-22" },
      { kind: "amount", value: "120.00" },
    ],
  },
  // Not expected: the closing date, the previous balance, the payment and its day, the minimum payment, the next closing day, the promo end.
  htmlMail({
    id: "h5-credit-card-us-html",
    name: "Your May statement.email",
    from: "Granite Card Services Example",
    writtenAt: Date.UTC(2027, 4, 6, 8),
    mailKind: "bill",
    html: `<html><body>
<table border="1" cellpadding="4">
<tr><td>Statement closing date</td><td>05/04/2027</td></tr>
<tr><td>Previous balance</td><td>$1,904.12</td></tr>
<tr><td>Payment 04/20/2027</td><td>-$1,904.12</td></tr>
<tr><td>New purchases</td><td>$2,204.18</td></tr>
<tr><td>New balance</td><td>$2,204.18</td></tr>
<tr><td>Minimum payment due</td><td>$35.00</td></tr>
<tr><td>Payment due date</td><td>06/01/2027</td></tr>
</table>
<p>Your next closing date is 06/04/2027. Your promotional APR ends 07/31/2027.</p>
<p>Granite Card Services Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-06-01" },
      { kind: "amount", value: "2204.18" },
    ],
  }),
  // Not expected: the service day, the processing day, the total charges, the adjustment, the insurance payment.
  {
    id: "h5-hospital-bill",
    name: "Patient statement after insurance.email",
    mime: EMAIL,
    from: "Riverbend Hospital Billing Example",
    writtenAt: Date.UTC(2027, 1, 24, 10),
    mailKind: "bill",
    text: `Patient statement

Date of service: 01/09/2027
Insurance processed: 02/11/2027

Total charges ............. $2,716.00
Insurance adjustment ...... -$1,640.88
Insurance paid ............ -$686.00

Amount you owe: $389.12
Remit by: 03/26/2027

Riverbend Hospital Billing Example`,
    expected: [
      { kind: "due", value: "2027-03-26" },
      { kind: "amount", value: "389.12" },
    ],
  },
  // Not expected: the invoice day, the prior invoice day, the subtotal, the GST.
  htmlMail({
    id: "h5-software-invoice-html",
    name: "Invoice for your annual plan.email",
    from: "Quillstack Software Example",
    writtenAt: Date.UTC(2026, 10, 18, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Invoice date: 2026-11-18. Your previous invoice, due 2026-10-18, was paid.</p>
<table border="1" cellpadding="4">
<tr><td>Subtotal</td><td>CAD 331.43</td></tr>
<tr><td>GST (5%)</td><td>CAD 16.57</td></tr>
<tr><td>Total</td><td>CAD 348.00</td></tr>
<tr><td>Due date</td><td>2026-12-18</td></tr>
</table>
<p>Quillstack Software Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "348.00" },
    ],
  }),
  // Not expected: the paid November rent day, the late fee start, the late fee.
  htmlMail({
    id: "h5-rent-invoice-html",
    name: "December rent invoice.email",
    from: "Alder Court Apartments Example",
    writtenAt: Date.UTC(2026, 10, 10, 9),
    mailKind: "bill",
    html: `<html><body>
<p>November rent was paid on 11/03/2026. Thank you.</p>
<table border="1" cellpadding="4">
<tr><td>December rent</td><td>$1,980.00</td></tr>
<tr><td>Rent due</td><td>12/01/2026</td></tr>
</table>
<p>A late fee of $99.00 applies after 12/06/2026.</p>
<p>Alder Court Apartments Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "1980.00" },
    ],
  }),
  // Not expected: the day the renewal term begins, last year's premium.
  {
    id: "h5-home-insurance-noyear",
    name: "Your home insurance premium notice.email",
    mime: EMAIL,
    from: "Maple Shield Insurance Example",
    writtenAt: Date.UTC(2026, 11, 11, 10),
    mailKind: "bill",
    text: `Home insurance premium notice
Notice date: Dec 11

Premium: $1,128.00 (last year: $1,042.00)
Premium due: Jan 4
Your renewal term begins Jan 15.

Maple Shield Insurance Example`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "1128.00" },
    ],
  },
  // Not expected: the next meter read day.
  {
    id: "h5-gas-short-noyear",
    name: "Your gas bill is ready.email",
    mime: EMAIL,
    from: "Tri-County Gas Example",
    writtenAt: Date.UTC(2026, 11, 17, 8),
    mailKind: "bill",
    text: `Your gas bill is ready.
Amount due: $73.28
Pay by: Jan 11
Next meter read: Jan 20`,
    expected: [
      { kind: "due", value: "2027-01-11" },
      { kind: "amount", value: "73.28" },
    ],
  },
];
