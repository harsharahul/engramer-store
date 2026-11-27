/**
 * Held-out documents: bills, notices and statements, written without sight
 * of the readers. No case here is ever used to tune a rule or an instruction.
 */

import { mailBodyText } from "../htmltext";
import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

/** An HTML mail: the body rides as `raw`, as the app passes it, and its text is what the app's own step makes of it. */
const htmlMail = (c: Omit<EvalCase, "mime" | "text" | "raw"> & { html: string }): EvalCase => {
  const { html, ...rest } = c;
  return { ...rest, mime: EMAIL, text: mailBodyText({ html }), raw: html };
};

export const HELDOUT_BILL2_CASES: readonly EvalCase[] = [
  // Not expected: the statement date, the last payment received date, the balance brought forward, the ground rent and reserve fund parts.
  {
    id: "h4-uk-service-charge-halfyear",
    name: "service-charge-demand-jan-2027.pdf",
    mime: "application/pdf",
    text: `Marlowe Court Residents Management Example Ltd
SERVICE CHARGE AND GROUND RENT DEMAND
Flat 14, Marlowe Court, Example Road, Exampleton EX4 2AB

Demand date: 12 January 2027
Demand reference: MC/14/0127

Description | Period | Amount
Service charge (half year) | 1 Jan 2027 - 30 Jun 2027 | £480.00
Ground rent | 1 Jan 2027 - 30 Jun 2027 | £75.00
Reserve fund contribution | 1 Jan 2027 - 30 Jun 2027 | £87.50

Balance brought forward: £0.00
Last payment received: 08 July 2026
Total now payable: £642.50

Date payable: 11 February 2027
Pay by bank transfer, quoting the demand reference.
Sort code 00-00-00  Account 00000000

Notice: under the Landlord and Tenant Act 1987 this demand must be accompanied by a summary of tenants' rights and obligations, which is enclosed.`,
    expected: [
      { kind: "due", value: "2027-02-11" },
      { kind: "amount", value: "642.50" },
    ],
  },
  // Not expected: the bill date, the billing period, the earlier payment date, the previous balance, the subtotal and the VAT.
  {
    id: "h4-ie-electricity-bimonthly",
    name: "Your electricity bill is ready.email",
    mime: EMAIL,
    from: "Corrib Electric Example",
    writtenAt: Date.UTC(2026, 10, 18, 8),
    mailKind: "bill",
    text: `Hi Aoife,

Your bill for the two months to 13/11/2026 is ready.

Bill date: 17/11/2026
Billing period: 14/09/2026 to 13/11/2026
Account number: 100-2203-77

Previous balance: EUR 98.20
Payment received 02/10/2026: EUR -98.20
Balance: EUR 0.00

Electricity used (968 kWh): EUR 157.30
Standing charge (61 days): EUR 31.56
Subtotal: EUR 188.86
VAT at 13.5%: EUR 25.49

Amount due: EUR 214.35

Please pay on or before 09/12/2026 using the Corrib Electric app, online, or at any post office.

Customer care: 0800 000 000 (Monday to Friday)

Corrib Electric Example`,
    expected: [
      { kind: "due", value: "2026-12-09" },
      { kind: "amount", value: "214.35" },
    ],
  },
  // Not expected: the previous instalment's due day, the billing period end, the annual total, the reminder day.
  htmlMail({
    id: "h4-nz-water-rates-instalment",
    name: "Water rates instalment 3 of 4.email",
    from: "Harbour City Water Example",
    writtenAt: Date.UTC(2026, 11, 8, 21),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial,sans-serif">
<table width="560" cellpadding="6" cellspacing="0" border="1">
<tr><td colspan="2"><b>Harbour City Water Example</b><br/>Rates instalment notice</td></tr>
<tr><td>Property</td><td>27 Pohutukawa Lane, Exampleville</td></tr>
<tr><td>Rates year</td><td>1 July 2026 to 30 June 2027</td></tr>
<tr><td>Instalment</td><td>3 of 4</td></tr>
<tr><td>Instalment 2 was due</td><td>20 November 2026 (received, thank you)</td></tr>
<tr><td>Annual rates for the year</td><td>$1,249.60</td></tr>
<tr><td>Amount of this instalment</td><td><b>$312.40</b></td></tr>
<tr><td>Pay this instalment by</td><td><b>4 February 2027</b></td></tr>
</table>
<p>Pay by internet banking using reference 40271-3, or by phone on 0800 000 000. GST is included.</p>
<p>Instalment 4 will be invoiced separately in April.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-04" },
      { kind: "amount", value: "312.40" },
    ],
  }),
  // Not expected: the bill date, the interest start day, the interest amount, the sinking fund and parking parts.
  {
    id: "h4-in-society-maintenance-quarter",
    name: "Maintenance Bill Dec2026-Feb2027.pdf",
    mime: "application/pdf",
    text: `SUNRISE APARTMENTS CO-OPERATIVE HOUSING SOCIETY EXAMPLE
Regd. No. EX/HSG/2041/1999
MAINTENANCE BILL

Bill No: 0412/26-27     Bill Date: 01/12/2026
Flat No: C-304     Member: Mr. R. Iyer

Particulars | Amount (Rs.)
Maintenance charges (3 months) | 5,400.00
Sinking fund | 900.00
Water charges | 450.00
Parking | 600.00
Total | 7,350.00

Arrears: Nil
Last date of payment: 15/12/2026
Interest at 21% p.a. is applicable from 16/12/2026 on unpaid amounts.

Cheques to be drawn in favour of "Sunrise Apartments CHS Example". Online payment: account details on the notice board.
Secretary`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "7350.00" },
    ],
  },
  // Not expected: the first reminder day, the 6-month price, the monthly Direct Debit figure.
  {
    id: "h4-uk-vehicle-tax-renewal",
    name: "Your vehicle tax is due for renewal.email",
    mime: EMAIL,
    from: "Vehicle Licensing Service Example",
    writtenAt: Date.UTC(2026, 11, 3, 9),
    mailKind: "bill",
    text: `Vehicle tax reminder

Vehicle: EX21 ABC
Current tax ends: 31 December 2026

Your vehicle is not set up to renew automatically. We first wrote to you about this on 12 November 2026.

Tax for 12 months: £195.00
Pay in two halves (6 months): £107.25 each, plus a 5% surcharge on the second
Monthly Direct Debit option: 12 x £17.06

Please renew before Tuesday 29 December 2026 to stay legally taxed. You will need the 11-digit number from your reminder letter or your vehicle's logbook.

If you have already sold this vehicle, tell us and ignore this message.

Vehicle Licensing Service Example`,
    expected: [
      { kind: "due", value: "2026-12-29" },
      { kind: "expiry", value: "2026-12-31" },
      { kind: "amount", value: "195.00" },
    ],
  },
  // Not expected: last year's renewal day, the monthly equivalent, the joining fee. The year is dropped on every date.
  {
    id: "h4-ie-gym-annual-renewal",
    name: "Your annual membership renews soon.email",
    mime: EMAIL,
    from: "Ironbridge Fitness Club Example",
    writtenAt: Date.UTC(2027, 0, 15, 10),
    mailKind: "bill",
    text: `Hello Cian,

Your annual membership comes up for renewal in the next few weeks.

Membership: Full access, single
Last renewal: 1 March
Renewal date: 1 March
Fee: EUR 529.00 (works out at EUR 44.08 a month)
Joining fee: EUR 0.00

On the renewal date we will take the full fee from the card ending 4417. If you would like to cancel or change to monthly payment, tell reception first.

See you at the club,
Ironbridge Fitness Club Example`,
    expected: [
      { kind: "due", value: "2027-03-01" },
      { kind: "amount", value: "529.00" },
    ],
  },
  // Not expected: the invoice date, the deposit received day, the tuition and levy parts, the invoice total.
  {
    id: "h4-nz-tuition-invoice",
    name: "tuition-invoice-semester1-2027.pdf",
    mime: "application/pdf",
    text: `Kauri Valley Institute of Technology Example
TAX INVOICE
Student ID: 2027-884120
Invoice date: 18 Jan 2027
Invoice no: INV-0099317

Item | Detail | Amount
Tuition | Semester 1, 3 courses | $4,200.00
Student services levy | Semester 1 | $310.50
Invoice total (GST inclusive) | | $4,510.50
Less enrolment deposit received on 14 Dec 2026 | | -$500.00

Balance payable | | $4,010.50

Payment due date | 26 Feb 2027

Pay online with your student ID as the reference, or at the Finance counter, Level 2, Block B. Unpaid fees will prevent access to results.`,
    expected: [
      { kind: "due", value: "2027-02-26" },
      { kind: "amount", value: "4010.50" },
    ],
  },
  // Not expected: the statement date, the statement period, the previous balance, the payment received, the minimum amount due.
  {
    id: "h4-in-credit-card-statement",
    name: "CreditCard_Statement_Dec2026.pdf",
    mime: "application/pdf",
    text: `Bharat Example Bank Credit Cards
Statement for card ending 5521
Statement period: 22/11/2026 - 21/12/2026

Statement Date | Payment Due Date | Total Amount Due | Minimum Amount Due
21/12/2026 | 08/01/2027 | Rs. 48,215.37 | Rs. 2,410.77

Previous balance: Rs. 31,009.00
Payment received on 05/12/2026: Rs. 31,009.00 Cr
New purchases and charges: Rs. 48,215.37

Paying only the minimum amount due attracts finance charges at 3.5% per month on the unpaid amount.
Reward points balance: 4,120`,
    expected: [
      { kind: "due", value: "2027-01-08" },
      { kind: "amount", value: "48215.37" },
    ],
  },
  // Not expected: the day of payment, the next bill's issue day. No payment is owed.
  htmlMail({
    id: "h4-uk-payment-confirmation-energy",
    name: "Thanks, we have your payment.email",
    from: "Brightwell Energy Example",
    writtenAt: Date.UTC(2026, 10, 24, 15),
    mailKind: "receipt",
    html: `<html><body>
<h2>Payment received</h2>
<p>Hello Mrs Okafor, thank you for paying your energy bill.</p>
<table border="0" cellpadding="4">
<tr><td>Paid on</td><td>24 November 2026</td></tr>
<tr><td>Payment method</td><td>Debit card ending 0932</td></tr>
<tr><td>Amount paid</td><td>&pound;86.40</td></tr>
<tr><td>Account balance</td><td>&pound;0.00</td></tr>
<tr><td>Your next bill will be issued on</td><td>20 December 2026</td></tr>
</table>
<p>Nothing more is needed from you.</p>
</body></html>`,
    expected: [{ kind: "amount", value: "86.40" }],
  }),
  // Not expected: the bill date, the last payment day, the credit, the monthly charges before credit.
  {
    id: "h4-ie-broadband-bill",
    name: "broadband-invoice-dec2026.pdf",
    mime: "application/pdf",
    text: `Shannon Broadband Example Ltd
Invoice
Invoice date: 01/12/2026
Customer: M. Nolan     Account: SB-662031

Fibre 500 monthly charge | EUR 49.99
TV Starter add-on | EUR 10.00
Charges for the month | EUR 59.99
Loyalty credit | EUR -5.00
Amount to pay | EUR 54.99

Last payment: EUR 59.99 received 12/11/2026
Direct Debit collection date: 12/12/2026

Your Direct Debit will be collected automatically. No action is needed unless your bank details have changed.`,
    expected: [
      { kind: "due", value: "2026-12-12" },
      { kind: "amount", value: "54.99" },
    ],
  },
  // Not expected: the provisional tax paid day, the tax assessed, the credits applied, the interest start day.
  {
    id: "h4-nz-income-tax-balance",
    name: "Your income tax assessment.email",
    mime: EMAIL,
    from: "Inland Revenue Service Example",
    writtenAt: Date.UTC(2027, 2, 12, 9),
    mailKind: "bill",
    text: `Income tax assessment, year ended 31 March 2026

Tax assessed: $9,422.22
Less tax already paid: $7,548.00
Balance to pay: $1,874.22

Provisional tax payment made on 28 August 2026 is included in the tax already paid.

Due date: 7 April 2027
Use of money interest starts on 8 April 2027 for any unpaid balance.

You can pay in myIR, by internet banking, or at a bank. Use payment reference IR-0048-2271.

Inland Revenue Service Example`,
    expected: [
      { kind: "due", value: "2027-04-07" },
      { kind: "amount", value: "1874.22" },
    ],
  },
  // Not expected: the contravention day, the notice date, the increased charge.
  {
    id: "h4-uk-parking-charge-notice",
    name: "PCN-4471920.pdf",
    mime: "application/pdf",
    text: `Eastgate Borough Parking Services Example
PENALTY CHARGE NOTICE
PCN number: EG4471920
Date of notice: 12 November 2026
Vehicle registration: EX21 ABC
Location: Mill Street car park, bay 14
Contravention: parked beyond the time paid for
Date and time of contravention: 03/11/2026 at 14:20

Charge for this notice: £70.00
Charge if unpaid: £105.00

Payment deadline: 10 December 2026

Pay online, by phone on 0300 000 0000 or by post. Cheques should be made payable to Eastgate Borough Parking Services Example.`,
    expected: [
      { kind: "due", value: "2026-12-10" },
      { kind: "amount", value: "70.00" },
    ],
  },
  // Not expected: the previous term payment day, the late fee per day, the fee head parts.
  htmlMail({
    id: "h4-in-school-term-fee",
    name: "Fee Notice - Term 2 (2026-27).email",
    from: "Greenfield Public School Example",
    writtenAt: Date.UTC(2026, 11, 12, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Parent of <b>Ananya Rao</b> (Class VI-B),</p>
<p>The fee for Term 2 of the session 2026-27 is as below.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th>Fee head</th><th>Rs.</th></tr>
<tr><td>Tuition fee</td><td>22,000.00</td></tr>
<tr><td>Activity fee</td><td>3,500.00</td></tr>
<tr><td>Transport</td><td>3,000.00</td></tr>
<tr><th align="left">Total payable</th><th align="right">28,500.00</th></tr>
</table>
<table border="1" cellpadding="5" cellspacing="0" style="margin-top:8px">
<tr><th>Last date for payment</th><th>Late fee</th></tr>
<tr><td>05-Jan-2027</td><td>Rs. 50 per day after the last date</td></tr>
</table>
<p>Term 1 fee was received on 06-Jul-2026. Fees can be paid through the school parent portal.</p>
<p>Accounts Office, Greenfield Public School Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-05" },
      { kind: "amount", value: "28500.00" },
    ],
  }),
  // Not expected: the annual figure, the cover renewal day. The year is dropped on every date.
  {
    id: "h4-ie-health-premium-due",
    name: "Premium notice for your health plan.email",
    mime: EMAIL,
    from: "Atlantic Health Cover Example",
    writtenAt: Date.UTC(2026, 11, 10, 11),
    mailKind: "bill",
    text: `Dear Mr Brennan,

This is your monthly premium notice for Family Plan Plus (policy 7710-3392).

Premium due date: 3 January
Premium: EUR 138.00
Annual cost at this rate: EUR 1,656.00
Policy renewed on: 1 December

The premium is collected from your account by Direct Debit unless you pay earlier. Cover continues as long as premiums are up to date.

Atlantic Health Cover Example
Member helpline 1800 000 000`,
    expected: [
      { kind: "due", value: "2027-01-03" },
      { kind: "amount", value: "138.00" },
    ],
  },
  // Not expected: the bill date, the next bill date, the usage charge, the handset instalment, the VAT.
  {
    id: "h4-uk-mobile-bill-table",
    name: "mobile-bill-dec2026.pdf",
    mime: "application/pdf",
    text: `Pennine Mobile Example
Your bill
Bill date | 04 Dec 2026
Next bill date | 04 Jan 2027
Account | 00 7731 2208

Charges | Net | VAT | Gross
Airtime plan 20GB | £14.00 | £2.80 | £16.80
Handset instalment 11 of 24 | £25.00 | £0.00 | £25.00
Out of plan usage | £4.35 | £0.87 | £5.22
Total charges | | | £47.02

Credit from last bill | | | -£0.00
Total to pay | | | £47.02

Pay by | 18 Dec 2026
Your Direct Debit will not be used for this bill as it is set to manual payment.`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "47.02" },
    ],
  },
  // Not expected: the statement date, the paid-to date, the weekly rent, the last payment.
  {
    id: "h4-nz-rent-statement-arrears",
    name: "rent-statement-arrears.pdf",
    mime: "application/pdf",
    text: `Ridgeway Property Management Example
RENT STATEMENT
Tenant: J. Taufa     Property: 9/14 Karaka Street
Statement date: 25 November 2026

Weekly rent: $520.00
Last payment: $520.00 received 11 November 2026
Rent paid to: 18 November 2026

Rent due since | Weeks | Amount
19 Nov 2026 - 2 Dec 2026 | 2 | $1,040.00

Arrears: $1,040.00
Please clear arrears by: 2 Dec 2026
Next rent is due weekly in advance, as set out in the tenancy agreement.

Bond number: 40/0042113/B`,
    expected: [
      { kind: "due", value: "2026-12-02" },
      { kind: "amount", value: "1040.00" },
    ],
  },
  // Not expected: the previous receipt day, the subtotal, the GST.
  {
    id: "h4-in-professional-subscription",
    name: "Annual subscription 2027 - invoice.email",
    mime: EMAIL,
    from: "Institute of Chartered Practitioners Example",
    writtenAt: Date.UTC(2027, 1, 15, 5),
    mailKind: "bill",
    text: `Dear Member (No. 094417),

Your annual membership subscription for the year 2027 is now payable.

Subscription: Rs. 3,000.00
GST @ 18%: Rs. 540.00
Total payable: Rs. 3,540.00

Subscription due by: 31/03/2027
Previous subscription receipt dated: 12/03/2026

You may pay through the member portal using net banking or UPI. Members whose subscriptions remain unpaid will not be shown on the practising list.

Secretary
Institute of Chartered Practitioners Example`,
    expected: [
      { kind: "due", value: "2027-03-31" },
      { kind: "amount", value: "3540.00" },
    ],
  },
  // Not expected: the treatment day, the deposit paid, the treatment total.
  htmlMail({
    id: "h4-uk-dental-invoice-balance",
    name: "Invoice 4471 from Larch Dental Example.email",
    from: "Larch Dental Example",
    writtenAt: Date.UTC(2027, 1, 3, 14),
    mailKind: "bill",
    html: `<html><body style="font-family:Verdana">
<h3>Larch Dental Example</h3>
<p>Invoice 4471 for Mr D. Pritchard</p>
<table cellpadding="4" border="1" cellspacing="0">
<tr><td>Treatment date</td><td>21 January 2027</td></tr>
<tr><td>Crown, lower left 6</td><td>&pound;312.00</td></tr>
<tr><td>Less deposit paid</td><td>-&pound;50.00</td></tr>
<tr><td><b>Balance to pay</b></td><td><b>&pound;262.00</b></td></tr>
<tr><td>Payment terms</td><td>14 days</td></tr>
<tr><td><b>Due date</b></td><td><b>17 February 2027</b></td></tr>
</table>
<p>Payment by card over the phone or by bank transfer to the details on your treatment plan.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-17" },
      { kind: "amount", value: "262.00" },
    ],
  }),
  // Not expected: the statement date, the outstanding balance, the last instalment day.
  {
    id: "h4-ie-car-loan-statement",
    name: "loan-statement-0112.pdf",
    mime: "application/pdf",
    text: `Cashel Finance Example DAC
LOAN STATEMENT   Agreement no. CF/883120
Statement date: 01/12/2026

Original loan: EUR 14,500.00
Outstanding balance: EUR 8,410.22
Instalments remaining: 27

Last instalment: EUR 312.45 collected 28/11/2026
Next instalment: EUR 312.45
Next instalment date: 28/12/2026

The next instalment will be collected from your account by Direct Debit on the date shown. Please make sure funds are available.`,
    expected: [
      { kind: "due", value: "2026-12-28" },
      { kind: "amount", value: "312.45" },
    ],
  },
  // Not expected: the payment received day. Nothing is owed.
  {
    id: "h4-nz-club-paid-in-full",
    name: "Your subscription is paid.email",
    mime: EMAIL,
    from: "Tamaki Rowing Club Example",
    writtenAt: Date.UTC(2027, 0, 20, 7),
    mailKind: "other",
    text: `Kia ora Hemi,

Just to confirm that your 2027 club subscription has been paid in full.

Payment received: 12 January 2027
Account balance: $0.00

There is nothing more to pay. Your membership card will be ready at the boatshed from next week.

Ngā mihi,
Treasurer, Tamaki Rowing Club Example`,
    expected: [],
  },
  // Not expected: the bill date, the previous reading date, the late-payment amount, the disconnection day, the last payment day.
  {
    id: "h4-in-electricity-discom-bill",
    name: "Electricity_Bill_Dec2026.pdf",
    mime: "application/pdf",
    text: `Deccan Power Distribution Company Example
ELECTRICITY BILL
Consumer No: 2204 118 7731     Category: LT-I Domestic
Bill Date: 05-Dec-2026
Previous reading date: 04-Nov-2026     Present reading date: 03-Dec-2026

Units consumed: 214
Energy charges: 1,284.00
Fixed charges: 420.00
Electricity duty: 96.00
Meter rent and other: 618.00

Net amount payable: Rs. 2,418.00
Due Date: 20-Dec-2026
Amount payable after due date: Rs. 2,466.00

Last payment: Rs. 2,190.00 on 12-Nov-2026
Supply is liable to be disconnected if unpaid after 28-Dec-2026.`,
    expected: [
      { kind: "due", value: "2026-12-20" },
      { kind: "amount", value: "2418.00" },
    ],
  },
  // Not expected: the bill date, the annual charge, the later instalments' figures, the start of the charge year.
  {
    id: "h4-uk-council-tax-2027",
    name: "council-tax-bill-2027-28.pdf",
    mime: "application/pdf",
    text: `Westmoor District Council Example
COUNCIL TAX BILL 2027/28
Bill date: 15 March 2027
Account: 5520-0917-3
Property: 3 Birch Terrace, Westmoor
Band: D

Total council tax for the year (including police and fire precepts): £1,684.00
You have chosen to pay in 10 monthly instalments of £168.40 from April 2027 to January 2028.

First instalment to pay: £168.40
Date of first instalment: 01 April 2027

The charge year runs from 1 April 2027 to 31 March 2028.
Later instalments are collected by Direct Debit on the 1st of each month.`,
    expected: [
      { kind: "due", value: "2027-04-01" },
      { kind: "amount", value: "168.40" },
    ],
  },
  // Not expected: the earlier reminder day, the amount paid for 2026.
  {
    id: "h4-ie-property-tax-reminder",
    name: "Local Property Tax payment reminder.email",
    mime: EMAIL,
    from: "Revenue Collections Example",
    writtenAt: Date.UTC(2026, 10, 12, 10),
    mailKind: "bill",
    text: `Local Property Tax: payment reminder

Property ID: LPT-77310-X
Tax year: 2027

We wrote to you on 29 October 2026 and have not yet received your payment.

Amount of tax for 2027: EUR 315.00
Paid for 2026: EUR 301.00 (received 14 November 2025)

Pay by: 25 November 2026

If you have already paid, thank you, and please ignore this message. You can pay online with your PIN, by card by phone, or through a Direct Debit set up in advance.`,
    expected: [
      { kind: "due", value: "2026-11-25" },
      { kind: "amount", value: "315.00" },
    ],
  },
  // Not expected: the invoice date, the last bill's Direct Debit day, the usage and daily-charge parts.
  htmlMail({
    id: "h4-nz-power-bill-html",
    name: "Your power bill for November.email",
    from: "Southern Lakes Power Example",
    writtenAt: Date.UTC(2026, 11, 3, 20),
    mailKind: "bill",
    html: `<html><body style="font-family:Helvetica,Arial">
<div style="background:#f4f4f4;padding:12px">
<h2 style="margin:0">Southern Lakes Power Example</h2>
<p>Invoice date: 3 December 2026 &nbsp;|&nbsp; Account 6602118</p>
</div>
<table width="520" border="0" cellpadding="5">
<tr><td>Usage (623 kWh at 27.5c)</td><td align="right">$171.33</td></tr>
<tr><td>Daily charge (30 days at $2.10)</td><td align="right">$63.00</td></tr>
<tr><td>GST</td><td align="right">$35.15</td></tr>
<tr><td><b>Total this month</b></td><td align="right"><b>$269.48</b></td></tr>
<tr><td>Last bill, $198.50, taken by Direct Debit on</td><td align="right">22 November 2026</td></tr>
<tr><td>Amount due</td><td align="right"><b>$269.48</b></td></tr>
<tr><td>Date due</td><td align="right"><b>21 December 2026</b></td></tr>
</table>
<p>Not on Direct Debit? Pay through your online account or at any bank.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-21" },
      { kind: "amount", value: "269.48" },
    ],
  }),
  // Not expected: the last premium day, the sum assured. The year is dropped on every date.
  {
    id: "h4-in-life-insurance-premium",
    name: "Premium due intimation - Policy 5120.email",
    mime: EMAIL,
    from: "Lakshmi Assurance Example",
    writtenAt: Date.UTC(2026, 11, 18, 4),
    mailKind: "bill",
    text: `Dear Policyholder,

Greetings from Lakshmi Assurance Example. This is to remind you that the premium on your policy is falling due.

Policy no: 5120-884-22
Plan: Endowment Plus
Sum assured: Rs. 10,00,000
Last premium paid on: 15 Oct
Premium due on: 15 Jan
Premium amount: Rs. 8,420.00

You can pay online, at any branch, or through your bank's bill-pay option. Please quote the policy number.

Regards,
Customer Services, Lakshmi Assurance Example`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "amount", value: "8420.00" },
    ],
  },
  // Not expected: the issue date, the late-entry day, the late entry fee.
  {
    id: "h4-uk-exam-entry-fee",
    name: "exam-entry-invoice-spring.pdf",
    mime: "application/pdf",
    text: `Institute of Accounting Technicians Example
EXAMINATION ENTRY - FEE NOTICE
Candidate number: 20-3318-077
Date issued: 11 January 2027
Sitting: Spring 2027, Paper 3

Entry fee: £185.00
Late entry fee (applies to entries received after 12 February 2027): £60.00

Closing date for entries: Friday 29 January 2027

Entries are not accepted without payment. Pay by card on the candidate portal or send a cheque payable to Institute of Accounting Technicians Example.`,
    expected: [
      { kind: "due", value: "2027-01-29" },
      { kind: "amount", value: "185.00" },
    ],
  },
  // Not expected: the registration fee day, the weekly rate.
  htmlMail({
    id: "h4-ie-nursery-fees-feb",
    name: "February fees - Little Acorns Montessori.email",
    from: "Little Acorns Montessori Example",
    writtenAt: Date.UTC(2027, 0, 18, 13),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Parents of Saoirse,</p>
<p>Please find your fees for February below.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th>Item</th><th>Amount</th></tr>
<tr><td>Weekly rate (full day)</td><td>EUR 255.00</td></tr>
<tr><td>Weeks in February</td><td>4</td></tr>
<tr><td><b>Fees for February</b></td><td><b>EUR 1,020.00</b></td></tr>
</table>
<p><b>Payment due: 28 January 2027</b></p>
<p>Registration fee was received on 3 September 2026. Fees can be paid by bank transfer to the account on your enrolment pack.</p>
<p>Many thanks, the office team</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-28" },
      { kind: "amount", value: "1020.00" },
    ],
  }),
  // Not expected: the quote date, the quote total.
  {
    id: "h4-nz-building-quote-deposit",
    name: "deck-repair-quote-Q2291.pdf",
    mime: "application/pdf",
    text: `Rimu Builders Example Ltd
QUOTATION Q2291
Quote date: 11 Jan 2027
Job: Replace rotten deck boards and balustrade, 22 Totara Drive

Materials | $5,100.00
Labour | $3,700.00
Quote total (incl. GST) | $8,800.00

Deposit required to book the job (30%): $2,640.00
Deposit payable by: 12 Feb 2027
Quote valid until: 31 Mar 2027

Work starts within 3 weeks of the deposit being received.`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "expiry", value: "2027-03-31" },
      { kind: "amount", value: "2640.00" },
    ],
  },
  // Not expected: the bill generated day, the last payment day, the surcharge.
  {
    id: "h4-in-water-bill-municipal",
    name: "Water bill for November 2026.email",
    mime: EMAIL,
    from: "Municipal Water Board Example",
    writtenAt: Date.UTC(2026, 10, 25, 5),
    mailKind: "bill",
    text: `Municipal Water Board Example
Consumer: Smt. L. Menon     Connection ID: W-91-4470

Bill generated on: 24-11-2026
Bill period: Sep-Nov 2026
Last paid on: 12-09-2026

Water charges: Rs. 520.00
Sewerage cess: Rs. 92.00
Amount payable: Rs. 612.00
Due date: 10-12-2026
Surcharge after due date: Rs. 61.00

Pay at the citizen service centre or through the board's online portal.`,
    expected: [
      { kind: "due", value: "2026-12-10" },
      { kind: "amount", value: "612.00" },
    ],
  },
  // Not expected: the statement date, the last payment day, the next demand's issue day. Nothing is owed.
  {
    id: "h4-uk-ground-rent-nil-statement",
    name: "ground-rent-account-statement.pdf",
    mime: "application/pdf",
    text: `Hartwell Freeholds Example Ltd
ACCOUNT STATEMENT - GROUND RENT
Statement date: 10 November 2026
Property: Flat 6, Orchard House, Exampleton

Ground rent account balance: £0.00
Last payment received: 14 July 2026 (£50.00)
Next demand will be issued on: 01 June 2027

No payment is due at this time. This statement is for your records only.`,
    expected: [],
  },
  // Not expected: the bill date, the day the last Direct Debit was collected, the line rental part. The year is dropped on every date.
  {
    id: "h4-uk-broadband-january",
    name: "Your January broadband bill.email",
    mime: EMAIL,
    from: "Fenland Fibre Example",
    writtenAt: Date.UTC(2027, 0, 6, 7),
    mailKind: "bill",
    text: `Hi there,

Here is your latest bill from Fenland Fibre Example.

Bill date: 5 Jan
Line rental: £19.99
Fibre 2 broadband: £20.00
Total to pay: £39.99

Pay by: 20 Jan

Your previous bill was collected by Direct Debit on 20 Dec, so nothing more is owed for that one. If you pay by card, use the link in your account area.

Fenland Fibre Example`,
    expected: [
      { kind: "due", value: "2027-01-20" },
      { kind: "amount", value: "39.99" },
    ],
  },
  // Not expected: the policy start day, the annual premium, the issue day.
  {
    id: "h4-ie-motor-insurance-instalment",
    name: "motor-insurance-schedule.pdf",
    mime: "application/pdf",
    text: `Liffey Mutual Insurance Example DAC
MOTOR INSURANCE - PAYMENT SCHEDULE
Issued: 14/12/2026
Policy number: LM-MOT-330917
Policy start date: 14/12/2026
Annual premium: EUR 684.00
Payment plan: 6 monthly instalments

Instalment | Amount | Due on
Instalment 1 of 6 | EUR 114.00 | 14/01/2027

Later instalments will be sent to you by separate notice.
Instalments are taken by Direct Debit. Missing a payment may lead to cancellation of the policy.`,
    expected: [
      { kind: "due", value: "2027-01-14" },
      { kind: "amount", value: "114.00" },
    ],
  },
  // Not expected: the failed collection day, the last good payment day, the next fortnightly fee.
  htmlMail({
    id: "h4-nz-gym-overdue-fees",
    name: "Overdue membership fees.email",
    from: "Ponsonby Fitness Example",
    writtenAt: Date.UTC(2026, 10, 12, 1),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Mere,</p>
<p>We could not collect your membership fees on <b>8 Nov 2026</b> because your card was declined.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Last successful payment</td><td>25 Oct 2026</td></tr>
<tr><td>Overdue fees</td><td><b>$96.00</b></td></tr>
<tr><td>Next fortnightly fee after that</td><td>$48.00</td></tr>
<tr><td>Please pay by</td><td><b>20 Nov 2026</b></td></tr>
</table>
<p>Update your card in the app or at the front desk. After that date your key tag will stop working.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-11-20" },
      { kind: "amount", value: "96.00" },
    ],
  }),
  // Not expected: the statement date, the outstanding principal, the last EMI day.
  {
    id: "h4-in-loan-emi-statement",
    name: "Home_Loan_Statement_Dec2026.pdf",
    mime: "application/pdf",
    text: `Narmada Housing Finance Example Ltd
Loan Account Statement
Loan A/c No: HL/2019/00481
Statement date: 28/12/2026

Outstanding principal: Rs. 3,84,212.00
Interest rate: 8.65% p.a. (floating)

Last EMI received on: 05/12/2026
EMI amount: Rs. 14,250.00
EMI due date: 05/01/2027

Please keep sufficient balance in your account. A bounce charge of Rs. 500.00 applies on a failed mandate.`,
    expected: [
      { kind: "due", value: "2027-01-05" },
      { kind: "amount", value: "14250.00" },
    ],
  },
  // Not expected: the day the last rent was received.
  {
    id: "h4-uk-rent-reminder-text",
    name: "Rent reminder for 14 Alder Close.email",
    mime: EMAIL,
    from: "Harbour Lettings Example",
    writtenAt: Date.UTC(2027, 1, 22, 9),
    mailKind: "bill",
    text: `Dear Ms Whitfield,

A quick reminder from Harbour Lettings Example about your tenancy at 14 Alder Close. We received your February rent on 1 February 2027, thank you. Your next payment of £950.00 falls due on Monday 1 March 2027 and should reach our client account by that day.

As always, please pay by standing order and use your tenancy reference as the payment reference. If your circumstances have changed, do get in touch with the office.

Kind regards,
Harbour Lettings Example`,
    expected: [
      { kind: "due", value: "2027-03-01" },
      { kind: "amount", value: "950.00" },
    ],
  },
  // Not expected: the day of the offence, the notice day, the increased charge.
  htmlMail({
    id: "h4-ie-parking-fixed-charge",
    name: "Fixed charge notice FC-20871.email",
    from: "Dunmore Parking Management Example",
    writtenAt: Date.UTC(2026, 11, 9, 12),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial">
<h3>Fixed Charge Notice FC-20871</h3>
<table cellpadding="4" border="0">
<tr><td>Notice issued</td><td>9 December 2026</td></tr>
<tr><td>Date of parking</td><td>27 November 2026</td></tr>
<tr><td>Vehicle</td><td>12-D-48817</td></tr>
<tr><td>Fixed charge</td><td><b>EUR 80.00</b></td></tr>
<tr><td>Charge if paid late</td><td>EUR 120.00</td></tr>
<tr><td>Pay by</td><td><b>6 January 2027</b></td></tr>
</table>
<p>You can pay on our website using the notice number. Payment of the fixed charge settles the matter.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-06" },
      { kind: "amount", value: "80.00" },
    ],
  }),
  // Not expected: the treatment day, the insurer contribution, the treatment total.
  {
    id: "h4-nz-dental-account",
    name: "Account from Remuera Dental Example.email",
    mime: EMAIL,
    from: "Remuera Dental Example",
    writtenAt: Date.UTC(2026, 11, 15, 22),
    mailKind: "bill",
    text: `Dear Mr Singh,

Here is your account for your visit on 10 December 2026.

Examination and two fillings: $420.00
Less contribution from your insurer (claimed for you): $235.00
Balance owing: $185.00

Due: 29 December 2026

Internet banking details are at the foot of your last invoice. Cash and card are welcome at reception.

Remuera Dental Example`,
    expected: [
      { kind: "due", value: "2026-12-29" },
      { kind: "amount", value: "185.00" },
    ],
  },
  // Not expected: the entrance fee day, the subtotal, the GST.
  htmlMail({
    id: "h4-in-club-annual-subscription",
    name: "Annual subscription 2027 - Lakeview Club.email",
    from: "Lakeview Sports Club Example",
    writtenAt: Date.UTC(2027, 0, 5, 3),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Member 118,</p>
<p>Your subscription for the calendar year 2027 is now due.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Annual subscription</td><td>Rs. 12,000.00</td></tr>
<tr><td>GST @ 18%</td><td>Rs. 2,160.00</td></tr>
<tr><td><b>Total due</b></td><td><b>Rs. 14,160.00</b></td></tr>
<tr><td>Due by</td><td><b>31-Jan-2027</b></td></tr>
<tr><td>Entrance fee paid on</td><td>10-Mar-2025</td></tr>
</table>
<p>Pay at the club office or by NEFT to the account in your handbook.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-31" },
      { kind: "amount", value: "14160.00" },
    ],
  }),
  // Not expected: the previous bill's payment day, the previous bill amount, the issue day.
  htmlMail({
    id: "h4-uk-water-metered-bill",
    name: "Your water bill.email",
    from: "Severn Valley Water Example",
    writtenAt: Date.UTC(2027, 2, 29, 8),
    mailKind: "bill",
    html: `<html><body style="font-family:Georgia">
<h3>Severn Valley Water Example</h3>
<p>Bill issued 29/03/2027</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Metered water used (18 m3)</td><td>&pound;41.40</td></tr>
<tr><td>Sewerage</td><td>&pound;57.20</td></tr>
<tr><td>Standing charges</td><td>&pound;30.00</td></tr>
<tr><td>Bill total</td><td>&pound;128.60</td></tr>
<tr><td>Previous bill &pound;112.00, paid on</td><td>11/10/2026</td></tr>
<tr><td>Payment due by</td><td>12/04/2027</td></tr>
</table>
<p>Struggling to pay? Ask about our help schemes.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-12" },
      { kind: "amount", value: "128.60" },
    ],
  }),
  // Not expected: the issue day, the late charge start day, the late charge.
  {
    id: "h4-ie-management-fee-annual",
    name: "annual-service-charge-2027.pdf",
    mime: "application/pdf",
    text: `Ardfield Owners' Management Company Example CLG
ANNUAL SERVICE CHARGE 2027
Date of issue: 05/01/2027
Unit: Apartment 22, Ardfield Court
Owner: Ms P. Doyle

Item | Amount
Common area maintenance | EUR 640.00
Buildings insurance share | EUR 310.00
Sinking fund | EUR 200.00
Total service charge | EUR 1,150.00

Due date: 31/01/2027
A late charge of EUR 50.00 will apply from 01/02/2027.
Payment by EFT to the OMC account, quoting the unit number.`,
    expected: [
      { kind: "due", value: "2027-01-31" },
      { kind: "amount", value: "1150.00" },
    ],
  },
  // Not expected: the invoice date, the earlier payment day, the gross fees, the subsidy credit.
  {
    id: "h4-nz-childcare-invoice",
    name: "childcare-invoice-feb2027.pdf",
    mime: "application/pdf",
    text: `Pukeko Early Learning Centre Example
INVOICE 20270118
Invoice date: 15 Jan 2027
Child: Aroha K.

Description | Hours | Amount
Fees, 4 weeks to 12 Feb 2027 | 160 | $640.00
20 Hours ECE subsidy | -50 | -$275.00
Amount owing | | $365.00

Payment due | 12 Feb 2027
Previous payment received 14 Dec 2026.

Pay by internet banking to the centre account; use the invoice number as the reference.`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "amount", value: "365.00" },
    ],
  },
  // Not expected: the previous instalment's due day, the annual rates. The year is dropped on every date.
  {
    id: "h4-nz-council-rates-instalment",
    name: "Rates instalment 3 reminder.email",
    mime: EMAIL,
    from: "Waikare District Council Example",
    writtenAt: Date.UTC(2027, 1, 4, 19),
    mailKind: "bill",
    text: `Rates instalment notice

Ratepayer: P. & S. Campbell
Assessment: 4412-009-30

Annual rates (4 instalments): $2,816.60
Instalment 2 was due: 20 Nov
Instalment 3: $704.15
Instalment 3 due: 20 Feb

Pay by internet banking, direct debit or at a council service centre. Penalties are added by law to unpaid rates.

Rates team
Waikare District Council Example`,
    expected: [
      { kind: "due", value: "2027-02-20" },
      { kind: "amount", value: "704.15" },
    ],
  },
  // Not expected: the invoice date, the service period, the previous payment day, the previous balance, the router hire part.
  htmlMail({
    id: "h4-nz-broadband-invoice",
    name: "Invoice for December - Kiwi Fibre Example.email",
    from: "Kiwi Fibre Example",
    writtenAt: Date.UTC(2026, 11, 1, 16),
    mailKind: "bill",
    html: `<html><body style="font-family:Tahoma">
<table width="500" cellpadding="5" cellspacing="0" border="1">
<tr><th colspan="2" align="left">Kiwi Fibre Example - Tax invoice</th></tr>
<tr><td>Invoice date</td><td>01/12/2026</td></tr>
<tr><td>Service period</td><td>01/12/2026 - 31/12/2026</td></tr>
<tr><td>Previous balance</td><td>$0.00</td></tr>
<tr><td>Payment received</td><td>14/11/2026</td></tr>
<tr><td>Fibre 300 plan</td><td>$74.00</td></tr>
<tr><td>Router hire</td><td>$5.00</td></tr>
<tr><td>Total (GST incl.)</td><td>$79.00</td></tr>
<tr><td>Pay on or before</td><td><b>14/12/2026</b></td></tr>
</table>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-14" },
      { kind: "amount", value: "79.00" },
    ],
  }),
  // Not expected: the visit day, the full fee, the ACC contribution, the issue day.
  {
    id: "h4-nz-gp-invoice",
    name: "GP-invoice-0127.pdf",
    mime: "application/pdf",
    text: `Mt Eden Medical Centre Example
Patient invoice
Issued: 20 Jan 2027
Date of visit: 12 Jan 2027
Patient: T. Wiremu

Consultation (standard) | $95.00
ACC contribution | -$45.00
Patient share | $50.00

Please pay by: 3 Feb 2027
Payments can be made at reception, by card over the phone, or into our bank account using your NHI number as the reference.`,
    expected: [
      { kind: "due", value: "2027-02-03" },
      { kind: "amount", value: "50.00" },
    ],
  },
  // Not expected: the policy start day, the monthly alternative, the excess.
  {
    id: "h4-nz-house-insurance-renewal",
    name: "Your house insurance renews soon.email",
    mime: EMAIL,
    from: "Tui Insurance Example",
    writtenAt: Date.UTC(2027, 0, 12, 21),
    mailKind: "bill",
    text: `Kia ora Sione,

Your home insurance is set to renew automatically.

Policy: HOME-5530-221
Policy first started: 5 February 2026
Excess: $400.00
Renewal premium: $1,120.00
Monthly alternative: 12 x $96.40

On 5 February 2027 we will charge $1,120.00 to the card on file. To change anything before then, call us or use the app.

Tui Insurance Example`,
    expected: [
      { kind: "due", value: "2027-02-05" },
      { kind: "amount", value: "1120.00" },
    ],
  },
  // Not expected: the invoice date, the last payment day, the previous outstanding, the base charge and GST.
  {
    id: "h4-in-broadband-invoice",
    name: "BroadbandInvoice_Jan2027.pdf",
    mime: "application/pdf",
    text: `Netlink Fibre Example Pvt Ltd
TAX INVOICE
Invoice No: SN/2027/011904
Invoice Date: 01-Jan-2027
Customer ID: 70031882

Particulars | Amount (INR)
Unlimited Fibre 100 Mbps - monthly | 1,000.00
IGST @ 18% | 180.00
Previous outstanding | 0.00
Total amount payable | 1,180.00

Last payment received: 03-Dec-2026
Pay before: 16-Jan-2027

Services may be suspended for non-payment after the due date.`,
    expected: [
      { kind: "due", value: "2027-01-16" },
      { kind: "amount", value: "1180.00" },
    ],
  },
  // Not expected: the previous year's payment day, the penalty. The year is dropped on every date.
  {
    id: "h4-in-property-tax-notice",
    name: "Property tax notice 2027-28.email",
    mime: EMAIL,
    from: "Nagar Municipal Corporation Example",
    writtenAt: Date.UTC(2027, 2, 10, 6),
    mailKind: "bill",
    text: `Property Tax Notice for FY 2027-28

Assessee: Shri K. Venkatesh
Property ID: ZN4/0912/118

Arrears: Rs. 0.00
Property tax payable: Rs. 6,840.00
Previous year's tax was paid on 28 June.

Pay before: 31 March
Penalty if paid after the date above: Rs. 684.00

Pay on the corporation portal, at any e-seva centre, or at the ward office counter.

Revenue Department, Nagar Municipal Corporation Example`,
    expected: [
      { kind: "due", value: "2027-03-31" },
      { kind: "amount", value: "6840.00" },
    ],
  },
  // Not expected: the bill date, the previous bill's payment day, the plan rental, the GST.
  htmlMail({
    id: "h4-in-postpaid-mobile-bill",
    name: "Your postpaid bill is ready.email",
    from: "Sagar Telecom Example",
    writtenAt: Date.UTC(2026, 11, 11, 7),
    mailKind: "bill",
    html: `<html><body>
<h3>Postpaid bill for 98xxxxxx21</h3>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Bill date</td><td>10 Dec 2026</td></tr>
<tr><td>Plan rental (Rs. 749)</td><td>749.00</td></tr>
<tr><td>GST</td><td>134.82</td></tr>
<tr><td>Bill amount</td><td><b>Rs. 883.82</b></td></tr>
<tr><td>Due date</td><td><b>26 Dec 2026</b></td></tr>
<tr><td>Last bill paid on</td><td>14 Nov 2026</td></tr>
</table>
<p>Pay with UPI, card or net banking from the app.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-26" },
      { kind: "amount", value: "883.82" },
    ],
  }),
  // Not expected: the issue day, the late-fee window end, the late fee.
  {
    id: "h4-in-university-exam-fee",
    name: "Exam_Fee_Notice_Sem4.pdf",
    mime: "application/pdf",
    text: `Vidya Sagar University Example
CONTROLLER OF EXAMINATIONS
Notice for payment of examination fee - Semester IV

Notice date: 02.01.2027
Enrolment no: BC/2024/10932

Examination fee: Rs. 1,850.00
Late fee (Rs. 500.00) accepted up to: 30.01.2027

Last date for payment of fee: 20.01.2027

Candidates who do not pay the fee will not be issued admit cards. Fee may be paid online through the university payment gateway.`,
    expected: [
      { kind: "due", value: "2027-01-20" },
      { kind: "amount", value: "1850.00" },
    ],
  },
  // Not expected: the payment day, the next invoice day.
  {
    id: "h4-in-payment-success",
    name: "Payment successful.email",
    mime: EMAIL,
    from: "Netlink Fibre Example",
    writtenAt: Date.UTC(2026, 11, 3, 5),
    mailKind: "receipt",
    text: `Dear Customer,

We have received your payment.

Amount paid: Rs. 2,300.00
Transaction date: 02-12-2026
Transaction ID: UPI/6120/884471
Mode: UPI

Your next invoice will be generated on 01-01-2027. No payment is pending on your account.

Thank you,
Netlink Fibre Example`,
    expected: [{ kind: "amount", value: "2300.00" }],
  },
  // Not expected: the last rent day. The year is dropped on every date.
  {
    id: "h4-ie-rent-statement-feb",
    name: "Rent statement for February.email",
    mime: EMAIL,
    from: "Ballymore Residential Example",
    writtenAt: Date.UTC(2027, 0, 28, 9),
    mailKind: "bill",
    text: `Hi Dara,

Your rent statement for Apartment 8, The Maltings:

Rent received 2 Jan: EUR 1,350.00
Balance carried forward: EUR 0.00

Rent due 1 Feb: EUR 1,350.00

Please pay into the Ballymore client account. Payments are matched using your tenancy number.

Ballymore Residential Example`,
    expected: [
      { kind: "due", value: "2027-02-01" },
      { kind: "amount", value: "1350.00" },
    ],
  },
  // Not expected: the statement issue day, the preliminary tax paid day, the liability, the payments made.
  htmlMail({
    id: "h4-ie-tax-balancing-statement",
    name: "Your balancing statement.email",
    from: "Revenue Office Example",
    writtenAt: Date.UTC(2027, 0, 20, 11),
    mailKind: "bill",
    html: `<html><body>
<h3>Balancing statement, tax year 2025</h3>
<table border="1" cellpadding="5" cellspacing="0">
<tr><td>Statement issued</td><td>20 January 2027</td></tr>
<tr><td>Total liability</td><td>EUR 5,840.00</td></tr>
<tr><td>Preliminary tax paid on 31 October 2026</td><td>EUR 5,200.00</td></tr>
<tr><td>Balance due</td><td><b>EUR 640.00</b></td></tr>
<tr><td>Pay by</td><td><b>12 February 2027</b></td></tr>
</table>
<p>Pay through your online account or by bank transfer using your PPS-style reference.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "amount", value: "640.00" },
    ],
  }),
  // Not expected: the statement date, the last payment day, the minimum payment.
  {
    id: "h4-ie-credit-card-statement",
    name: "card-statement-nov2026.pdf",
    mime: "application/pdf",
    text: `Emerald Bank Example plc
CREDIT CARD STATEMENT
Card ending 7782
Statement date: 30/11/2026

Opening balance: EUR 612.30
Payments received: EUR 612.30 (last payment 18/11/2026)
New spending: EUR 1,320.45

Closing balance | Minimum payment | Payment due date
EUR 1,320.45 | EUR 39.61 | 21/12/2026

Interest is charged on any balance not paid in full by the payment due date.`,
    expected: [
      { kind: "due", value: "2026-12-21" },
      { kind: "amount", value: "1320.45" },
    ],
  },
  // Not expected: the first reminder day, the monthly alternative. The licence end is an expiry.
  htmlMail({
    id: "h4-uk-tv-licence-renewal",
    name: "Your TV Licence is about to run out.email",
    from: "Television Licensing Example",
    writtenAt: Date.UTC(2026, 11, 14, 10),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial">
<h3>Time to renew your licence</h3>
<p>We first reminded you on 1 December 2026.</p>
<table border="0" cellpadding="4">
<tr><td>Licence ends</td><td>31 January 2027</td></tr>
<tr><td>Annual cost</td><td>&pound;174.50</td></tr>
<tr><td>Or monthly Direct Debit</td><td>&pound;14.54</td></tr>
<tr><td>Renew by</td><td><b>16 January 2027</b></td></tr>
</table>
<p>Watching live TV without a licence can lead to a fine.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-16" },
      { kind: "expiry", value: "2027-01-31" },
      { kind: "amount", value: "174.50" },
    ],
  }),
  // Not expected: the return received day, the tax year liability, the payments on account made.
  {
    id: "h4-uk-self-assessment-balance",
    name: "Your Self Assessment payment.email",
    mime: EMAIL,
    from: "Revenue and Customs Service Example",
    writtenAt: Date.UTC(2027, 0, 12, 8),
    mailKind: "bill",
    text: `Self Assessment 2025-26

We received your tax return on 6 October 2026.

Tax liability for the year: £4,810.60
Payments on account already made: £2,500.00
Balance to pay: £2,310.60

Date by which to pay: Sunday 31 January 2027

Paying late adds interest from the day after. You can pay by Faster Payments, debit card or online banking using your 10-digit reference.

Revenue and Customs Service Example`,
    expected: [
      { kind: "due", value: "2027-01-31" },
      { kind: "amount", value: "2310.60" },
    ],
  },
];
