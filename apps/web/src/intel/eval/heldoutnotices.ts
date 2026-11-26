/**
 * Forty more held-out documents: bills, notices, statements and quotes,
 * written without sight of the readers. They are part of the held-out set:
 * no case here is ever used to tune a rule or an instruction.
 */

import { mailBodyText } from "../htmltext";
import type { EvalCase } from "./score";

const EMAIL = "application/vnd.engram.email+json";

/** An HTML mail: the body rides as `raw`, as the app passes it, and its text is what the app's own step makes of it. */
const htmlMail = (c: Omit<EvalCase, "mime" | "text" | "raw"> & { html: string }): EvalCase => {
  const { html, ...rest } = c;
  return { ...rest, mime: EMAIL, text: mailBodyText({ html }), raw: html };
};

export const HELDOUT_NOTICE_CASES: readonly EvalCase[] = [
  // Not expected: the issue date, the billing period, the payment of 20 October 2026, the next meter read, the previous bill, the line charges.
  {
    id: "h2-water-quarterly",
    name: "water-account-jan-2027.pdf",
    mime: "application/pdf",
    text: `Southgate Water Example
TAX INVOICE
Account number | 5530 1187 04
Issue date | 12 January 2027
Billing period | 1 October 2026 to 31 December 2026
Service address | 14 Wattle Court, Bayview VIC
Description | Usage | Charge
Water usage | 61 kL | $142.30
Sewerage service charge | | $71.85
Water service charge | | $24.00
Total charges this bill | | $238.15
Previous bill | | $219.40
Payment received 20 October 2026 | | -$219.40
Amount to pay | | $238.15
Pay by | | 9 February 2027
Next meter read | | on or about 31 March 2027
Pay online, by BPAY or at any post office.`,
    expected: [
      { kind: "due", value: "2027-02-09" },
      { kind: "amount", value: "238.15" },
    ],
  },
  // Not expected: the treatment date, the date the insurance claim was sent, the zero insurer line.
  htmlMail({
    id: "h2-dental-html",
    name: "Your invoice from Corrib Dental Example.email",
    from: "Corrib Dental Example",
    writtenAt: Date.UTC(2027, 1, 3, 14),
    mailKind: "bill",
    html: `<html><body style="font-family:Arial,sans-serif">
<p>Dear Ms Keane,</p>
<p>Thank you for visiting us. Your invoice is below.</p>
<table border="1" cellpadding="6" cellspacing="0">
<tr><th>Invoice no.</th><th>Date of treatment</th><th>Description</th><th align="right">Fee</th></tr>
<tr><td>4471</td><td>28 Jan 2027</td><td>Examination, scale and polish</td><td align="right">&euro;185.00</td></tr>
<tr><td colspan="3">Less insurer contribution (claim sent 29 Jan 2027)</td><td align="right">&euro;0.00</td></tr>
<tr><td colspan="3"><b>Balance payable</b></td><td align="right"><b>&euro;185.00</b></td></tr>
</table>
<p>Payment terms: net 14 days. Settle by <b>17 February 2027</b> by card over the phone or by bank transfer.</p>
<p>Corrib Dental Example, Quay Road</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-17" },
      { kind: "amount", value: "185.00" },
    ],
  }),
  // Not expected: the bill date, the previous Direct Debit of 6 November 2026.
  {
    id: "h2-broadband-plain",
    name: "Your Fibrelink bill is ready.email",
    mime: EMAIL,
    from: "Fibrelink Broadband Example",
    writtenAt: Date.UTC(2026, 10, 18, 8),
    mailKind: "bill",
    text: `Hi Priya,

Your latest Fibrelink bill is ready to view in your account.

Bill date:            18 November 2026
Bill number:          FL-2290417
Charges this month:   £42.99
Direct Debit:         we will collect £42.99 on 7 December 2026
Last Direct Debit:    £42.99 collected on 6 November 2026

Nothing else for you to do. If your details have changed, update them in the app before that date.

The Fibrelink team`,
    expected: [
      { kind: "due", value: "2026-12-07" },
      { kind: "amount", value: "42.99" },
    ],
  },
  // Not expected: the date of notice, the date and time of the contravention.
  {
    id: "h2-parking-pcn",
    name: "penalty-charge-notice-MB40318827.pdf",
    mime: "application/pdf",
    text: `Marlow Borough Parking Example
PENALTY CHARGE NOTICE
Notice number: MB 40318827
Date of notice: 11 December 2026
Vehicle registration: KX27 EXM
Date and time of contravention: 4 December 2026 at 14:20
Location: Hollin Lane car park, bay 12
Contravention: Parked beyond the period paid for
Penalty charge: £70.00
Payment is due by: 8 January 2027
If you wish to challenge this notice you must make written representations before the date above.
Pay online, by phone or by post.`,
    expected: [
      { kind: "due", value: "2027-01-08" },
      { kind: "amount", value: "70.00" },
    ],
  },
  // Not expected: the date the return was filed, the tax year end, the date of the mail.
  {
    id: "h2-tax-balance-running",
    name: "Outcome of your 2025 return.email",
    mime: EMAIL,
    from: "Eastbrook Tax Office Example",
    writtenAt: Date.UTC(2027, 0, 12, 10),
    mailKind: "bill",
    text: `Dear Mr Doyle,

We have finished reviewing the return you filed on 15 October 2026 for the tax year that ended on 31 December 2025. The review shows a balance of €1,240.00 payable by you. We ask that the full balance reaches us no later than 31 January 2027, after which interest will be charged for each day it remains unpaid.

You can pay through your online account or at any post office. If you think the figure is wrong, please reply to this mail with your reference, ET-77-30412.

Eastbrook Tax Office Example`,
    expected: [
      { kind: "due", value: "2027-01-31" },
      { kind: "amount", value: "1240.00" },
    ],
  },
  // Not expected: the letter date, the date the Term 1 fees were received, the term dates.
  {
    id: "h2-nursery-term2",
    name: "term2-fees-letter.pdf",
    mime: "application/pdf",
    text: `Kowhai Early Learning Centre Example
14 February 2027

Tena koutou, whanau,

TERM 2 FEES (26 April to 2 July 2027)
Child | Days per week | Fee
Mere T. | 3 | $1,860.00
Term 1 fees were received in full on 11 February 2027, with thanks.
Amount payable | | $1,860.00
Payment due | | Friday 5 March 2027
Please use the child's name as the bank reference.
Naku noa, the office team`,
    expected: [
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "1860.00" },
    ],
  },
  // Not expected: the statement date, the previous balance and the payment of 28 November 2026, the new transactions, the minimum payment.
  htmlMail({
    id: "h2-card-sg-html",
    name: "Your credit card e-statement.email",
    from: "Merlion Bank Cards Example",
    writtenAt: Date.UTC(2026, 11, 21, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Cardmember,</p>
<p>Your e-statement is ready. A summary follows.</p>
<table width="480" border="0" cellpadding="4">
<tr><td>Statement Date</td><td>20 Dec 2026</td></tr>
<tr><td>Previous Balance</td><td>S$1,100.00</td></tr>
<tr><td>Payment received 28 Nov 2026</td><td>-S$900.00</td></tr>
<tr><td>New Transactions</td><td>S$1,332.60</td></tr>
<tr><td><b>Total Outstanding</b></td><td><b>S$1,532.60</b></td></tr>
<tr><td>Minimum Payment</td><td>S$50.00</td></tr>
<tr><td><b>Payment Due Date</b></td><td><b>14 Jan 2027</b></td></tr>
</table>
<p>Log in to view your full statement.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-14" },
      { kind: "amount", value: "1532.60" },
    ],
  }),
  // Not expected: the last payment of 11/02/2026.
  {
    id: "h2-rent-us-plain",
    name: "December rent reminder.email",
    mime: EMAIL,
    from: "Maple Court Apartments Example",
    writtenAt: Date.UTC(2026, 10, 25, 9),
    mailKind: "bill",
    text: `Hi Daniel,

A quick note from the Maple Court office about next month's rent.

Unit: 3B
Monthly rent: $1,850.00
Rent due date: 12/01/2026
Last payment received: 11/02/2026 ($1,850.00)

You can pay through the resident portal or leave a check at the office.

Thanks,
Maple Court Management`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "1850.00" },
    ],
  },
  // Not expected: the notice date, the last renewal date, the fee before tax, the tax.
  {
    id: "h2-gym-renewal-in",
    name: "membership-renewal-notice.pdf",
    mime: "application/pdf",
    text: `Zenith Fitness Club Example
MEMBERSHIP RENEWAL NOTICE
Notice date: 12-11-2026
Member ID: ZF/BLR/20418
Plan: Annual - All Access
Last renewed on: 06-12-2025
Renewal deadline: 05-12-2026
Fee | ₹ 12,000.00
GST @ 18% | ₹ 2,160.00
Total payable | ₹ 14,160.00
Pay at the front desk or by UPI.`,
    expected: [
      { kind: "due", value: "2026-12-05" },
      { kind: "amount", value: "14160.00" },
    ],
  },
  // Not expected: the date of the payment, the date of the next bill.
  {
    id: "h2-hydro-paid-ca",
    name: "We received your payment.email",
    mime: EMAIL,
    from: "Lakeshore Hydro Example",
    writtenAt: Date.UTC(2026, 11, 2, 10),
    mailKind: "receipt",
    text: `Hi Chantal,

Thank you. We received your payment of $128.46 on December 1, 2026 for account 7720-4415. Your confirmation number is 88213907.

Your account balance is now $0.00.
Your next bill will be issued on January 4, 2027.

No further action is needed.

Lakeshore Hydro Example`,
    expected: [{ kind: "amount", value: "128.46" }],
  },
  // Not expected: the bill date, the balance brought forward and its clearing date of 21 January 2027, the support line.
  {
    id: "h2-counciltax-uk",
    name: "council-tax-2027-28.pdf",
    mime: "application/pdf",
    text: `Ashdown District Council Example
COUNCIL TAX BILL 2027/28
Bill date: 5 March 2027
Account reference: 4400 7731 02
Property: 9 Gorse Lane, Ashdown
Valuation band: D
Annual charge | £1,876.40
Council tax support | £0.00
Balance brought forward from 2026/27 (cleared 21 January 2027) | £0.00
Total payable for the year | £1,876.40
Pay in full by: 1 April 2027
Instalment plans are not offered with this bill. Contact us if you need a different arrangement.`,
    expected: [
      { kind: "due", value: "2027-04-01" },
      { kind: "amount", value: "1876.40" },
    ],
  },
  // Not expected: the policy period dates, the date billed, the last payment of January 3, 2027.
  {
    id: "h2-insurance-premium-us",
    name: "Premium notice for policy PM-4417-908.email",
    mime: EMAIL,
    from: "Pinecrest Mutual Example",
    writtenAt: Date.UTC(2027, 0, 8, 12),
    mailKind: "bill",
    text: `Hello Marcus,

Your auto policy renews next month. This is your premium notice.

Policy number: PM-4417-908
Policy period: February 1, 2027 to February 1, 2028
Renewal premium: $612.50
Date billed: January 8, 2027
Premium due date: Monday, February 1, 2027
Last payment received: January 3, 2027 (prior term, $98.00)

Pay by card, bank draft or at any agent office.

Pinecrest Mutual Example`,
    expected: [
      { kind: "due", value: "2027-02-01" },
      { kind: "amount", value: "612.50" },
    ],
  },
  // Not expected: the issue date, the usage period, the last payment of 12/02/2027.
  htmlMail({
    id: "h2-mobile-au-html",
    name: "Your Outback Mobile bill.email",
    from: "Outback Mobile Example",
    writtenAt: Date.UTC(2027, 2, 9, 7),
    mailKind: "bill",
    html: `<html><body>
<p>G'day Chris,</p>
<p>Your latest bill is here.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th>Bill issued</th><th>Usage period</th><th>Payment due</th><th>Total to pay</th></tr>
<tr><td>09/03/2027</td><td>01/02/2027 - 28/02/2027</td><td>23/03/2027</td><td>$79.00</td></tr>
</table>
<p>Your last payment of $79.00 was received on 12/02/2027. Thanks!</p>
<p>Outback Mobile Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-23" },
      { kind: "amount", value: "79.00" },
    ],
  }),
  // Not expected: the bill date, the reading dates, the previous bill and its due date and payment, the line charges.
  {
    id: "h2-electricity-in",
    name: "electricity-bill-dec-2026.pdf",
    mime: "application/pdf",
    text: `Eastern Grid Distribution Example
ELECTRICITY BILL
Consumer No. | 4417 22 0931
Bill date | 14-12-2026
Previous reading date | 10-11-2026
Present reading date | 10-12-2026
Units consumed | 318
Energy charges | ₹ 2,544.00
Fixed charges | ₹ 150.00
Duty and surcharges | ₹ 788.00
Previous bill | ₹ 2,910.00 | due 22-11-2026 | paid 05-11-2026
Due date | 29-12-2026
Amount payable by due date | ₹ 3,482.00`,
    expected: [
      { kind: "due", value: "2026-12-29" },
      { kind: "amount", value: "3482.00" },
    ],
  },
  // Not expected: the invoice date, the date the Autumn term fees were received.
  {
    id: "h2-school-spring-running",
    name: "Spring term fees.email",
    mime: EMAIL,
    from: "Hartwell School Example",
    writtenAt: Date.UTC(2027, 0, 5, 17),
    mailKind: "bill",
    text: `Invoice no. 20917
Invoice date: 5 January 2027

Dear Mr and Mrs Okafor,

Welcome back for the Spring term. The fees for Oliver for this term come to £4,215.00 in total, covering tuition, lunches and music tuition. Autumn term fees were received on 4 December 2026, thank you. For this term, please arrange for payment to reach the bursar by Friday 22 January 2027, either by bank transfer or by cheque.

With kind regards,
The Bursar's Office`,
    expected: [
      { kind: "due", value: "2027-01-22" },
      { kind: "amount", value: "4215.00" },
    ],
  },
  // Not expected: the notice date, the offence date and time.
  {
    id: "h2-speeding-au",
    name: "infringement-notice-7120884.pdf",
    mime: "application/pdf",
    text: `State Fines Service Example
TRAFFIC INFRINGEMENT NOTICE
Notice date: 20/01/2027
Infringement no.: 7 120 884 3
Offence date: 03/01/2027
Time: 08:47
Offence: Exceed speed limit by less than 10 km/h
Location: Coast Road, Eastvale
Penalty amount: $277.00
Due date: 19/02/2027
Pay online, by phone or at a service centre. Quote the infringement number.`,
    expected: [
      { kind: "due", value: "2027-02-19" },
      { kind: "amount", value: "277.00" },
    ],
  },
  // Not expected: the date of service, the invoice total, the deposit and the date it was received.
  htmlMail({
    id: "h2-physio-ca-html",
    name: "Invoice 1093 from Harbourview Physio Example.email",
    from: "Harbourview Physio Example",
    writtenAt: Date.UTC(2027, 1, 15, 11),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Jordan,</p>
<p>Your invoice for last week's visit.</p>
<table cellpadding="4">
<tr><td>Date of service</td><td>Feb 10, 2027</td></tr>
<tr><td>Treatment (45 min)</td><td>$95.00</td></tr>
<tr><td>Deposit received Feb 10, 2027</td><td>-$20.00</td></tr>
<tr><td><b>Balance due</b></td><td><b>$75.00</b></td></tr>
<tr><td>Due date</td><td>Mar 1, 2027</td></tr>
</table>
<p>E-transfer to the clinic address is fine.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-01" },
      { kind: "amount", value: "75.00" },
    ],
  }),
  // Not expected: the date of the quote, the provisional start week, the labour, materials and VAT lines.
  {
    id: "h2-wall-quote-uk",
    name: "quote-Q-2291-garden-wall.pdf",
    mime: "application/pdf",
    text: `Fernley Building Services Example
QUOTATION Q-2291
Date of quote: 8 February 2027
Works: Replace rear garden wall (approx. 8 m), including footings and capping
Labour | £2,350.00
Materials | £1,640.00
VAT at 20% | £798.00
Total quote | £4,788.00
Prices valid until: 30 April 2027
Please confirm acceptance by: 12 March 2027
Provisional start: week commencing 24 May 2027`,
    expected: [
      { kind: "due", value: "2027-03-12" },
      { kind: "expiry", value: "2027-04-30" },
      { kind: "amount", value: "4788.00" },
    ],
  },
  // Not expected: the member since date, the last charge of March 14, 2026.
  htmlMail({
    id: "h2-streaming-renewal-html",
    name: "Your StreamNest plan renews soon.email",
    from: "StreamNest Example",
    writtenAt: Date.UTC(2027, 1, 25, 15),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Taylor,</p>
<p>Your annual plan will renew automatically.</p>
<table cellpadding="5" border="1" cellspacing="0">
<tr><td>Plan</td><td>Annual Premium</td></tr>
<tr><td>Renewal date</td><td>March 14, 2027</td></tr>
<tr><td>Amount to be charged</td><td>$119.99</td></tr>
<tr><td>Member since</td><td>March 14, 2022</td></tr>
<tr><td>Last charge</td><td>$109.99 on March 14, 2026</td></tr>
</table>
<p>To change or cancel, open Account &gt; Plan before the renewal date.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-14" },
      { kind: "amount", value: "119.99" },
    ],
  }),
  // Not expected: the statement date, the dates of the charges and payments listed, the period.
  {
    id: "h2-tenant-statement-uk",
    name: "tenant-statement-dec-2026.pdf",
    mime: "application/pdf",
    text: `Westgate Lettings Example
TENANT STATEMENT
Statement date: 15 December 2026
Tenant: Ms A. Reid
Property: Flat 4, 22 Orchard Road
Date | Description | Charge | Payment
1 Oct 2026 | Rent | £950.00 |
2 Oct 2026 | Payment received | | £950.00
1 Nov 2026 | Rent | £950.00 |
3 Nov 2026 | Payment received | | £950.00
1 Dec 2026 | Rent | £950.00 |
1 Dec 2026 | Payment received | | £950.00
Balance | | | £0.00
Your account is fully paid. No payment is needed.`,
    expected: [],
  },
  // Not expected: the invoice date, the last payment of $198.50 and its date.
  {
    id: "h2-power-nz",
    name: "Your Kiwi Hearth bill.email",
    mime: EMAIL,
    from: "Kiwi Hearth Energy Example",
    writtenAt: Date.UTC(2026, 11, 3, 9),
    mailKind: "bill",
    text: `Kia ora Aroha,

Your power bill for November is ready.

Invoice date: 3 December 2026
Invoice number: 60418822
Account: 11-4-77802
Amount due: $214.37
Pay by: 21 December 2026
Last payment: $198.50 received on 18 November 2026

You can also set up automatic payments in the app.

Ngā mihi,
Kiwi Hearth Energy Example`,
    expected: [
      { kind: "due", value: "2026-12-21" },
      { kind: "amount", value: "214.37" },
    ],
  },
  // Not expected: the bill date, the bill period, the last GIRO deduction of 19 Dec 2026.
  htmlMail({
    id: "h2-fibre-sg-html",
    name: "Island Fibre e-bill for January.email",
    from: "Island Fibre Example",
    writtenAt: Date.UTC(2027, 0, 5, 8),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Customer,</p>
<p>Your e-bill is ready.</p>
<table border="0" cellpadding="3">
<tr><td>Bill Date</td><td>05 Jan 2027</td></tr>
<tr><td>Bill Period</td><td>05 Dec 2026 - 04 Jan 2027</td></tr>
<tr><td>Last GIRO deduction</td><td>S$49.90 on 19 Dec 2026</td></tr>
<tr><td>Amount to be deducted</td><td>S$49.90</td></tr>
<tr><td>GIRO deduction date</td><td>19 Jan 2027</td></tr>
</table>
<p>Please make sure your account has enough funds.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-19" },
      { kind: "amount", value: "49.90" },
    ],
  }),
  // Not expected: the notice date, the date the return was assessed.
  {
    id: "h2-tax-balance-ca",
    name: "Notice of balance owing.email",
    mime: EMAIL,
    from: "Maple Revenue Agency Example",
    writtenAt: Date.UTC(2027, 2, 22, 9),
    mailKind: "bill",
    text: `Notice date: March 22, 2027
Reference: MRA-2026-77120

Dear Ms Tremblay,

We assessed your 2026 return on March 20, 2027. The assessment shows a balance owing of $2,106.35. To avoid interest, this balance has to be paid by April 30, 2027. You can pay through your bank's bill payment service or in your online account.

If you disagree with the assessment, you may file an objection.

Maple Revenue Agency Example`,
    expected: [
      { kind: "due", value: "2027-04-30" },
      { kind: "amount", value: "2106.35" },
    ],
  },
  // Not expected: the invoice date, the date of the visit, the amount paid at reception.
  {
    id: "h2-clinic-ie",
    name: "invoice-88217.pdf",
    mime: "application/pdf",
    text: `Liffey Family Clinic Example
INVOICE 88217
Invoice date: 15 January 2027
Date of visit: 14 January 2027
Patient: R. Byrne
Consultation | €95.00
Paid at reception on 14 January 2027 | -€30.00
Balance outstanding | €65.00
Payment due within 21 days: 5 February 2027
Cards, cash and bank transfer are accepted.`,
    expected: [
      { kind: "due", value: "2027-02-05" },
      { kind: "amount", value: "65.00" },
    ],
  },
  // Not expected: the mailing date, the assessment date, the assessed value, the note on the 2025 taxes.
  {
    id: "h2-property-tax-us",
    name: "property-tax-statement-2026.pdf",
    mime: "application/pdf",
    text: `Calloway County Tax Collector Example
2026 PROPERTY TAX STATEMENT
Mailing date: 11/16/2026
Parcel: 04-221-0087
Assessment date: 01/01/2026
Net taxable value | $312,000.00
Rate per $100 | 1.3840
Annual tax | $4,318.08
2025 taxes were paid in full on 12/12/2025.
Pay on or before: 01/31/2027
Amount due: $4,318.08
Payments may be made online, by mail or at the courthouse annex.`,
    expected: [
      { kind: "due", value: "2027-01-31" },
      { kind: "amount", value: "4318.08" },
    ],
  },
  // Not expected: the statement date, the previous balance, the payment of 21 December 2026, the new purchases, the minimum payment.
  {
    id: "h2-card-uk-plain",
    name: "Your Thornbury Visa statement.email",
    mime: EMAIL,
    from: "Thornbury Card Services Example",
    writtenAt: Date.UTC(2027, 0, 14, 7),
    mailKind: "bill",
    text: `Dear Ms Whitfield,

Your Thornbury Visa statement is ready.

Statement date        13 January 2027
Previous balance      £610.45
Payments received     £500.00 (on 21 December 2026)
New purchases         £632.67
New balance           £743.12
Minimum payment       £25.00
Pay by                8 February 2027

Paying less than the new balance means interest is charged.`,
    expected: [
      { kind: "due", value: "2027-02-08" },
      { kind: "amount", value: "743.12" },
    ],
  },
  // Not expected: the date paid, the date the next invoice will be sent.
  htmlMail({
    id: "h2-school-receipt-in-html",
    name: "Fee receipt GPS-2026-4417.email",
    from: "Greenfield Public School Example",
    writtenAt: Date.UTC(2026, 11, 3, 11),
    mailKind: "receipt",
    html: `<html><body>
<p>Dear Parent,</p>
<p>We acknowledge your payment.</p>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th>Receipt No.</th><td>GPS/2026/4417</td></tr>
<tr><th>Date paid</th><td>02-12-2026</td></tr>
<tr><th>Towards</th><td>Term 2 tuition</td></tr>
<tr><th>Mode</th><td>UPI</td></tr>
<tr><th>Amount paid</th><td>&#8377; 4,500.00</td></tr>
</table>
<p>The Term 3 invoice will be sent on 01-02-2027.</p>
</body></html>`,
    expected: [{ kind: "amount", value: "4500.00" }],
  }),
  // Not expected: none; every date and sum printed is in the expected list.
  {
    id: "h2-surf-club-au",
    name: "Time to renew your membership.email",
    mime: EMAIL,
    from: "Seabright Surf Club Example",
    writtenAt: Date.UTC(2027, 5, 2, 9),
    mailKind: "bill",
    text: `Hi Mia,

It is time to renew your membership of Seabright Surf Club Example.

Member number: SB-0782
Current membership ends: 30 June 2027
Renewal fee: $140.00
Renewal due: 16 June 2027

Renew online or at the clubhouse bar.

See you on the sand,
The committee`,
    expected: [
      { kind: "due", value: "2027-06-16" },
      { kind: "expiry", value: "2027-06-30" },
      { kind: "amount", value: "140.00" },
    ],
  },
  // Not expected: the date of notice, the date of filing, the total income.
  {
    id: "h2-assessment-sg",
    name: "notice-of-assessment-YA2027.pdf",
    mime: "application/pdf",
    text: `Island Tax Authority Example
NOTICE OF ASSESSMENT (YEAR OF ASSESSMENT 2027)
Date of Notice | 18 Apr 2027
Date of filing | 12 Mar 2027
Total income | S$ 61,400.00
Tax payable | S$ 3,204.50
Payment due date | 18 May 2027
Payment can be made by GIRO, internet banking or at a post office.`,
    expected: [
      { kind: "due", value: "2027-05-18" },
      { kind: "amount", value: "3204.50" },
    ],
  },
  // Not expected: the job date.
  {
    id: "h2-plumber-running",
    name: "Invoice for the boiler pump.email",
    mime: EMAIL,
    from: "Redwood Heating Example",
    writtenAt: Date.UTC(2027, 5, 1, 16),
    mailKind: "bill",
    text: `Job number: JB-2245
Job date: 27 May 2027

Hi Helen,

Thanks for having us out to fix the boiler pump. The invoice for the work comes to £265.00 including parts and VAT. We would be grateful if you could settle it by Friday 18 June 2027, by bank transfer to the details on the attached invoice.

Regards,
Redwood Heating Example`,
    expected: [
      { kind: "due", value: "2027-06-18" },
      { kind: "amount", value: "265.00" },
    ],
  },
  // Not expected: the date of service, the total charges, the insurance payment and its date of 12/02/2026.
  htmlMail({
    id: "h2-radiology-us-html",
    name: "Statement from Summit Radiology Example.email",
    from: "Summit Radiology Example",
    writtenAt: Date.UTC(2026, 11, 12, 10),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Ms Alvarez,</p>
<p>This is a statement for services you received. It is not a bill from your insurer.</p>
<table border="1" cellpadding="6" cellspacing="0">
<tr><td>Date of service</td><td>11/18/2026</td></tr>
<tr><td>Total charges</td><td>$852.40</td></tr>
<tr><td>Insurance paid (received 12/02/2026)</td><td>-$640.00</td></tr>
<tr><td><b>Amount you owe</b></td><td><b>$212.40</b></td></tr>
<tr><td>Pay by</td><td>01/11/2027</td></tr>
</table>
<p>Questions? Call our billing office.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-11" },
      { kind: "amount", value: "212.40" },
    ],
  }),
  // Not expected: the reminder date, the first reminder of 2 December 2026, the original bill's date and due date.
  {
    id: "h2-gas-reminder-ie",
    name: "gas-reminder-90-221-4410.pdf",
    mime: "application/pdf",
    text: `Atlantic Gas Supply Example
REMINDER NOTICE
Reminder date: 10 December 2026
Account: 90-221-4410
Our first reminder was sent on 2 December 2026.
Original bill dated 19 November 2026, due 3 December 2026.
Amount overdue | €156.20
Please pay by: 23 December 2026
If you have already paid, please ignore this notice.`,
    expected: [
      { kind: "due", value: "2026-12-23" },
      { kind: "amount", value: "156.20" },
    ],
  },
  // Not expected: Instalment 2 and the date it was due and paid.
  {
    id: "h2-rates-nz",
    name: "Your rates instalment.email",
    mime: EMAIL,
    from: "Hauraki Coast Council Example",
    writtenAt: Date.UTC(2027, 3, 28, 8),
    mailKind: "bill",
    text: `Kia ora,

Here is a reminder about your rates.

Rating unit: 14 Rata Street
Instalment 3 amount: $687.45
Instalment 3 due date: 20 May 2027

Instalment 2 (due 20 February 2027) was paid on 18 February 2027, thank you.

Hauraki Coast Council Example`,
    expected: [
      { kind: "due", value: "2027-05-20" },
      { kind: "amount", value: "687.45" },
    ],
  },
  // Not expected: the last payment and its date, the policy start date.
  htmlMail({
    id: "h2-pet-dd-uk-html",
    name: "Advance notice of your Direct Debit.email",
    from: "Pawsure Pet Cover Example",
    writtenAt: Date.UTC(2027, 1, 12, 13),
    mailKind: "bill",
    html: `<html><body>
<h3>Advance notice</h3>
<table cellpadding="4">
<tr><td>Policy</td><td>PC-88120</td></tr>
<tr><td>Policy start date</td><td>14 June 2026</td></tr>
<tr><td>Last payment</td><td>1 February 2027 (&pound;18.75)</td></tr>
<tr><td>Next payment date</td><td>1 March 2027</td></tr>
<tr><td>Amount</td><td>&pound;18.75</td></tr>
</table>
<p>The payment will show on your statement as PAWSURE EXAMPLE.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-01" },
      { kind: "amount", value: "18.75" },
    ],
  }),
  // Not expected: the letter date, the date of the trip.
  {
    id: "h2-school-trip-running",
    name: "year4-science-centre-letter.pdf",
    mime: "application/pdf",
    text: `Beech Lane Primary School Example
Date: 22 February 2027

Dear parents and carers,

Year 4 will visit the Riverside Science Centre on 3 June 2027. To confirm your child's place, please return the signed consent form and pay the £35.00 contribution to the school office by 12 March 2027. Places cannot be held after that day.

Thank you for your support,
Mrs Ellis, Year 4 Lead`,
    expected: [
      { kind: "due", value: "2027-03-12" },
      { kind: "amount", value: "35.00" },
    ],
  },
  // Not expected: the bill date, the closure date, the charges, the payments, the credit and the date the refund is made.
  {
    id: "h2-final-bill-uk",
    name: "final-bill-account-closed.pdf",
    mime: "application/pdf",
    text: `Severn Water Example
FINAL BILL
Bill date: 18 January 2027
Account closed: 15 January 2027
Charges up to closure | £82.40
Payments received | £116.50
Account credit | £34.10
We will refund the credit to your bank account by 12 February 2027.
Nothing further is owed on this account.`,
    expected: [],
  },
  // Not expected: the bill date, the date of collection.
  htmlMail({
    id: "h2-broadband-paid-ie-html",
    name: "Your January bill is already paid.email",
    from: "Shannon Broadband Example",
    writtenAt: Date.UTC(2027, 0, 5, 9),
    mailKind: "receipt",
    html: `<html><body>
<p>Hello Aoife,</p>
<table border="0" cellpadding="4">
<tr><td>Bill date</td><td>2 January 2027</td></tr>
<tr><td>Bill total</td><td>&euro;54.20</td></tr>
<tr><td>Collected by Direct Debit on</td><td>4 January 2027</td></tr>
<tr><td>Status</td><td><b>PAID</b></td></tr>
</table>
<p>There is nothing more for you to pay.</p>
</body></html>`,
    expected: [{ kind: "amount", value: "54.20" }],
  }),
  // Not expected: the original due date.
  {
    id: "h2-gas-pastdue-us",
    name: "Your gas account is past due.email",
    mime: EMAIL,
    from: "Prairie Gas Co Example",
    writtenAt: Date.UTC(2026, 11, 7, 8),
    mailKind: "bill",
    text: `Hello Erin,

Our records show your gas account is past due.

Account: 5520-8841
Original due date: November 20, 2026
Past due amount: $184.55
Pay by: December 14, 2026, to avoid a service interruption

If you have already sent your payment, thank you, and please disregard this message.

Prairie Gas Co Example`,
    expected: [
      { kind: "due", value: "2026-12-14" },
      { kind: "amount", value: "184.55" },
    ],
  },
  // Not expected: the date the permit was issued.
  {
    id: "h2-permit-ca",
    name: "Your parking permit renewal.email",
    mime: EMAIL,
    from: "Northshore City Parking Example",
    writtenAt: Date.UTC(2027, 1, 22, 9),
    mailKind: "bill",
    text: `Hello,

Your resident parking permit is due for renewal.

Permit number: RP-30417
Issued: April 1, 2026
Expires: March 31, 2027
Renewal fee: $65.00
Renew by: March 14, 2027

Renew in the online portal. A renewed permit is mailed within 10 days.`,
    expected: [
      { kind: "due", value: "2027-03-14" },
      { kind: "expiry", value: "2027-03-31" },
      { kind: "amount", value: "65.00" },
    ],
  },
  // Not expected: the notice date, the policy issue date, the last premium date, the end of the grace period.
  {
    id: "h2-life-premium-in",
    name: "premium-due-notice-SL0047718.pdf",
    mime: "application/pdf",
    text: `Sunrise Life Insurance Example
PREMIUM DUE NOTICE
Notice date: 10-12-2026
Policy no.: SL/0047718
Policy issue date: 20-01-2016
Last premium paid on: 19-01-2026 (₹ 18,500.00)
Premium due date: 20-01-2027
Premium amount: ₹ 18,500.00
Grace period ends: 19-02-2027
Cover continues only while premiums are paid.`,
    expected: [
      { kind: "due", value: "2027-01-20" },
      { kind: "amount", value: "18500.00" },
    ],
  },
];
