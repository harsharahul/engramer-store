#!/usr/bin/env node
/**
 * Builds the recorded PDF text items the PDF text tests read.
 *
 * It draws a few invented documents as real PDFs (a bill with a table, an
 * invoice in two columns, a ticket, a letter, an itinerary, and a line set
 * in several pieces), reads each back with pdf.js the way the app does,
 * and writes what pdf.js reports for every piece of text: its words, where
 * it stands and how large it is. The tests then check that those pieces
 * become the lines and columns a person sees on the page.
 *
 * Usage: node tools/build-pdf-item-fixtures.mjs
 * Writes apps/web/src/intel/fixtures/pdfitems/<name>.json. Run it again
 * only when a fixture is added or pdf.js is updated; the tests fail when a
 * fixture no longer matches its page.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "apps", "web");
const require = createRequire(join(web, "package.json"));
const { PDFDocument, StandardFonts, degrees } = require("pdf-lib");
const pdfjs = await import(pathToFileURL(join(web, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href);
const out = join(web, "src", "intel", "fixtures", "pdfitems");

/** One page drawn from a list of pieces: text, left edge, baseline from the top, size, bold, turned. */
async function page(pieces) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const sheet = doc.addPage([595, 842]);
  for (const piece of pieces) {
    const font = piece.mono ? mono : piece.bold ? bold : regular;
    sheet.drawText(piece.text, {
      x: piece.x,
      y: 842 - piece.top,
      size: piece.size ?? 10,
      font,
      ...(piece.turned ? { rotate: degrees(90) } : {}),
    });
  }
  return doc.save();
}

/** A row of cells at fixed left edges. */
const row = (top, cells, extra = {}) => cells.map(([x, text]) => ({ text, x, top, ...extra })).filter((piece) => piece.text !== "");

const documents = {
  // A bill: field lines, then a table of three columns, then totals.
  "bill-table": [
    { text: "Northline Energy Example", x: 50, top: 60, size: 16, bold: true },
    { text: "Gas and electricity statement", x: 50, top: 82 },
    { text: "Statement date: 2 November 2026", x: 50, top: 120 },
    { text: "Account number: REF-48213", x: 50, top: 134 },
    ...row(170, [[50, "Description"], [220, "Period"], [420, "Amount (GBP)"]], { bold: true }),
    ...row(184, [[50, "Electricity"], [220, "1 Oct to 31 Oct"], [420, "52.10"]]),
    ...row(198, [[50, "Gas"], [220, "1 Oct to 31 Oct"], [420, "34.25"]]),
    { text: "Total amount due: 86.35 GBP", x: 50, top: 236, bold: true },
    { text: "Payment due date: 23 November 2026", x: 50, top: 250 },
    { text: "Next statement date: 2 December 2026", x: 50, top: 264 },
  ],
  // An invoice whose page has two columns: the sender's address at the left, the invoice's fields at the right.
  "invoice-two-columns": [
    { text: "Lakeside Plumbing Example", x: 50, top: 60, size: 14, bold: true },
    ...row(100, [[50, "12 High Street"], [340, "Invoice number: INV-1144"]]),
    ...row(114, [[50, "Lakeside LK1 2AB"], [340, "Invoice date: 5 November 2026"]]),
    ...row(128, [[50, "Phone 01632 960001"], [340, "Payment due: 23 November 2026"]]),
    ...row(170, [[50, "Labour, 3 hours"], [460, "195.00"]]),
    ...row(184, [[50, "Parts"], [460, "48.50"]]),
    ...row(198, [[50, "Subtotal"], [460, "243.50"]]),
    ...row(212, [[50, "VAT 20%"], [460, "48.70"]]),
    ...row(232, [[50, "Total due"], [460, "GBP 292.20"]], { bold: true }),
  ],
  // A ticket: the day on one line, the times on the lines under it, a blank gap, then the small print.
  ticket: [
    { text: "Riverside Hall Example", x: 50, top: 60, size: 16, bold: true },
    { text: "An Evening of Strings", x: 50, top: 84, size: 12 },
    { text: "Date: Saturday 6 November 2027", x: 50, top: 120 },
    { text: "Doors: 7:00 PM", x: 50, top: 134 },
    { text: "Show starts: 8:00 PM", x: 50, top: 148 },
    { text: "Seat: Stalls K 14", x: 50, top: 162 },
    { text: "Booked on: 3 September 2027", x: 50, top: 210, size: 8 },
    { text: "No refunds after 30 October 2027.", x: 50, top: 222, size: 8 },
  ],
  // A letter: running text, each printed line one piece.
  letter: [
    { text: "Harbour Dental Example", x: 50, top: 60, size: 14, bold: true },
    { text: "Dear Alex,", x: 50, top: 110 },
    { text: "This is a reminder of your check-up on 22 July 2027 at 09:30. Please arrive", x: 50, top: 134 },
    { text: "ten minutes early. If you cannot attend, tell us by 15 July 2027 so that", x: 50, top: 148 },
    { text: "another patient can take the time.", x: 50, top: 162 },
    { text: "Kind regards,", x: 50, top: 196 },
    { text: "The reception team", x: 50, top: 210 },
  ],
  // An itinerary: a header row and two rows of four cells; a note set sideways in the margin.
  itinerary: [
    { text: "Tidewater Ferries Example", x: 50, top: 60, size: 16, bold: true },
    { text: "Booking date: 14 June 2027", x: 50, top: 96 },
    ...row(130, [[50, "Sailing"], [150, "Date"], [330, "Departs"], [430, "Arrives"]], { bold: true }),
    ...row(144, [[50, "Outbound"], [150, "2 July 2027"], [330, "07:30"], [430, "10:45"]]),
    ...row(158, [[50, "Return"], [150, "9 July 2027"], [330, "16:00"], [430, "19:15"]]),
    { text: "Total paid: GBP 186.00", x: 50, top: 196 },
    { text: "Printed by the passenger", x: 570, top: 400, size: 7, turned: true },
  ],
  // One line set in several pieces, as a typesetter that moves letters closer does it; and a monospaced line.
  "split-words": [
    { text: "Pay", x: 50, top: 60 },
    { text: "ment due: 23 Novem", x: 66.12, top: 60 },
    { text: "ber 2026", x: 153.94, top: 60 },
    { text: "Amount   due      86.35 GBP", x: 50, top: 90, mono: true },
  ],
};

mkdirSync(out, { recursive: true });
const round = (n) => Math.round(n * 100) / 100;
for (const [name, pieces] of Object.entries(documents)) {
  const loading = pdfjs.getDocument({ data: await page(pieces), useSystemFonts: true });
  const doc = await loading.promise;
  const content = await (await doc.getPage(1)).getTextContent();
  // Exactly what the app's own step is given, with numbers shortened.
  const items = content.items
    .filter((item) => "str" in item)
    .map((item) => ({ str: item.str, transform: item.transform.map(round), width: round(item.width), height: round(item.height), hasEOL: item.hasEOL }));
  await loading.destroy();
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ items }, null, 1)}\n`);
  console.log(`${name}: ${items.length} items`);
}
