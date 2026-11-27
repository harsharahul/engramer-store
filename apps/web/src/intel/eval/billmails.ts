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

export const BILL_MAIL_CASES: readonly EvalCase[] = [
  // Not expected: the late fee start 12/15/2026, the late fee $35.00, the previous balance $0.00.
  {
    id: "b1-hoa-dues",
    name: "Quarterly assessment notice - Maple Ridge Homeowners Association.email",
    mime: EMAIL,
    from: "Maple Ridge Homeowners Association Example",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "bill",
    text: `Dear Homeowner,

Your quarterly assessment for the period December 2026 - February 2027 has been posted to your account.

Lot / Unit: 114 Maple Ridge Court
Account #: MR-20418
Previous balance: $0.00
Quarterly assessment: $385.00
-----------------------------------
Total due: $385.00
Due Date: 12/01/2026

Payments may be made by check to the address below, through the resident portal, or by ACH. Assessments not received by the 15th day after the due date (12/15/2026) will carry a late fee of $35.00 per the Declaration of Covenants.

Questions? Call the management office at (555) 010-0142, weekdays 9 to 4.

Maple Ridge Homeowners Association Example
c/o Pinecrest Property Management Example
PO Box 2210, Fairhaven

You are receiving this notice as a member of the association. To change your notice preferences, reply to this message.`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "385.00" },
    ],
  },
  // Not expected: the earlier reminder sent on 2 November 2026.
  {
    id: "b1-tv-licence-reminder",
    name: "Reminder: your TV Licence payment is overdue.email",
    mime: EMAIL,
    from: "TV Licensing Example",
    writtenAt: Date.UTC(2026, 10, 16, 7),
    mailKind: "bill",
    text: `Dear Mr Hartley,

We wrote to you on 2 November 2026 about your TV Licence, and we have not yet received your payment.

Licence number: 7001 5521 08
Amount to pay: £180.00
Pay by: 30 November 2026

You can pay online or by Direct Debit using the link in your account. Watching or recording live TV without a valid licence is a criminal offence.

If you have already paid, please ignore this email.

TV Licensing Example, Customer Services, Bristol
This is an automated message. Please do not reply.`,
    expected: [
      { kind: "due", value: "2026-11-30" },
      { kind: "amount", value: "180.00" },
    ],
  },
  // Not expected: the interest start 16/12/2026, the levy period end 28/02/2027, the admin fund and sinking fund lines.
  htmlMail({
    id: "b1-strata-levy",
    name: "Levy notice - Lot 27, 14 Banksia Street.email",
    from: "Banksia Court Strata Example",
    writtenAt: Date.UTC(2026, 10, 20, 1),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Lena,</p>
<p>The quarterly levy notice for Lot 27 is set out below.</p>
<table border="1" cellpadding="6">
<tr><th>Fund</th><th>Levy period</th><th>Amount</th><th>Due</th></tr>
<tr><td>Administrative fund</td><td>01/12/2026 - 28/02/2027</td><td>$1,120.00</td><td>15/12/2026</td></tr>
<tr><td>Capital works fund</td><td>01/12/2026 - 28/02/2027</td><td>$480.00</td><td>15/12/2026</td></tr>
<tr><td colspan="2"><b>Total payable</b></td><td><b>$1,600.00</b></td><td></td></tr>
</table>
<p>Interest accrues on unpaid levies from 16/12/2026 at the rate set under the Strata Schemes regulation.</p>
<p>Pay by BPAY or EFT using the details on the attached levy slip. Reference: BC27-1126.</p>
<p>Banksia Court Strata Example<br>Strata managers: Harbourline Strata Services Example<br>strata@example.com</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "1600.00" },
    ],
  }),
  // Not expected: the last payment of 03-09-2026, the penalty start 06-12-2026, the penalty Rs. 150.
  {
    id: "b1-society-maintenance",
    name: "Maintenance bill Dec 2026 to Feb 2027 - Flat B-403.email",
    mime: EMAIL,
    from: "Lotus Heights Cooperative Housing Society Example",
    writtenAt: Date.UTC(2026, 10, 24, 5),
    mailKind: "bill",
    text: `Respected Member,

Greetings from the Managing Committee of Lotus Heights CHS.

The quarterly maintenance bill for your flat is as follows:

Flat No.            : B-403
Bill period         : December 2026 to February 2027
Maintenance charges : Rs. 6,900.00
Sinking fund        : Rs. 600.00
Total payable       : Rs. 7,500.00
Last date for payment : 05-12-2026

Last payment received: Rs. 7,500.00 on 03-09-2026.
A penalty of Rs. 150.00 per month will be charged from 06-12-2026 on dues not cleared.

Kindly pay by cheque in the society office box or by UPI to the society account. Please quote your flat number.

Regards,
Hon. Secretary
Lotus Heights CHS Example`,
    expected: [
      { kind: "due", value: "2026-12-05" },
      { kind: "amount", value: "7500.00" },
    ],
  },
  // Not expected: the travel date 11/19, the notice date 12/03, the toll $14.75 and the admin fee $5.00.
  {
    id: "b1-toll-notice",
    name: "Unpaid toll notice - plate 7KRT204.email",
    mime: EMAIL,
    from: "Riverbend Tollway Example",
    writtenAt: Date.UTC(2026, 11, 3, 15),
    mailKind: "bill",
    text: `Notice of unpaid toll

Notice date: 12/03
Plate: 7KRT204 (state registered)
Date of travel: 11/19, 8:42 AM, Eastbound Gantry 4

Toll: $14.75
Administrative fee: $5.00
Amount due: $19.75

Pay online at the Riverbend Tollway Example site or by phone on (555) 010-0177 by 12/28 to avoid a civil penalty.

You are receiving this email because the plate above is registered to this address.`,
    expected: [
      { kind: "due", value: "2026-12-28" },
      { kind: "amount", value: "19.75" },
    ],
  },
  // Not expected: the fee period 4 Jan - 15 Jan 2027, the payment of 6 Jan 2027, the next statement 10 February 2027, the gross fees and the subsidy.
  htmlMail({
    id: "b1-childcare-fees",
    name: "Your childcare fee statement - Little Wattle Early Learning.email",
    from: "Little Wattle Early Learning Example",
    writtenAt: Date.UTC(2027, 0, 12, 2),
    mailKind: "bill",
    html: `<html><body>
<h3>Fee statement</h3>
<p>Child: Mia T. &nbsp; Room: Joeys</p>
<table cellpadding="4">
<tr><td>Fortnight</td><td>4 Jan 2027 to 15 Jan 2027</td></tr>
<tr><td>Gross session fees</td><td>$1,260.00</td></tr>
<tr><td>Child Care Subsidy (estimated)</td><td>-$882.00</td></tr>
<tr><td><b>Gap fee to pay</b></td><td><b>$378.00</b></td></tr>
<tr><td>Payment due</td><td>Wednesday 27 January 2027</td></tr>
<tr><td>Last payment received</td><td>6 Jan 2027 ($351.50)</td></tr>
</table>
<p>Your next statement will be issued on 10 February 2027.</p>
<p>Fees are paid by bank transfer to the account on your enrolment pack. Questions: accounts@example.com</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-27" },
      { kind: "amount", value: "378.00" },
    ],
  }),
  // Not expected: the last instalment received 1 January 2027, the instalment amount 163.40 each, the annual charge 1,634.00.
  {
    id: "b1-council-tax-instalments",
    name: "Council Tax: your remaining instalments.email",
    mime: EMAIL,
    from: "Westmere Borough Council Example",
    writtenAt: Date.UTC(2027, 0, 14, 10),
    mailKind: "bill",
    text: `Council Tax account 40-77213 - 2026/27

Dear Ms Okafor,

This is a summary of your account. You pay by Direct Debit in ten monthly instalments.

Annual charge for 2026/27: £1,634.00
Received to date: £1,307.20 (last instalment on 1 January 2027)

Instalments still to be collected:
  1 February 2027    £163.40
  1 March 2027       £163.40

Balance still to pay: £326.80

No action is needed if your Direct Debit is in place. If you wish to change the date, contact us at least 5 working days before the date above.

Revenues and Benefits, Westmere Borough Council Example
counciltax@example.org`,
    expected: [
      { kind: "due", value: "2027-02-01" },
      { kind: "due", value: "2027-03-01" },
      { kind: "amount", value: "326.80" },
    ],
  },
  // Not expected: the next meter reading on Jan 6, 2027, the last payment $58.40.
  htmlMail({
    id: "b1-water-bill-ready",
    name: "Your water and sewer bill is ready.email",
    from: "Hillcrest Water Example",
    writtenAt: Date.UTC(2026, 10, 30, 13),
    mailKind: "bill",
    html: `<html><body>
<p>Hello,</p>
<p>Your latest bill for 22 Orchard Lane is ready.</p>
<p><b>Amount due:</b> $62.18<br>
<b>Pay by:</b> Monday, December 21, 2026<br>
Last payment: $58.40<br>
Next meter reading: Jan 6, 2027</p>
<p>Log in to the customer portal to view the full bill or set up autopay.</p>
<p><small>Hillcrest Water Example. Unsubscribe from bill notices in your account settings.</small></p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-21" },
      { kind: "amount", value: "62.18" },
    ],
  }),
  // Not expected: the invoice date 08/12/2026, the bill period 01/11/2026 to 30/11/2026, the plan charges and the GST.
  htmlMail({
    id: "b1-broadband-bill",
    name: "SwiftFibre bill for November 2026.email",
    from: "SwiftFibre Broadband Example",
    writtenAt: Date.UTC(2026, 11, 8, 4),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Subscriber,</p>
<p>Your broadband invoice is generated. A copy is attached to this mail.</p>
<table border="1" cellpadding="5">
<tr><td>Account ID</td><td>SF-8840213</td></tr>
<tr><td>Invoice date</td><td>08/12/2026</td></tr>
<tr><td>Bill period</td><td>01/11/2026 to 30/11/2026</td></tr>
<tr><td>Plan charges (200 Mbps)</td><td>Rs. 1,100.70</td></tr>
<tr><td>GST @ 18%</td><td>Rs. 198.12</td></tr>
<tr><td>Previous dues</td><td>Rs. 0.00</td></tr>
<tr><td>Total payable</td><td>Rs. 1,298.82</td></tr>
<tr><td>Due date</td><td>22/12/2026</td></tr>
</table>
<p>Pay through the app, UPI or net banking. Service may be restricted if payment is not received.</p>
<p>SwiftFibre Broadband Example, Care: 1800-555-0123</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-22" },
      { kind: "amount", value: "1298.82" },
    ],
  }),
  // Not expected: the next bill on 12/17/2026, the payment date 11/17/2026.
  {
    id: "b1-payment-confirmation-auto",
    name: "We received your payment.email",
    mime: EMAIL,
    from: "Cardinal Mutual Insurance Example",
    writtenAt: Date.UTC(2026, 10, 19, 17),
    mailKind: "receipt",
    text: `Thank you, Dana.

We received your payment of $212.40 on 11/17/2026 for auto policy AU-5530817.

Your account is up to date. Your next bill will be issued on 12/17/2026.

Cardinal Mutual Insurance Example
Claims and service: (555) 010-0199`,
    expected: [{ kind: "amount", value: "212.40" }],
  },
  // Not expected: the assessment year 2025-26, the filing date 28 July 2026, tax computed Rs. 21,380, TDS credit Rs. 17,000.
  {
    id: "b1-income-tax-demand",
    name: "Intimation under section 143(1) - outstanding demand.email",
    mime: EMAIL,
    from: "Income Tax Helpdesk Example",
    writtenAt: Date.UTC(2026, 11, 16, 6),
    mailKind: "bill",
    text: `Dear Taxpayer,

This is with reference to your return of income for Assessment Year 2025-26, filed on 28 July 2026 (acknowledgement no. 884201330).

On processing, the tax payable was computed at Rs. 21,380. After giving credit for tax deducted at source of Rs. 17,000, a demand of Rs. 4,380 remains outstanding.

You are requested to either pay the demand or submit your response through the e-filing portal on or before 15th January 2027. If no action is taken, the demand will be adjusted against any refund due to you and interest will continue to run as per the Act.

This is a system generated email. Do not reply to this message.
Income Tax Helpdesk Example`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "amount", value: "4380.00" },
    ],
  },
  // Not expected: the invoice date 9-Feb-2027, the date of service 5-Feb-2027, the subtotal $275.00, the rebate $110.00.
  htmlMail({
    id: "b1-dental-invoice",
    name: "Tax invoice 31592 from Jacaranda Dental.email",
    from: "Jacaranda Dental Example",
    writtenAt: Date.UTC(2027, 1, 9, 3),
    mailKind: "bill",
    html: `<html><body>
<h2>Tax Invoice 31592</h2>
<table border="1" cellpadding="5">
<tr><th>Date</th><th>Item</th><th align="right">Amount</th></tr>
<tr><td>5-Feb-2027</td><td>Examination and x-rays</td><td align="right">$95.00</td></tr>
<tr><td>5-Feb-2027</td><td>Scale and clean</td><td align="right">$180.00</td></tr>
<tr><td colspan="2">Subtotal (GST free)</td><td align="right">$275.00</td></tr>
<tr><td colspan="2">Health fund rebate (claimed on the spot)</td><td align="right">-$110.00</td></tr>
<tr><td colspan="2"><b>Balance payable</b></td><td align="right"><b>$165.00</b></td></tr>
</table>
<p>Invoice date: 9-Feb-2027<br>Payment terms: due 23-Feb-2027</p>
<p>Direct deposit: BSB 000-000, account 12345678, reference 31592.</p>
<p>Jacaranda Dental Example - reception@example.com</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-23" },
      { kind: "amount", value: "165.00" },
    ],
  }),
  // Not expected: the statement date, the part payment of 3 November 2026, the monthly rent 1,150.00, the next statement 2 January 2027.
  {
    id: "b1-rent-arrears",
    name: "Rent statement and request for payment.email",
    mime: EMAIL,
    from: "Marlow Lettings Example",
    writtenAt: Date.UTC(2026, 11, 2, 11),
    mailKind: "bill",
    text: `Rent account statement for Flat 3, 18 Corn Exchange Mews
Tenant: Mr J. Whitcombe
Statement date: 2 December 2026

Date            Description                     Charge     Paid
1 Nov 2026      Rent                           1,150.00
3 Nov 2026      Payment received                           575.00
1 Dec 2026      Rent                           1,150.00
1 Dec 2026      Standing order received                  1,150.00

Balance outstanding: £575.00

Our records show a shortfall from the November rent. Please arrange to clear it.

Payment required by: 11 December 2026

If you have a problem paying, please call us before that date. A further statement will be sent on 2 January 2027.

Marlow Lettings Example, lettings@example.org`,
    expected: [
      { kind: "due", value: "2026-12-11" },
      { kind: "amount", value: "575.00" },
    ],
  },
  // Not expected: the statement closing date 12/05/2026, the next closing date 01/05/2027, the previous balance, the payment received 11/20/2026, the minimum payment $35.00.
  htmlMail({
    id: "b1-credit-card-statement",
    name: "Your statement is ready - Harborline Visa ending 4417.email",
    from: "Harborline Card Services Example",
    writtenAt: Date.UTC(2026, 11, 10, 14),
    mailKind: "bill",
    html: `<html><body>
<p>Your December statement is available online.</p>
<table cellpadding="5" border="1">
<tr><td>Statement closing date</td><td>12/05/2026</td></tr>
<tr><td>Previous balance</td><td>$1,210.00</td></tr>
<tr><td>Payment received 11/20/2026</td><td>-$1,210.00</td></tr>
<tr><td>New purchases</td><td>$1,846.20</td></tr>
<tr><td><b>New balance</b></td><td><b>$1,846.20</b></td></tr>
<tr><td>Minimum payment due</td><td>$35.00</td></tr>
<tr><td><b>Payment due date</b></td><td><b>01/04/2027</b></td></tr>
</table>
<p>Your next statement closes on 01/05/2027. Paying only the minimum will increase interest charges.</p>
<p><small>Harborline Card Services Example. Customer care (555) 010-0113. You can opt out of marketing in Settings.</small></p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "1846.20" },
    ],
  }),
  // Not expected: the date of notice 3 March, the lodgment date 14 Feb, the interest start 22 April.
  {
    id: "b1-tax-assessment",
    name: "Your notice of assessment is ready.email",
    mime: EMAIL,
    from: "Revenue Services Example",
    writtenAt: Date.UTC(2027, 2, 3, 0),
    mailKind: "bill",
    text: `Your income tax assessment is ready in your online account.

Date of notice: 3 March
Return lodged: 14 Feb
Balance payable: $3,420.50
Pay by: 21 April

Interest applies to amounts not paid by the due date, from 22 April.

Revenue Services Example. Do not reply to this email.`,
    expected: [
      { kind: "due", value: "2027-04-21" },
      { kind: "amount", value: "3420.50" },
    ],
  },
  // Not expected: the receipt dated 04-09-2026, the term start 04-01-2027, the tuition 22,000 and activity 2,000 lines.
  htmlMail({
    id: "b1-school-fees-term3",
    name: "Term 3 fee notice and concession declaration - Class 6.email",
    from: "Greenfield International School Example",
    writtenAt: Date.UTC(2026, 11, 21, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Parent,</p>
<p>Fee notice for Term 3 (starts 04-01-2027) for Aarav S., Class 6B.</p>
<table border="1" cellpadding="5">
<tr><td>Tuition fee</td><td>Rs. 22,000</td></tr>
<tr><td>Activity fee</td><td>Rs. 2,000</td></tr>
<tr><td><b>Total fee payable</b></td><td><b>Rs. 24,000.00</b></td></tr>
<tr><td>Fee payment last date</td><td>12-01-2027</td></tr>
<tr><td>Term 2 receipt no. 5531 dated</td><td>04-09-2026</td></tr>
</table>
<p>Parents who wish to continue the sibling concession must return the signed declaration form to the accounts office by 05-01-2027, otherwise the concession will not be applied.</p>
<p>Accounts Office, Greenfield International School Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-05" },
      { kind: "due", value: "2027-01-12" },
      { kind: "amount", value: "24000.00" },
    ],
  }),
  // Not expected: the renewal date 14 March 2027, last year's premium £289.10, the reminder date 6 January 2027.
  {
    id: "b1-home-insurance-dd",
    name: "Your home insurance renewal and Direct Debit.email",
    mime: EMAIL,
    from: "Ashgrove Home Cover Example",
    writtenAt: Date.UTC(2027, 0, 20, 9),
    mailKind: "bill",
    text: `Dear Mrs Pryce,

We wrote to you on 6 January 2027 with your renewal documents. Here are the key facts again.

Policy number: HC-300-78124
Your cover renews on: 14 March 2027
Last year's premium: £289.10
Your renewal premium: £312.40
Collection date: 12 March 2027

We will collect £312.40 from your bank account by Direct Debit on the collection date. You do not need to do anything. If you want to change or cancel your cover, please tell us before then.

Ashgrove Home Cover Example
Customer helpline 0800 555 0147 (lines open Monday to Friday)`,
    expected: [
      { kind: "due", value: "2027-03-12" },
      { kind: "amount", value: "312.40" },
    ],
  },
  // Not expected: the statement date Jan 5 2027, the billing period, the previous balance, the payment of Dec 22, the plan, device and taxes lines, the price change on Feb 1 2027.
  {
    id: "b1-phone-bill-forward",
    name: "Fwd: Your bill from Lakeshore Mobile.email",
    mime: EMAIL,
    from: "Rohan Mehta",
    writtenAt: Date.UTC(2027, 0, 7, 19),
    mailKind: "bill",
    text: `Hi Dad, can you take care of this one before the end of the month? I only got it today. Thanks, Rohan

---------- Forwarded message ----------
From: Lakeshore Mobile Example <billing@example.com>
Sent: Tuesday, January 5, 2027 7:02 AM
To: rohan.mehta@example.org
Subject: Your bill from Lakeshore Mobile

Account summary
Statement date
Jan 5, 2027
Billing period
Dec 6, 2026 - Jan 5, 2027

Previous balance          $118.40
Payment received Dec 22  -$118.40
Monthly plan - 2 lines     $65.00
Device installment         $24.99
Taxes and fees             $11.37

AMOUNT DUE
$101.36

DUE DATE
Tuesday, January 26, 2027

Heads up: starting Feb 1, 2027 your plan price changes to $68.00 per month.

Lakeshore Mobile Example, PO Box 5000. Manage your preferences or unsubscribe in My Account.`,
    expected: [
      { kind: "due", value: "2027-01-26" },
      { kind: "amount", value: "101.36" },
    ],
  },
  // Not expected: the issue date 2 December 2026, the contravention date 28 November 2026, the full charge £100.00.
  {
    id: "b1-parking-forward",
    name: "Fwd: Parking Charge Notice PC-5520931.email",
    mime: EMAIL,
    from: "Priya Nair",
    writtenAt: Date.UTC(2026, 11, 14, 18),
    mailKind: "bill",
    text: `Dad, this arrived for the car, I think from when you borrowed it to go to the garden centre. Can you have a look and pay it? Priya x

> From: Harbour Parking Example <notices@example.org>
> Sent: 2 December 2026 10:15
> To: priya.nair@example.com
> Subject: Parking Charge Notice PC-5520931
>
> Parking Charge Notice PC-5520931
> Vehicle: LK19 ABX
> Location: Dockside Retail Park car park
> Date of contravention: 28 November 2026
> Date of notice: 2 December 2026
>
> The charge is £100.00. If you pay £60.00 by 18 December 2026 the charge is reduced and no further action will be taken.
>
> Pay online with the reference above or call 0345 555 0191.`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "60.00" },
    ],
  },
  // Not expected: the invoice date 22 January 2027, the earlier reminder 2 February 2027, the original due date 29 January 2027.
  {
    id: "b1-plumber-final-reminder",
    name: "RE: Overdue invoice 20871.email",
    mime: EMAIL,
    from: "Kestrel Plumbing Example",
    writtenAt: Date.UTC(2027, 1, 16, 22),
    mailKind: "bill",
    text: `Hi Neil,

Invoice 20871 for $640.00 is still open and was due on 29 January 2027. Please pay it in full by Friday 5 March 2027. After that we will have to pass it on for collection.

Thanks, Tracey

On 2 February 2027, Kestrel Plumbing Example <accounts@example.com> wrote:
> Hi Neil,
> Just a friendly reminder that invoice 20871, dated 22 January 2027, for the hot water unit replacement ($640.00) has not been paid yet.
> Our terms are 7 days from the invoice date. Details for direct deposit are on the invoice.
> Regards, Tracey`,
    expected: [
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "640.00" },
    ],
  },
  // Not expected: the last renewal March 3, 2026, the early-renewal offer that ended Feb 1, 2027, the monthly option $8.99.
  htmlMail({
    id: "b1-gym-renewal",
    name: "Your membership renews soon.email",
    from: "Pinnacle Fitness Club Example",
    writtenAt: Date.UTC(2027, 1, 10, 12),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Marcus,</p>
<p>Your annual membership renews on <b>March 3, 2027</b>. We will charge <b>$79.00</b> to the card ending 2290 on that day.</p>
<p>Last renewed: March 3, 2026. The early-renewal offer ended Feb 1, 2027. A monthly plan is $8.99 if you would rather switch.</p>
<p>To cancel or change plans, sign in at the member site.</p>
<p><small>Pinnacle Fitness Club Example | unsubscribe</small></p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-03" },
      { kind: "amount", value: "79.00" },
    ],
  }),
  // Not expected: the invoice date 09/03/2027, the visit date 06/03/2027, the total 2,250 and the advance 500.
  htmlMail({
    id: "b1-clinic-invoice",
    name: "Invoice CL-77412 from Sunrise Diagnostics and Clinic.email",
    from: "Sunrise Diagnostics and Clinic Example",
    writtenAt: Date.UTC(2027, 2, 9, 7),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Mrs Iyer,</p>
<p>Please find your invoice below.</p>
<table border="1" cellpadding="5">
<tr><td>Invoice no.</td><td>CL-77412</td></tr>
<tr><td>Invoice date</td><td>09/03/2027</td></tr>
<tr><td>Date of visit</td><td>06/03/2027</td></tr>
<tr><td>Consultation</td><td>Rs. 800.00</td></tr>
<tr><td>Laboratory tests</td><td>Rs. 1,450.00</td></tr>
<tr><td>Total</td><td>Rs. 2,250.00</td></tr>
<tr><td>Advance paid</td><td>Rs. 500.00</td></tr>
<tr><td><b>Balance to pay</b></td><td><b>Rs. 1,750.00</b></td></tr>
<tr><td>Payable on or before</td><td>20/03/2027</td></tr>
</table>
<p>Pay at the front desk or by UPI to the clinic ID. Thank you.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-20" },
      { kind: "amount", value: "1750.00" },
    ],
  }),
  // Not expected: the statement date, the last payment 03/30/2027, the maturity date 11/30/2028, the principal balance, the interest portion.
  htmlMail({
    id: "b1-loan-statement",
    name: "Auto loan statement for April.email",
    from: "Granite State Credit Union Example",
    writtenAt: Date.UTC(2027, 3, 6, 15),
    mailKind: "bill",
    html: `<html><body>
<p>Your loan statement is ready.</p>
<table cellpadding="4">
<tr><td>Loan</td><td>Auto loan ending 8812</td></tr>
<tr><td>Statement date</td><td>04/06/2027</td></tr>
<tr><td>Principal balance</td><td>$9,812.40</td></tr>
<tr><td>Interest paid this period</td><td>$38.12</td></tr>
<tr><td>Last payment received</td><td>$412.55 on 03/30/2027</td></tr>
<tr><td>Maturity date</td><td>11/30/2028</td></tr>
<tr><td>Next payment</td><td>$412.55</td></tr>
<tr><td>Next payment due</td><td>04/30/2027</td></tr>
</table>
<p>Granite State Credit Union Example is federally insured. Member services: (555) 010-0128.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-30" },
      { kind: "amount", value: "412.55" },
    ],
  }),
  // Not expected: the reminder date 12 January 2027, the warrant date 12 February 2027, the previous bill £191.12, the late payment charge £37.25.
  htmlMail({
    id: "b1-electric-final-notice",
    name: "Final notice: please pay your electricity account.email",
    from: "Northfield Power Example",
    writtenAt: Date.UTC(2027, 0, 26, 8),
    mailKind: "bill",
    html: `<html><body>
<h3>FINAL NOTICE</h3>
<p>Dear Mr Bannister,</p>
<p>We sent you a reminder on 12 January 2027 and we still have not received payment for account 55-20931.</p>
<table border="1" cellpadding="5">
<tr><td>Previous bill</td><td>£191.12</td></tr>
<tr><td>Late payment charge</td><td>£37.25</td></tr>
<tr><td><b>Total now owed</b></td><td><b>£228.37</b></td></tr>
<tr><td><b>Pay by</b></td><td><b>5pm, 5 February 2027</b></td></tr>
</table>
<p>If we do not receive payment, we may apply to the court for a warrant to fit a prepayment meter after 12 February 2027. If you are struggling, please contact us on 0800 555 0160 and we will help.</p>
<p>Northfield Power Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-05", time: "17:00" },
      { kind: "amount", value: "228.37" },
    ],
  }),
  // Not expected: the first installment paid 11/04/2026, the penalty start 04/11/2027, the annual total $2,840.00.
  {
    id: "b1-property-tax-second-half",
    name: "2026-27 property tax: second installment.email",
    mime: EMAIL,
    from: "Tri-County Tax Collector Example",
    writtenAt: Date.UTC(2027, 1, 24, 16),
    mailKind: "bill",
    text: `PROPERTY TAX NOTICE 2026-27
Parcel: 0412-221-09
Owner: R. and S. Delgado

Annual tax: $2,840.00
First installment: $1,420.00, paid 11/04/2026
Second installment: $1,420.00
Pay on or before: 04/10/2027

A 10% penalty is added to installments that are delinquent after 04/11/2027.

Pay online with the parcel number, by mail postmarked on or before the date above, or in person at the collector's office.

Tri-County Tax Collector Example
Hours: Mon-Fri 8:30 to 4:30`,
    expected: [
      { kind: "due", value: "2027-04-10" },
      { kind: "amount", value: "1420.00" },
    ],
  },
  // Not expected: the issue date 27 Nov, the supply period 1 Aug to 31 Oct, the previous bill paid 3 Nov, the next meter read 30 Jan, the usage, supply and GST lines.
  {
    id: "b1-electricity-bill-au",
    name: "Your electricity bill.email",
    mime: EMAIL,
    from: "Sunburst Energy Example",
    writtenAt: Date.UTC(2026, 10, 27, 0),
    mailKind: "bill",
    text: `Hi Gabrielle,

Here's your latest bill.

Bill issued: 27 Nov
Supply period: 1 Aug to 31 Oct
Usage charges        $140.00
Supply charges        $55.00
GST                   $19.50

Total this bill      $214.50
Please pay by        18 Dec

Your previous bill was paid on 3 Nov, thank you. Your next meter read is expected around 30 Jan.

Pay with BPAY, card or direct debit through My Account.

Sunburst Energy Example | 1300 555 0166 | Unsubscribe`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "214.50" },
    ],
  },
  // Not expected: the new tariff start 01-04-2027, the last bill paid 02-03-2027, the rates per kilolitre.
  {
    id: "b1-water-tariff-change",
    name: "Revised water tariff from April.email",
    mime: EMAIL,
    from: "Nagar Water Supply Board Example",
    writtenAt: Date.UTC(2027, 2, 15, 5),
    mailKind: "other",
    text: `Dear Consumer (No. 20-4471-9),

The Board has revised the domestic water tariff. The new rate will be Rs. 14 per kilolitre instead of Rs. 12 per kilolitre, effective 01-04-2027.

Your last bill was paid on 02-03-2027. No action is required from you.

Nagar Water Supply Board Example
Helpline 1916`,
    expected: [],
  },
  // Not expected: the next assessment of $385.00 billed on 06/01/2027, the payment of 05/01/2027.
  {
    id: "b1-hoa-zero-balance",
    name: "Your account is paid in full.email",
    mime: EMAIL,
    from: "Maple Ridge Homeowners Association Example",
    writtenAt: Date.UTC(2027, 4, 4, 10),
    mailKind: "other",
    text: `Dear Homeowner,

Account #: MR-20418
Balance as of today: $0.00

Nothing is owed on your account. Thank you for staying current.

The next quarterly assessment of $385.00 will be billed on 06/01/2027.

Maple Ridge Homeowners Association Example
c/o Pinecrest Property Management Example`,
    expected: [],
  },
  // Not expected: the quote date 27 Jan 27, the quote total £2,860.00.
  {
    id: "b1-roof-repair-quote",
    name: "Quote Q-3318: roof repair at 7 Elm Terrace.email",
    mime: EMAIL,
    from: "Redwing Roofing Example",
    writtenAt: Date.UTC(2027, 0, 27, 14),
    mailKind: "other",
    text: `Dear Mr and Mrs Calloway,

Thank you for having us visit. Our quote is below.

Quote ref: Q-3318
Quote date: 27 Jan 27
Work: strip and re-lay 14 sq m of slate, replace 2 ridge tiles, new lead flashing
Total price: £2,860.00 (including VAT)

To book the work, a deposit of £572.00 is needed.
Deposit due by: 12 Feb 27
This quote is valid until 28 Feb 27.

Reply to this email to accept and we will send you our bank details.

Redwing Roofing Example, Lancashire`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "expiry", value: "2027-02-28" },
      { kind: "amount", value: "572.00" },
    ],
  },
  // Not expected: the bill date 8 June 2027, the billing period 8 May to 7 June 2027, the previous bill £41.80, the price rise on 1 July 2027.
  htmlMail({
    id: "b1-mobile-bill-uk",
    name: "Your June bill is ready.email",
    from: "Kestrel Mobile Example",
    writtenAt: Date.UTC(2027, 5, 8, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Alex,</p>
<p>Your bill for 8 May 2027 to 7 June 2027 (issued 8 June 2027) is ready.</p>
<table cellpadding="4">
<tr><td>This bill</td><td><b>£47.20</b></td></tr>
<tr><td>Last month's bill</td><td>£41.80</td></tr>
<tr><td>Direct Debit collection date</td><td>22 June 2027</td></tr>
</table>
<p>From 1 July 2027 your monthly plan price goes up by £2.00.</p>
<p><small>Kestrel Mobile Example. Manage your marketing choices in the app.</small></p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-06-22" },
      { kind: "amount", value: "47.20" },
    ],
  }),
];
