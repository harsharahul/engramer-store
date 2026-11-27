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

export const HELDOUT_MAIL3_CASES: readonly EvalCase[] = [
  // Not expected: the bill date, the last payment received, the previous balance and payment, the next bill date.
  {
    id: "h7-sg-tc-sc-dec",
    name: "Your S&CC bill for December 2026.email",
    mime: EMAIL,
    from: "Tampines Green Town Council Example",
    writtenAt: Date.UTC(2026, 10, 16, 8),
    mailKind: "bill",
    text: `Dear Resident,

Your Service and Conservancy Charges (S&CC) bill for Blk 214 #06-118 is ready.

Bill no: TC-5528-1126
Bill date: 15 Nov 2026
Billing month: December 2026
Last payment received: 03 Nov 2026

Previous balance                $61.70
Payment received               -$61.70
S&CC                            $62.40
Sinking fund contribution       $14.90
----------------------------------------
Total amount payable            $77.30

Please pay by: 30 Nov 2026
Next bill date: 15 Dec 2026

You may pay via GIRO, AXS, PayNow or at the Town Council office.
Enquiries: 6555 0142 (Mon to Fri, 8.30am to 5.30pm).
This is a computer-generated notice. No signature is required.`,
    expected: [
      { kind: "due", value: "2026-11-30" },
      { kind: "amount", value: "77.30" },
    ],
  },
  // Not expected: the levy notice date, the last levy paid, the levy period dates, the interest start day, the admin fund and capital works fund lines.
  htmlMail({
    id: "h7-au-strata-levy-q1",
    name: "Quarterly levy notice SP 48213 Unit 14.email",
    from: "Harbourline Strata Management Example",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial,sans-serif">
<p>Dear Owner,</p>
<p>The quarterly levy notice for Strata Plan 48213, Unit 14, is set out below.</p>
<table border="1" cellpadding="6" cellspacing="0">
<tr><td>Levy notice date</td><td>10/11/2026</td></tr>
<tr><td>Levy period</td><td>01/01/2027 to 31/03/2027</td></tr>
<tr><td>Last levy paid</td><td>13/09/2026</td></tr>
<tr><td>Administrative fund contribution</td><td>$1,020.00</td></tr>
<tr><td>Capital works fund contribution</td><td>$380.00</td></tr>
<tr><td><b>Total levy payable</b></td><td><b>$1,400.00</b></td></tr>
<tr><td>Payment due on</td><td>15/12/2026</td></tr>
<tr><td>Interest on unpaid levies applies from</td><td>16/12/2026</td></tr>
</table>
<p>Pay by BPAY or EFT using the details on the attached remittance slip. Quote lot number 14 as the reference.</p>
<p style="font-size:11px">Harbourline Strata Management Example, PO Box 118, Parramatta NSW. This email and any attachment is confidential.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "1400.00" },
    ],
  }),
  // Not expected: the late payment charge of Rs. 250.00.
  {
    id: "h7-in-chs-maint",
    name: "Maintenance bill generated.email",
    mime: EMAIL,
    from: "Greenfield Heights CHS Example",
    writtenAt: Date.UTC(2026, 10, 20, 10),
    mailKind: "bill",
    text: `Dear Member (Flat C-904),

Your quarterly maintenance bill has been generated.

Bill amount: Rs. 7,350.00
Pay on or before: 05-12-2026

A late payment charge of Rs. 250.00 is added to bills paid after the due date.
Pay by UPI, NEFT or cheque at the society office.

Helpline: 022-5550-0147
Managing Committee, Greenfield Heights CHS Example`,
    expected: [
      { kind: "due", value: "2026-12-05" },
      { kind: "amount", value: "7350.00" },
    ],
  },
  // Not expected: the statement date, the reading date, the next reading date, the opening balance, the payment received, the electricity and water subtotals.
  htmlMail({
    id: "h7-za-metro-account",
    name: "Municipal account for November 2026.email",
    from: "Khayalami Metro Municipality Example",
    writtenAt: Date.UTC(2026, 10, 23, 7),
    mailKind: "bill",
    html: `<html><body>
<h3>Consolidated municipal account</h3>
<p>Account 7104 3382 91 &nbsp; Erf 2251</p>
<table cellpadding="4">
<tr><td>Statement date</td><td>2026-11-20</td></tr>
<tr><td>Meter reading date</td><td>2026-11-12</td></tr>
<tr><td>Next reading</td><td>2026-12-10</td></tr>
<tr><td>Balance brought forward</td><td>R 2,100.00</td></tr>
<tr><td>Payment received 2026-11-03</td><td>-R 2,100.00</td></tr>
<tr><td>Electricity</td><td>R 1,840.50</td></tr>
<tr><td>Water</td><td>R 905.60</td></tr>
<tr><td>Refuse removal</td><td>R 410.00</td></tr>
<tr><td>Sanitation</td><td>R 326.05</td></tr>
<tr><td><b>Total now due</b></td><td><b>R 3,482.15</b></td></tr>
<tr><td>Pay by</td><td>2026-12-14</td></tr>
</table>
<p>Accounts not paid by the date above are subject to credit control. Queries: accounts@khayalami.example.org</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-14" },
      { kind: "amount", value: "3482.15" },
    ],
  }),
  // Not expected: the statement closing date, the payment received on 12 November, the next statement date, the opening balance, the minimum payment.
  {
    id: "h7-au-card-statement-nov",
    name: "Your statement is ready.email",
    mime: EMAIL,
    from: "Marlow Bank Cards Example",
    writtenAt: Date.UTC(2026, 11, 2, 7),
    mailKind: "bill",
    text: `Hi Priya,

Your Marlow Bank Visa statement is now available in online banking.

Card ending 4417
Statement closing date: 30 November 2026
Opening balance                        $1,942.10
Payment received 12 November 2026     -$1,942.10
Purchases and fees                     $2,318.40
Closing balance                        $2,318.40

Minimum payment                           $70.00
Payment due date: 24 December 2026

Your next statement will close on 31 December 2026.
Pay the closing balance by the due date to avoid interest on new purchases.

Marlow Bank Cards Example is a trading name of Marlow Bank Example Ltd. Lost or stolen card: 1800 555 0102.
To stop these emails, update your preferences in online banking.`,
    expected: [
      { kind: "due", value: "2026-12-24" },
      { kind: "amount", value: "2318.40" },
    ],
  },
  // Not expected: the last premium paid day, the cover start and end days, the premium and policy fee lines.
  htmlMail({
    id: "h7-sg-insurance-renewal",
    name: "Premium reminder for policy HM-30417.email",
    from: "Lion Crest Insurance Example",
    writtenAt: Date.UTC(2026, 11, 7, 3),
    mailKind: "bill",
    html: `<html><body style="font-family:Verdana,sans-serif;font-size:13px">
<p>Dear Policyholder,</p>
<p>The premium for your home insurance renewal is due soon.</p>
<table border="0" cellpadding="5">
<tr><td>Policy number</td><td>HM-30417</td></tr>
<tr><td>Premium last paid on</td><td>20 Dec 2025</td></tr>
<tr><td>Cover for the next year</td><td>01 Jan 2027 to 31 Dec 2027</td></tr>
<tr><td>Annual premium</td><td>$1,250.00</td></tr>
<tr><td>Policy fee</td><td>$36.50</td></tr>
<tr><td><b>Total premium due</b></td><td><b>$1,286.50</b></td></tr>
<tr><td>Please pay by</td><td>21 Dec 2026</td></tr>
</table>
<p>Pay with PayNow, credit card or GIRO. Reply to this email if you wish to change your cover.</p>
<p style="font-size:10px">Lion Crest Insurance Example Pte Ltd. Unsubscribe from reminders.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-21" },
      { kind: "amount", value: "1286.50" },
    ],
  }),
  // Not expected: the date of intimation, the tax payable and interest components, the interest accrual start day.
  {
    id: "h7-in-tax-demand",
    name: "Intimation of outstanding demand, AY 2026-27.email",
    mime: EMAIL,
    from: "Income Tax Processing Centre Example",
    writtenAt: Date.UTC(2027, 0, 12, 5),
    mailKind: "other",
    text: `Dear Taxpayer,

An intimation has been issued to you for the assessment year 2026-27. The processed return shows an outstanding demand.

Date of intimation: 08-01-2027
Tax payable: Rs. 17,200.00
Interest payable: Rs. 1,220.00
Total demand outstanding: Rs. 18,420.00

Pay on or before: 11-02-2027

Interest under section 220(2) continues to accrue at 1% per month on the outstanding demand from 12-02-2027.
Log in to the e-filing portal to pay online or to respond to the demand.

This is a system generated email. Please do not reply to this email.`,
    expected: [
      { kind: "due", value: "2027-02-11" },
      { kind: "amount", value: "18420.00" },
    ],
  },
  // Not expected: the invoice date, the annual fee, the Term 2 invoice day, the forward header day.
  {
    id: "h7-za-school-fwd",
    name: "Fwd: Term 1 fee instalment.email",
    mime: EMAIL,
    from: "Sipho Mokoena",
    writtenAt: Date.UTC(2027, 0, 18, 19),
    mailKind: "personal",
    text: `Hi Dad,

School fees again. Please sort this one out, I do not have the login for the bank. Thanks.

Sipho

---------- Forwarded message ----------
From: Accounts, Willowbrook Primary Example <accounts@willowbrook.example.org>
Date: Mon, 18 Jan 2027 at 07:42
Subject: Term 1 fee instalment
To: Sipho Mokoena

Dear Parent,

Please find the Term 1 instalment for your child below.

Invoice date: 15 January 2027
Annual fee: R 27,800.00
Instalment 1 of 4: R 6,950.00
Amount due: R 6,950.00
Payment due: 29 January 2027

Use the learner number as your EFT reference. The Term 2 invoice will be issued on 12 April 2027.

Willowbrook Primary Example, Finance Office`,
    expected: [
      { kind: "due", value: "2027-01-29" },
      { kind: "amount", value: "6950.00" },
    ],
  },
  // Not expected: the date the payment was received, the next bill day.
  {
    id: "h7-au-water-paid",
    name: "Payment received.email",
    mime: EMAIL,
    from: "Brightwater Water Example",
    writtenAt: Date.UTC(2026, 10, 25, 16),
    mailKind: "receipt",
    text: `Thanks, we have received your payment.

Receipt number: BW-2290417
Amount received: $142.60
Date received: 24 November 2026
Your next bill is expected on 24 February 2027.

Nothing more to do. Keep this email as your record.
Brightwater Water Example, 1300 555 0166`,
    expected: [{ kind: "amount", value: "142.60" }],
  },
  // Not expected: the bill date, the bill period, the previous bill and its payment day, the subtotal, GST, the new plan rates day.
  htmlMail({
    id: "h7-sg-mobile-dec",
    name: "Your Starlane bill for December 2026.email",
    from: "Starlane Mobile Example",
    writtenAt: Date.UTC(2026, 11, 11, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Hello,</p>
<p>Your bill is ready. Here is the summary.</p>
<table border="1" cellpadding="4" cellspacing="0" width="420">
<tr><th align="left">Bill date</th><td>10 Dec 2026</td></tr>
<tr><th align="left">Bill period</th><td>11 Nov 2026 - 10 Dec 2026</td></tr>
<tr><th align="left">Plan charges</th><td>$72.00</td></tr>
<tr><th align="left">Roaming and add-ons</th><td>$18.32</td></tr>
<tr><th align="left">Subtotal</th><td>$90.32</td></tr>
<tr><th align="left">GST (9%)</th><td>$8.13</td></tr>
<tr><th align="left">Total due</th><td>$98.45</td></tr>
<tr><th align="left">Last bill</th><td>$89.10, paid 02 Dec 2026</td></tr>
<tr><th align="left">Pay by</th><td>28 Dec 2026</td></tr>
</table>
<p>New plan rates apply from 01 Jan 2027. See your account page for details.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-28" },
      { kind: "amount", value: "98.45" },
    ],
  }),
  // Not expected: the statement date, the last payment received, the minimum amount due, the reward points expiry day.
  htmlMail({
    id: "h7-in-card-estmt",
    name: "Your card e-statement for 25/11/2026.email",
    from: "Rajdhani Bank Cards Example",
    writtenAt: Date.UTC(2026, 10, 27, 6),
    mailKind: "bill",
    html: `<html><body style="font-family:Tahoma,sans-serif">
<p>Dear Cardmember,</p>
<p>Your credit card statement is summarised below. The full statement is attached as a protected PDF.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Statement date</td><td>25/11/2026</td></tr>
<tr><td>Total amount due</td><td>&#8377; 41,210.55</td></tr>
<tr><td>Minimum amount due</td><td>&#8377; 2,060.53</td></tr>
<tr><td>Payment due date</td><td>15/12/2026</td></tr>
<tr><td>Last payment received</td><td>&#8377; 36,480.00 on 12/11/2026</td></tr>
<tr><td>Reward points expiring</td><td>2,400 points on 31/12/2026</td></tr>
</table>
<p>Paying only the minimum amount due attracts finance charges on the unpaid balance.</p>
<p style="font-size:10px">Rajdhani Bank Cards Example. For help call the number printed on the back of your card.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "41210.55" },
    ],
  }),
  // Not expected: the previous account day, the interest start day, the rates and refuse lines, the rebate.
  {
    id: "h7-za-rates-annual",
    name: "Rates and services account 2026/27.email",
    mime: EMAIL,
    from: "Overberg Local Municipality Example",
    writtenAt: Date.UTC(2027, 0, 5, 9),
    mailKind: "bill",
    text: `Dear Ratepayer,

Your rates and services account for the 2026/27 financial year is set out below.

Property rates          R 4,850.00
Refuse removal          R   650.00
Pensioner rebate       -R   400.00
Total due               R 5,100.00

Previous account due: 30 November 2026 (settled)
Interest charged from: 1 March 2027

We ask that the amount of R 5,100.00 reaches the municipal cashier or our bank account no later than Friday 26 February 2027. Please use your account number as the payment reference.

Municipal Finance Office
Overberg Local Municipality Example`,
    expected: [
      { kind: "due", value: "2027-02-26" },
      { kind: "amount", value: "5100.00" },
    ],
  },
  // Not expected: the quote date, the works start day, the subtotal, GST and deposit.
  {
    id: "h7-au-roof-quote",
    name: "Quote Q-2291 for your roof restoration.email",
    mime: EMAIL,
    from: "Ironbark Roofing Example",
    writtenAt: Date.UTC(2027, 0, 25, 11),
    mailKind: "bill",
    text: `Hello Mr Bennett,

Thanks for having us out to look at the roof. Our quote is below.

Quote no: Q-2291
Date of quote: 25/01/2027
Scope: re-bed and re-point ridge capping, replace 34 broken tiles, full re-seal and two coats of membrane paint

Subtotal            $13,500.00
GST                  $1,350.00
Total price         $14,850.00
Deposit (20%)        $2,970.00

Accept by: 12/02/2027
Works can start from: 22/03/2027

To accept, reply to this email with "Accepted" and we will send the deposit invoice.

Ironbark Roofing Example | Licence 40117C | Phone 02 5550 0188`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "amount", value: "14850.00" },
    ],
  },
  // Not expected: last month's deduction amount.
  {
    id: "h7-sg-giro-notice",
    name: "GIRO deduction notice.email",
    mime: EMAIL,
    from: "Pasir Ris Water and Power Example",
    writtenAt: Date.UTC(2026, 11, 14, 9),
    mailKind: "bill",
    text: `Dear Customer,

This is to let you know that $215.60 will be deducted from your bank account under your GIRO arrangement on 28 Dec.

Last month's deduction was $198.40.
Please make sure your account has enough funds. No action is needed otherwise.

Customer Care: 6555 0129
Pasir Ris Water and Power Example`,
    expected: [
      { kind: "due", value: "2026-12-28" },
      { kind: "amount", value: "215.60" },
    ],
  },
  // Not expected: the bill date, the billing cycle, the previous bill's payment day, the late surcharge start day, the rental line, GST.
  {
    id: "h7-in-fibre-dec",
    name: "Broadband bill for Nov cycle.email",
    mime: EMAIL,
    from: "Fibrenet Broadband Example",
    writtenAt: Date.UTC(2026, 11, 3, 8),
    mailKind: "bill",
    text: `Dear Subscriber,

Your Fibrenet bill is ready.
Bill date: 02-Dec
Billing cycle: 01-Nov to 30-Nov
Previous bill paid on: 05-Nov
Monthly rental: Rs. 999.00
GST @ 18%: Rs. 179.82
Total payable: Rs. 1,178.82
Due date: 17-Dec
Late payment surcharge applies from: 18-Dec
Pay on the app or at any partner outlet.`,
    expected: [
      { kind: "due", value: "2026-12-17" },
      { kind: "amount", value: "1178.82" },
    ],
  },
  // Not expected: the invoice date, the last payment received, the promotional credit, the price increase day.
  htmlMail({
    id: "h7-za-fibre-feb",
    name: "Invoice for your fibre line.email",
    from: "Lekker Fibre Example",
    writtenAt: Date.UTC(2027, 1, 1, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Howzit,</p>
<table cellpadding="4" border="0">
<tr><td>Invoice date</td><td>2027-01-31</td></tr>
<tr><td>Fibre 100/100 uncapped</td><td>R 999.00</td></tr>
<tr><td>Loyalty credit</td><td>-R 100.00</td></tr>
<tr><td><b>Amount to pay</b></td><td><b>R 899.00</b></td></tr>
<tr><td>Last payment received</td><td>R 899.00 on 2027-01-14</td></tr>
<tr><td>Settle by</td><td>2027-02-15</td></tr>
<tr><td>New monthly price effective</td><td>2027-03-01</td></tr>
</table>
<p>Prefer a debit order? Reply to this email and we will send the form.</p>
<p style="color:#777;font-size:11px">Lekker Fibre Example (Pty) Ltd. Reg. 2019/000000/07. Unsubscribe.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-15" },
      { kind: "amount", value: "899.00" },
    ],
  }),
  // Not expected: the original due day, the reminder day, the bill amount and late fee lines, the disconnection warning day.
  {
    id: "h7-au-final-notice-power",
    name: "FINAL NOTICE: electricity account overdue.email",
    mime: EMAIL,
    from: "Eastgrid Energy Example",
    writtenAt: Date.UTC(2027, 1, 9, 8),
    mailKind: "bill",
    text: `FINAL NOTICE

Dear Customer,

We have not received payment for your electricity account 5520 4417.

Original due date: 22 January 2027
Reminder sent: 29 January 2027
Bill amount: $389.50
Late payment fee: $23.25
Overdue total: $412.75

Final date for payment: 19 February 2027

If your account is still unpaid we may begin disconnection steps.
Disconnection warning date: 26 February 2027

If you are having trouble paying, call us on 1300 555 0171 and ask about a payment plan.
Eastgrid Energy Example Pty Ltd`,
    expected: [
      { kind: "due", value: "2027-02-19" },
      { kind: "amount", value: "412.75" },
    ],
  },
  // Not expected: the subsidy line, the full term fee.
  htmlMail({
    id: "h7-sg-nursery-term1",
    name: "Term 1 fee invoice.email",
    from: "Little Acorn Childcare Example",
    writtenAt: Date.UTC(2027, 0, 4, 8),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Parent,</p>
<p>Your fee invoice for Term 1 is ready.</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><td>Full-day fee</td><td>$1,020.00</td></tr>
<tr><td>Government subsidy</td><td>-$408.00</td></tr>
<tr><td>Fee payable</td><td>$612.00</td></tr>
<tr><td>Payment due</td><td>18 Jan 2027</td></tr>
</table>
<p>Pay by PayNow to our UEN. Thank you.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-18" },
      { kind: "amount", value: "612.00" },
    ],
  }),
  // Not expected: the December rent received day, the revised rent day, the rent and electricity lines.
  {
    id: "h7-in-rent-jan",
    name: "Rent for January.email",
    mime: EMAIL,
    from: "Ramesh Iyer",
    writtenAt: Date.UTC(2026, 11, 26, 18),
    mailKind: "bill",
    text: `Dear Anand,

Rent details for next month, as usual.

Rent for January 2027: Rs. 28,500.00
Electricity share (sub-meter): Rs. 1,150.00
Total to transfer: Rs. 29,650.00

Due date: 05 January 2027

Your December rent was received on 04 December 2026, thanks.
Revised rent effective: 01 April 2027 (Rs. 30,000.00 per month), as agreed in the lease.

Please send the transfer screenshot once done.

Regards,
Ramesh Iyer
Landlord, Flat 3B Example Residency`,
    expected: [
      { kind: "due", value: "2027-01-05" },
      { kind: "amount", value: "29650.00" },
    ],
  },
  // Not expected: the paid instalment days and amounts, the annual total, the single instalment amount.
  {
    id: "h7-au-council-rates-remaining",
    name: "Rates reminder: two instalments remaining.email",
    mime: EMAIL,
    from: "Bayside City Council Example",
    writtenAt: Date.UTC(2027, 0, 20, 7),
    mailKind: "bill",
    text: `Dear Ratepayer,

This is a reminder of your rates instalments for assessment 30-1187-4.

Annual rates and charges: $2,049.60

Instalment 1, 31 August 2026: $512.40 (paid)
Instalment 2, 30 November 2026: $512.40 (paid)
Instalment 3, due 28 February 2027: $512.40
Instalment 4, due 31 May 2027: $512.40

Balance still to pay: $1,024.80

You can pay by BPAY, at any post office, or by direct debit. To set up direct debit, reply to this email.

Rates Office, Bayside City Council Example`,
    expected: [
      { kind: "due", value: "2027-02-28" },
      { kind: "due", value: "2027-05-31" },
      { kind: "amount", value: "1024.80" },
    ],
  },
  // Not expected: none.
  htmlMail({
    id: "h7-za-bodycorp-short",
    name: "Levy for Unit 31.email",
    from: "Protea Gardens Body Corporate Example",
    writtenAt: Date.UTC(2027, 0, 14, 8),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Owner of Unit 31,</p>
<p>Your monthly levy is ready.</p>
<table cellpadding="4">
<tr><td>Levy</td><td>R 2,450.00</td></tr>
<tr><td>Due</td><td>01 February 2027</td></tr>
</table>
<p>Bank details are on your statement. Managing agent: 021 555 0190.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-01" },
      { kind: "amount", value: "2450.00" },
    ],
  }),
  // Not expected: the last premium received day, the sum assured, the rate card day.
  htmlMail({
    id: "h7-in-life-premium",
    name: "Premium due notice, policy 88120437.email",
    from: "Suraksha Life Insurance Example",
    writtenAt: Date.UTC(2027, 1, 3, 5),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial">
<p>Dear Policyholder,</p>
<p>The next premium for your policy is falling due.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th align="left">Policy number</th><td>88120437</td></tr>
<tr><th align="left">Sum assured</th><td>Rs. 10,00,000.00</td></tr>
<tr><th align="left">Last premium received on</th><td>27-Feb-2026</td></tr>
<tr><th align="left">Premium amount</th><td>Rs. 24,860.00</td></tr>
<tr><th align="left">Premium due date</th><td>28-Feb-2027</td></tr>
<tr><th align="left">New rate card applies from</th><td>01-Apr-2027</td></tr>
</table>
<p>Pay through net banking, UPI or at any branch. Premiums paid are eligible for tax benefits as per prevailing law.</p>
<p style="font-size:10px">Suraksha Life Insurance Example Ltd. Insurance is the subject matter of solicitation.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-28" },
      { kind: "amount", value: "24860.00" },
    ],
  }),
  // Not expected: the issue date, the period, the last payment, the previous balance, the plan price change day.
  {
    id: "h7-au-mobile-nov",
    name: "Your Koala Mobile bill.email",
    mime: EMAIL,
    from: "Koala Mobile Example",
    writtenAt: Date.UTC(2026, 10, 30, 10),
    mailKind: "bill",
    text: `Hi there,

Your bill is ready.

Issue date: 28 Nov
Period: 29 Oct to 28 Nov
Last payment: 30 Oct
Previous balance: $79.00
Plan: $75.00
Excess data: $8.50
Total due: $83.50
Pay by: 21 Dec

Plan prices rise from 1 Feb.
Koala Mobile Example`,
    expected: [
      { kind: "due", value: "2026-12-21" },
      { kind: "amount", value: "83.50" },
    ],
  },
  // Not expected: the statement date, the previous balance, the payment received, the minimum payment, the next statement date.
  htmlMail({
    id: "h7-sg-card-jan",
    name: "eStatement for card ending 9082.email",
    from: "Merlion Trust Bank Cards Example",
    writtenAt: Date.UTC(2027, 0, 19, 7),
    mailKind: "bill",
    html: `<html><body style="font-family:Helvetica,Arial,sans-serif">
<p>Dear Customer,</p>
<p>Your credit card eStatement is ready to view.</p>
<table width="460" cellpadding="3">
<tr><td>Statement date</td><td align="right">17 Jan 2027</td></tr>
<tr><td>Previous balance</td><td align="right">$2,984.00</td></tr>
<tr><td>Payment received 05 Jan 2027</td><td align="right">-$2,984.00</td></tr>
<tr><td>New charges</td><td align="right">$3,742.18</td></tr>
<tr><td><b>Total outstanding</b></td><td align="right"><b>$3,742.18</b></td></tr>
<tr><td>Minimum payment due</td><td align="right">$50.00</td></tr>
<tr><td>Pay on or before</td><td align="right">11 Feb 2027</td></tr>
<tr><td>Next statement date</td><td align="right">17 Feb 2027</td></tr>
</table>
<p>If you pay by GIRO, we will collect the amount you chose on the due date above.</p>
<p style="font-size:10px">Merlion Trust Bank Cards Example. Please do not reply to this email.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-11" },
      { kind: "amount", value: "3742.18" },
    ],
  }),
  // Not expected: the last payment day, the rent line, the overpayment credit.
  {
    id: "h7-za-rent-dec",
    name: "December rent statement, 12 Marine Road.email",
    mime: EMAIL,
    from: "Cape Meridian Property Agents Example",
    writtenAt: Date.UTC(2026, 11, 1, 7),
    mailKind: "bill",
    text: `Dear Tenant,

Your rent statement for December:

Last payment received: 2026-11-05
Rent for December: R 11,500.00
Credit from overpayment: -R 750.00
Balance due: R 10,750.00

Rent is payable on or before 2026-12-07.

Please pay into the trust account and use your unit number as the reference. Send proof of payment to rentals@capemeridian.example.org.

Cape Meridian Property Agents Example`,
    expected: [
      { kind: "due", value: "2026-12-07" },
      { kind: "amount", value: "10750.00" },
    ],
  },
  // Not expected: the bill generated day, the previous year's payment day, the current tax and rebate lines, the interest start day.
  htmlMail({
    id: "h7-in-property-tax",
    name: "Property tax bill 2027-28.email",
    from: "Metropolitan Corporation Property Tax Department Example",
    writtenAt: Date.UTC(2027, 2, 2, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Property Owner,</p>
<p>Your property tax bill for 2027-28 has been generated.</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><td>Bill generated on</td><td>01/03/2027</td></tr>
<tr><td>Last year paid on</td><td>22/04/2026</td></tr>
<tr><td>Current year tax</td><td>Rs. 13,136.84</td></tr>
<tr><td>Early payment rebate (5%)</td><td>-Rs. 656.84</td></tr>
<tr><td>Net payable</td><td>Rs. 12,480.00</td></tr>
<tr><td>Last date for payment</td><td>30/04/2027</td></tr>
<tr><td>Interest at 2% per month from</td><td>01/05/2027</td></tr>
</table>
<p>The rebate is available only on payment by the last date. Pay online on the corporation portal.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-30" },
      { kind: "amount", value: "12480.00" },
    ],
  }),
  // Not expected: the weekly rent, the last payment day, the tribunal application day.
  {
    id: "h7-au-rent-arrears",
    name: "Notice of rent arrears.email",
    mime: EMAIL,
    from: "Fairway Realty Example",
    writtenAt: Date.UTC(2027, 1, 22, 9),
    mailKind: "bill",
    text: `Dear Tenant,

Our records show your rent is behind.

Weekly rent: $480.00
Last payment received: 8 February 2027
Arrears: $960.00 (2 weeks)

Pay arrears by: 5 March 2027

If the arrears are not cleared, we may lodge an application with the tribunal.
Tribunal application may be lodged from: 8 March 2027

Please contact the property manager on 03 5550 0133 if you need to discuss this.

Fairway Realty Example Pty Ltd`,
    expected: [
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "960.00" },
    ],
  },
  // Not expected: the invoice date.
  {
    id: "h7-sg-reminder-short",
    name: "Reminder: invoice INV-2290.email",
    mime: EMAIL,
    from: "Kaki Print Supplies Example",
    writtenAt: Date.UTC(2026, 10, 18, 13),
    mailKind: "bill",
    text: `Hi,

A friendly reminder that invoice INV-2290 for $330.00 is due on 02 Dec.

Invoice date: 04 Nov

Please ignore this if you have already paid.
Accounts, Kaki Print Supplies Example`,
    expected: [
      { kind: "due", value: "2026-12-02" },
      { kind: "amount", value: "330.00" },
    ],
  },
  // Not expected: the offence day, the notice issue day, the summons day.
  htmlMail({
    id: "h7-za-traffic-fine",
    name: "Notice of traffic infringement.email",
    from: "Cape Road Traffic Authority Example",
    writtenAt: Date.UTC(2027, 2, 8, 8),
    mailKind: "bill",
    html: `<html><body>
<p><b>Notice of infringement</b></p>
<table cellpadding="4" border="0">
<tr><td>Date of offence</td><td>2027-02-20</td></tr>
<tr><td>Notice issued</td><td>2027-03-08</td></tr>
<tr><td>Offence</td><td>Exceeding speed limit (78 in a 60 zone)</td></tr>
<tr><td>Fine amount</td><td>R 750.00</td></tr>
<tr><td>Pay before</td><td>2027-04-06</td></tr>
<tr><td>Summons may be issued from</td><td>2027-04-20</td></tr>
</table>
<p>You may pay online, at any post office or at our traffic centre. Quote the notice number on payment.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-06" },
      { kind: "amount", value: "750.00" },
    ],
  }),
  // Not expected: the subscription start day, the monthly price, the add-on trial end day.
  {
    id: "h7-in-subscription-renew",
    name: "Your annual plan renews soon.email",
    mime: EMAIL,
    from: "PageTurner Digital Library Example",
    writtenAt: Date.UTC(2027, 2, 1, 10),
    mailKind: "bill",
    text: `Hello,

Your annual plan renews automatically on 14 Mar 2027. Rs. 1,499.00 will be charged to the card on file.

Subscribed since: 14 Mar 2026
Monthly option: Rs. 149.00
Audiobook add-on trial ends: 20 Mar 2027

To change your plan, visit Account settings before the renewal.
PageTurner Digital Library Example`,
    expected: [
      { kind: "due", value: "2027-03-14" },
      { kind: "amount", value: "1499.00" },
    ],
  },
  // Not expected: the date of service, the invoice date, the full fee, the rebate.
  htmlMail({
    id: "h7-au-clinic-invoice",
    name: "Tax invoice 20917 from Elmstead Family Clinic.email",
    from: "Elmstead Family Clinic Example",
    writtenAt: Date.UTC(2027, 1, 16, 14),
    mailKind: "bill",
    html: `<html><body style="font-family:Georgia,serif">
<p>Dear Ms Okafor,</p>
<p>Thank you for visiting us. Your tax invoice is below.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Invoice no</td><td>20917</td></tr>
<tr><td>Date of service</td><td>04/02/2027</td></tr>
<tr><td>Invoice date</td><td>15/02/2027</td></tr>
<tr><td>Consultation fee (long)</td><td>$280.30</td></tr>
<tr><td>Medicare rebate</td><td>-$94.30</td></tr>
<tr><td><b>Gap payable</b></td><td><b>$186.00</b></td></tr>
<tr><td>Payment terms</td><td>Pay by 08/03/2027</td></tr>
</table>
<p>Card payments by phone on 03 5550 0120 or at reception.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-08" },
      { kind: "amount", value: "186.00" },
    ],
  }),
  // Not expected: the late payment surcharge.
  {
    id: "h7-sg-parking-fine",
    name: "Notice of composition fine.email",
    mime: EMAIL,
    from: "Marina Estate Parking Office Example",
    writtenAt: Date.UTC(2027, 3, 12, 8),
    mailKind: "bill",
    text: `Dear Vehicle Owner,

A composition fine has been issued for parking in a season-only lot (Lot 5).

Composition fine: $80.00
Pay by 03 May 2027

A late payment surcharge of $20.00 is added after the due date.
Pay at the AXS machine or online. Parking Office, Marina Estate Parking Office Example`,
    expected: [
      { kind: "due", value: "2027-05-03" },
      { kind: "amount", value: "80.00" },
    ],
  },
  // Not expected: the payment day, the next statement day.
  htmlMail({
    id: "h7-za-premium-paid",
    name: "We have received your payment.email",
    from: "Karoo Insurance Brokers Example",
    writtenAt: Date.UTC(2026, 11, 9, 12),
    mailKind: "receipt",
    html: `<html><body>
<p>Dear Client,</p>
<p>Payment received: <b>R 1,250.00</b></p>
<p>Paid on: 2026-12-08<br>Policy: Household 6620<br>Your next statement is issued on 2027-01-05.</p>
<p>No further action is needed. Karoo Insurance Brokers Example</p>
</body></html>`,
    expected: [{ kind: "amount", value: "1250.00" }],
  }),
  // Not expected: the last EMI debit day, the principal outstanding, the interest component, the next statement day.
  {
    id: "h7-in-home-loan-emi",
    name: "EMI debit intimation for loan account 40021177.email",
    mime: EMAIL,
    from: "Janata Housing Finance Example",
    writtenAt: Date.UTC(2026, 11, 28, 7),
    mailKind: "bill",
    text: `Dear Customer,

Your monthly instalment will be debited from your registered account as per your standing instruction.

EMI debit date: 05-01-2027 (Tue)
EMI amount: Rs. 18,540.00
Last EMI debited on: 05-12-2026
Principal outstanding: Rs. 6,21,400.00
Interest portion of this EMI: Rs. 4,310.00
Next statement on: 28-01-2027

Please keep sufficient balance in your account to avoid bounce charges.
Janata Housing Finance Example Ltd. Toll free 1800-555-0144.`,
    expected: [
      { kind: "due", value: "2027-01-05" },
      { kind: "amount", value: "18540.00" },
    ],
  },
  // Not expected: the statement period, the final repayment day, the document return day, the last repayment amount.
  htmlMail({
    id: "h7-au-loan-discharged",
    name: "Your loan is paid out.email",
    from: "Gumtree Credit Union Example",
    writtenAt: Date.UTC(2027, 3, 7, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Member,</p>
<p>Your personal loan is now fully repaid. Nothing further is owed.</p>
<table cellpadding="4" border="1" cellspacing="0">
<tr><td>Statement period</td><td>1 Mar 2027 to 31 Mar 2027</td></tr>
<tr><td>Final repayment received</td><td>28 March 2027</td></tr>
<tr><td>Last monthly repayment</td><td>$1,840.00</td></tr>
<tr><td>Closing balance</td><td>$0.00</td></tr>
</table>
<p>We will release the security and return any title documents by 30 April 2027.</p>
<p style="font-size:10px">Gumtree Credit Union Example Ltd. Congratulations on clearing your loan.</p>
</body></html>`,
    expected: [],
  }),
  // Not expected: the effective day of the new price, the current and new monthly prices.
  {
    id: "h7-sg-price-change",
    name: "Changes to your broadband plan price.email",
    mime: EMAIL,
    from: "Starlane Home Broadband Example",
    writtenAt: Date.UTC(2027, 1, 8, 9),
    mailKind: "other",
    text: `Dear Customer,

We are writing to tell you about a change to the price of your home broadband plan.

Effective date: 01 Apr 2027
Current monthly price: $49.90
New monthly price: $52.90

Your plan speed and terms stay the same. You do not need to do anything.
Customer Care: 6555 0188 | Starlane Home Broadband Example`,
    expected: [],
  },
  // Not expected: the statement day, the next statement day, the zero balance.
  {
    id: "h7-za-water-nothing-owed",
    name: "Statement of account.email",
    mime: EMAIL,
    from: "Hilltop Water Services Example",
    writtenAt: Date.UTC(2027, 2, 3, 8),
    mailKind: "bill",
    text: `Dear Customer,

Statement as at 2027-03-02
Balance: R 0.00
Nothing is due on your account.
Next statement: 2027-04-03

Hilltop Water Services Example`,
    expected: [],
  },
  // Not expected: the previous bill's payment day, the interest start day, the usage and service lines, the forward header day.
  {
    id: "h7-au-water-fwd",
    name: "Fwd: Your water bill.email",
    mime: EMAIL,
    from: "Marcus Ellery",
    writtenAt: Date.UTC(2027, 2, 9, 20),
    mailKind: "personal",
    text: `Mum, this came for the unit. Can you have a look?

Love M

-----Original Message-----
From: Customer Service <service@baysidewater.example.org>
Sent: Tuesday, 9 March 2027 6:12 AM
To: Marcus Ellery
Subject: Your water bill

Hello,

Your water account 4471 bill is ready.

Water usage          $310.45
Service charge       $188.30
Total                $498.75

Previous bill paid on 30 November 2026.
Pay by 31 March 2027
Interest applies to overdue amounts from 1 April 2027.

Bayside Water Example`,
    expected: [
      { kind: "due", value: "2027-03-31" },
      { kind: "amount", value: "498.75" },
    ],
  },
  // Not expected: the quoted mail's sent day.
  {
    id: "h7-in-power-reply",
    name: "RE: Electricity bill for January.email",
    mime: EMAIL,
    from: "Dakshin Power Distribution Example",
    writtenAt: Date.UTC(2027, 1, 24, 9),
    mailKind: "bill",
    text: `Dear Customer,

We have not yet received payment for the bill below. Please pay by 05 March 2027 to avoid a reminder charge.

Customer Care, Dakshin Power Distribution Example

-----Original Message-----
From: Billing <billing@dakshinpower.example.org>
Sent: 10 February 2027 08:05
Subject: Electricity bill for January

Dear Customer,
Your electricity bill for consumer no. 1130-2278 is Rs. 2,316.00. Please pay by 05 March 2027.
Pay online or at any collection centre.`,
    expected: [
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "2316.00" },
    ],
  },
  // Not expected: the meter reading day, the next meter reading, the previous bill and its payment day, the electricity charge, GST.
  htmlMail({
    id: "h7-sg-power-nov",
    name: "Your electricity bill is ready.email",
    from: "Merlion Energy Retail Example",
    writtenAt: Date.UTC(2026, 10, 12, 6),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial">
<p>Hi,</p>
<p>Your electricity bill for October is ready.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Meter reading date</td><td>05 Nov 2026</td></tr>
<tr><td>Next meter reading</td><td>07 Dec 2026</td></tr>
<tr><td>Previous bill</td><td>$201.30, paid on 14 Oct 2026</td></tr>
<tr><td>Electricity charges</td><td>$172.13</td></tr>
<tr><td>GST (9%)</td><td>$15.49</td></tr>
<tr><td>Amount payable</td><td>$187.62</td></tr>
<tr><td>Payment due date</td><td>27 Nov 2026</td></tr>
</table>
<p>GIRO customers: no action needed. Others may pay through the app.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-11-27" },
      { kind: "amount", value: "187.62" },
    ],
  }),
  // Not expected: the issue day, the last bill amount, the next bill issue day.
  {
    id: "h7-au-gas-text-due",
    name: "Your gas bill.email",
    mime: EMAIL,
    from: "Redgum Gas Example",
    writtenAt: Date.UTC(2026, 11, 14, 8),
    mailKind: "bill",
    text: `Hi Dana,

Your latest gas bill has been issued.

Issue date: 12 December 2026
Last bill: $251.07
Total this bill: $233.18
Next bill issue date: 12 March 2027

To keep your account in good standing, please pay by Monday 4 January 2027. You can pay with BPAY, by card on the app, or by phone.

Redgum Gas Example | ABN 00 000 000 000 | Manage your emails in the app.`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "233.18" },
    ],
  },
  // Not expected: none.
  {
    id: "h7-za-water-text-short",
    name: "Water account for 14 Hope Street.email",
    mime: EMAIL,
    from: "Mfuleni Water Board Example",
    writtenAt: Date.UTC(2027, 2, 15, 9),
    mailKind: "bill",
    text: `Dear Customer,

Your water account for 14 Hope Street comes to R 612.50. Please make payment by 31 March 2027, at any bank or at our offices.

Mfuleni Water Board Example`,
    expected: [
      { kind: "due", value: "2027-03-31" },
      { kind: "amount", value: "612.50" },
    ],
  },
  // Not expected: none.
  {
    id: "h7-in-school-text-short",
    name: "Pending term fee.email",
    mime: EMAIL,
    from: "Saraswati Vidyalaya Example",
    writtenAt: Date.UTC(2027, 3, 5, 9),
    mailKind: "bill",
    text: `Dear Parents,

The fee for your ward is still pending.
Fee payable: Rs. 42,000.00
Kindly clear it by 15th April at the school accounts window or through the parent portal.

Accounts Office, Saraswati Vidyalaya Example`,
    expected: [
      { kind: "due", value: "2027-04-15" },
      { kind: "amount", value: "42000.00" },
    ],
  },
  // Not expected: the invoice issue day, the single instalment amount.
  htmlMail({
    id: "h7-sg-studentcare-instal",
    name: "Fee instalments for the next three months.email",
    from: "Bukit Timah Student Care Example",
    writtenAt: Date.UTC(2026, 10, 13, 9),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial">
<p>Dear Parent,</p>
<p>Your student care fees are payable in three equal instalments.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th>Instalment</th><th>Amount</th><th>Due</th></tr>
<tr><td>1</td><td>$480.00</td><td>15 Dec 2026</td></tr>
<tr><td>2</td><td>$480.00</td><td>15 Jan 2027</td></tr>
<tr><td>3</td><td>$480.00</td><td>15 Feb 2027</td></tr>
</table>
<p>Invoice issued: 01 Nov 2026<br>Total outstanding: $1,440.00</p>
<p>Payment by PayNow to our UEN. We do not send separate reminders for each instalment.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "due", value: "2027-01-15" },
      { kind: "due", value: "2027-02-15" },
      { kind: "amount", value: "1440.00" },
    ],
  }),
  // Not expected: the AGM day, the next levy invoice day.
  {
    id: "h7-za-estate-levy-form",
    name: "Levy invoice and access card form.email",
    mime: EMAIL,
    from: "Jacaranda Estate Body Corporate Example",
    writtenAt: Date.UTC(2027, 0, 27, 8),
    mailKind: "bill",
    text: `Dear Owner,

Two things this month.

1. Quarterly levy invoice: R 3,120.00. Please pay by 2027-02-26.
2. The signed access-card form (attached) must be returned to the managing agent by 2027-02-12, or your cards will not be renewed.

For your records: the annual general meeting was held on 2026-11-24 and the minutes are on the portal.
The next levy invoice will be sent on 2027-04-27.

Jacaranda Estate Body Corporate Example
Managing agent: 021 555 0177`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "due", value: "2027-02-26" },
      { kind: "amount", value: "3120.00" },
    ],
  },
  // Not expected: the Term 1 receipt day, the late fee start day, the late fee per day.
  {
    id: "h7-in-school-term2",
    name: "Term 2 fee notice.email",
    mime: EMAIL,
    from: "Navjyoti Public School Example",
    writtenAt: Date.UTC(2026, 11, 4, 10),
    mailKind: "bill",
    text: `Dear Parent,

Term 2 fee: Rs. 38,500.00
Last date for payment: 10/01/2027
Late fee of Rs. 100.00 per day from 11/01/2027
Term 1 fee receipt dated 12/08/2026 is on file.

Pay on the school portal or by cheque to the Accounts Office.`,
    expected: [
      { kind: "due", value: "2027-01-10" },
      { kind: "amount", value: "38500.00" },
    ],
  },
  // Not expected: the monthly option price.
  htmlMail({
    id: "h7-au-swim-club-renew",
    name: "Your membership renews on 28 May.email",
    from: "Sunfield Swimming Club Example",
    writtenAt: Date.UTC(2027, 4, 3, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Jo,</p>
<p>Your annual membership renews on <b>28 May 2027</b>. We will charge $240.00 to your card on that day.</p>
<p>Prefer to pay monthly? The monthly option is $22.00 a month; reply to switch.</p>
<p>Sunfield Swimming Club Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-28" },
      { kind: "amount", value: "240.00" },
    ],
  }),
  // Not expected: the total tax, the advance payment.
  {
    id: "h7-sg-tax-assessment",
    name: "Notice of Assessment for Year of Assessment 2027.email",
    mime: EMAIL,
    from: "Inland Revenue Authority Example",
    writtenAt: Date.UTC(2027, 3, 15, 8),
    mailKind: "bill",
    text: `Dear Taxpayer,

Your Notice of Assessment is ready.

Total tax: $4,618.60
Less advance payment: $1,200.00
Tax payable: $3,418.60

Pay by: 14 May 2027

You can pay with GIRO, PayNow or internet banking. Quote your tax reference number.
This is an automated email. Do not reply.`,
    expected: [
      { kind: "due", value: "2027-05-14" },
      { kind: "amount", value: "3418.60" },
    ],
  },
  // Not expected: the original due day, the last payment and its day, the supply restriction day.
  htmlMail({
    id: "h7-za-power-overdue",
    name: "Your electricity account is overdue.email",
    from: "Karoo Power Utility Example",
    writtenAt: Date.UTC(2027, 4, 18, 7),
    mailKind: "bill",
    html: `<html><body>
<p><b>Account overdue</b></p>
<table cellpadding="4">
<tr><td>Original due date</td><td>2027-05-05</td></tr>
<tr><td>Last payment</td><td>R 1,200.00 on 2027-04-26</td></tr>
<tr><td>Overdue balance</td><td>R 2,845.30</td></tr>
<tr><td>Pay by</td><td>2027-05-28</td></tr>
<tr><td>Supply restriction from</td><td>2027-06-01</td></tr>
</table>
<p>Clear the overdue balance by the date above to keep your supply. Call 086 055 0112 for arrangements.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-28" },
      { kind: "amount", value: "2845.30" },
    ],
  }),
  // Not expected: the notice date, the last levy paid day, the ordinary levy and special levy lines, the interest start day.
  htmlMail({
    id: "h7-au-owners-corp-special",
    name: "Levy notice with special levy.email",
    from: "Cedar Court Owners Corporation Example",
    writtenAt: Date.UTC(2027, 5, 14, 9),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial">
<p>Dear Lot Owner,</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Notice date</td><td>11/06/2027</td></tr>
<tr><td>Last levy paid</td><td>15/03/2027</td></tr>
<tr><td>Ordinary levy</td><td>$1,320.00</td></tr>
<tr><td>Special levy (lift repairs)</td><td>$850.00</td></tr>
<tr><td><b>Total payable</b></td><td><b>$2,170.00</b></td></tr>
<tr><td>Payment due</td><td>30/07/2027</td></tr>
<tr><td>Interest on arrears from</td><td>31/07/2027</td></tr>
</table>
<p>Pay by BPAY. The biller code is on the attached notice.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-07-30" },
      { kind: "amount", value: "2170.00" },
    ],
  }),
];
