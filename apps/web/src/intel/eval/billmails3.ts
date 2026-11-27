/**
 * Bills, notices and statements that arrive by mail, written without sight
 * of the readers. A part of the first set: its cases are read and worked on.
 */

import { mailBodyText } from "../htmltext";
import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

/** An HTML mail: the body rides as `raw`, as the app passes it, and its text is what the app's own step makes of it. */
const htmlMail = (c: Omit<EvalCase, "mime" | "text" | "raw"> & { html: string }): EvalCase => {
  const { html, ...rest } = c;
  return { ...rest, mime: EMAIL, text: mailBodyText({ html }), raw: html };
};

export const BILL_MAIL3_CASES: readonly EvalCase[] = [
  // Not expected: the date the insurer processed the claim, billed charges, the insurance payment, the contract adjustment.
  {
    id: "b3-us-eob-clinic",
    name: "Your balance after insurance - Lakeview Family Clinic Example.email",
    mime: EMAIL,
    from: "Lakeview Family Clinic Example",
    writtenAt: Date.UTC(2026, 10, 12, 15),
    mailKind: "bill",
    text: `Dear Jordan Whitfield,

Your insurance plan has finished processing the claim for your visit. Here is what is left for you.

Patient account: 20-558314
Insurance processed claim on: 11/06/2026

Billed charges ............ $486.00
Contract adjustment ....... -$131.20
Paid by Evergreen Health Plan Example ... -$142.40
-----------------------------------------
Patient responsibility .... $212.40

Please send payment by 12/14/2026 using the link in your patient portal, by phone, or by check to the billing office.
Questions about this bill? Call 555-0142 weekdays 8am to 5pm.

Lakeview Family Clinic Example, Billing Office
This message contains information about your account. If you received it in error, please delete it.`,
    expected: [
      { kind: "due", value: "2026-12-14" },
      { kind: "amount", value: "212.40" },
    ],
  },
  // Not expected: the new tax class start day (no-year mail), the standard rate.
  {
    id: "b3-uk-vehicle-tax-short",
    name: "Your vehicle tax is ready to renew.email",
    mime: EMAIL,
    from: "Motor Licensing Office Example",
    writtenAt: Date.UTC(2026, 10, 20, 9),
    mailKind: "bill",
    text: `Hello,

Vehicle: KD19 EXM
Tax for 12 months: 195.00 GBP
Pay by 18 December to keep the vehicle taxed without a gap.

Your new tax will start on 1 January once payment clears.

Pay online or by Direct Debit through your account. This is an automated message, please do not reply.`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "195.00" },
    ],
  },
  // Not expected: the penalty start day, the renewal fee alone, the admin charge alone.
  htmlMail({
    id: "b3-za-licence-disc-html",
    name: "Licence disc renewal notice - VKC1423 GP.email",
    from: "Provincial Licensing Department Example",
    writtenAt: Date.UTC(2027, 0, 11, 7),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial">
<h3>Motor vehicle licence renewal</h3>
<p>Dear owner,</p>
<p>The licence disc for your vehicle is due for renewal.</p>
<table border="1" cellpadding="4">
<tr><td>Registration</td><td>VKC 142 GP</td></tr>
<tr><td>Renewal fee</td><td>R 912.00</td></tr>
<tr><td>Administration charge</td><td>R 130.00</td></tr>
<tr><td><b>Total payable</b></td><td><b>R 1 042.00</b></td></tr>
<tr><td>Pay on or before</td><td>Friday, 12 February 2027</td></tr>
<tr><td>Penalty applies from</td><td>13 February 2027</td></tr>
</table>
<p>Pay at any participating post office or at your nearest licensing centre. Quote reference LD-77120-Z.</p>
<p style="font-size:10px">Provincial Licensing Department Example. Do not reply to this message.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "amount", value: "1042.00" },
    ],
  }),
  // Not expected: the date of the last payment, the sinking fund alone, the maintenance charge alone, the quarter.
  {
    id: "b3-in-society-dues",
    name: "Maintenance bill Oct-Dec quarter - Shanti Nagar CHS.email",
    mime: EMAIL,
    from: "Shanti Nagar Cooperative Housing Society Example",
    writtenAt: Date.UTC(2026, 10, 30, 6),
    mailKind: "bill",
    text: `Flat No. B-304, Shanti Nagar CHS Example

Maintenance bill for quarter ending 31/12/2026
Bill date : 30/11/2026

Maintenance charges     3500.00
Sinking fund             400.00
Parking                  250.00
Lift AMC                 500.00
Total                   4650.00

Last payment received on 05/11/2026 (Rs. 4650.00).

Members are requested to pay the total amount on or before 15/12/2026 at the society office or by NEFT to the society account. Cheques to be drawn in favour of the society.

Hon. Secretary
Shanti Nagar Cooperative Housing Society Example`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "4650.00" },
    ],
  },
  // Not expected: the fall payment received, the late fee start day, the single instalment of 1,200.00.
  htmlMail({
    id: "b3-us-tuition-instalments-html",
    name: "Spring 2027 tuition - payment plan schedule.email",
    from: "Ridgemont Academy Example, Business Office",
    writtenAt: Date.UTC(2026, 11, 1, 16),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Parent or Guardian of Maya Okonkwo,</p>
<p>Your spring tuition payment plan is set up. The remaining balance is shown below.</p>
<table border="1" cellspacing="0" cellpadding="5">
<tr><th>Instalment</th><th>Due date</th><th>Amount</th></tr>
<tr><td>Spring 1 of 2</td><td>01/05/2027</td><td>$1,200.00</td></tr>
<tr><td>Spring 2 of 2</td><td>02/05/2027</td><td>$1,200.00</td></tr>
</table>
<p>Remaining balance on plan: <b>$2,400.00</b></p>
<p>Fall payment received 08/21/2026. A $50.00 late fee is added to any instalment not paid by the 10th of its month, starting 01/11/2027.</p>
<p>Business Office, Ridgemont Academy Example. This mailbox is not monitored.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-05" },
      { kind: "due", value: "2027-02-05" },
      { kind: "amount", value: "2400.00" },
    ],
  }),
  // Not expected: the bill date, the previous bill sum, the price rise day.
  {
    id: "b3-uk-broadband-short",
    name: "Your broadband bill for November.email",
    mime: EMAIL,
    from: "Fibrelink Broadband Example",
    writtenAt: Date.UTC(2026, 10, 24, 10),
    mailKind: "bill",
    text: `Hi Priya,

Your bill dated 24/11/2026 is ready: 38.50.
Last month you paid 36.00.

We will collect 38.50 by Direct Debit on 3 Dec 2026.

From 1 Apr 2027 your monthly price goes up by 1.50.

Fibrelink Broadband Example. Registered in England. Need help? Visit the help centre.`,
    expected: [
      { kind: "due", value: "2026-12-03" },
      { kind: "amount", value: "38.50" },
    ],
  },
  // Not expected: the cover period, the previous balance, the member and dependant contributions.
  {
    id: "b3-za-medical-aid-statement",
    name: "Contribution statement - January 2027 cover.email",
    mime: EMAIL,
    from: "Cape Coast Medical Scheme Example",
    writtenAt: Date.UTC(2026, 11, 2, 8),
    mailKind: "bill",
    text: `Member: Mr T. Naidoo        Membership no: 4471920

CONTRIBUTION STATEMENT

Statement date:        02 December 2026
Cover period:          01 January 2027 to 31 January 2027
Previous balance:      R 0.00
Principal member:      R 3 100.00
Adult dependant:       R 2 540.00
Child dependant:       R 1 205.00
Total contribution:    R 6 845.00

Payment due:           30 December 2026

Late contributions may lead to suspension of benefits. Please use your membership number as the payment reference.

Cape Coast Medical Scheme Example is a registered scheme. Queries: members@example.org`,
    expected: [
      { kind: "due", value: "2026-12-30" },
      { kind: "amount", value: "6845.00" },
    ],
  },
  // Not expected: the last payment day, the next meter read day, the previous charges.
  htmlMail({
    id: "b3-us-water-sewer-html",
    name: "Water and sewer bill - account 77-3201.email",
    from: "Dunmore Water and Sewer District Example",
    writtenAt: Date.UTC(2027, 0, 19, 13),
    mailKind: "bill",
    html: `<html><body>
<h2>Water and Sewer Statement</h2>
<table cellpadding="3">
<tr><td>Account</td><td>77-3201</td></tr>
<tr><td>Bill date</td><td>2027-01-19</td></tr>
<tr><td>Previous balance</td><td>$138.20</td></tr>
<tr><td>Payment received 2026-12-30</td><td>-$138.20</td></tr>
<tr><td>Water usage (14 units)</td><td>$61.44</td></tr>
<tr><td>Sewer service</td><td>$82.33</td></tr>
<tr><td><b>Amount due</b></td><td><b>$143.77</b></td></tr>
<tr><td>Pay by</td><td>2027-02-16</td></tr>
<tr><td>Next meter read</td><td>2027-03-10</td></tr>
</table>
<p>Pay online, by mail or at the district office.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-16" },
      { kind: "amount", value: "143.77" },
    ],
  }),
  // Not expected: the late fee start day, the late fee, the semester fee paid earlier.
  {
    id: "b3-in-exam-fee-short",
    name: "Exam fee payment - Semester 2.email",
    mime: EMAIL,
    from: "Vidyasagar Institute of Technology Example",
    writtenAt: Date.UTC(2026, 11, 5, 11),
    mailKind: "bill",
    text: `Dear Student,

Semester 2 examination fee is now open for payment.

Fee payable : Rs. 1250.00
Last date for fee payment : 09-Jan-2027
Late fee of Rs. 500.00 will be charged from 10-Jan-2027.

Pay through the student portal. Fee of 14-Aug-2026 (Semester 1) is not included.

Controller of Examinations
Vidyasagar Institute of Technology Example`,
    expected: [
      { kind: "due", value: "2027-01-09" },
      { kind: "amount", value: "1250.00" },
    ],
  },
  // Not expected: the instalment of 410.00 alone, the bill issue day, the band change day, the earlier-year bill sum.
  htmlMail({
    id: "b3-uk-council-tax-supplementary-html",
    name: "Council tax: supplementary bill for 2026-27.email",
    from: "Brookshire Borough Council Example",
    writtenAt: Date.UTC(2027, 2, 8, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Mr Hallam,</p>
<p>Following a change to your property band from 14 September 2026, we have issued a supplementary bill for the current year. Issue date: 8 March 2027.</p>
<table border="1" cellpadding="4">
<tr><th>Description</th><th>Amount</th></tr>
<tr><td>Additional council tax 2026-27</td><td>&pound;820.00</td></tr>
<tr><td>Balance to pay</td><td>&pound;820.00</td></tr>
</table>
<p>As agreed by telephone, this is split into two instalments:</p>
<table border="1" cellpadding="4">
<tr><th>Instalment</th><th>Date</th><th>Amount</th></tr>
<tr><td>1</td><td>1 April 2027</td><td>&pound;410.00</td></tr>
<tr><td>2</td><td>1 May 2027</td><td>&pound;410.00</td></tr>
</table>
<p>Your 2025-26 account was closed with a zero balance on 31 March 2026.</p>
<p>Brookshire Borough Council Example, Revenues Service</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-01" },
      { kind: "due", value: "2027-05-01" },
      { kind: "amount", value: "820.00" },
    ],
  }),
  // Not expected: the date of service, the billed total, the insurance payment, the date of the original mail.
  {
    id: "b3-us-ortho-forward",
    name: "Fwd: Statement from Riverside Orthopaedics.email",
    mime: EMAIL,
    from: "Sam Okafor",
    writtenAt: Date.UTC(2026, 10, 16, 19),
    mailKind: "bill",
    text: `Dad, this came for you at my address by mistake. Can you pay it? I do not have the login for the portal.
Sam

-----Original Message-----
From: Riverside Orthopaedics Example <billing@example.com>
Sent: Friday, November 13, 2026 9:12 AM
To: Sam Okafor
Subject: Statement from Riverside Orthopaedics

Patient: Daniel Okafor
Date of service: November 3, 2026

Total billed:                 $540.00
Allowed by your plan:         $310.00
Paid by insurance:            $222.50
Amount you owe:               $87.50

Please pay by December 4, 2026 to avoid collection referral.

Riverside Orthopaedics Example`,
    expected: [
      { kind: "due", value: "2026-12-04" },
      { kind: "amount", value: "87.50" },
    ],
  },
  // Not expected: the account date, the meter reading day, the subtotal of services, the opening balance.
  htmlMail({
    id: "b3-za-rates-account-html",
    name: "Municipal account for February 2027.email",
    from: "Karoo Hills Local Municipality Example",
    writtenAt: Date.UTC(2027, 1, 10, 6),
    mailKind: "bill",
    html: `<html><body style="font-family:Verdana;font-size:12px">
<table width="520" border="0" cellpadding="3">
<tr><td colspan="2"><b>RATES AND SERVICES ACCOUNT</b></td></tr>
<tr><td>Account number</td><td>0045 8812 3</td></tr>
<tr><td>Account date</td><td>10/02/2027</td></tr>
<tr><td>Opening balance</td><td>R 0.00</td></tr>
<tr><td>Property rates</td><td>R 1 102.00</td></tr>
<tr><td>Water</td><td>R 904.65</td></tr>
<tr><td>Refuse removal</td><td>R 380.00</td></tr>
<tr><td>Sewerage</td><td>R 520.00</td></tr>
<tr><td>Subtotal: municipal services</td><td>R 2 906.65</td></tr>
<tr><td>Electricity (prepaid top-up arrears)</td><td>R 377.50</td></tr>
<tr><td><b>TOTAL DUE</b></td><td><b>R 3 284.15</b></td></tr>
<tr><td>Payment must reach us by</td><td>05/03/2027</td></tr>
<tr><td>Next meter reading</td><td>20/03/2027</td></tr>
</table>
<p>Interest is charged on overdue accounts.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "3284.15" },
    ],
  }),
  // Not expected: the new fee start day, nothing else dated.
  {
    id: "b3-in-rc-renewal-short",
    name: "Registration certificate renewal - MH12 vehicle.email",
    mime: EMAIL,
    from: "Regional Transport Office Example",
    writtenAt: Date.UTC(2027, 0, 6, 5),
    mailKind: "bill",
    text: `Dear Vehicle Owner,

The registration certificate of your vehicle is eligible for renewal. The renewal fee is Rs. 5000.00 and you should complete the online renewal on or before 20.02.2027 to avoid a penalty.

Please note that the fee schedule will be revised with effect from 01.04.2027.

Regards,
Regional Transport Office Example
This is a system generated mail.`,
    expected: [
      { kind: "due", value: "2027-02-20" },
      { kind: "amount", value: "5000.00" },
    ],
  },
  // Not expected: the original due day, the overdue amount, the reminder fee, the date of the earlier reminder.
  {
    id: "b3-uk-energy-reply-reminder",
    name: "Re: Your gas and electricity bill.email",
    mime: EMAIL,
    from: "Northfield Power Example",
    writtenAt: Date.UTC(2026, 11, 9, 11),
    mailKind: "bill",
    text: `Dear Ms Dube,

We have not yet had payment for the bill below, so a reminder fee has been added. The total to pay is now 142.19. Final date to pay: 23 December 2026.

If you have already paid, please ignore this note.

Customer Accounts, Northfield Power Example

> From: Northfield Power Example
> Sent: 25 November 2026 08:30
> Subject: Your gas and electricity bill
>
> Amount overdue: 130.19
> Reminder fee: 12.00
> Payment was due on 2 December 2026.
> Please pay as soon as you can.`,
    expected: [
      { kind: "due", value: "2026-12-23" },
      { kind: "amount", value: "142.19" },
    ],
  },
  // Not expected: the notice mailing day, the penalty start day, the first-half payment day, the first-half amount, the annual total.
  htmlMail({
    id: "b3-us-property-tax-html",
    name: "Second half property tax - parcel 118-44-902.email",
    from: "Calder County Treasurer Example",
    writtenAt: Date.UTC(2026, 10, 18, 17),
    mailKind: "bill",
    html: `<html><body>
<h3>Calder County Property Tax Notice</h3>
<p>Parcel 118-44-902. Notice mailed 10/15/2026.</p>
<table border="1" cellpadding="4">
<tr><td>Annual tax</td><td>$4,636.00</td></tr>
<tr><td>First half paid 05/28/2026</td><td>$2,318.00</td></tr>
<tr><td><b>Second half balance</b></td><td><b>$2,318.00</b></td></tr>
</table>
<p><b>Second installment due:</b> 12/10/2026</p>
<p>A 10% penalty is added to unpaid balances beginning 12/11/2026. Pay online, by mail, or at the Treasurer's window.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-10" },
      { kind: "amount", value: "2318.00" },
    ],
  }),
  // Not expected: the bill date, the disconnection day, the late-payment amount, the arrears.
  htmlMail({
    id: "b3-in-electricity-html",
    name: "Electricity bill for the month of November.email",
    from: "Deccan Power Distribution Example",
    writtenAt: Date.UTC(2026, 11, 14, 4),
    mailKind: "bill",
    html: `<html><body>
<p>Consumer No. 220-118-4433</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th>Bill Date</th><th>Due Date</th><th>Disconnection Date</th><th>Net Payable</th></tr>
<tr><td>14-Dec-2026</td><td>02-Jan-2027</td><td>20-Jan-2027</td><td>Rs. 1,876.00</td></tr>
</table>
<p>Arrears: Rs. 0.00. Amount payable after due date: Rs. 1,914.00.</p>
<p>Pay via the mobile app, UPI or any collection centre.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-02" },
      { kind: "amount", value: "1876.00" },
    ],
  }),
  // Not expected: the autumn payment day, the term start day.
  {
    id: "b3-uk-nursery-spring-short",
    name: "Spring term fees - Little Acorns Nursery.email",
    mime: EMAIL,
    from: "Little Acorns Nursery Example",
    writtenAt: Date.UTC(2026, 10, 27, 12),
    mailKind: "bill",
    text: `Dear parents,

Spring term fees are now ready.

Total fees: £1,980.00
Payment deadline: 4 January 2027

We received your autumn payment on 9 September 2026, thank you. Spring term begins on 11 January 2027.

Bank details are on the invoice in your parent app.
Little Acorns Nursery Example`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "1980.00" },
    ],
  },
  // Not expected: the last licence renewal day, the penalty start day, the admin amount alone.
  {
    id: "b3-za-licence-forward",
    name: "FW: Licence renewal notice.email",
    mime: EMAIL,
    from: "Lerato Mokoena",
    writtenAt: Date.UTC(2027, 2, 3, 18),
    mailKind: "bill",
    text: `Hi love, can you pay this licence thing before the month ends? I am travelling. Thanks!
L

---------- Forwarded message ----------
From: Overberg Traffic Department Example
Date: 1 March 2027
Subject: Licence renewal notice

Dear owner,

Your vehicle licence is up for renewal.
Date of last renewal: 2026/03/30
Renewal fee: R 689.00
Pay before: 31 March 2027
Penalties apply from 1 April 2027.

Overberg Traffic Department Example`,
    expected: [
      { kind: "due", value: "2027-03-31" },
      { kind: "amount", value: "689.00" },
    ],
  },
  // Not expected: the price change day, the old price, the new price.
  {
    id: "b3-us-price-change-notice",
    name: "A change to your plan price.email",
    mime: EMAIL,
    from: "Clearwave Mobile Example",
    writtenAt: Date.UTC(2027, 0, 12, 14),
    mailKind: "other",
    text: `Hi Alex,

Your Unlimited Plus price changes on March 1, 2027, from $62.00 to $68.00 per month.
Nothing to do: your next bills will simply show the new price.

Questions? Chat with us in the app.
Clearwave Mobile Example. Unsubscribe from service notices at example.com/prefs.`,
    expected: [],
  },
  // Not expected: the payment day, the balance lines, the date the next fee notice will be issued.
  htmlMail({
    id: "b3-in-fee-receipt-html",
    name: "Fee receipt - Term 2 - Greenfield High School.email",
    from: "Greenfield High School Example",
    writtenAt: Date.UTC(2026, 11, 11, 7),
    mailKind: "receipt",
    html: `<html><body>
<h3>Fee Receipt</h3>
<table border="1" cellpadding="4">
<tr><td>Receipt no.</td><td>R-2026-90871</td></tr>
<tr><td>Student</td><td>Aarav Menon, Class 7B</td></tr>
<tr><td>Term</td><td>Term 2</td></tr>
<tr><td>Previous balance</td><td>Rs. 18,500.00</td></tr>
<tr><td>Amount received on 10-12-2026</td><td><b>Rs. 18,500.00</b></td></tr>
<tr><td>Balance</td><td>Rs. 0.00</td></tr>
</table>
<p>The next fee notice will be issued on 01-04-2027. Please keep this receipt for your records.</p>
</body></html>`,
    expected: [{ kind: "amount", value: "18500.00" }],
  }),
  // Not expected: the statement date, the next statement date, the credit balance.
  {
    id: "b3-uk-card-nothing-owed",
    name: "Your Silverstone card statement.email",
    mime: EMAIL,
    from: "Silverstone Bank Example",
    writtenAt: Date.UTC(2027, 1, 2, 7),
    mailKind: "bill",
    text: `Dear Mr Penhale,

Your statement is ready.
Statement date: 02 Feb 2027
Your account is in credit by 14.20, so there is nothing to pay this month.
Minimum payment: 0.00
Next statement: 02 Mar 2027

Silverstone Bank Example is authorised and regulated in the UK.`,
    expected: [],
  },
  // Not expected: the statement closing date, the promotional rate end, the previous balance, the payment received, the minimum payment.
  htmlMail({
    id: "b3-us-card-statement-html",
    name: "Your January statement is available.email",
    from: "Harborline Card Services Example",
    writtenAt: Date.UTC(2027, 0, 21, 12),
    mailKind: "bill",
    html: `<html><body style="font-family:Helvetica">
<table width="480" border="1" cellpadding="6" cellspacing="0">
<tr><td colspan="2"><b>Account summary</b> - closing date 01/20/2027</td></tr>
<tr><td>Previous balance</td><td align="right">$980.11</td></tr>
<tr><td>Payments</td><td align="right">-$980.11</td></tr>
<tr><td>Purchases</td><td align="right">$1,251.30</td></tr>
<tr><td>Interest and fees</td><td align="right">$23.32</td></tr>
<tr><td><b>New balance</b></td><td align="right"><b>$1,274.62</b></td></tr>
<tr><td>Minimum payment</td><td align="right">$35.00</td></tr>
<tr><td>Payment due date</td><td align="right">02/17/2027</td></tr>
</table>
<p>Your promotional rate on the balance transfer ends 03/31/2027.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-17" },
      { kind: "amount", value: "1274.62" },
    ],
  }),
  // Not expected: the account date and the interest day (no-year mail).
  {
    id: "b3-za-refuse-sewer-short",
    name: "Refuse and sewer account ready.email",
    mime: EMAIL,
    from: "Tygerberg Valley Municipality Example",
    writtenAt: Date.UTC(2026, 10, 19, 6),
    mailKind: "bill",
    text: `Dear ratepayer,

Account date: 14 November
Your refuse and sewer account for this month is R 612.40. Please make sure that payment reaches the municipality by 10 December, because interest is charged on overdue accounts from 11 December.

Pay at any retail till point or by EFT.
Tygerberg Valley Municipality Example`,
    expected: [
      { kind: "due", value: "2026-12-10" },
      { kind: "amount", value: "612.40" },
    ],
  },
  // Not expected: the policy term, the last payment day, the premium alone, the instalment fee alone.
  {
    id: "b3-us-insurance-draft-notice",
    name: "Upcoming automatic payment for your policy.email",
    mime: EMAIL,
    from: "Pinecrest Mutual Insurance Example",
    writtenAt: Date.UTC(2026, 11, 28, 9),
    mailKind: "bill",
    text: `Hello Dana,

Your next automatic payment is scheduled.

Draft date: 01/05/2027
Draft amount: $118.35 (premium $108.35 plus $10.00 installment fee)
Policy term: 01/01/2027 - 06/30/2027
Last payment received: 12/05/2026

No action is needed if your bank account details are unchanged.
Pinecrest Mutual Insurance Example`,
    expected: [
      { kind: "due", value: "2027-01-05" },
      { kind: "amount", value: "118.35" },
    ],
  },
  // Not expected: the invoice date, the deposit paid, the subtotal, the recall day.
  htmlMail({
    id: "b3-uk-dental-invoice-html",
    name: "Invoice D-20931 from Elmwood Dental Example.email",
    from: "Elmwood Dental Example",
    writtenAt: Date.UTC(2027, 0, 14, 14),
    mailKind: "bill",
    html: `<html><body>
<h3>Invoice D-20931</h3>
<p>Invoice date: 14 Jan 2027 &nbsp; Terms: 28 days</p>
<table border="1" cellpadding="4">
<tr><td>Crown, lower left molar</td><td>&pound;315.00</td></tr>
<tr><td>Subtotal</td><td>&pound;315.00</td></tr>
<tr><td>Deposit paid</td><td>-&pound;50.00</td></tr>
<tr><td><b>Balance payable</b></td><td><b>&pound;265.00</b></td></tr>
<tr><td>Due date</td><td>11 Feb 2027</td></tr>
</table>
<p>Your six-month recall check is due around 15 Jul 2027. We will write to you nearer the time.</p>
<p>Elmwood Dental Example. Payments by card over the phone or bank transfer.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-11" },
      { kind: "amount", value: "265.00" },
    ],
  }),
  // Not expected: the discharge day, the insurer approval day, the refund day, the gross bill, the insurer share, the discount.
  htmlMail({
    id: "b3-in-hospital-final-bill-html",
    name: "Final bill after TPA settlement - Admission 55203.email",
    from: "Lotus Care Hospital Example",
    writtenAt: Date.UTC(2027, 1, 8, 5),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Mr. Iyer,</p>
<p>Please find your final bill. Admission no. 55203; date of discharge: 30-Jan-2027.</p>
<table border="1" cellpadding="4">
<tr><td>Gross bill</td><td>Rs. 52,000.00</td></tr>
<tr><td>Approved by insurer on 04-Feb-2027</td><td>- Rs. 40,000.00</td></tr>
<tr><td>Hospital discount</td><td>- Rs. 4,580.00</td></tr>
<tr><td><b>Payable by patient</b></td><td><b>Rs. 7,420.00</b></td></tr>
<tr><td>Pay by</td><td>22-Feb-2027</td></tr>
</table>
<p>If any amount is found to be excess, our billing office will issue a refund by 28-Feb-2027.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-22" },
      { kind: "amount", value: "7420.00" },
    ],
  }),
  // Not expected: the violation day, the increased fine, the increase day.
  {
    id: "b3-us-parking-notice",
    name: "Parking violation notice 40-221876.email",
    mime: EMAIL,
    from: "City of Oakhurst Parking Services Example",
    writtenAt: Date.UTC(2027, 2, 16, 13),
    mailKind: "bill",
    text: `NOTICE OF PARKING VIOLATION

Citation: 40-221876
Date of violation: March 9, 2027
Location: 400 block of Mill Street
Violation: Expired meter
Fine: $75.00

You may pay the fine or contest it in writing. Payments and written appeals must be received no later than April 15, 2027. If the fine is not paid, it increases to $150.00 on April 16, 2027.

Pay at oakhurst-parking.example.org or at City Hall.`,
    expected: [
      { kind: "due", value: "2027-04-15" },
      { kind: "amount", value: "75.00" },
    ],
  },
  // Not expected: the last receipt, the reserve fund alone, the levy alone.
  {
    id: "b3-za-body-corporate-levy",
    name: "Levy statement - Unit 12, Seaview Sectional Title.email",
    mime: EMAIL,
    from: "Seaview Body Corporate Example",
    writtenAt: Date.UTC(2027, 3, 6, 8),
    mailKind: "bill",
    text: `LEVY STATEMENT

Unit 12, Seaview Sectional Title Scheme Example
Owner: Mrs A. van Wyk

Ordinary levy:             R 1 800.00
Reserve fund:              R   350.00
Amount payable:            R 2 150.00

Levy due on/before:        30/04/2027
Last receipt:              12/03/2027, R 2 150.00

Please pay by EFT and use your unit number as reference. Proof of payment to levies@example.org.

Seaview Body Corporate Example`,
    expected: [
      { kind: "due", value: "2027-04-30" },
      { kind: "amount", value: "2150.00" },
    ],
  },
  // Not expected: the meter reading day, the next bill day, the credit, the charges before credit.
  htmlMail({
    id: "b3-uk-water-bill-html",
    name: "Your water bill, account 4400 1187.email",
    from: "Marlow Water Example",
    writtenAt: Date.UTC(2026, 11, 21, 8),
    mailKind: "bill",
    html: `<html><body>
<p>Dear customer,</p>
<p>Your latest bill is below. We read your meter on 14 Dec 2026.</p>
<table border="1" cellpadding="4">
<tr><td>Charges for this period</td><td>&pound;104.40</td></tr>
<tr><td>Credit brought forward</td><td>-&pound;8.00</td></tr>
<tr><td>Amount to pay</td><td>&pound;96.40</td></tr>
<tr><td>Please pay by</td><td>18 January 2027</td></tr>
</table>
<p>Your next bill will be sent on 21 Jun 2027.</p>
<p>Marlow Water Example, Customer Services</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-18" },
      { kind: "amount", value: "96.40" },
    ],
  }),
  // Not expected: the pricing guarantee end (no-year mail).
  {
    id: "b3-us-membership-renewal-short",
    name: "Your membership renews soon.email",
    mime: EMAIL,
    from: "Pathfinder Outdoor Club Example",
    writtenAt: Date.UTC(2027, 3, 12, 10),
    mailKind: "bill",
    text: `Hi Chris,

Your annual membership renews automatically.
Renewal date: Monday, May 3
Amount: $79.00, charged to the card ending 4242

Your member pricing guarantee ends June 30.
To cancel or change your plan, sign in before the renewal date.

Pathfinder Outdoor Club Example`,
    expected: [
      { kind: "due", value: "2027-05-03" },
      { kind: "amount", value: "79.00" },
    ],
  },
  // Not expected: the bill period, the last payment day and sum, the rental alone, the GST alone, the tariff revision day.
  htmlMail({
    id: "b3-in-broadband-html",
    name: "Your broadband invoice for April 2027.email",
    from: "SwiftNet Broadband Example",
    writtenAt: Date.UTC(2027, 4, 2, 6),
    mailKind: "bill",
    html: `<html><body>
<table border="1" cellpadding="4">
<tr><td>Bill period</td><td>01 Apr 2027 to 30 Apr 2027</td></tr>
<tr><td>Plan rental</td><td>Rs. 999.00</td></tr>
<tr><td>Extra data usage</td><td>Rs. 120.00</td></tr>
<tr><td>GST (18% on rental)</td><td>Rs. 179.82</td></tr>
<tr><td>Previous dues</td><td>Rs. 0.00</td></tr>
<tr><td>Last payment (04 Apr 2027)</td><td>Rs. 1,180.00</td></tr>
<tr><td><b>Total amount due</b></td><td><b>Rs. 1,298.82</b></td></tr>
<tr><td>Pay By</td><td>17 May 2027</td></tr>
</table>
<p>Tariff revision applies from 01 Jun 2027.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-17" },
      { kind: "amount", value: "1298.82" },
    ],
  }),
  // Not expected: the last payment day, the outstanding loan balance, the arrears, the next statement day.
  {
    id: "b3-uk-loan-statement",
    name: "Personal loan statement - May 2027.email",
    mime: EMAIL,
    from: "Westbridge Finance Example",
    writtenAt: Date.UTC(2027, 4, 14, 9),
    mailKind: "bill",
    text: `Dear Mr Okoro,

Your loan statement

Outstanding balance:     4,318.90
Arrears:                 0.00
Last payment received:   1 May 2027
Next payment due:        1 June 2027
Monthly payment:         214.67

Next statement: 14 Aug 2027

Your payment will be collected by Direct Debit. Westbridge Finance Example is authorised and regulated.`,
    expected: [
      { kind: "due", value: "2027-06-01" },
      { kind: "amount", value: "214.67" },
    ],
  },
  // Not expected: the insurance adjustment posting day, the late statement fee day, the billed charges, the insurance payment, the write-off.
  {
    id: "b3-us-medical-statement",
    name: "Statement of account - Hollis Imaging Center.email",
    mime: EMAIL,
    from: "Hollis Imaging Center Example",
    writtenAt: Date.UTC(2027, 5, 8, 15),
    mailKind: "bill",
    text: `Statement of account for Riley Brandt

Insurance adjustment posted: 05/27/2027

Charges for MRI knee:        $480.00
Insurance payment:          -$250.00
Contractual write-off:       -$74.00
Your balance:                $156.00

Please remit by: 06/30/2027

A $25.00 statement fee applies after 07/01/2027. You can pay by phone at 555-0177 or online.`,
    expected: [
      { kind: "due", value: "2027-06-30" },
      { kind: "amount", value: "156.00" },
    ],
  },
  // Not expected: the late registration start day, the late amount, the base fee alone.
  htmlMail({
    id: "b3-za-exam-registration-html",
    name: "Exam registration fee, June 2027 session.email",
    from: "Southern Cross College Example",
    writtenAt: Date.UTC(2027, 3, 20, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Dear student 20418833,</p>
<p>The fee for the June 2027 examination session is now payable.</p>
<table border="1" cellpadding="4">
<tr><td>Exam registration fee</td><td>R 850.00</td></tr>
<tr><td>Closing date for payment</td><td>14 May 2027</td></tr>
<tr><td>Late registration fee (from 15 May 2027)</td><td>R 1 100.00</td></tr>
</table>
<p>Use your student number as reference. The Finance Office, Southern Cross College Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-14" },
      { kind: "amount", value: "850.00" },
    ],
  }),
  // Not expected: the service period end, the previous bill sum.
  {
    id: "b3-us-gas-bill-short",
    name: "Your gas bill is ready.email",
    mime: EMAIL,
    from: "Summit Gas Company Example",
    writtenAt: Date.UTC(2026, 11, 15, 8),
    mailKind: "bill",
    text: `Hi Taylor,

Service period ended: 12/10/2026
Amount due: $64.18
Due 01/08/2027
Your previous bill of $71.02 was paid in full.

Pay at summitgas.example.com. Reply STOP to end text alerts.`,
    expected: [
      { kind: "due", value: "2027-01-08" },
      { kind: "amount", value: "64.18" },
    ],
  },
];
