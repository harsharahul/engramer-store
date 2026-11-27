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

export const BILL_MAIL2_CASES: readonly EvalCase[] = [
  // Not expected: the previous balance, the last payment received, the reserve fund line.
  {
    id: "b2-condo-fees-ca",
    name: "December common expense fees posted.email",
    mime: EMAIL,
    from: "Maple Court Condominium Corporation Example",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "bill",
    text: `Dear Owner of Unit 1408,

Your common expense fees for December are now posted to your account.

Account: MCC-1408-22
Common expenses ........ $356.00
Reserve fund ........... $42.50
Parking stall 61 ....... $14.00
-------------------------------
Previous balance ....... $0.00
Last payment received: November 3, 2026 ($412.50)

Total now owing: $412.50
Payment due: December 1, 2026

Pre-authorized debit owners need take no action. Cheques may be left at the management office.

Maple Court Condominium Corporation Example
Property management: 555-0142 (weekdays 9 to 4)
This message is confidential and meant for the unit owner named above.`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "412.50" },
    ],
  },
  // Not expected: the late surcharge and its start day.
  {
    id: "b2-motor-tax-ie",
    name: "Reminder: your motor tax is due.email",
    mime: EMAIL,
    from: "Motor Tax Office Example",
    writtenAt: Date.UTC(2026, 10, 20, 10),
    mailKind: "bill",
    text: `Dear Customer,

This is a reminder that the motor tax on your vehicle needs to be renewed.

Registration: 12-D-00418
Annual rate: EUR 280.00
Renew by: 18/12/2026

A late renewal surcharge of EUR 28.00 applies to renewals made from 01/01/2027.

You can renew online with your vehicle registration and PIN.

Motor Tax Office Example, Customer Service Line 1890 555 010
Please do not reply to this message.`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "280.00" },
    ],
  },
  // Not expected: the odometer date, the amount excluding GST, the GST, the previous balance.
  htmlMail({
    id: "b2-road-user-charges-nz",
    name: "Your road user charges invoice.email",
    from: "Road Charges Hub Example",
    writtenAt: Date.UTC(2026, 11, 2, 7),
    mailKind: "bill",
    html: `<html><body>
<p>Kia ora,</p>
<p>Here is your invoice for the distance licence you asked for.</p>
<table border="1" cellpadding="6">
<tr><th>Vehicle</th><th>Distance</th><th>Odometer recorded</th></tr>
<tr><td>Diesel ute, plate KQP204</td><td>3,000 km</td><td>30/11/2026</td></tr>
</table>
<table cellpadding="4">
<tr><td>Amount excluding GST</td><td>$314.09</td></tr>
<tr><td>GST (15%)</td><td>$47.11</td></tr>
<tr><td>Previous balance</td><td>$0.00</td></tr>
<tr><td><b>Total to pay</b></td><td><b>$361.20</b></td></tr>
<tr><td>Pay by</td><td>15/01/2027</td></tr>
</table>
<p>Pay online or at any agent. Questions? Call 0800 555 018.</p>
<p style="font-size:11px">Road Charges Hub Example. Terms apply.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "amount", value: "361.20" },
    ],
  }),
  // Not expected: the date of notice, the tax before rebate, the rebate, the interest start day.
  {
    id: "b2-property-tax-sg",
    name: "Property Tax Notice for 2027.email",
    mime: EMAIL,
    from: "Property Tax Division Example",
    writtenAt: Date.UTC(2027, 0, 4, 2),
    mailKind: "bill",
    text: `PROPERTY TAX NOTICE

Date of Notice: 04 Jan 2027
Property: Unit 12-07, Lorong Example Tower
Tax before rebate:         $1,404.00
Owner-occupier rebate:      -$120.00
Property tax payable:      $1,284.00

Pay on or before 29 Jan 2027 by GIRO, internet banking or at an AXS machine.

Interest of 5% a year will be charged on any unpaid tax from 1 Feb 2027.

Payment methods are on our site. If you disagree with the notice you may file an objection within 30 days.

Property Tax Division Example`,
    expected: [
      { kind: "due", value: "2027-01-29" },
      { kind: "amount", value: "1284.00" },
    ],
  },
  // Not expected: the next bill's issue day.
  htmlMail({
    id: "b2-town-council-sg",
    name: "Your Service and Conservancy Charges bill.email",
    from: "Pasir Example Town Council",
    writtenAt: Date.UTC(2026, 10, 25, 1),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Resident,</p>
<p>Your S&amp;CC bill for December 2026 is ready.</p>
<table border="1" cellpadding="5">
<tr><th>Account</th><th>Amount</th><th>Due date</th></tr>
<tr><td>TC-70-3345</td><td>$83.00</td><td>15 Dec 2026</td></tr>
</table>
<p>Your next bill will be issued on 01 Jan 2027.</p>
<p>Pasir Example Town Council. Hotline 6555 0120.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "83.00" },
    ],
  }),
  // Not expected: the term start day, the instalment size.
  {
    id: "b2-kindergarten-nz",
    name: "Term 1 2027 kindergarten fees.email",
    mime: EMAIL,
    from: "Kowhai Kindergarten Example",
    writtenAt: Date.UTC(2027, 0, 18, 22),
    mailKind: "bill",
    text: `Kia ora Mere,

Fees for Aroha for Term 1 are set out below. Term 1 begins on 02/02/2027.

Fees for the term                $800.00
20 hours ECE subsidy            -$120.00
Total outstanding                $680.00

You can pay this in two instalments of $340.00:

  Instalment 1: due 05/02/2027
  Instalment 2: due 05/03/2027

Please put "AROHA T1" as the reference when paying to the kindergarten account.

Ngā mihi,
Office, Kowhai Kindergarten Example`,
    expected: [
      { kind: "due", value: "2027-02-05" },
      { kind: "due", value: "2027-03-05" },
      { kind: "amount", value: "680.00" },
    ],
  },
  // Not expected: the statement date, the payment received, the sibling credit, the gross charges.
  htmlMail({
    id: "b2-afterschool-ca",
    name: "February statement, after-school program.email",
    from: "Birchwood After-School Care Example",
    writtenAt: Date.UTC(2027, 1, 8, 16),
    mailKind: "bill",
    html: `<html><body>
<h3>Statement</h3>
<table cellpadding="4" border="1">
<tr><td>Statement date</td><td>February 8, 2027</td></tr>
<tr><td>Child</td><td>Noah L.</td></tr>
<tr><td>February care (20 days)</td><td>$500.00</td></tr>
<tr><td>Sibling credit</td><td>-$35.00</td></tr>
<tr><td>Payment received January 29, 2027</td><td>-$500.00</td></tr>
<tr><td><b>Balance to pay</b></td><td><b>$465.00</b></td></tr>
</table>
<p>Please pay by <b>Feb 26, 2027</b> by e-transfer to billing@afterschool.example.com.</p>
<p>Thank you, Birchwood After-School Care Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-26" },
      { kind: "amount", value: "465.00" },
    ],
  }),
  // Not expected: the renewal day, last year's premium.
  {
    id: "b2-pet-insurance-ie",
    name: "Your pet insurance renews soon.email",
    mime: EMAIL,
    from: "Paws Cover Insurance Example",
    writtenAt: Date.UTC(2027, 2, 2, 9),
    mailKind: "bill",
    text: `Hi Cian,

Biscuit's cover renews soon and nothing is needed from you to keep it going.

Policy: PC-884120
Renewal date: 01/04/2027
Last year's premium: EUR 289.10
Your renewal premium: EUR 312.84
Collection date: 24/03/2027

We will collect the premium by direct debit from the account ending 7710 on the collection date. If you would like to change your cover, call us before then.

Paws Cover Insurance Example is regulated as an insurance intermediary.`,
    expected: [
      { kind: "due", value: "2027-03-24" },
      { kind: "amount", value: "312.84" },
    ],
  },
  // Not expected: the invoice day, the subtotal, the GST, the rental period, the next invoice day.
  htmlMail({
    id: "b2-storage-unit-nz",
    name: "Invoice SU-20977 for unit 114.email",
    from: "Cubby Storage Example",
    writtenAt: Date.UTC(2026, 10, 30, 20),
    mailKind: "bill",
    html: `<html><body>
<table width="480" cellpadding="3">
<tr><td colspan="2"><b>TAX INVOICE SU-20977</b></td></tr>
<tr><td>Invoice date</td><td>30/11/2026</td></tr>
<tr><td>Period</td><td>01/12/2026 to 31/12/2026</td></tr>
<tr><td>Unit 114 (6 sqm) rent</td><td>$163.00</td></tr>
<tr><td>Subtotal</td><td>$163.00</td></tr>
<tr><td>GST</td><td>$24.45</td></tr>
<tr><td>Total</td><td>$187.45</td></tr>
<tr><td>Due</td><td>14/12/2026</td></tr>
<tr><td>Next invoice</td><td>31/12/2026</td></tr>
</table>
<p>Pay by bank transfer, quoting SU-20977.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-14" },
      { kind: "amount", value: "187.45" },
    ],
  }),
  // Not expected: the bill day, the billing period, the next meter reading, the previous balance, the last payment.
  {
    id: "b2-hydro-ca",
    name: "Your electricity bill is ready.email",
    mime: EMAIL,
    from: "Northshore Hydro Example",
    writtenAt: Date.UTC(2026, 11, 10, 14),
    mailKind: "bill",
    text: `Hello,

Your latest bill for service address 77 Alder Lane is ready to view.

Bill date: Dec 9
Billing period: Nov 6 to Dec 8 (33 days)
Next meter reading: on or about Jan 12

Previous balance        $138.20
Payment received Nov 24 -$138.20
Current charges         $142.77

Amount due:             $142.77
Please pay by Jan 4

Set up pre-authorized payments to skip the queue.
Northshore Hydro Example, 555-0188`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "142.77" },
    ],
  },
  // Not expected: the billing date, the last payment day, the previous bill's amount.
  {
    id: "b2-fwd-water-ie",
    name: "Fwd: Your water bill.email",
    mime: EMAIL,
    from: "Aoife Brennan",
    writtenAt: Date.UTC(2027, 0, 14, 19),
    mailKind: "bill",
    text: `Dad, this came for the Tullamore house. Can you sort it out before the deadline? I am away all month.
A

-------- Forwarded message --------
From: Shannon Water Example <billing@shannonwater.example.com>
Sent: 12 January 2027 08:02
To: aoife.brennan@example.com
Subject: Your water bill

Dear Customer,

Account number: 4402 7781
Date of bill: 12/01/2027
Previous bill: EUR 104.50, paid 18/11/2026
Water services this period: EUR 96.30
Total amount due: EUR 96.30
Payment due date: 10/02/2027

Pay by card on our website or by standing order.
Shannon Water Example`,
    expected: [
      { kind: "due", value: "2027-02-10" },
      { kind: "amount", value: "96.30" },
    ],
  },
  // Not expected: the bill date, the bill period, the previous bill, the promotional rate end.
  htmlMail({
    id: "b2-mobile-bill-sg",
    name: "Your December bill is here.email",
    from: "LionTel Mobile Example",
    writtenAt: Date.UTC(2026, 11, 5, 4),
    mailKind: "bill",
    html: `<html><body>
<h2>Your bill</h2>
<table cellpadding="4" border="0">
<tr><td>Bill date:</td><td>05 Dec 2026</td></tr>
<tr><td>Bill period:</td><td>05 Nov 2026 - 04 Dec 2026</td></tr>
<tr><td>Previous bill (paid):</td><td>$68.20</td></tr>
<tr><td>Plan</td><td>$49.90</td></tr>
<tr><td>Roaming pass</td><td>$12.00</td></tr>
<tr><td>Device instalment</td><td>$13.00</td></tr>
<tr><td><b>Total payable</b></td><td><b>$74.90</b></td></tr>
</table>
<p><b>Payment due:</b> 20 Dec 2026</p>
<p>Your student promotional rate ends on 31 Jan 2027, after which the standard plan price applies.</p>
<p>LionTel Mobile Example &middot; Care line 6555 0133</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2026-12-20" },
      { kind: "amount", value: "74.90" },
    ],
  }),
  // Not expected: the statement date, the previous balance, the payment received, the minimum payment, the next statement day.
  {
    id: "b2-credit-card-ca",
    name: "Your statement is ready.email",
    mime: EMAIL,
    from: "Lakeview Bank Cards Example",
    writtenAt: Date.UTC(2026, 11, 19, 12),
    mailKind: "bill",
    text: `Statement summary - Lakeview Platinum Card ending 3350

Statement date              December 18, 2026
Previous balance            $640.00
Payment received Dec 6      -$640.00
Purchases                   $1,246.12
Interest                    $0.00
Fees                        $38.55
-----------------------------------------
New balance                 $1,284.67
Minimum payment             $25.00
Payment due date            January 12, 2027

Pay the new balance by the due date to avoid interest on purchases. Your next statement closes on January 18, 2027.

Lakeview Bank Cards Example. Lost card? Call 555-0100 any time.`,
    expected: [
      { kind: "due", value: "2027-01-12" },
      { kind: "amount", value: "1284.67" },
    ],
  },
  // Not expected: the statement date, the last repayment, the principal outstanding, the rate review day.
  htmlMail({
    id: "b2-loan-statement-nz",
    name: "Home loan statement.email",
    from: "Southern Cross Lending Example",
    writtenAt: Date.UTC(2027, 0, 5, 21),
    mailKind: "bill",
    html: `<html><body>
<p>Loan statement for account 00-4417-221</p>
<table border="1" cellpadding="5">
<tr><th>Item</th><th>Detail</th></tr>
<tr><td>Statement date</td><td>05/01/2027</td></tr>
<tr><td>Principal outstanding</td><td>$18,430.55</td></tr>
<tr><td>Last repayment (20/12/2026)</td><td>$612.30 received</td></tr>
<tr><td>Interest rate review</td><td>01/03/2027</td></tr>
</table>
<table border="1" cellpadding="5">
<tr><th>Next repayment</th><th>Due on</th></tr>
<tr><td>$612.30</td><td>20/01/2027</td></tr>
</table>
<p>Southern Cross Lending Example. Hardship team: 0800 555 071.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-01-20" },
      { kind: "amount", value: "612.30" },
    ],
  }),
  // Not expected: the receipt day, the balance, the next bill's issue day.
  {
    id: "b2-payment-confirm-sg",
    name: "We have received your payment.email",
    mime: EMAIL,
    from: "CityGas Example",
    writtenAt: Date.UTC(2027, 1, 3, 3),
    mailKind: "receipt",
    text: `Dear Customer,

Thank you. We received your payment of $215.60 on 02 Feb 2027.

Account balance: $0.00
Your next bill will be issued on 01 Mar 2027.

CityGas Example`,
    expected: [{ kind: "amount", value: "215.60" }],
  },
  // Not expected: the payment day, the refund sum, the refund day.
  {
    id: "b2-lpt-paid-ie",
    name: "Your Local Property Tax account is clear.email",
    mime: EMAIL,
    from: "Local Property Tax Office Example",
    writtenAt: Date.UTC(2027, 2, 10, 11),
    mailKind: "other",
    text: `Dear Property Owner,

Your Local Property Tax for 2027 was paid in full on 05/03/2027. Your account is clear and no further payment is needed.

Because of a duplicate payment, a credit of EUR 41.00 will be refunded to your bank account by 31/03/2027.

Keep this message for your records.

Local Property Tax Office Example
Helpline: 1890 555 044`,
    expected: [],
  },
  // Not expected: the new price's start day, the old and new monthly prices, the next bill day.
  htmlMail({
    id: "b2-price-change-nz",
    name: "A change to your broadband price.email",
    from: "FibreFlow Broadband Example",
    writtenAt: Date.UTC(2027, 3, 12, 0),
    mailKind: "other",
    html: `<html><body>
<p>Kia ora Hemi,</p>
<p>We are writing to let you know about a change to your Fibre 300 plan.</p>
<table border="1" cellpadding="5">
<tr><td>Current price</td><td>$79.00 per month</td></tr>
<tr><td>New price</td><td>$89.00 per month</td></tr>
<tr><td>New price starts</td><td>1 June 2027</td></tr>
<tr><td>Your next bill</td><td>1 May 2027</td></tr>
</table>
<p>You do not need to do anything. If you would rather leave, you can do so with no fee until the new price starts.</p>
<p>FibreFlow Broadband Example</p>
</body></html>`,
    expected: [],
  }),
  // Not expected: the service day, the subtotal, the insurance payment.
  htmlMail({
    id: "b2-dental-ca",
    name: "Invoice 20871 from Lakeshore Dental Example.email",
    from: "Lakeshore Dental Example",
    writtenAt: Date.UTC(2027, 1, 26, 15),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Ms. Gagnon,</p>
<p>Thank you for visiting us on February 22, 2027. Your invoice follows.</p>
<table border="1" cellpadding="5">
<tr><td>Exam and X-rays</td><td>$178.00</td></tr>
<tr><td>Filling, one surface</td><td>$412.00</td></tr>
<tr><td>Subtotal</td><td>$590.00</td></tr>
<tr><td>Paid by your insurer</td><td>-$352.00</td></tr>
<tr><td>Balance</td><td>$238.00</td></tr>
</table>
<p>We kindly ask that the balance be settled within 21 days of this invoice, which is by March 19, 2027. Cards, e-transfer and cheques are accepted.</p>
<p>Lakeshore Dental Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-19" },
      { kind: "amount", value: "238.00" },
    ],
  }),
  // Not expected: the missed rent days, the day of the earlier reminder, the monthly rent.
  {
    id: "b2-rent-demand-ie",
    name: "Rent arrears - formal demand.email",
    mime: EMAIL,
    from: "Hawthorn Lettings Example",
    writtenAt: Date.UTC(2027, 0, 25, 9),
    mailKind: "bill",
    text: `Dear Mr Walsh,

Re: 14 Ashgrove Court

The rent for this property is EUR 1,450.00 a month, due on the first of each month. We have not received the payments due on 01/12/2026 or 01/01/2027, and the arrears now stand at EUR 2,900.00. We reminded you by email on 12/01/2027 without a reply.

Unless the full arrears are in our client account by Friday 5 February 2027, our client will begin the process to end the tenancy.

If you are in difficulty please call us at once on 01 555 0166.

Yours sincerely,
Accounts, Hawthorn Lettings Example`,
    expected: [
      { kind: "due", value: "2027-02-05" },
      { kind: "amount", value: "2900.00" },
    ],
  },
  // Not expected: the early-bird end day, the standard fee, the loyalty discount.
  htmlMail({
    id: "b2-membership-renewal-sg",
    name: "Your annual membership will renew.email",
    from: "Harbourside Fitness Club Example",
    writtenAt: Date.UTC(2027, 4, 3, 5),
    mailKind: "bill",
    html: `<html><body>
<p>Hi Wei Jie,</p>
<p>Your annual membership renews automatically next month.</p>
<table cellpadding="4" border="1">
<tr><td>Standard annual fee</td><td>S$198.00</td></tr>
<tr><td>Loyalty discount</td><td>-S$30.00</td></tr>
<tr><td>Renewal charge</td><td>S$168.00</td></tr>
<tr><td>Charge date</td><td>25 May 2027</td></tr>
<tr><td>Early-bird renewal offer ended</td><td>30 Apr 2027</td></tr>
</table>
<p>The charge will go to your card ending 4412. To cancel, reply to this email before the charge date.</p>
<p>Harbourside Fitness Club Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-05-25" },
      { kind: "amount", value: "168.00" },
    ],
  }),
  // Not expected: the assessment day, the total tax, the instalments paid, the interest start day.
  {
    id: "b2-income-tax-ca",
    name: "Notice of assessment - balance owing.email",
    mime: EMAIL,
    from: "Northern Revenue Agency Example",
    writtenAt: Date.UTC(2027, 2, 15, 13),
    mailKind: "bill",
    text: `Notice of assessment, tax year 2025

Date of assessment: March 12, 2027
Total tax payable:       $3,634.18
Instalments paid:       -$1,500.00
Balance owing:           $2,134.18

Balance due date: April 30, 2027

Interest is charged on any unpaid balance starting May 1, 2027. You can pay through your bank's bill payment service using the agency as a payee.

If you disagree, you may file a notice of objection within 90 days of the date of assessment.

Northern Revenue Agency Example`,
    expected: [
      { kind: "due", value: "2027-04-30" },
      { kind: "amount", value: "2134.18" },
    ],
  },
  // Not expected: the offence day, the late fee.
  {
    id: "b2-parking-nz",
    name: "Parking infringement notice 553120.email",
    mime: EMAIL,
    from: "Harbour City Parking Example",
    writtenAt: Date.UTC(2026, 10, 27, 1),
    mailKind: "bill",
    text: `PARKING INFRINGEMENT NOTICE 553120

Vehicle: JHX 912
Offence date: 14/11/2026
Offence: Parked over the time limit, Quay Street
Fee: $60.00
Fine due date: 18/12/2026

A late fee of $30.00 is added to fines not paid by the due date.
Pay online with the notice number or at a council service centre.

Harbour City Parking Example`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "60.00" },
    ],
  },
  // Not expected: the offence day, the fine before the surcharge.
  htmlMail({
    id: "b2-traffic-notice-ca",
    name: "Notice of violation 88-41207.email",
    from: "Provincial Traffic Court Services Example",
    writtenAt: Date.UTC(2027, 0, 22, 15),
    mailKind: "bill",
    html: `<html><body>
<p><b>Notice of violation 88-41207</b></p>
<table border="1" cellpadding="4">
<tr><td>Offence date</td><td>2027-01-09</td></tr>
<tr><td>Fine</td><td>$76.00</td></tr>
<tr><td>Victim surcharge</td><td>$19.00</td></tr>
<tr><td>Total payable</td><td>$95.00</td></tr>
<tr><td>Payable by</td><td>2027-03-02</td></tr>
</table>
<p>Pay online with the notice number. Provincial Traffic Court Services Example.</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-03-02" },
      { kind: "amount", value: "95.00" },
    ],
  }),
  // Not expected: the original due day, the day of the earlier reminder, the review day, the reconnection fee.
  {
    id: "b2-final-notice-ie",
    name: "FINAL NOTICE - account 3320.email",
    mime: EMAIL,
    from: "Boyne Valley Power Example",
    writtenAt: Date.UTC(2027, 1, 15, 8),
    mailKind: "bill",
    text: `FINAL NOTICE

Account 3320
Original due date: 29/01/2027
First reminder sent: 08/02/2027
Amount overdue: EUR 203.15
Pay by 22/02/2027 to avoid disconnection.

Our collections team will review your account on 23/02/2027. If your supply is disconnected a reconnection fee of EUR 55.00 applies.

Boyne Valley Power Example`,
    expected: [
      { kind: "due", value: "2027-02-22" },
      { kind: "amount", value: "203.15" },
    ],
  },
  // Not expected: the last withdrawal day.
  {
    id: "b2-debit-notice-ca",
    name: "Upcoming automatic payment.email",
    mime: EMAIL,
    from: "ClearWave Internet Example",
    writtenAt: Date.UTC(2027, 2, 25, 13),
    mailKind: "bill",
    text: `Hi there,

A heads-up on your automatic payment.

We will withdraw $89.99 from your chequing account on April 7, 2027 for your Internet 500 plan.

Last withdrawal: March 7, 2027.

No action is needed. To change the account, sign in to your portal.

ClearWave Internet Example`,
    expected: [
      { kind: "due", value: "2027-04-07" },
      { kind: "amount", value: "89.99" },
    ],
  },
  // Not expected: the statement day, the next statement day.
  {
    id: "b2-giro-notice-sg",
    name: "GIRO deduction advice.email",
    mime: EMAIL,
    from: "Bayfront Utilities Example",
    writtenAt: Date.UTC(2026, 11, 14, 2),
    mailKind: "bill",
    text: `Dear Customer,

Statement date: 14 Dec 2026
Your GIRO deduction of S$129.30 will be made on 22 Dec 2026.
Next statement: 15 Jan 2027

Please keep enough funds in your account. No payment is needed from you.

Bayfront Utilities Example`,
    expected: [
      { kind: "due", value: "2026-12-22" },
      { kind: "amount", value: "129.30" },
    ],
  },
  // Not expected: the day rent is paid to, the day of the last payment, the weekly rent, the bond.
  {
    id: "b2-rent-statement-nz",
    name: "Rent statement for 9 Rata Street.email",
    mime: EMAIL,
    from: "Tui Property Management Example",
    writtenAt: Date.UTC(2026, 11, 1, 20),
    mailKind: "bill",
    text: `Hi Sam and Jo,

Here is your rent statement for 9 Rata Street.

Weekly rent:  $260.00
Bond held:    $2,080.00
Last rent received: 25 Nov ($520.00)
Rent paid to: 28 Nov

Next payment due: 7 Dec
Amount due: $520.00 (two weeks)

Automatic payments are fine, just keep the reference RATA9.

Thanks,
Tui Property Management Example`,
    expected: [
      { kind: "due", value: "2026-12-07" },
      { kind: "amount", value: "520.00" },
    ],
  },
  // Not expected: the day the late fee starts, the late fee.
  {
    id: "b2-bin-charge-ie",
    name: "Annual waste charge.email",
    mime: EMAIL,
    from: "Midlands County Council Example",
    writtenAt: Date.UTC(2026, 10, 16, 9),
    mailKind: "bill",
    text: `Dear Householder,

Your annual waste collection charge is EUR 195.00.

Please pay by 11 Dec.
A late fee of EUR 20.00 applies from 14 Dec.

Midlands County Council Example, Waste Section`,
    expected: [
      { kind: "due", value: "2026-12-11" },
      { kind: "amount", value: "195.00" },
    ],
  },
  // Not expected: the meeting day, the monthly fees, the day of the earlier notice.
  {
    id: "b2-reply-condo-levy-ca",
    name: "Re: Roof special assessment.email",
    mime: EMAIL,
    from: "Maple Court Condominium Corporation Example",
    writtenAt: Date.UTC(2027, 3, 20, 15),
    mailKind: "bill",
    text: `Hi Priya,

Thanks for asking. Yes, the roof assessment of $1,850.00 per unit has to reach the office by May 14, 2027. Your monthly fees stay at $412.50 and are separate from this.

Regards,
Office, Maple Court Condominium Corporation Example

On Tuesday, April 6, 2027 at 10:15 AM, Maple Court Condominium Corporation Example <office@maplecourt.example.com> wrote:
> Dear Owner,
>
> At the owners' meeting held on March 25, 2027 a special assessment for
> the roof repairs was approved. The share for each unit is $1,850.00.
> Please see the attached schedule for the notes on payment.
>
> Maple Court Condominium Corporation Example`,
    expected: [
      { kind: "due", value: "2027-05-14" },
      { kind: "amount", value: "1850.00" },
    ],
  },
  // Not expected: the bill day, the single instalment size.
  {
    id: "b2-fwd-property-tax-ca",
    name: "Fwd: Final tax bill.email",
    mime: EMAIL,
    from: "Gary Doyle",
    writtenAt: Date.UTC(2027, 4, 20, 17),
    mailKind: "bill",
    text: `Mina, can you put both of these dates in my calendar? Thanks, Gary

---------- Forwarded message ----------
From: Township of Elm Ridge Example <taxes@elmridge.example.org>
Date: Fri, May 14, 2027 at 9:30 AM
Subject: Final tax bill

Tax bill date: May 14, 2027
Roll number: 0420-117-004
Total remaining: $3,400.00

Instalment 1 of 2: $1,700.00, due June 15, 2027
Instalment 2 of 2: $1,700.00, due September 15, 2027

Pre-authorized plans debit on the instalment dates.
Township of Elm Ridge Example`,
    expected: [
      { kind: "due", value: "2027-06-15" },
      { kind: "due", value: "2027-09-15" },
      { kind: "amount", value: "3400.00" },
    ],
  },
  // Not expected: the start day of the new policy year, the monthly option.
  htmlMail({
    id: "b2-home-insurance-nz",
    name: "Your home insurance renewal.email",
    from: "Kauri Mutual Insurance Example",
    writtenAt: Date.UTC(2027, 0, 12, 19),
    mailKind: "bill",
    html: `<html><body>
<p>Your home policy HP-33920 is ready to renew.</p>
<table border="1" cellpadding="6">
<tr><td colspan="2"><b>Renewal summary</b></td></tr>
<tr><td>New policy year starts</td><td>01/03/2027</td></tr>
<tr><td>Pay in full</td><td>$1,046.00</td></tr>
<tr><td>Or monthly</td><td>12 x $91.30</td></tr>
<tr><td>Premium due</td><td>12/02/2027</td></tr>
</table>
<p>To pay monthly, call us before the premium due date.</p>
<p>Kauri Mutual Insurance Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "amount", value: "1046.00" },
    ],
  }),
  // Not expected: the offer price, the day the offer price ended.
  {
    id: "b2-newspaper-renewal-ie",
    name: "Your digital subscription renews soon.email",
    mime: EMAIL,
    from: "Evening Courier Example",
    writtenAt: Date.UTC(2027, 2, 4, 8),
    mailKind: "bill",
    text: `Dear Reader,

Your digital subscription renews on 18/03/2027, when EUR 119.00 will be charged to your card.

Introductory price of EUR 99.00 ended on 31/12/2026.

Manage your plan on our website.
Evening Courier Example`,
    expected: [
      { kind: "due", value: "2027-03-18" },
      { kind: "amount", value: "119.00" },
    ],
  },
  // Not expected: the consultation day, the full fee, the deposit.
  htmlMail({
    id: "b2-medical-invoice-ie",
    name: "Invoice 7710 from Rathmines Clinic Example.email",
    from: "Rathmines Clinic Example",
    writtenAt: Date.UTC(2027, 2, 19, 11),
    mailKind: "bill",
    html: `<html><body>
<p>Invoice 7710</p>
<table border="1" cellpadding="4">
<tr><td>Consultation date</td><td>03/03/2027</td></tr>
<tr><td>Consultation fee</td><td>EUR 160.00</td></tr>
<tr><td>Deposit paid</td><td>-EUR 25.00</td></tr>
<tr><td>Balance outstanding</td><td>EUR 135.00</td></tr>
<tr><td>Pay by</td><td>03/04/2027</td></tr>
</table>
<p>Rathmines Clinic Example, Reception 01 555 0190</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-03" },
      { kind: "amount", value: "135.00" },
    ],
  }),
  // Not expected: the billing day, the period, the previous bill, the payment day, the next meter read.
  htmlMail({
    id: "b2-gas-bill-ca",
    name: "Your natural gas bill.email",
    from: "Prairie Gas Utility Example",
    writtenAt: Date.UTC(2027, 1, 2, 12),
    mailKind: "bill",
    html: `<html><body>
<table width="460" border="1" cellpadding="5">
<tr><td colspan="2"><b>Account summary</b></td></tr>
<tr><td>Billing date</td><td>February 1, 2027</td></tr>
<tr><td>Period</td><td>December 30, 2026 to January 29, 2027</td></tr>
<tr><td>Previous bill</td><td>$188.40</td></tr>
<tr><td>Payment received January 20, 2027</td><td>-$188.40</td></tr>
<tr><td>Gas supply</td><td>$126.55</td></tr>
<tr><td>Delivery</td><td>$62.40</td></tr>
<tr><td>Carbon charge</td><td>$28.71</td></tr>
<tr><td><b>Amount due</b></td><td><b>$217.66</b></td></tr>
<tr><td>Due date</td><td>February 24, 2027</td></tr>
<tr><td>Next meter read</td><td>March 1, 2027</td></tr>
</table>
<p>Prairie Gas Utility Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-02-24" },
      { kind: "amount", value: "217.66" },
    ],
  }),
  // Not expected: the total price, the works start day.
  htmlMail({
    id: "b2-repair-quote-sg",
    name: "Quotation Q-2231, bathroom waterproofing.email",
    from: "Anchor Renovation Works Example",
    writtenAt: Date.UTC(2027, 3, 1, 3),
    mailKind: "bill",
    html: `<html><body>
<p>Dear Mr Lim,</p>
<p>Please find our quotation Q-2231 below.</p>
<table border="1" cellpadding="5">
<tr><td>Bathroom waterproofing and retiling</td><td>$4,860.00</td></tr>
<tr><td>30% deposit to confirm the job</td><td>$1,458.00</td></tr>
<tr><td>Deposit payable by</td><td>14 Apr 2027</td></tr>
<tr><td>Quotation valid until</td><td>30 Apr 2027</td></tr>
<tr><td>Works to start</td><td>17 May 2027</td></tr>
</table>
<p>Anchor Renovation Works Example</p>
</body></html>`,
    expected: [
      { kind: "due", value: "2027-04-14" },
      { kind: "expiry", value: "2027-04-30" },
      { kind: "amount", value: "1458.00" },
    ],
  }),
];
