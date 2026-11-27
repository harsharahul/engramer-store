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

export const HELDOUT_MAIL2_CASES: readonly EvalCase[] = [
  // Not expected: the last payment day, the last payment sum (14.50).
  {
    id: "h6-tv-licence-dd-failed",
    name: "Your TV Licence payment did not go through.email",
    mime: EMAIL,
    from: "TV Licensing Example",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "bill",
    text: `Hello,

Your last Direct Debit instalment was returned by your bank, so your licence is not paid up.

Licence number: 7301 2294 08
Annual fee: £174.50
Pay by: 27 November 2026
Last payment received: 1 October 2026 (£14.50)

You can pay online with your licence number and postcode, or call 0300 555 0100.

TV Licensing Example, Customer Services, PO Box 1234, Bristol.
`,
    expected: [
      { kind: "due", value: "2026-11-27" },
      { kind: "amount", value: "174.50" },
    ],
  },
  // Not expected: the last renewal day, the surcharge start, the reminder letter day, the six month sum (107.25).
  htmlMail({
    id: "h6-vehicle-tax-renew",
    name: "Your vehicle tax is due for renewal.email",
    from: "Vehicle Licensing Reminders Example",
    writtenAt: Date.UTC(2026, 11, 3, 10),
    mailKind: "bill",
    html: `<html><body>
<p>Dear keeper,</p>
<p>Vehicle tax for registration <b>EX21 KLM</b> needs renewing.</p>
<table border="1" cellpadding="6">
<tr><th align="left">Renew before</th><td>31 December 2026</td></tr>
<tr><th align="left">12 months</th><td>£195.00</td></tr>
<tr><th align="left">6 months</th><td>£107.25</td></tr>
<tr><th align="left">Last renewal paid</th><td>5 January 2026</td></tr>
<tr><th align="left">Surcharge applies from</th><td>1 January 2027</td></tr>
</table>
<p>If we do not hear from you, a reminder letter will be posted on 14 December 2026.</p>
<p>Pay the 12 month rate (£195.00) to keep your tax running without a gap.</p>
<p style="font-size:11px">Vehicle Licensing Reminders Example. This mailbox is not monitored. Unsubscribe in your account settings.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-31" },
      { kind: "amount", value: "195.00" },
    ],
  }),
  // Not expected: the tax year end, the penalty start day, the payment on account sums (1830.00 each), the balancing sum (2380.00).
  {
    id: "h6-self-assessment-balance",
    name: "Self Assessment: your payments for 2025-26.email",
    mime: EMAIL,
    from: "Revenue Services Example",
    writtenAt: Date.UTC(2027, 0, 12, 7),
    mailKind: "bill",
    text: `Self Assessment reminder

Tax year ended 5 April 2026

Balancing payment for 2025-26:            £2,380.00
First payment on account for 2026-27:     £1,830.00
-----------------------------------------------------
Total now payable:                        £4,210.00

Payable by Sunday 31 January 2027.

Second payment on account due: 31 July 2027 (£1,830.00)

If the total is not paid by 31 January 2027, a late payment penalty applies from 1 March 2027.

Pay from your online account or by bank transfer using your 10 digit reference 4471920058.

Revenue Services Example. Do not reply to this message.
`,
    expected: [
      { kind: "due", value: "2027-01-31" },
      { kind: "due", value: "2027-07-31" },
      { kind: "amount", value: "4210.00" },
    ],
  },
  // Not expected: the invoice day, the meter read days, the previous balance and payment (287.10), the water and wastewater lines.
  htmlMail({
    id: "h6-water-invoice-nz",
    name: "Water and wastewater invoice 8830412.email",
    from: "Waterline Council Example",
    writtenAt: Date.UTC(2026, 10, 16, 20),
    mailKind: "bill",
    html: `<html><body>
<h3>Invoice 8830412</h3>
<table cellpadding="4">
<tr><td>Invoice date</td><td>16/11/2026</td></tr>
<tr><td>Last meter read</td><td>29/10/2026</td></tr>
<tr><td>Next meter read</td><td>29/01/2027</td></tr>
</table>
<table border="1" cellpadding="4">
<tr><th>Description</th><th>Amount</th></tr>
<tr><td>Previous balance</td><td>$287.10</td></tr>
<tr><td>Payment received 05/09/2026</td><td>-$287.10</td></tr>
<tr><td>Water supply</td><td>$98.40</td></tr>
<tr><td>Wastewater</td><td>$214.45</td></tr>
<tr><td><b>Amount due</b></td><td><b>$312.85</b></td></tr>
</table>
<table cellpadding="4"><tr><td>Due date</td><td>10/12/2026</td></tr></table>
<p>Pay online, by automatic payment or at any bank. Questions: 0800 555 019.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-10" },
      { kind: "amount", value: "312.85" },
    ],
  }),
  // Not expected: the last payment day, the subsidy credit (120.00), the gross fee (780.00).
  {
    id: "h6-childcare-december-ie",
    name: "December fees at Little Acorns.email",
    mime: EMAIL,
    from: "Little Acorns Childcare Example",
    writtenAt: Date.UTC(2026, 10, 20, 11),
    mailKind: "bill",
    text: `Hi Aoife,

December fees for Cian:

Fee, 5 days: €780.00
Subsidy credit: -€120.00
Balance to pay: €660.00
Payment due: 04/12/2026
Last payment received: 02/11/2026

Thanks,
Little Acorns office
office@littleacorns.example.com
`,
    expected: [
      { kind: "due", value: "2026-12-04" },
      { kind: "amount", value: "660.00" },
    ],
  },
  // Not expected: the last payment day and sum (700.00), the arrears (450.00), this month's rent (1150.00), the rent period, the possession notice day.
  {
    id: "h6-rent-demand-arrears",
    name: "Rent demand: account 20418.email",
    mime: EMAIL,
    from: "Harbour Lettings Example",
    writtenAt: Date.UTC(2026, 10, 25, 9),
    mailKind: "bill",
    text: `Dear Mr Okafor,

RENT DEMAND

Property: Flat 4, Pennine Court, Leeds
Tenancy ref: 20418

Arrears brought forward:     £450.00
Rent for 1 December 2026 to 31 December 2026:     £1,150.00
Total payable:    £1,600.00

Our records show your last payment, £700.00, arrived on 3 November 2026.

Pay by: Tuesday 1 December 2026

If the arrears are not cleared, the landlord may serve notice seeking possession from 15 December 2026.

Please pay by standing order to the client account quoting the tenancy reference.

Harbour Lettings Example, 12 Quay Street. Registered with a client money protection scheme.
`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "1600.00" },
    ],
  },
  // Not expected: the demand day, the accounting year end, the budget statement day, the service charge (640.00) and ground rent (75.00) lines.
  htmlMail({
    id: "h6-service-charge-ground-rent",
    name: "Demand for service charge and ground rent.email",
    from: "Redbrick Estates Example",
    writtenAt: Date.UTC(2027, 0, 8, 12),
    mailKind: "bill",
    html: `<html><body>
<p>Dear leaseholder of Unit 9, Marlow House,</p>
<p>Demand date: 8 January 2027<br/>Accounting year ended: 31 December 2026</p>
<table border="1" cellpadding="5">
<tr><th>Item</th><th>Period</th><th>Sum</th></tr>
<tr><td>Service charge</td><td>1 Jan 2027 to 30 Jun 2027</td><td>£640.00</td></tr>
<tr><td>Ground rent</td><td>Half year</td><td>£75.00</td></tr>
<tr><td colspan="2"><b>Total demanded</b></td><td><b>£715.00</b></td></tr>
</table>
<p>Payable by: Monday 8 February 2027</p>
<p>The year-end budget statement will be sent to you by 31 March 2027.</p>
<p>Summary of leaseholders' rights and obligations is available on request.</p>
<p>Redbrick Estates Example, managing agent.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-08" },
      { kind: "amount", value: "715.00" },
    ],
  }),
  // Not expected: instalment 1 paid day, the annual total (1944.80), the penalty day.
  {
    id: "h6-rates-instalment-nz",
    name: "Rates instalment notice 2026/27.email",
    mime: EMAIL,
    from: "Kauri Bay Rates Example",
    writtenAt: Date.UTC(2026, 10, 30, 8),
    mailKind: "bill",
    text: `RATES INSTALMENT NOTICE 2026/27
Assessment 5521-04

Annual rates:  $1,944.80   (four instalments)

Instalment 1   $486.20   paid 22/09/2026
Instalment 2   $486.20   due 22/12/2026
Instalment 3   $486.20   due 22/03/2027
Instalment 4   $486.20   due 22/06/2027

Amount due this instalment: $486.20

A penalty of 10% is added to any unpaid balance on 23/12/2026.

Pay by internet banking, direct debit or at the service centre. Assessment number must be quoted.
`,
    expected: [
      { kind: "due", value: "2026-12-22" },
      { kind: "due", value: "2027-03-22" },
      { kind: "due", value: "2027-06-22" },
      { kind: "amount", value: "486.20" },
    ],
  },
  // Not expected: the bill day, the bill period, the day the last bill was collected, the next bill day, the previous balance (47.10).
  htmlMail({
    id: "h6-mobile-bill-ie",
    name: "Your Emerald Mobile bill is ready.email",
    from: "Emerald Mobile Example",
    writtenAt: Date.UTC(2026, 11, 14, 6),
    mailKind: "bill",
    html: `<html><body>
<p>Hi there, your bill is here.</p>
<table border="1" cellpadding="4">
<tr><td>Bill date</td><td>14 Dec 2026</td></tr>
<tr><td>Bill period</td><td>14 Nov 2026 - 13 Dec 2026</td></tr>
<tr><td>Previous bill</td><td>€47.10, collected 1 Dec 2026</td></tr>
<tr><td>Monthly plan</td><td>€35.00</td></tr>
<tr><td>Data add-on</td><td>€6.50</td></tr>
<tr><td>Roaming</td><td>€8.49</td></tr>
<tr><td>Total (incl. VAT 23%)</td><td><b>€49.99</b></td></tr>
<tr><td>Direct debit collection date</td><td>29 Dec 2026</td></tr>
<tr><td>Next bill</td><td>14 Jan 2027</td></tr>
</table>
<p>Emerald Mobile Example. Help: 1800 555 010.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-29" },
      { kind: "amount", value: "49.99" },
    ],
  }),
  // Not expected: the day the earlier mail was sent, the last bill's sum (94.20) and its paid day.
  {
    id: "h6-fwd-water-uk",
    name: "Fwd: Your water bill.email",
    mime: EMAIL,
    from: "Priya Shah",
    writtenAt: Date.UTC(2026, 10, 27, 18),
    mailKind: "bill",
    text: `Dad, this came for you. I have not paid it, it is in your name. Can you sort it at the weekend?

P

-------- Forwarded message --------
From: Thamesbank Water Example <billing@thamesbankwater.example.com>
Sent: 20 November 2026 07:02
To: ravi.shah@example.org
Subject: Your water bill

Dear Mr Shah,

Account balance: £188.40
Please pay by 18 December 2026.

Your last bill, £94.20, was paid on 12 October 2026. Thank you.

Pay online, by direct debit or at a PayPoint outlet.
Thamesbank Water Example
`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "188.40" },
    ],
  },
  // Not expected: nothing else is printed.
  {
    id: "h6-council-tax-dd-notice",
    name: "Council Tax: your next Direct Debit.email",
    mime: EMAIL,
    from: "Millbrook Borough Council Example",
    writtenAt: Date.UTC(2027, 2, 20, 9),
    mailKind: "bill",
    text: `Dear resident,

Council Tax account 3320 1187
Instalment 12 of 12: £142.00
Collection date: 1 April 2027

Nothing more is needed from you. Your bank will take the money on that day.

Millbrook Borough Council Example, Revenues Team.
`,
    expected: [
      { kind: "due", value: "2027-04-01" },
      { kind: "amount", value: "142.00" },
    ],
  },
  // Not expected: the day the 2026 payment was received.
  {
    id: "h6-property-tax-ie",
    name: "Local Property Tax 2027.email",
    mime: EMAIL,
    from: "Property Tax Office Example",
    writtenAt: Date.UTC(2027, 1, 5, 10),
    mailKind: "bill",
    text: `Dear Ms Brennan,

Our records show that your Local Property Tax for 2026 was received on 10 March 2026, with thanks.

The liability for 2027 on your property at 14 Dunmore Road is €315.00. You must pay this in full, or have a payment method in place for it, on or before 21 February 2027.

You can do this through your online account or by calling the helpline.

Property Tax Office Example
`,
    expected: [
      { kind: "due", value: "2027-02-21" },
      { kind: "amount", value: "315.00" },
    ],
  },
  // Not expected: the statement day, the last payment day, the previous balance and payments (912.40), the minimum payment (25.00), the promotional rate end.
  htmlMail({
    id: "h6-credit-card-statement-uk",
    name: "Your December statement.email",
    from: "Meridian Card Example",
    writtenAt: Date.UTC(2026, 11, 5, 7),
    mailKind: "bill",
    html: `<html><body>
<p>Your statement for card ending 6620 is ready to view.</p>
<table border="1" cellpadding="4">
<tr><td>Statement date</td><td>05-Dec-2026</td></tr>
<tr><td>Previous balance</td><td>£912.40</td></tr>
<tr><td>Payments received (28-Nov-2026)</td><td>-£912.40</td></tr>
<tr><td>New purchases and fees</td><td>£1,284.37</td></tr>
<tr><td>Statement balance</td><td><b>£1,284.37</b></td></tr>
<tr><td>Minimum payment</td><td>£25.00</td></tr>
<tr><td>Payment due date</td><td>30-Dec-2026</td></tr>
<tr><td>0% balance transfer rate ends</td><td>31-Jan-2027</td></tr>
</table>
<p>Pay the statement balance by the due date to avoid interest.</p>
<p style="font-size:10px">Meridian Card Example is a trading name. Representative APR 24.9%.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-30" },
      { kind: "amount", value: "1284.37" },
    ],
  }),
  // Not expected: the outstanding balance (14220.18), the statement period.
  {
    id: "h6-loan-statement-uk",
    name: "Loan statement, January 2027.email",
    mime: EMAIL,
    from: "Cedar Loans Example",
    writtenAt: Date.UTC(2027, 0, 4, 8),
    mailKind: "bill",
    text: `Loan account 004-9917-2

Statement period 2026-12-01 to 2026-12-31
Balance outstanding: £14,220.18
Monthly payment: £386.55
Next payment due: 2027-02-01

Your payment is taken by Direct Debit unless you tell us otherwise. Cedar Loans Example is authorised and regulated.
`,
    expected: [
      { kind: "due", value: "2027-02-01" },
      { kind: "amount", value: "386.55" },
    ],
  },
  // Not expected: the payment day, the next bill day.
  {
    id: "h6-payment-received-energy",
    name: "Thanks, we have your payment.email",
    mime: EMAIL,
    from: "Northern Spark Energy Example",
    writtenAt: Date.UTC(2026, 11, 4, 15),
    mailKind: "receipt",
    text: `Hi Mark,

We received your payment of £86.40 on 3 December 2026. Your account is now up to date.

Account balance: £0.00
Next bill expected: 3 March 2027

Northern Spark Energy Example
`,
    expected: [{ kind: "amount", value: "86.40" }],
  },
  // Not expected: the treatment day, the total (300.00), the deposit (50.00).
  htmlMail({
    id: "h6-dental-invoice-ie",
    name: "Invoice D-5530 from Larchfield Dental.email",
    from: "Larchfield Dental Example",
    writtenAt: Date.UTC(2027, 1, 9, 13),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Mr Walsh,</p>
<table border="1" cellpadding="5">
<tr><td>Treatment date</td><td>02/02/2027</td></tr>
<tr><td>Crown fitting</td><td>€240.00</td></tr>
<tr><td>Hygienist</td><td>€60.00</td></tr>
<tr><td>Total</td><td>€300.00</td></tr>
<tr><td>Deposit paid</td><td>-€50.00</td></tr>
<tr><td><b>Balance</b></td><td><b>€250.00</b></td></tr>
<tr><td>Due by</td><td>23/02/2027</td></tr>
</table>
<p>Medical expenses receipt (Med 2) available on request.</p>
<p>Larchfield Dental Example, 3 Church Lane.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-23" },
      { kind: "amount", value: "250.00" },
    ],
  }),
  // Not expected: the contravention day, the increased charge (150.00) and its day.
  {
    id: "h6-parking-charge-notice",
    name: "Parking Charge Notice PX-90714.email",
    mime: EMAIL,
    from: "Parkwell Enforcement Example",
    writtenAt: Date.UTC(2026, 10, 18, 14),
    mailKind: "bill",
    text: `PARKING CHARGE NOTICE

Vehicle: EX19 ABC
Location: Riverside Retail Park, Bay 14
Contravention date: 8 November 2026
Parking charge: £100.00
Payment due: 2 December 2026

If the charge is unpaid, it increases to £150.00 on 16 December 2026 and the matter may pass to our collections team.

To appeal, reply to this email quoting PX-90714.

Parkwell Enforcement Example
`,
    expected: [
      { kind: "due", value: "2026-12-02" },
      { kind: "amount", value: "100.00" },
    ],
  },
  // Not expected: the new price day, the new price (14.00).
  htmlMail({
    id: "h6-news-subscription-renewal",
    name: "Your subscription renews soon.email",
    from: "Daily Chronicle Digital Example",
    writtenAt: Date.UTC(2027, 0, 5, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Hello,</p>
<p>Your digital subscription is set to renew automatically.</p>
<table cellpadding="4">
<tr><td>Renewal date:</td><td><b>19 January 2027</b></td></tr>
<tr><td>Amount to be charged:</td><td><b>£12.00</b></td></tr>
<tr><td>Card:</td><td>ending 4417</td></tr>
<tr><td>New monthly price from:</td><td>19 February 2027 (£14.00)</td></tr>
</table>
<p>To cancel, visit your account page before the renewal date.</p>
<p style="font-size:11px">Daily Chronicle Digital Example. Unsubscribe from marketing emails.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-19" },
      { kind: "amount", value: "12.00" },
    ],
  }),
  // Not expected: nothing else is printed.
  {
    id: "h6-home-insurance-no-year",
    name: "Your home insurance renewal.email",
    mime: EMAIL,
    from: "Shamrock Mutual Insurance Example",
    writtenAt: Date.UTC(2027, 0, 14, 10),
    mailKind: "bill",
    text: `Dear Customer,

Your policy HI-88231 renews on 1 February. The premium is €412.60 and we will collect it from your account on 28 January, so there is nothing to do unless your details have changed.

Call us on 01 555 0123 if you want to change your cover.

Shamrock Mutual Insurance Example is regulated by the Central Bank.
`,
    expected: [
      { kind: "due", value: "2027-01-28" },
      { kind: "amount", value: "412.60" },
    ],
  },
  // Not expected: the earlier reminder day, the original bill (317.17), the late fee (25.00), the visit day.
  {
    id: "h6-electricity-final-notice",
    name: "FINAL NOTICE: electricity account 55-1209.email",
    mime: EMAIL,
    from: "Ironbridge Power Example",
    writtenAt: Date.UTC(2026, 10, 24, 8),
    mailKind: "bill",
    text: `FINAL NOTICE

Account: 55-1209
Original bill: £317.17
Late payment fee: £25.00
Total outstanding: £342.17

Pay in full by 4 December 2026.

We wrote to you on 10 November 2026 and have had no reply. If the account is still unpaid, a visit to arrange a prepayment meter may be booked from 11 December 2026.

Pay by card on our site, by phone or at a Post Office with your bill.

Ironbridge Power Example, Customer Care.
`,
    expected: [
      { kind: "due", value: "2026-12-04" },
      { kind: "amount", value: "342.17" },
    ],
  },
  // Not expected: the meter reading day, the billing period, the unit sums.
  {
    id: "h6-gas-bill-no-year",
    name: "Your gas bill from Fenland Gas.email",
    mime: EMAIL,
    from: "Fenland Gas Example",
    writtenAt: Date.UTC(2026, 11, 1, 8),
    mailKind: "bill",
    text: `Dear Mrs Tate,

Here is your gas bill for the period 1 September to 30 November.

Meter reading taken on: 25 November
Reading: 48,112 kWh (previous 47,380 kWh)
Usage 732 kWh at 7.1p per kWh: £51.97
Standing charge, 91 days at 28.5p: £25.94
VAT at 5%: £3.89

Amount to pay: £81.80

Payment due: 23 December

You can pay by card, Direct Debit or at a PayPoint shop. If you are struggling, please call us on 0800 555 0188.

Fenland Gas Example. Registered in England.
`,
    expected: [
      { kind: "due", value: "2026-12-23" },
      { kind: "amount", value: "81.80" },
    ],
  },
  // Not expected: the invoice day.
  htmlMail({
    id: "h6-broadband-invoice-nz",
    name: "Invoice for February.email",
    from: "Kiwi Fibre Example",
    writtenAt: Date.UTC(2027, 1, 2, 5),
    mailKind: "bill",
    html: `<html><body>
<p>Kia ora,</p>
<p>Invoice date: 2 Feb 27</p>
<p>Fibre 300 plan: <b>$89.00</b></p>
<p>Due 16 Feb 27</p>
<p>Kiwi Fibre Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-16" },
      { kind: "amount", value: "89.00" },
    ],
  }),
  // Not expected: the trip day.
  {
    id: "h6-school-trip-ie",
    name: "Sixth class trip to the Science Centre.email",
    mime: EMAIL,
    from: "St Brendan's Primary School Example",
    writtenAt: Date.UTC(2027, 2, 1, 12),
    mailKind: "bill",
    text: `Dear parents and guardians,

Sixth class will visit the Science Centre this term.

Date of trip: 30/03/2027
Permission form to be returned by: 15/03/2027
Trip fee: €25.00, payable by: 26/03/2027

Fees can be paid through the school app or in an envelope marked with your child's name.

Ms Daly, Principal
St Brendan's Primary School Example
`,
    expected: [
      { kind: "due", value: "2027-03-15" },
      { kind: "due", value: "2027-03-26" },
      { kind: "amount", value: "25.00" },
    ],
  },
  // Not expected: the year the assessment covers.
  {
    id: "h6-income-tax-balance-ie",
    name: "Notice of assessment 2026.email",
    mime: EMAIL,
    from: "Revenue Office Example",
    writtenAt: Date.UTC(2027, 4, 10, 9),
    mailKind: "bill",
    text: `Dear Mr Lynch,

Your income tax assessment for the year ended 31 December 2026 has been completed. It shows a balance of €1,950.00 to pay. Please pay it by 18 June 2027 using your online account or the payment slip enclosed with your letter.

Revenue Office Example
`,
    expected: [
      { kind: "due", value: "2027-06-18" },
      { kind: "amount", value: "1950.00" },
    ],
  },
  // Not expected: the quote day, the estimated start, the quoted sum (4860.00).
  htmlMail({
    id: "h6-roof-repair-quote",
    name: "Quote Q-2210 for your roof repair.email",
    from: "Oakley Roofing Example",
    writtenAt: Date.UTC(2026, 11, 14, 16),
    mailKind: "other",
    html: `<html><body>
<p>Dear Ms Gregory,</p>
<p>Thank you for having us visit. Our quote is below.</p>
<table border="1" cellpadding="5">
<tr><td>Quote number</td><td>Q-2210</td></tr>
<tr><td>Quote date</td><td>14 December 2026</td></tr>
<tr><td>Strip and re-tile rear slope</td><td>£4,860.00</td></tr>
<tr><td>Quote valid until</td><td>12 January 2027</td></tr>
<tr><td>Estimated start</td><td>1 March 2027</td></tr>
</table>
<p>Reply to this email to accept. No payment is needed until work begins.</p>
<p>Oakley Roofing Example, 14 Mill Lane.</p>
</body></html>`,
    expected: [{ kind: "expiry", value: "2027-01-12" }],
  }),
  // Not expected: the earlier reminder's day (27 November 2026), the part payment day and sum (400.00), the original sum (950.00).
  {
    id: "h6-reply-rent-reminder",
    name: "Re: Rent reminder for 22 Bell Street.email",
    mime: EMAIL,
    from: "Hollin Residential Lettings Example",
    writtenAt: Date.UTC(2026, 10, 30, 10),
    mailKind: "bill",
    text: `Hi Dan,

Thanks, I have posted your part payment of £400.00 received on 28 November 2026. The balance is now £550.00 and the new date for it is 15 December 2026.

Regards,
Jo, Accounts
Hollin Residential Lettings Example

> From: Hollin Residential Lettings Example
> Sent: 20 November 2026 09:15
> To: dan.mercer@example.org
> Subject: Rent reminder for 22 Bell Street
>
> Dear Dan,
> Rent for November is outstanding: £950.00.
> Please pay by 27 November 2026.
`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "550.00" },
    ],
  },
  // Not expected: nothing else is printed.
  {
    id: "h6-card-reminder-ie",
    name: "Payment reminder.email",
    mime: EMAIL,
    from: "Bluebell Card Example",
    writtenAt: Date.UTC(2026, 11, 2, 7),
    mailKind: "bill",
    text: `Hello Niamh,

A quick reminder about your Bluebell card.

Payment due: €35.00
Pay by: 09/12/2026

Paying on time keeps your account in good standing.
Bluebell Card Example
`,
    expected: [
      { kind: "due", value: "2026-12-09" },
      { kind: "amount", value: "35.00" },
    ],
  },
  // Not expected: the offence day, the increased fine (120.00) and its day.
  htmlMail({
    id: "h6-fixed-charge-ie",
    name: "Fixed charge notice FC-33871.email",
    from: "Fixed Charge Processing Example",
    writtenAt: Date.UTC(2026, 10, 13, 11),
    mailKind: "bill",
    html: `<html><body>
<h4>Fixed Charge Notice FC-33871</h4>
<table border="1" cellpadding="4">
<tr><td>Date of offence</td><td>31/10/2026</td></tr>
<tr><td>Offence</td><td>Speeding, 60 km/h zone</td></tr>
<tr><td>Fixed charge</td><td>€80.00</td></tr>
<tr><td>Pay by</td><td>11/12/2026</td></tr>
<tr><td>Increased charge if unpaid</td><td>€120.00 from 12/12/2026</td></tr>
</table>
<p>Payment can be made online with the notice number above.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-11" },
      { kind: "amount", value: "80.00" },
    ],
  }),
  // Not expected: the day the earlier reminder was sent.
  {
    id: "h6-second-reminder-nz",
    name: "Second reminder: power account.email",
    mime: EMAIL,
    from: "Silverfern Power Example",
    writtenAt: Date.UTC(2026, 11, 9, 20),
    mailKind: "bill",
    text: `Hi Tane,

We sent a first reminder on 02/12/2026 and have not seen a payment yet.

Overdue amount: $230.40
Please pay by: 18/12/2026

Silverfern Power Example
`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "230.40" },
    ],
  },
  // Not expected: the statement day, the next statement day, the day the new rate starts.
  htmlMail({
    id: "h6-savings-rate-change",
    name: "A change to your savings rate.email",
    from: "Harlow Savings Example",
    writtenAt: Date.UTC(2027, 1, 26, 9),
    mailKind: "other",
    html: `<html><body>
<p>Dear customer,</p>
<p>We are writing to let you know that the interest rate on your Easy Saver account is changing.</p>
<table border="1" cellpadding="4">
<tr><td>Current rate</td><td>3.10% AER</td></tr>
<tr><td>New rate</td><td>2.80% AER</td></tr>
<tr><td>New rate starts</td><td>1 April 2027</td></tr>
<tr><td>Next statement</td><td>31 March 2027</td></tr>
</table>
<p>You do not need to do anything. If you would like to move your money, you can do so at any time without charge.</p>
<p>Harlow Savings Example. Statement issued 26 February 2027.</p>
</body></html>`,
    expected: [],
  }),
  // Not expected: nothing else is printed.
  {
    id: "h6-car-insurance-dd-no-year",
    name: "Your next car insurance payment.email",
    mime: EMAIL,
    from: "Pennant Insurance Example",
    writtenAt: Date.UTC(2026, 11, 28, 9),
    mailKind: "bill",
    text: `Hello,

Your monthly car insurance payment is coming up.

Amount: £47.80
Next payment date: 6 January

It will be taken by Direct Debit. Pennant Insurance Example
`,
    expected: [
      { kind: "due", value: "2027-01-06" },
      { kind: "amount", value: "47.80" },
    ],
  },
  // Not expected: the member-since day, the new price (450.00), the new price day.
  htmlMail({
    id: "h6-gym-membership-renewal",
    name: "Time to renew your membership.email",
    from: "Ironworks Gym Example",
    writtenAt: Date.UTC(2026, 11, 15, 12),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Jordan,</p>
<p>Your annual membership is up for renewal.</p>
<table border="1" cellpadding="5">
<tr><td>Member since</td><td>31 January 2024</td></tr>
<tr><td>Renew by</td><td>24 January 2027</td></tr>
<tr><td>Renewal fee</td><td>£420.00</td></tr>
<tr><td>Price from</td><td>1 February 2027: £450.00</td></tr>
</table>
<p>Renew at reception or in the app.</p>
<p style="font-size:11px">Ironworks Gym Example. Reply STOP to end texts.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-24" },
      { kind: "amount", value: "420.00" },
    ],
  }),
  // Not expected: the day of the last payment, the credit (5.00).
  {
    id: "h6-phone-bill-uk",
    name: "Your March bill.email",
    mime: EMAIL,
    from: "Tallis Mobile Example",
    writtenAt: Date.UTC(2027, 2, 10, 8),
    mailKind: "bill",
    text: `Hi Sam,

Your March bill is ready.

Monthly plan: £48.00
Extra data: £19.18
Loyalty credit: -£5.00
Total to pay: £62.18
Pay by: 31/03/2027

We received your last payment on 02/03/2027.

Tallis Mobile Example. Need help? Text HELP to 4455.
`,
    expected: [
      { kind: "due", value: "2027-03-31" },
      { kind: "amount", value: "62.18" },
    ],
  },
  // Not expected: nothing else is printed.
  htmlMail({
    id: "h6-rates-receipt-nz",
    name: "Receipt for your rates payment.email",
    from: "Tui Valley Council Example",
    writtenAt: Date.UTC(2026, 11, 23, 2),
    mailKind: "receipt",
    html: `<html><body>
<h4>Payment receipt</h4>
<p>Thank you. We have received your payment.</p>
<table border="1" cellpadding="4">
<tr><td>Received</td><td>22/12/2026</td></tr>
<tr><td>Assessment</td><td>3318-02</td></tr>
<tr><td>Amount paid</td><td>$1,240.00</td></tr>
<tr><td>Balance owing</td><td>$0.00</td></tr>
</table>
<p>Tui Valley Council Example</p>
</body></html>`,
    expected: [{ kind: "amount", value: "1240.00" }],
  }),
  // Not expected: the day the nursery mail was sent, the late fee (20.00) and its day.
  {
    id: "h6-fwd-nursery-fees",
    name: "Fwd: Spring term fees.email",
    mime: EMAIL,
    from: "Siobhan Doyle",
    writtenAt: Date.UTC(2026, 11, 10, 19),
    mailKind: "bill",
    text: `Can you take this one? I am away until the new year. S

Begin forwarded message:

From: Sunbeam Nursery Example <accounts@sunbeamnursery.example.com>
Date: 4 December 2026
Subject: Spring term fees

Dear parent,

Spring term fees: £1,420.00
Payable by: 8 January 2027
Late fee applies from: 11 January 2027 (£20.00)

Bank details are on your enrolment pack.
Sunbeam Nursery Example
`,
    expected: [
      { kind: "due", value: "2027-01-08" },
      { kind: "amount", value: "1420.00" },
    ],
  },
  // Not expected: the consultation, X-ray and medication lines.
  htmlMail({
    id: "h6-vet-invoice-uk",
    name: "Invoice 20931 from Hartley Vets.email",
    from: "Hartley Vets Example",
    writtenAt: Date.UTC(2026, 11, 8, 15),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Mrs Pike,</p>
<p>Invoice 20931 for Biscuit:</p>
<table border="1" cellpadding="4">
<tr><td>Consultation</td><td>£48.00</td></tr>
<tr><td>X-ray</td><td>£95.00</td></tr>
<tr><td>Medication</td><td>£32.50</td></tr>
<tr><td><b>Invoice total</b></td><td><b>£175.50</b></td></tr>
<tr><td>Pay by</td><td>22 Dec 2026</td></tr>
</table>
<p>Hartley Vets Example, 2 High Street.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-22" },
      { kind: "amount", value: "175.50" },
    ],
  }),
  // Not expected: the last payment day.
  {
    id: "h6-power-bill-nz-no-year",
    name: "Your power account.email",
    mime: EMAIL,
    from: "Pohutukawa Energy Example",
    writtenAt: Date.UTC(2026, 10, 30, 21),
    mailKind: "bill",
    text: `Kia ora Hemi,

Amount owing: $176.20
Payment date: 14 December
Last payment received: 11 November

Set up automatic payments in your account to skip this next time.
Pohutukawa Energy Example
`,
    expected: [
      { kind: "due", value: "2026-12-14" },
      { kind: "amount", value: "176.20" },
    ],
  },
  // Not expected: the previous instalment day, the year-to-date sum (6300.00), the interest start day.
  htmlMail({
    id: "h6-provisional-tax-nz",
    name: "Provisional tax: instalment reminder.email",
    from: "Taxes Office Example",
    writtenAt: Date.UTC(2027, 3, 12, 22),
    mailKind: "bill",
    html: `<html><body>
<p>Your provisional tax instalment is coming up.</p>
<table border="1" cellpadding="4">
<tr><td>Instalment due</td><td>7 May 2027</td></tr>
<tr><td>Amount</td><td>$3,150.00</td></tr>
<tr><td>Previous instalment paid</td><td>15 January 2027</td></tr>
<tr><td>Paid so far this year</td><td>$6,300.00</td></tr>
<tr><td>Interest starts on unpaid tax</td><td>8 May 2027</td></tr>
</table>
<p>Pay through your online account. Taxes Office Example.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-07" },
      { kind: "amount", value: "3150.00" },
    ],
  }),
  // Not expected: the day the bill was paid, the next bill day.
  {
    id: "h6-water-bill-paid-uk",
    name: "Your bill has been paid.email",
    mime: EMAIL,
    from: "Severn Vale Water Example",
    writtenAt: Date.UTC(2026, 11, 3, 8),
    mailKind: "receipt",
    text: `Hello,

Good news: your water bill of £63.25 was paid by Direct Debit on 1 December 2026. There is nothing for you to pay.

Your next bill will be issued on 1 March 2027.

Severn Vale Water Example
`,
    expected: [{ kind: "amount", value: "63.25" }],
  },
  // Not expected: the last payment day, the weekly rent (520.00).
  htmlMail({
    id: "h6-rent-statement-nz",
    name: "Rent statement for 9 Totara Lane.email",
    from: "Cornerstone Property Management Example",
    writtenAt: Date.UTC(2026, 10, 30, 1),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Alex and Jess,</p>
<table border="1" cellpadding="4">
<tr><th>Item</th><th>Amount</th></tr>
<tr><td>Weekly rent</td><td>$520.00</td></tr>
<tr><td>Arrears, 2 weeks</td><td>$1,040.00</td></tr>
<tr><td>Balance owing</td><td>$1,040.00</td></tr>
</table>
<p>Last payment received: 23/11/2026<br/>Pay by: 07/12/2026</p>
<p>Cornerstone Property Management Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-07" },
      { kind: "amount", value: "1040.00" },
    ],
  }),
  // Not expected: the day the summer term starts.
  htmlMail({
    id: "h6-school-fees-uk",
    name: "Summer term fees.email",
    from: "Brackenhill School Example",
    writtenAt: Date.UTC(2027, 2, 15, 10),
    mailKind: "bill",
    html: `<html><body>
<p>Dear parents,</p>
<p>The fee account for the summer term is below.</p>
<table border="1" cellpadding="5">
<tr><td>Pupil</td><td>Ella Marsh, Year 4</td></tr>
<tr><td>Summer term fees</td><td>£4,350.00</td></tr>
<tr><td>Due date</td><td>12 April 2027</td></tr>
<tr><td>Term starts</td><td>19 April 2027</td></tr>
</table>
<p>Bursar's office, Brackenhill School Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-12" },
      { kind: "amount", value: "4350.00" },
    ],
  }),
  // Not expected: nothing else is printed.
  {
    id: "h6-pet-insurance-premium",
    name: "Your pet insurance premium.email",
    mime: EMAIL,
    from: "Whiskerwell Pet Cover Example",
    writtenAt: Date.UTC(2027, 1, 17, 9),
    mailKind: "bill",
    text: `Dear Ms Aziz,

Annual premium for Pepper: £312.40
Pay by: 3 March 2027

Pay by card using the link in your account.
Whiskerwell Pet Cover Example
`,
    expected: [
      { kind: "due", value: "2027-03-03" },
      { kind: "amount", value: "312.40" },
    ],
  },
  // Not expected: nothing else is printed.
  {
    id: "h6-physio-invoice-nz",
    name: "Invoice 1187 from Parnell Physio.email",
    mime: EMAIL,
    from: "Parnell Physio Example",
    writtenAt: Date.UTC(2027, 1, 4, 3),
    mailKind: "bill",
    text: `Hi Liam,

Invoice 1187 for your session.

Total: $145.00
Payable by: 24/02/2027

Bank account details are at the bottom of your last invoice.
Parnell Physio Example
`,
    expected: [
      { kind: "due", value: "2027-02-24" },
      { kind: "amount", value: "145.00" },
    ],
  },
  // Not expected: nothing else is printed.
  {
    id: "h6-water-charges-no-year",
    name: "Your water charges instalment.email",
    mime: EMAIL,
    from: "Dalesway Water Example",
    writtenAt: Date.UTC(2027, 3, 2, 8),
    mailKind: "bill",
    text: `Dear customer,

This is your first monthly instalment for this year's water charges.

Instalment 1 of 10: £41.20
Pay by: 28 April

If you pay by Direct Debit you do not need to do anything.

Dalesway Water Example
`,
    expected: [
      { kind: "due", value: "2027-04-28" },
      { kind: "amount", value: "41.20" },
    ],
  },
  // Not expected: the price rise (41.99) and its day.
  htmlMail({
    id: "h6-broadband-dd-uk",
    name: "Your broadband bill.email",
    from: "Fieldwire Broadband Example",
    writtenAt: Date.UTC(2026, 11, 30, 7),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Ben,</p>
<table cellpadding="4">
<tr><td>Full fibre 500</td><td>£38.99</td></tr>
<tr><td>Direct Debit date</td><td>16 Jan 2027</td></tr>
<tr><td>Price from 1 April 2027</td><td>£41.99 a month</td></tr>
</table>
<p>Fieldwire Broadband Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-16" },
      { kind: "amount", value: "38.99" },
    ],
  }),
  // Not expected: the contravention day.
  {
    id: "h6-penalty-charge-notice",
    name: "Penalty Charge Notice BL4471209.email",
    mime: EMAIL,
    from: "Eastborough Traffic Services Example",
    writtenAt: Date.UTC(2027, 2, 1, 10),
    mailKind: "bill",
    text: `PENALTY CHARGE NOTICE BL4471209

Contravention: Driving in a bus lane
Contravention date: 14 February 2027
Penalty charge: £70.00
Pay by: 29 March 2027

You can pay online or challenge this notice using the reference above.
Eastborough Traffic Services Example
`,
    expected: [
      { kind: "due", value: "2027-03-29" },
      { kind: "amount", value: "70.00" },
    ],
  },
  // Not expected: nothing else is printed.
  htmlMail({
    id: "h6-software-renewal-uk",
    name: "Your Cloudlark plan renews on 2027-05-20.email",
    from: "Cloudlark Software Example",
    writtenAt: Date.UTC(2027, 4, 6, 9),
    mailKind: "bill",
    html: `<html><body>
<p>Hello,</p>
<table cellpadding="4">
<tr><td>Plan</td><td>Team, annual</td></tr>
<tr><td>Charge date</td><td>2027-05-20</td></tr>
<tr><td>Amount</td><td>£119.00</td></tr>
</table>
<p>The card on file will be charged on that date. Manage your plan in Settings.</p>
<p>Cloudlark Software Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-20" },
      { kind: "amount", value: "119.00" },
    ],
  }),
  // Not expected: nothing else is printed.
  {
    id: "h6-rent-due-uk",
    name: "Rent for June.email",
    mime: EMAIL,
    from: "Marlowe Property Management Example",
    writtenAt: Date.UTC(2027, 4, 25, 8),
    mailKind: "bill",
    text: `Dear tenant,

Rent due: £1,075.00
Due on: 1 June 2027
Property: 6 Elm Court

Payment by standing order is preferred. Questions to rents@marlowe.example.com.
Marlowe Property Management Example
`,
    expected: [
      { kind: "due", value: "2027-06-01" },
      { kind: "amount", value: "1075.00" },
    ],
  },
  // Not expected: nothing else is printed.
  htmlMail({
    id: "h6-electricity-bill-ie",
    name: "Your electricity bill.email",
    from: "Shannon Electric Example",
    writtenAt: Date.UTC(2027, 1, 12, 8),
    mailKind: "bill",
    html: `<html><body>
<p>Hello,</p>
<p>Your bill for account 90-4410 is ready.</p>
<table border="1" cellpadding="4">
<tr><td>Amount due</td><td>€142.77</td></tr>
<tr><td>Please pay by</td><td>5 March 2027</td></tr>
</table>
<p>Shannon Electric Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "142.77" },
    ],
  }),
  // Not expected: nothing else is printed.
  {
    id: "h6-clinic-final-reminder",
    name: "Final reminder: invoice 7712.email",
    mime: EMAIL,
    from: "Westgate Clinic Example",
    writtenAt: Date.UTC(2027, 0, 29, 11),
    mailKind: "bill",
    text: `Dear Mr Hughes,

This is a final reminder for invoice 7712.

Amount outstanding: £85.00
Pay by: 10 February 2027

Westgate Clinic Example, accounts team.
`,
    expected: [
      { kind: "due", value: "2027-02-10" },
      { kind: "amount", value: "85.00" },
    ],
  },
];
