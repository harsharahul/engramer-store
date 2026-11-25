import { describe, expect, it } from "vitest";
import bill from "./fixtures/pdfitems/bill-table.json";
import invoice from "./fixtures/pdfitems/invoice-two-columns.json";
import itinerary from "./fixtures/pdfitems/itinerary.json";
import letter from "./fixtures/pdfitems/letter.json";
import split from "./fixtures/pdfitems/split-words.json";
import ticket from "./fixtures/pdfitems/ticket.json";
import { pdfItemsOf, pdfLines, type PdfItem } from "./pdftext";

/**
 * The fixtures are what pdf.js reports for real pages drawn by
 * tools/build-pdf-item-fixtures.mjs. Each test states the lines and columns
 * a person sees on that page.
 */
const text = (content: { items: unknown[] }) => pdfLines(pdfItemsOf(content));

describe("a PDF page as its lines and columns", () => {
  it("a bill: field lines, a table of three columns, the totals", () => {
    expect(text(bill)).toBe(
      [
        "Northline Energy Example",
        "Gas and electricity statement",
        "",
        "Statement date: 2 November 2026",
        "Account number: REF-48213",
        "",
        "Description | Period | Amount (GBP)",
        "Electricity | 1 Oct to 31 Oct | 52.10",
        "Gas | 1 Oct to 31 Oct | 34.25",
        "",
        "Total amount due: 86.35 GBP",
        "Payment due date: 23 November 2026",
        "Next statement date: 2 December 2026",
      ].join("\n"),
    );
  });

  it("an invoice in two columns: what stands side by side is one row of two cells", () => {
    expect(text(invoice)).toBe(
      [
        "Lakeside Plumbing Example",
        "",
        "12 High Street | Invoice number: INV-1144",
        "Lakeside LK1 2AB | Invoice date: 5 November 2026",
        "Phone 01632 960001 | Payment due: 23 November 2026",
        "",
        "Labour, 3 hours | 195.00",
        "Parts | 48.50",
        "Subtotal | 243.50",
        "VAT 20% | 48.70",
        "",
        "Total due | GBP 292.20",
      ].join("\n"),
    );
  });

  it("a ticket: the times stay on their own lines under the date, the small print is a block of its own", () => {
    expect(text(ticket)).toBe(
      [
        "Riverside Hall Example",
        "An Evening of Strings",
        "",
        "Date: Saturday 6 November 2027",
        "Doors: 7:00 PM",
        "Show starts: 8:00 PM",
        "Seat: Stalls K 14",
        "",
        "Booked on: 3 September 2027",
        "No refunds after 30 October 2027.",
      ].join("\n"),
    );
  });

  it("a letter: a sentence that the page wrapped is one line again", () => {
    expect(text(letter)).toBe(
      [
        "Harbour Dental Example",
        "",
        "Dear Alex,",
        "",
        "This is a reminder of your check-up on 22 July 2027 at 09:30. Please arrive ten minutes early. If you cannot attend, tell us by 15 July 2027 so that another patient can take the time.",
        "",
        "Kind regards,",
        "The reception team",
      ].join("\n"),
    );
  });

  it("an itinerary: a header row and its rows, and text set sideways comes last on a line of its own", () => {
    expect(text(itinerary)).toBe(
      [
        "Tidewater Ferries Example",
        "",
        "Booking date: 14 June 2027",
        "",
        "Sailing | Date | Departs | Arrives",
        "Outbound | 2 July 2027 | 07:30 | 10:45",
        "Return | 9 July 2027 | 16:00 | 19:15",
        "",
        "Total paid: GBP 186.00",
        "",
        "Printed by the passenger",
      ].join("\n"),
    );
  });

  it("a word set in several pieces is one word, and three spaces of a typewriter face part two cells", () => {
    expect(text(split)).toBe(["Payment due: 23 November 2026", "", "Amount | due | 86.35 GBP"].join("\n"));
  });
});

