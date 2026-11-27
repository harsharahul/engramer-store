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

export const HELDOUT_BILL_CASES: readonly EvalCase[] = [
  // Not expected: the statement date, the previous balance 395.00 and the payment of Oct 28, 2026, the late fee 35.00 and the day it is added.
  {
    id: "h3-hoa-dues-q1",
    name: "Maple Ridge statement for 418 Alder Court.email",
    mime: EMAIL,
    from: "Maple Ridge Homeowners Association Example",
    writtenAt: Date.UTC(2026, 10, 12, 9),
    mailKind: "bill",
    text: `Hi Dana,

Here is your statement for 418 Alder Court.

Statement date: November 12, 2026
Account #: MR-30417
Previous balance: $395.00
Payment received October 28, 2026: -$395.00
Quarterly assessment (Q1): $412.50
Total now owed: $412.50

Please pay by: December 1, 2026

A $35.00 late fee is added to every account still open on December 15, 2026.
Checks payable to Maple Ridge HOA Example. You can also pay on the owner portal.

Thanks,
The Maple Ridge board
manager@mapleridge-hoa.example.com`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "412.50" },
    ],
  },
  // Not expected: the notice date, the registration fee 489.00, the traffic levy 98.40, the CTP premium 275.00, the last renewal payment day.
  {
    id: "h3-rego-renewal-nsw",
    name: "rego-renewal-notice-2027.pdf",
    mime: "application/pdf",
    text: `Roads and Transport Example
VEHICLE REGISTRATION RENEWAL NOTICE
Date of notice: 16/11/2026
Plate: EXA-48Q
Vehicle: 2017 Hatchback, 5 door
Last renewal paid: 12/01/2026
Fee | Amount
Registration fee (12 months) | $489.00
Traffic levy | $98.40
Compulsory third party premium | $275.00
Total to pay | $862.40
Pay by: 04/01/2027
Registration expires: 18/01/2027
Driving an unregistered vehicle is an offence. Pay online, by phone or at a service centre.
Please quote reference RN-2027-880413 when you pay.`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "expiry", value: "2027-01-18" },
      { kind: "amount", value: "862.40" },
    ],
  },
  // Not expected: the statement date, the last payment day, interest accrual day, the outstanding principal 18,420.55, the last payment sum.
  htmlMail({
    id: "h3-student-loan-statement",
    name: "Your December loan statement.email",
    from: "Brookfield Loan Servicing Example",
    writtenAt: Date.UTC(2026, 10, 20, 7),
    mailKind: "bill",
    html: `<html><body><p>Your statement is ready.</p><table border="1" cellpadding="4"><tr><td>Statement date</td><td>11/20/2026</td></tr><tr><td>Outstanding principal</td><td>$18,420.55</td></tr><tr><td>Interest accrued through</td><td>11/19/2026</td></tr><tr><td>Last payment received</td><td>11/02/2026 for $287.64</td></tr><tr><td>Amount due</td><td><b>$287.64</b></td></tr><tr><td>Next payment due</td><td>12/15/2026</td></tr><tr><td>Past due</td><td>$0.00</td></tr></table><p>Questions? Reply to servicing@brookfield-loans.example.com</p></body></html>`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "287.64" },
    ],
  }),
  // Not expected: the visit day, the deposit 60.00 and the day it was taken, the services subtotal 378.50, the total 397.43.
  {
    id: "h3-vet-invoice-biscuit",
    name: "Invoice 20418 for Biscuit.email",
    mime: EMAIL,
    from: "Harbourview Animal Clinic Example",
    writtenAt: Date.UTC(2026, 11, 3, 15),
    mailKind: "bill",
    text: `Hello,

Thank you for bringing Biscuit in. Your invoice is below.

Invoice no: 20418
Visit: 2026-11-28
Examination and bloodwork: 330.00
Medication: 48.50
Subtotal: 378.50
GST 5%: 18.93
Invoice total: 397.43
Deposit received 2026-11-28: -60.00
Balance owing: 337.43

Payment is expected by 2026-12-17.
Interac e-Transfer to billing@harbourview-vets.example.com or call us with a card.

Harbourview Animal Clinic Example`,
    expected: [
      { kind: "due", value: "2026-12-17" },
      { kind: "amount", value: "337.43" },
    ],
  },
  // Not expected: the invoice date, the rental period start and end, the deposit held 570.00, the last payment day and sum.
  {
    id: "h3-storage-rent-sg",
    name: "stowaway-invoice-dec.pdf",
    mime: "application/pdf",
    text: `Stowaway Self Storage Example Pte Ltd
TAX INVOICE
Invoice date: 25 Nov 2026
Unit B-217 (10 sq ft)
Rental period | 1 Dec 2026 to 31 Dec 2026
Unit rent | SGD 285.00
GST 9% | SGD 25.65
Total payable | SGD 310.65
Deposit held | SGD 570.00
Last payment received 02 Nov 2026 | SGD 310.65
Please settle on or before 5 Dec 2026
Payment by PayNow or bank transfer, quote your unit number.
Accounts: ar@stowaway-storage.example.com`,
    expected: [
      { kind: "due", value: "2026-12-05" },
      { kind: "amount", value: "310.65" },
    ],
  },
  // Not expected: the notice date, the previous levy paid on 22/09/2026 and its sum 1,750.00, the levy period end.
  {
    id: "h3-strata-levy-48211",
    name: "SP48211-levy-notice-Q1.pdf",
    mime: "application/pdf",
    text: `Harbour Strata Management Example
LEVY NOTICE - Strata Plan 48211, Lot 14
Notice date: 18/11/2026
Levy period: 01/01/2027 to 31/03/2027
Fund | Amount | Due date
Administrative fund | $1,420.00 | 15/01/2027
Capital works fund | $380.00 | 15/01/2027
Total levies payable | $1,800.00 | 15/01/2027
Previous levy, paid 22/09/2026 | $1,750.00 | settled
Arrears: nil
Direct deposit details are on the back of this notice.`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "amount", value: "1800.00" },
    ],
  },
  // Not expected: the last top-up day and sum 40.00, the admin fee 11.00 and the day it applies.
  htmlMail({
    id: "h3-toll-account-unpaid",
    name: "Unpaid trips on your account.email",
    from: "Southern Link Tolls Example",
    writtenAt: Date.UTC(2026, 11, 8, 6),
    mailKind: "bill",
    html: `<html><body><h3>Unpaid trips</h3><p>We could not take payment for recent trips because your balance was too low.</p><table><tr><th>Item</th><th>Detail</th></tr><tr><td>Last top-up</td><td>$40.00 on 01 Dec 2026</td></tr><tr><td>Unpaid trips total</td><td>$34.60</td></tr><tr><td>Pay by</td><td>22 Dec 2026</td></tr><tr><td>Admin fee if unpaid after</td><td>29 Dec 2026 ($11.00)</td></tr></table><p>Pay in the app or at tolls.example.org</p></body></html>`,
    expected: [
      { kind: "due", value: "2026-12-22" },
      { kind: "amount", value: "34.60" },
    ],
  }),
  // Not expected: the bill date, the billing period, the previous balance 151.30, the payment received Jan 20.
  {
    id: "h3-power-feb",
    name: "Your Lakeshore Hydro bill.email",
    mime: EMAIL,
    from: "Lakeshore Hydro Example",
    writtenAt: Date.UTC(2027, 1, 9, 10),
    mailKind: "bill",
    text: `Account 5530-1182

Bill date: Feb 9
Service from Dec 29 to Jan 28
Previous balance: $151.30
Payment received Jan 20: -$151.30
Electricity used (612 kWh): $118.04
Delivery and regulatory: $39.60
HST: $7.08
Amount due: $164.72

Due: Wed, Mar 3

Pay through your bank or at lakeshorehydro.example.com. Questions: help@lakeshorehydro.example.com`,
    expected: [
      { kind: "due", value: "2027-03-03" },
      { kind: "amount", value: "164.72" },
    ],
  },
  // Not expected: the bill date, the bill period, the previous bill 88.20 and its due day 29 Dec 2026, the GST.
  htmlMail({
    id: "h3-mobile-giro",
    name: "Merlion Mobile bill for January.email",
    from: "Merlion Mobile Example",
    writtenAt: Date.UTC(2027, 0, 14, 9),
    mailKind: "bill",
    html: `<html><body><table width="500"><tr><td colspan="2"><b>Your bill</b></td></tr><tr><td>Bill date</td><td>14 Jan 2027</td></tr><tr><td>Bill period</td><td>1 Dec 2026 - 31 Dec 2026</td></tr><tr><td>Previous bill</td><td>$88.20 (due 29 Dec 2026, paid)</td></tr><tr><td>Plan and add-ons</td><td>$88.49</td></tr><tr><td>GST 9%</td><td>$7.96</td></tr><tr><td>Total bill</td><td>$96.45</td></tr><tr><td>GIRO deduction date</td><td>28 Jan 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-01-28" },
      { kind: "amount", value: "96.45" },
    ],
  }),
  // Not expected: the closing date, the payment received 11/05/2026, the previous balance 1,845.20, the minimum payment 35.00.
  {
    id: "h3-credit-card-nov",
    name: "card-statement-2026-11.pdf",
    mime: "application/pdf",
    text: `Summit Bank Example
VISA ENDING 4408 - ACCOUNT SUMMARY
Statement Closing Date: 11/24/2026
Previous Balance | $1,845.20
Payment received 11/05/2026 | -$1,845.20
Purchases | $932.18
Fees charged | $0.00
New Balance | $932.18
Minimum Payment Due | $35.00
Payment Due Date | 12/19/2026
If you do not pay by the date above, a late fee may apply.
Available credit: $6,067.82`,
    expected: [
      { kind: "due", value: "2026-12-19" },
      { kind: "amount", value: "932.18" },
    ],
  },
  // Not expected: the issue date, the first instalment paid 16 November 2026, the annual total 1,754.40.
  {
    id: "h3-council-rates-inst2",
    name: "rates-notice-instalment-2.pdf",
    mime: "application/pdf",
    text: `Tallowood Shire Council Example
RATES AND CHARGES - INSTALMENT NOTICE
Date of issue | 20 January 2027
Assessment no. | 0071-2250-3
Property | 9 Wattle Grove
Annual rates and charges | $1,754.40
Instalment 1 | paid 16 November 2026 | $438.60
Instalment 2 | Amount payable | $438.60
Date payable | 15 February 2027
Pay at the council office, by BPAY or by mail.`,
    expected: [
      { kind: "due", value: "2027-02-15" },
      { kind: "amount", value: "438.60" },
    ],
  },
  // Not expected: the first half paid on January 8, 2027 for 2,140.00, the annual total 4,292.60, the day interest starts.
  htmlMail({
    id: "h3-city-tax-second-half",
    name: "Second half property tax bill.email",
    from: "Oakmont City Treasurer Example",
    writtenAt: Date.UTC(2027, 2, 1, 8),
    mailKind: "bill",
    html: `<html><body><table border="1" cellpadding="6"><tr><th colspan="2">PROPERTY TAX - SECOND HALF 2026-27</th></tr><tr><td>Parcel</td><td>044-19-3820</td></tr><tr><td>Annual tax</td><td>$4,292.60</td></tr><tr><td>First half, paid January 8, 2027</td><td>$2,140.00</td></tr><tr><td>Second half now billed</td><td>$2,152.60</td></tr><tr><td>Tax due date</td><td>April 1, 2027</td></tr><tr><td>Interest of 1.5% per month begins</td><td>April 10, 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-04-01" },
      { kind: "amount", value: "2152.60" },
    ],
  }),
  // Not expected: the policy start and end days, the total premium 1,212.00, the last payment 298.00 and its day.
  {
    id: "h3-auto-insurance-renewal",
    name: "Your auto policy renewal and first installment.email",
    mime: EMAIL,
    from: "Cedar Mutual Auto Insurance Example",
    writtenAt: Date.UTC(2026, 11, 2, 11),
    mailKind: "bill",
    text: `Dear policyholder,

Your policy renews for a new term. Details:

Policy no.: CM-9921704
Policy period: Jan 1, 2027 to Jun 30, 2027
Total premium for the term: $1,212.00
Last payment received Aug 14, 2026: $298.00

Your first installment of $303.00 is due Dec 28, 2026. The remaining installments follow monthly.

Pay online at cedarmutual.example.com or by phone.
Cedar Mutual Auto Insurance Example`,
    expected: [
      { kind: "due", value: "2026-12-28" },
      { kind: "amount", value: "303.00" },
    ],
  },
  // Not expected: the letter date, the gross fee 1,180.00, the subsidy 300.00, the November fee day, the term start.
  {
    id: "h3-nursery-fees-jan",
    name: "Little Sparrows fee letter January 2027.pdf",
    mime: "application/pdf",
    text: `Little Sparrows Childcare Example Pte Ltd
FEE LETTER
Date: 30 Nov 2026
Child: Mia T.
Programme: Full day, K1
Monthly fee (Jan 2027) | $1,180.00
Less: government subsidy | -$300.00
Net fees payable | $880.00
November fees received on 05 Nov 2026
Term 1 starts: 4 Jan 2027
Fees are to be paid by Mon, 7 Dec 2026.
Please pay via GIRO or PayNow to the school account.
Enquiries: fees@littlesparrows.example.com`,
    expected: [
      { kind: "due", value: "2026-12-07" },
      { kind: "amount", value: "880.00" },
    ],
  },
  // Not expected: the statement date, the November rent paid on Nov 1, 2026, the rent 1,850.00 alone, the late fee day.
  {
    id: "h3-rent-statement-dec",
    name: "Rent statement for Unit 5.email",
    mime: EMAIL,
    from: "Cobblestone Property Management Example",
    writtenAt: Date.UTC(2026, 10, 25, 14),
    mailKind: "bill",
    text: `Hello,

Your statement for Unit 5, 212 Fenner Street.

Balance brought forward: $0.00
Rent paid November 1, 2026: $1,850.00
December rent: $1,850.00
Parking stall: $75.00
Total due: $1,925.00
Rent is due on December 1, 2026.

Late charges start accruing after December 5, 2026.

e-Transfer to rent@cobblestone-pm.example.com
Cobblestone Property Management Example`,
    expected: [
      { kind: "due", value: "2026-12-01" },
      { kind: "amount", value: "1925.00" },
    ],
  },
  // Not expected: the notice date, the offence day, the late penalty 30.00.
  {
    id: "h3-parking-notice-rivermouth",
    name: "parking-penalty-notice-RM88120.pdf",
    mime: "application/pdf",
    text: `City of Rivermouth Parking Services Example
PARKING PENALTY NOTICE
Notice date: 2026-11-18
Notice no.: RM88120
Offence date: 2026-11-14
Location: 40 Quay Street, zone C
Offence: Parked beyond posted time
Penalty: $60.00
Pay or dispute by: 2026-12-18
A late penalty of $30.00 is added to unpaid notices.
Pay online at parking.rivermouth.example.org`,
    expected: [
      { kind: "due", value: "2026-12-18" },
      { kind: "amount", value: "60.00" },
    ],
  },
  // Not expected: the bill date, the billing cycle end, the previous bill 68.20 and the day it was paid, the subtotal 64.90.
  {
    id: "h3-fibre-bill-mar",
    name: "Island Fibre bill 17 Mar.email",
    mime: EMAIL,
    from: "Island Fibre Example",
    writtenAt: Date.UTC(2027, 2, 17, 9),
    mailKind: "bill",
    text: `Hi there,

Bill date: 17 Mar
Bill cycle: 1 Feb to 28 Feb
Previous bill: $68.20 (paid on 02 Mar)
1Gbps plan: $59.90
Router rental: $5.00
Subtotal: $64.90
GST (9%): $5.84
Total payable: $70.74

Payment due: 3 Apr

Pay with PayNow, GIRO or card at islandfibre.example.com.`,
    expected: [
      { kind: "due", value: "2027-04-03" },
      { kind: "amount", value: "70.74" },
    ],
  },
  // Not expected: the invoice date, the insurer payment 210.00 and its day, the total fees 355.00, the next visit.
  htmlMail({
    id: "h3-dental-invoice-birchwood",
    name: "Invoice 7731 from Birchwood Dental Example.email",
    from: "Birchwood Dental Example",
    writtenAt: Date.UTC(2027, 0, 12, 16),
    mailKind: "bill",
    html: `<html><body><table border="1" cellpadding="5"><tr><td>Invoice date</td><td>Jan 12, 2027</td></tr><tr><td>Total fees</td><td>$355.00</td></tr><tr><td>Insurer paid Jan 11, 2027</td><td>-$210.00</td></tr><tr><td>Patient portion</td><td><b>$145.00</b></td></tr><tr><td>Remit by</td><td>Feb 11, 2027</td></tr><tr><td>Next visit</td><td>Jul 9, 2027</td></tr></table><p>Cheque, cash or card at reception.</p></body></html>`,
    expected: [
      { kind: "due", value: "2027-02-11" },
      { kind: "amount", value: "145.00" },
    ],
  }),
  // Not expected: the date of issue, the date of lodgement, the tax assessed 18,420.00, the credits 15,300.00, the day interest starts.
  {
    id: "h3-income-tax-assessment",
    name: "notice-of-assessment-2026.pdf",
    mime: "application/pdf",
    text: `Federal Revenue Office Example
NOTICE OF ASSESSMENT - 2025-26 income year
Date of issue: 14 February 2027
Date of lodgement: 31 October 2026
Tax on taxable income | $18,420.00
Less credits for tax withheld | -$15,300.00
Amount payable | $3,120.00
Pay by Wednesday 17 March 2027
General interest charge begins on 18 March 2027 on any amount unpaid.
Pay using the reference on your payment slip.`,
    expected: [
      { kind: "due", value: "2027-03-17" },
      { kind: "amount", value: "3120.00" },
    ],
  },
  // Not expected: the term start day, the previous year's charge 449.00.
  {
    id: "h3-gym-annual-renewal",
    name: "Your membership renews soon.email",
    mime: EMAIL,
    from: "Ironbridge Fitness Example",
    writtenAt: Date.UTC(2027, 4, 4, 10),
    mailKind: "bill",
    text: `Hi Marcus,

Quick heads up about your annual membership.

Current term started: May 28, 2026
Renewal date: May 28, 2027
Renewal charge: $479.00 to the card ending 7731
Last year you paid $449.00.

Nothing to do if you want to keep your membership.
See you at the gym,
Ironbridge Fitness Example`,
    expected: [
      { kind: "due", value: "2027-05-28" },
      { kind: "amount", value: "479.00" },
    ],
  },
  // Not expected: the bill date, the service period, the previous balance 78.12 and its payment day.
  {
    id: "h3-water-sewer-dec",
    name: "riverbend-water-bill-dec.pdf",
    mime: "application/pdf",
    text: `Riverbend Water District Example
WATER AND SEWER BILL
BILL DATE
12/08/2026
SERVICE PERIOD
11/05/2026 - 12/04/2026
PREVIOUS BALANCE
$78.12
PAYMENT RECEIVED 11/30/2026
-$78.12
CURRENT CHARGES
$84.37
DUE DATE
12/29/2026
AMOUNT DUE
$84.37
Pay by mail, online or by phone.`,
    expected: [
      { kind: "due", value: "2026-12-29" },
      { kind: "amount", value: "84.37" },
    ],
  },
  // Not expected: the statement date, the Term 4 payment day, the term start, the instalment plan sum 917.00.
  {
    id: "h3-school-fees-term1",
    name: "Term 1 fees at St Aldric's.email",
    mime: EMAIL,
    from: "St Aldric's College Example",
    writtenAt: Date.UTC(2027, 0, 20, 8),
    mailKind: "bill",
    text: `Dear parents,

Statement date: 20 January
Term 4 fees paid: 1 December
Term 1 begins: 28 January

Tuition, Term 1: $4,850.00
Building levy: $220.00
Sibling discount: -$485.00
Fees for this term: $4,585.00

Fees payable by 12 February.

Prefer instalments? Five payments of $917.00 each can be arranged through the bursar.

Bursar's office, St Aldric's College Example`,
    expected: [
      { kind: "due", value: "2027-02-12" },
      { kind: "amount", value: "4585.00" },
    ],
  },
  // Not expected: the statement date, the outstanding principal 24,310.90, the last instalment day, the rate review day.
  htmlMail({
    id: "h3-personal-loan-feb",
    name: "Personal loan statement for February.email",
    from: "Harbour Trust Bank Example",
    writtenAt: Date.UTC(2027, 1, 3, 10),
    mailKind: "bill",
    html: `<html><body><table width="480" cellpadding="4"><tr><td>Statement date</td><td align="right">03 Feb 2027</td></tr><tr><td>Outstanding principal</td><td align="right">SGD 24,310.90</td></tr><tr><td>Last instalment paid</td><td align="right">14 Jan 2027</td></tr><tr><td>Overdue amount</td><td align="right">SGD 0.00</td></tr><tr><td>Monthly instalment</td><td align="right">SGD 1,148.20</td></tr><tr><td>Instalment due date</td><td align="right">15 Feb 2027</td></tr><tr><td>Interest rate review</td><td align="right">01 Mar 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-02-15" },
      { kind: "amount", value: "1148.20" },
    ],
  }),
  // Not expected: the payment date, the next bill day, the estimate of the next bill 301.00.
  {
    id: "h3-gas-payment-received",
    name: "We received your payment.email",
    mime: EMAIL,
    from: "Prairie Gas Co-op Example",
    writtenAt: Date.UTC(2027, 0, 6, 17),
    mailKind: "receipt",
    text: `Thank you, your payment has been received.

Payment date: 2027-01-06
Confirmation number: PG-55120-77
Amount paid: $286.40
Balance after payment: $0.00

Your next bill is expected on 2027-02-04. We estimate it at about $301.00.

Prairie Gas Co-op Example`,
    expected: [{ kind: "amount", value: "286.40" }],
  },
  // Not expected: the site inspection day, the planned work start, the total job price 6,200.00.
  {
    id: "h3-roof-quote",
    name: "Quote Q-2209 for your roof repair.email",
    mime: EMAIL,
    from: "Ironwood Roofing Example",
    writtenAt: Date.UTC(2027, 3, 12, 13),
    mailKind: "bill",
    text: `Hi Priya,

Thanks for having us out. Your quote:

Quote no.: Q-2209
Site inspection: April 8, 2027
Total for the job: $6,200.00
Deposit payable on acceptance: $1,860.00
Quote valid until: May 14, 2027
Accept by: April 26, 2027
Work would start around June 7, 2027.

Reply to this email to accept.
Ironwood Roofing Example`,
    expected: [
      { kind: "due", value: "2027-04-26" },
      { kind: "expiry", value: "2027-05-14" },
      { kind: "amount", value: "1860.00" },
    ],
  },
  // Not expected: the interim payment of 1,950.00 on 2027-02-26, the total tax 3,923.15, the penalty day.
  htmlMail({
    id: "h3-final-tax-greywater",
    name: "Final tax bill 2027.email",
    from: "Municipality of Greywater Example",
    writtenAt: Date.UTC(2027, 5, 1, 9),
    mailKind: "bill",
    html: `<html><body><div style="border:1px solid #333;padding:8px"><b>Final tax bill 2027</b><br>Roll no. 3320-118<br>Total 2027 tax: $3,923.15<br>Interim bill, paid 2027-02-26: $1,950.00<br><b>Balance of final bill: $1,973.15</b><br>Due date: 2027-06-29<br>Penalty of 1.25% is charged on 2027-07-01 and monthly after.</div></body></html>`,
    expected: [
      { kind: "due", value: "2027-06-29" },
      { kind: "amount", value: "1973.15" },
    ],
  }),
  // Not expected: the subscription start day, the last year's charge day and sum 62.00.
  {
    id: "h3-magazine-autorenew",
    name: "Your Lion City Monthly subscription renews.email",
    mime: EMAIL,
    from: "Lion City Monthly Example",
    writtenAt: Date.UTC(2027, 0, 25, 8),
    mailKind: "bill",
    text: `Dear reader,

Subscribed since: 15 Feb 2025
Last charge: $62.00 on 15 Feb 2026
Auto-renewal date: 15 Feb 2027
Amount to be charged: $68.00 (incl. GST)

The amount will be charged to your card on the renewal date. To change your plan, sign in at lioncitymonthly.example.com.

Subscriptions, Lion City Monthly Example`,
    expected: [
      { kind: "due", value: "2027-02-15" },
      { kind: "amount", value: "68.00" },
    ],
  },
  // Not expected: the bill date, the admission day, the total bill 3,412.60, the insurance 2,100.00, the MediSave 800.00, the deposit 300.00.
  {
    id: "h3-hospital-eastgate",
    name: "eastgate-hospital-final-bill.pdf",
    mime: "application/pdf",
    text: `Eastgate General Hospital Example
FINAL BILL
Bill date: 12 Mar 2027
Admission: 08 Mar 2027 | Discharge: 11 Mar 2027
Description | Amount (SGD)
Total hospital charges | 3,412.60
Less insurer claim | -2,100.00
Less MediSave deduction | -800.00
Less deposit paid 08 Mar 2027 | -300.00
Balance payable | 212.60
Payment due date: 26 Mar 2027
Pay at the cashier or via the patient portal.`,
    expected: [
      { kind: "due", value: "2027-03-26" },
      { kind: "amount", value: "212.60" },
    ],
  },
  // Not expected: the notice date, last year's premium 902.10 and its day, the monthly option 84.20.
  {
    id: "h3-car-insurance-wombat",
    name: "wombat-direct-renewal-notice.pdf",
    mime: "application/pdf",
    text: `Wombat Direct Insurance Example
RENEWAL NOTICE
Date of notice: 22/02/2027
Policy: WD-4471-09
Current cover ends: 22/03/2027
Last year's premium $902.10 was paid on 15/03/2026
Renewal premium (annual) | $934.50
Or pay monthly | 12 x $84.20
To keep your cover without a break, pay by 17/03/2027.`,
    expected: [
      { kind: "due", value: "2027-03-17" },
      { kind: "expiry", value: "2027-03-22" },
      { kind: "amount", value: "934.50" },
    ],
  },
  // Not expected: the failed reload day, the negative balance 4.25, the reload 40.00, the suspension day.
  {
    id: "h3-transit-reload-failed",
    name: "Your transit card needs funds.email",
    mime: EMAIL,
    from: "Metro Transit Pass Example",
    writtenAt: Date.UTC(2027, 2, 2, 9),
    mailKind: "bill",
    text: `Hello,

Your auto-reload did not go through.

Failed reload attempt: Feb 26
Negative balance: $4.25
Minimum reload: $40.00
Amount to add: $44.25
Add funds by: Mar 12
Your card is suspended after Mar 19.

Add funds in the app or at any station.
Metro Transit Pass Example`,
    expected: [
      { kind: "due", value: "2027-03-12" },
      { kind: "amount", value: "44.25" },
    ],
  },
  // Not expected: the issue date, the supply period, the meter read days, the previous bill 312.80 and its payment day.
  {
    id: "h3-electricity-apr",
    name: "Your electricity bill is ready.email",
    mime: EMAIL,
    from: "Southern Cross Energy Example",
    writtenAt: Date.UTC(2027, 3, 14, 7),
    mailKind: "bill",
    text: `Hi Tom,

Bill issue date: 14/04/2027
Supply period: 11/01/2027 to 11/04/2027
Meter read: 11/04/2027 (next read 12/07/2027)
Previous bill: $312.80, paid 01/04/2027
Usage charges: $241.90
Supply charge: $45.65
Total amount due: $287.55

Pay by Wed 05/05/2027

BPAY biller code 4415, or pay online. Hardship help: care@southerncrossenergy.example.com`,
    expected: [
      { kind: "due", value: "2027-05-05" },
      { kind: "amount", value: "287.55" },
    ],
  },
  // Not expected: the invoice date, the payment received 2026-12-01, the gross fee 1,100.00, the subsidy 320.00.
  {
    id: "h3-daycare-january",
    name: "daycare-invoice-2027-01.pdf",
    mime: "application/pdf",
    text: `Sunshine Day Care Centre Example
INVOICE 0912
Invoice date: 2026-12-15
Child: Owen K.
Care for January 2027 | $1,100.00
Child care subsidy | -$320.00
Late pick-up charges (November) | $15.00
Total payable | $795.00
Payment received 2026-12-01 | $780.00
Payable on or before | 2027-01-04
Bank transfer or cheque. Please include the invoice number.`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "795.00" },
    ],
  },
  // Not expected: the statement date, the balance 4,210.77, the interest 3.18, the next statement date.
  {
    id: "h3-savings-summary",
    name: "Your December account summary.email",
    mime: EMAIL,
    from: "Summit Savings Example",
    writtenAt: Date.UTC(2026, 11, 1, 6),
    mailKind: "other",
    text: `Account summary (for your information, nothing to pay)

Statement date: December 1, 2026
Account ending: 2290
Closing balance: $4,210.77
Interest earned in November: $3.18
Next statement: January 3, 2027

Summit Savings Example`,
    expected: [],
  },
  // Not expected: the bill date, the previous balance 142.66 and its payment day, the budget plan amount 118.00.
  htmlMail({
    id: "h3-gas-bill-jan",
    name: "Your Pinecrest Gas bill.email",
    from: "Pinecrest Gas Example",
    writtenAt: Date.UTC(2027, 0, 19, 7),
    mailKind: "bill",
    html: `<html><body><table border="1" cellpadding="4"><tr><td>Bill date</td><td>01/19/2027</td></tr><tr><td>Previous balance</td><td>$142.66</td></tr><tr><td>Payments received 01/08/2027</td><td>-$142.66</td></tr><tr><td>New charges</td><td>$131.04</td></tr><tr><td>Budget plan amount</td><td>$118.00</td></tr><tr><td><b>Amount due</b></td><td><b>$131.04</b></td></tr><tr><td>Pay on or before</td><td>Tuesday, February 9, 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-02-09" },
      { kind: "amount", value: "131.04" },
    ],
  }),
  // Not expected: the notice date, the offence date, the demerit points, the higher fine 300.00.
  {
    id: "h3-traffic-notice-sg",
    name: "notice-of-traffic-offence.pdf",
    mime: "application/pdf",
    text: `Traffic Police Example
NOTICE OF TRAFFIC OFFENCE
Date of notice: 20 Nov 2026
Date of offence: 07 Nov 2026
Offence: Exceeding speed limit
Demerit points: 4
Composition fine | SGD 150.00
Fine if not paid by the date below | SGD 300.00
Last day to pay | 4 Jan 2027
Payment is accepted at AXS stations and online.`,
    expected: [
      { kind: "due", value: "2027-01-04" },
      { kind: "amount", value: "150.00" },
    ],
  },
  // Not expected: the statement date, the billing period, the last bill 142.30 and its payment day, the autopay credit 10.00.
  {
    id: "h3-wireless-march",
    name: "redwood-wireless-statement.pdf",
    mime: "application/pdf",
    text: `Redwood Wireless Example
MONTHLY STATEMENT
Statement date: 03/16/2027
Billing period: 02/17/2027 to 03/16/2027
Last bill $142.30 paid 03/02/2027
Plan charges | $128.55
Device payment | $20.00
Autopay credit | -$10.00
Total due | $138.55
Due date | 04/09/2027
Manage your account at redwoodwireless.example.com`,
    expected: [
      { kind: "due", value: "2027-04-09" },
      { kind: "amount", value: "138.55" },
    ],
  },
  // Not expected: the notice date, the board meeting day, the regular monthly dues 310.00.
  {
    id: "h3-special-assessment-roof",
    name: "special-assessment-notice.pdf",
    mime: "application/pdf",
    text: `Cypress Landing Owners Association Example
NOTICE OF SPECIAL ASSESSMENT
Date: November 30, 2026
Unit 22C
Approved by the board on: October 22, 2026
Purpose: roof replacement, buildings A and B
Special assessment: $2,400.00
Payment due: January 15, 2027
Regular monthly dues of $310.00 continue and are billed separately.
Installment plans are not offered for this assessment.`,
    expected: [
      { kind: "due", value: "2027-01-15" },
      { kind: "amount", value: "2400.00" },
    ],
  },
  // Not expected: the repayment start day, the grace period end, the loan balance 14,220.00.
  {
    id: "h3-student-loan-repayment",
    name: "Your loan repayment is starting.email",
    mime: EMAIL,
    from: "National Student Loans Example",
    writtenAt: Date.UTC(2027, 4, 18, 9),
    mailKind: "bill",
    text: `Hello,

Your grace period ended: Apr 30
Repayment start date: Jun 1
Loan balance: $14,220.00
Monthly payment: $164.00

First payment due: Wednesday, Jun 30

You can set up pre-authorized debit in your online account.
National Student Loans Example`,
    expected: [
      { kind: "due", value: "2027-06-30" },
      { kind: "amount", value: "164.00" },
    ],
  },
  // Not expected: the last payment day and sum 198.00, the bond 396.00, the optional insurance 12.00.
  {
    id: "h3-storage-lockit",
    name: "Rent for Unit 118 is coming up.email",
    mime: EMAIL,
    from: "Lockit Self Storage Example",
    writtenAt: Date.UTC(2026, 11, 10, 9),
    mailKind: "bill",
    text: `Hi,

A reminder for Unit 118.

Last payment received: 01/12/2026, $198.00
Security bond held: $396.00
Rent due: Friday 1 January 2027
Rent amount: $198.00
Optional insurance ($12.00 a month) is not included.

Direct debit customers need do nothing else.
Lockit Self Storage Example`,
    expected: [
      { kind: "due", value: "2027-01-01" },
      { kind: "amount", value: "198.00" },
    ],
  },
  // Not expected: the original invoice date and original due date, the invoice total 226.00, the part payment 40.00 and its day.
  htmlMail({
    id: "h3-vet-reminder-paws",
    name: "Reminder: invoice 5523 is unpaid.email",
    from: "Paws and Claws Vet Example",
    writtenAt: Date.UTC(2027, 1, 17, 12),
    mailKind: "bill",
    html: `<html><body><p>Hello,</p><p>Our records show invoice 5523 is still open.</p><table border="1" cellpadding="4"><tr><td>Invoice date</td><td>20 January 2027</td></tr><tr><td>Original due date</td><td>3 February 2027</td></tr><tr><td>Invoice total</td><td>$226.00</td></tr><tr><td>Part payment, 28 January 2027</td><td>-$40.00</td></tr><tr><td>Balance outstanding</td><td>$186.00</td></tr><tr><td>Please pay by</td><td>3 March 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-03-03" },
      { kind: "amount", value: "186.00" },
    ],
  }),
  // Not expected: the invoice date, the previous visit's sum 95.00.
  {
    id: "h3-dental-recall-letter",
    name: "Your outstanding dental invoice.email",
    mime: EMAIL,
    from: "Lee and Partners Dental Example",
    writtenAt: Date.UTC(2027, 1, 8, 10),
    mailKind: "bill",
    text: `Dear Mr Lim,

Invoice date: 12 January 2027

We are writing about invoice 3318 for $186.50, which our records show as unpaid. Your previous visit, for $95.00, was settled in full, thank you. We would be grateful if you could arrange payment for the open invoice no later than 26 February 2027, by PayNow or at the front desk.

Kind regards,
Accounts, Lee and Partners Dental Example`,
    expected: [
      { kind: "due", value: "2027-02-26" },
      { kind: "amount", value: "186.50" },
    ],
  },
  // Not expected: the notice date, the original due date 15 Feb 2027.
  {
    id: "h3-council-overdue-notice",
    name: "overdue-rates-reminder.pdf",
    mime: "application/pdf",
    text: `Tallowood Shire Council Example
FINAL REMINDER - RATES
Notice date: 12 March 2027
Original due date: 15 February 2027
Assessment no. 0098-4410-1
You have not paid the instalment that fell due in February. If the sum of
$1,206.35 is not received by the council by 9 April 2027, we will begin
recovery action and add legal costs to your account.
Contact rates@tallowood-council.example.org to arrange a payment plan.`,
    expected: [
      { kind: "due", value: "2027-04-09" },
      { kind: "amount", value: "1206.35" },
    ],
  },
  // Not expected: the notice date, the trip date, the late fee 25.00.
  {
    id: "h3-toll-text-balance",
    name: "Toll balance notice.email",
    mime: EMAIL,
    from: "Eastlake Turnpike Example",
    writtenAt: Date.UTC(2027, 1, 23, 8),
    mailKind: "bill",
    text: `Notice date: February 23, 2027
Trip date: February 14, 2027
Plate: 7ABC221

Our cameras recorded your vehicle on the Eastlake Bridge with no valid transponder. Please pay the $18.40 toll balance by March 8, 2027. After that date a $25.00 fee is added to the invoice.

Pay at eastlake-turnpike.example.com
Eastlake Turnpike Example`,
    expected: [
      { kind: "due", value: "2027-03-08" },
      { kind: "amount", value: "18.40" },
    ],
  },
  // Not expected: the invoice date, the original due date, the day it was paid on.
  {
    id: "h3-paid-stamp-invoice",
    name: "invoice-8812-paid.pdf",
    mime: "application/pdf",
    text: `Kopi Supply Trading Example Pte Ltd
INVOICE 8812 - PAID
Invoice date: 12 Nov 2026
Due date: 26 Nov 2026
Paid on: 20 Nov 2026
Amount paid | SGD 640.00
Balance | SGD 0.00
Thank you for your payment. This is your receipt.`,
    expected: [{ kind: "amount", value: "640.00" }],
  },
  // Not expected: the statement date, the previous bill's due date, the next bill date.
  {
    id: "h3-water-nil-balance",
    name: "water-account-statement-nil.pdf",
    mime: "application/pdf",
    text: `Murray Valley Water Example
ACCOUNT STATEMENT
Statement date: 14/12/2026
Previous bill due date: 30/11/2026 (settled)
Closing balance | $0.00
Amount to pay | Nil
Next bill date | 14/03/2027
No action is needed on your part.`,
    expected: [],
  },
  // Not expected: the invoice date, the prior invoice 79.99 and its day, the plan 79.99, the equipment fee, the taxes.
  htmlMail({
    id: "h3-cobalt-broadband-autopay",
    name: "Your Cobalt Broadband invoice.email",
    from: "Cobalt Broadband Example",
    writtenAt: Date.UTC(2027, 1, 2, 8),
    mailKind: "bill",
    html: `<html><body><table cellpadding="5"><tr><td>Invoice date</td><td>02/02/2027</td></tr><tr><td>Service period</td><td>Feb 5 - Mar 4, 2027</td></tr><tr><td>Prior invoice $79.99, paid</td><td>Jan 30, 2027</td></tr><tr><td>Internet plan</td><td>$79.99</td></tr><tr><td>Equipment fee</td><td>$14.00</td></tr><tr><td>Taxes and fees</td><td>$6.40</td></tr><tr><td>Total to be drafted</td><td>$100.39</td></tr><tr><td>Auto-pay draft date</td><td>February 19, 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-02-19" },
      { kind: "amount", value: "100.39" },
    ],
  }),
  // Not expected: the period end, the previous quarter's 1,792.00 and its day.
  htmlMail({
    id: "h3-quarterly-instalment-ato",
    name: "Your quarterly instalment notice.email",
    from: "Federal Revenue Office Example",
    writtenAt: Date.UTC(2027, 3, 6, 9),
    mailKind: "bill",
    html: `<html><body><p><b>Quarterly instalment notice</b></p><table border="1" cellpadding="4"><tr><th>Item</th><th>Detail</th></tr><tr><td>Quarter ended</td><td>31 March 2027</td></tr><tr><td>Previous quarter, paid 25 January 2027</td><td>$1,792.00</td></tr><tr><td>Instalment payable</td><td>$1,845.00</td></tr><tr><td>Payment due</td><td>Wednesday 28 April 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-04-28" },
      { kind: "amount", value: "1845.00" },
    ],
  }),
  // Not expected: the last year's payment day, the subscription before GST 540.00, the GST 48.60.
  htmlMail({
    id: "h3-bowls-club-renewal",
    name: "Annual subscription renewal.email",
    from: "Sentosa Lawn Bowls Club Example",
    writtenAt: Date.UTC(2027, 5, 14, 10),
    mailKind: "bill",
    html: `<html><body><table border="1" cellpadding="4"><tr><td>Last year's fee paid</td><td>02 Jul 2026</td></tr><tr><td>Subscription</td><td>$540.00</td></tr><tr><td>GST 9%</td><td>$48.60</td></tr><tr><td>Total subscription</td><td>$588.60</td></tr><tr><td>Pay before</td><td>Mon 28 Jun 2027</td></tr><tr><td>Membership expires</td><td>30 Jun 2027</td></tr></table></body></html>`,
    expected: [
      { kind: "due", value: "2027-06-28" },
      { kind: "expiry", value: "2027-06-30" },
      { kind: "amount", value: "588.60" },
    ],
  }),
  // Not expected: the last year's premium 1,102.00 and its day, the monthly plan 102.50.
  {
    id: "h3-home-insurance-ca",
    name: "Home insurance renewal.email",
    mime: EMAIL,
    from: "Maple Leaf Home Insurance Example",
    writtenAt: Date.UTC(2026, 10, 17, 9),
    mailKind: "bill",
    text: `Hello,

Your home policy renews soon.

Policy term: Jan 1 to Dec 31
Last year's premium: $1,102.00, paid Dec 10
Annual premium: $1,184.00
Monthly plan: $102.50 a month
Please pay by Dec 15

Pay online, by phone or through your broker.
Maple Leaf Home Insurance Example`,
    expected: [
      { kind: "due", value: "2026-12-15" },
      { kind: "amount", value: "1184.00" },
    ],
  },
  // Not expected: the previous bill 158.40 and its payment day, the service charge 64.80, the usage charge 96.20.
  htmlMail({
    id: "h3-water-murray-may",
    name: "Murray Valley Water account notice.email",
    from: "Murray Valley Water Example",
    writtenAt: Date.UTC(2027, 4, 20, 8),
    mailKind: "bill",
    html: `<html><body><div style="border:1px solid #444;padding:10px"><b>Account summary</b><br>Previous bill $158.40 paid 11 May 2027<br>Usage charge $96.20<br>Service charge $64.80<br>Amount owing: <b>$161.00</b><br>Pay by: 14 June 2027</div></body></html>`,
    expected: [
      { kind: "due", value: "2027-06-14" },
      { kind: "amount", value: "161.00" },
    ],
  }),
  // Not expected: the statement date, the last payment day, the principal 11,208.30, the late charge 19.48 and its day.
  {
    id: "h3-auto-finance-dec",
    name: "auto-loan-statement-dec.pdf",
    mime: "application/pdf",
    text: `Prairie State Auto Finance Example
MONTHLY LOAN STATEMENT
Statement date: 12/22/2026
Principal balance: $11,208.30
Last payment received 12/09/2026: $389.52
Past due amount: $0.00
Regular payment: $389.52
Payment due date: 01/12/2027
A late charge of $19.48 applies if payment is not received by 01/22/2027.`,
    expected: [
      { kind: "due", value: "2027-01-12" },
      { kind: "amount", value: "389.52" },
    ],
  },
  // Not expected: the issue date, the class start day, the 12 lessons price 45.00 each.
  {
    id: "h3-tuition-centre-term1",
    name: "brightminds-fee-notice.pdf",
    mime: "application/pdf",
    text: `Bright Minds Tuition Example
FEE NOTICE - TERM 1
Issued: 28 Dec 2026
Student: Ethan W., Sec 2 Maths
12 lessons x $45.00 | $540.00
Classes begin | 4 Jan 2027
Fee payable | $540.00
Pay on or before 11 Jan 2027 by PayNow or cash at the centre.`,
    expected: [
      { kind: "due", value: "2027-01-11" },
      { kind: "amount", value: "540.00" },
    ],
  },
  // Not expected: the statement date, the date of service, the insurer payment day, the charges 420.00, the insurer payment 260.00, the adjustment 75.00.
  {
    id: "h3-clinic-statement",
    name: "lakeside-patient-statement.pdf",
    mime: "application/pdf",
    text: `Lakeside Family Medicine Example
PATIENT STATEMENT
Statement date: 11/16/2026
Date of service: 10/30/2026
Total charges | $420.00
Insurance payment 11/09/2026 | -$260.00
Contractual adjustment | -$75.00
Patient responsibility | $85.00
Please send payment by 12/16/2026
Make checks payable to Lakeside Family Medicine Example.`,
    expected: [
      { kind: "due", value: "2026-12-16" },
      { kind: "amount", value: "85.00" },
    ],
  },
  // Not expected: the last deduction day, the pass type.
  htmlMail({
    id: "h3-transit-pass-renewal",
    name: "Your monthly pass renews on 1 Apr.email",
    from: "Island Transit Example",
    writtenAt: Date.UTC(2027, 2, 25, 9),
    mailKind: "bill",
    html: `<html><body><table cellpadding="4"><tr><td>Last deduction</td><td>1 Mar 2027</td></tr><tr><td>Pass type</td><td>Adult monthly, all modes</td></tr><tr><td>Next deduction date</td><td>1 Apr 2027</td></tr><tr><td>Amount</td><td>$128.00</td></tr></table><p>The amount will be taken from your linked card.</p></body></html>`,
    expected: [
      { kind: "due", value: "2027-04-01" },
      { kind: "amount", value: "128.00" },
    ],
  }),
  // Not expected: the notice date, the new rent 1,720.00 and the day it starts.
  {
    id: "h3-rent-increase-notice",
    name: "rent-notice-june.pdf",
    mime: "application/pdf",
    text: `Dundas Park Apartments Example
RENT NOTICE - Suite 304
Notice date: 2027-05-14
Rent due: June 1, 2027
Rent for June: $1,680.00
New monthly rent from 2027-07-01: $1,720.00
Rent is payable by e-transfer or pre-authorized debit.`,
    expected: [
      { kind: "due", value: "2027-06-01" },
      { kind: "amount", value: "1680.00" },
    ],
  },
];