describe("pdfLines on its own", () => {
  const at = (str: string, x: number, y: number, over: Partial<PdfItem> = {}): PdfItem => ({ str, x, y, width: str.length * 5, height: 10, ...over });

  it("gives the same text whatever order the pieces come in", () => {
    const items = pdfItemsOf(bill);
    const shuffled = [...items].reverse();
    expect(pdfLines(shuffled)).toBe(pdfLines(items));
  });

  it("puts a space between words, nothing between touching pieces, and a cell boundary across a wide gap", () => {
    // Pieces of 5 units a character: 2 units apart is a space, 12 a cell boundary.
    expect(pdfLines([at("Total", 0, 100), at("due", 27, 100)])).toBe("Total due");
    expect(pdfLines([at("Novem", 0, 100), at("ber", 25, 100)])).toBe("November");
    expect(pdfLines([at("Total", 0, 100), at("86.35", 37, 100)])).toBe("Total | 86.35");
  });

  it("starts a new block after a gap of two lines, not after one", () => {
    expect(pdfLines([at("One", 0, 100), at("Two", 0, 86), at("Three", 0, 60)])).toBe("One\nTwo\n\nThree");
  });

  it("joins a line to the one above when the sentence goes on, and never across a blank gap or into a row of cells", () => {
    expect(pdfLines([at("Please arrive", 0, 100), at("ten minutes early.", 0, 86)])).toBe("Please arrive ten minutes early.");
    expect(pdfLines([at("Your check-up is on", 0, 100), at("22 July 2027.", 0, 86)])).toBe("Your check-up is on 22 July 2027.");
    expect(pdfLines([at("Please arrive", 0, 100), at("ten minutes early.", 0, 60)])).toBe("Please arrive\n\nten minutes early.");
    expect(pdfLines([at("Please arrive", 0, 100), at("ten", 0, 86), at("minutes", 60, 86)])).toBe("Please arrive\nten | minutes");
  });

  it("keeps a form line apart from the next, even when it is the widest line on the page", () => {
    expect(pdfLines([at("Date: Saturday 6 November 2027", 0, 100), at("Doors: 7:00 PM", 0, 86)])).toBe("Date: Saturday 6 November 2027\nDoors: 7:00 PM");
  });

  it("skips a piece with no place or no words, and gives nothing for nothing", () => {
    expect(pdfLines([at("kept", 0, 100), at("lost", Number.NaN, 100), at("   ", 40, 100), at("", 60, 100)])).toBe("kept");
    expect(pdfLines([])).toBe("");
    expect(pdfItemsOf({ items: [{ type: "beginMarkedContent" }, { str: "x", transform: [10, 0, 0, 10, 5, 7], width: 5, height: 10 }] })).toEqual([{ str: "x", x: 5, y: 7, width: 5, height: 10 }]);
  });

  it("a tall piece does not pull the lines under it into its row, and a small raised sign stays in its own", () => {
    const tall = (str: string, x: number, y: number, height: number): PdfItem => ({ str, x, y, width: str.length * height * 0.5, height });
    expect(pdfLines([tall("INVOICE", 0, 750, 48), at("Invoice date: 3 Feb 2027", 0, 728)])).toBe("INVOICE\nInvoice date: 3 Feb 2027");
    // A stamp set across the page.
    expect(pdfLines([tall("PAID", 200, 500, 200), at("Line one 1 March 2027", 0, 470), at("Line two", 0, 458)])).toBe("PAID\nLine one 1 March 2027\nLine two");
    expect(pdfLines([at("Total", 0, 100), { str: "£", x: 60, y: 103, width: 3, height: 6 }, at("429.00", 64, 100)])).toBe("Total | £429.00");
  });

  it("pieces that lie over each other are parted by a space, never glued", () => {
    expect(pdfLines([at("Line one", 0, 100), at("COPY", 10, 100)])).toBe("Line one COPY");
  });

  it("slanted text is upright text; only text set at an angle is put last", () => {
    const piece = (str: string, transform: number[]) => ({ str, transform, width: str.length * 5, height: 10 });
    const items = pdfItemsOf({ items: [piece("Due date:", [10, 0, 0, 10, 0, 100]), piece("12 March 2027", [10, 0, 2.5, 10, 50, 100]), piece("Printed sideways", [0, 10, -10, 0, 300, 50])] });
    expect(pdfLines(items)).toBe("Due date: 12 March 2027\n\nPrinted sideways");
  });

  it("a capital at a line's end is a value, not a joining word", () => {
    expect(pdfLines([at("Grade: A", 0, 100), at("Next review: 12 March 2027", 0, 86)])).toBe("Grade: A\nNext review: 12 March 2027");
    expect(pdfLines([at("State: OR", 0, 100), at("Boarding 10:30", 0, 86)])).toBe("State: OR\nBoarding 10:30");
  });

  it("a piece that states no width is as wide as its words, so the next word is a word and not a cell", () => {
    const items = pdfItemsOf({ items: [{ str: "Total", transform: [10, 0, 0, 10, 0, 100], width: 0, height: 10 }, { str: "£429.00", transform: [10, 0, 0, 10, 30, 100], width: 35, height: 10 }] });
    expect(pdfLines(items)).toBe("Total £429.00");
  });

  it("reads a row of a hundred and sixty thousand pieces", () => {
    const row = Array.from({ length: 160_000 }, (_, i) => at("w", i * 8, 100));
    expect(pdfLines(row).length).toBe(160_000 * 2 - 1);
  });

  it("reads five thousand pieces in a fraction of a second", () => {
    const many = Array.from({ length: 5000 }, (_, i) => at(`W${i}`, (i % 20) * 30, 10_000 - Math.floor(i / 20) * 14));
    const started = performance.now();
    expect(pdfLines(many).split("\n")).toHaveLength(250);
    // A wide limit, for a shared test machine.
    expect(performance.now() - started).toBeLessThan(500);
  });
});
