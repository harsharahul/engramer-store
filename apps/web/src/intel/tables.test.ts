import { describe, expect, it } from "vitest";
import { cellsOf, headerLines, tableBlocks, type Cell } from "./tables";

const lines = (...text: string[]) => text.join("\n");
const words = (cells: readonly Cell[]) => cells.map((cell) => cell.text);
const shape = (text: string) => tableBlocks(text).map((block) => ({ ...(block.header ? { header: words(block.header) } : {}), rows: block.rows.map(words) }));

const FERRY = { header: ["Sailing", "Date", "Departs", "Arrives"], rows: [["Outbound", "2 July 2027", "07:30", "10:45"], ["Return", "9 July 2027", "16:00", "19:15"]] };

describe("cellsOf: the cells of one line", () => {
  it("parts a line at each bar that stands between spaces, and says where each cell is", () => {
    const line = "Outbound | 2 July 2027 | 07:30";
    const cells = cellsOf(line, 100);
    expect(words(cells)).toEqual(["Outbound", "2 July 2027", "07:30"]);
    expect(cells.map((cell) => line.slice(cell.at - 100, cell.end - 100))).toEqual(["Outbound", "2 July 2027", "07:30"]);
  });

  it("keeps an empty cell in its place, at the start and the end of a line too", () => {
    expect(words(cellsOf("Total | | | £429.00", 0))).toEqual(["Total", "", "", "£429.00"]);
    expect(words(cellsOf("| Date | Amount", 0))).toEqual(["", "Date", "Amount"]);
    expect(words(cellsOf("Gas | 34.25 |", 0))).toEqual(["Gas", "34.25", ""]);
  });

  it("parts a line at tabs, or at gaps of three spaces or more, when it holds no bar", () => {
    expect(words(cellsOf("Outbound\t2 July 2027\t\t10:45", 0))).toEqual(["Outbound", "2 July 2027", "", "10:45"]);
    expect(words(cellsOf("  Outbound     2 July 2027   07:30  ", 0))).toEqual(["Outbound", "2 July 2027", "07:30"]);
  });

  it("is one cell for running words, whatever they hold, and nothing for nothing", () => {
    expect(words(cellsOf("Payment due: 23 November 2026", 0))).toEqual(["Payment due: 23 November 2026"]);
    expect(words(cellsOf("A|B and C  or D", 0))).toEqual(["A|B and C  or D"]);
    expect(cellsOf("   ", 0)).toEqual([]);
    expect(cellsOf("", 0)).toEqual([]);
  });
});

describe("tableBlocks: rows of cells that stand together", () => {
  const ferry = lines("Tidewater Ferries Example", "", "Sailing | Date | Departs | Arrives", "Outbound | 2 July 2027 | 07:30 | 10:45", "Return | 9 July 2027 | 16:00 | 19:15", "", "Total paid: GBP 186.00");

  it("a header and its rows, parted by bars", () => {
    expect(shape(ferry)).toEqual([FERRY]);
    const [block] = tableBlocks(ferry);
    expect(ferry.slice(block!.at, block!.end)).toBe(lines("Sailing | Date | Departs | Arrives", "Outbound | 2 July 2027 | 07:30 | 10:45", "Return | 9 July 2027 | 16:00 | 19:15"));
    for (const cell of [...block!.header!, ...block!.rows.flat()]) {
      expect(ferry.slice(cell.at, cell.end)).toBe(cell.text);
    }
  });

  it("the same parted by tabs, and by wide gaps", () => {
    expect(shape(lines("Sailing\tDate\tDeparts\tArrives", "Outbound\t2 July 2027\t07:30\t10:45", "Return\t9 July 2027\t16:00\t19:15"))).toEqual([FERRY]);
    expect(shape(lines("Sailing      Date            Departs   Arrives", "Outbound     2 July 2027     07:30     10:45", "Return       9 July 2027     16:00     19:15"))).toEqual([FERRY]);
  });

  it("names the header lines", () => {
    expect(headerLines(ferry).map((span) => ferry.slice(span.at, span.end))).toEqual(["Sailing | Date | Departs | Arrives"]);
    expect(headerLines("No table here.")).toEqual([]);
  });

  it("a block of labels and values in two cells has no header", () => {
    expect(shape(lines("Guest | Alex Example", "Check-in | Fri 12 March 2027", "Check-out | Mon 15 March 2027"))).toEqual([
      { rows: [["Guest", "Alex Example"], ["Check-in", "Fri 12 March 2027"], ["Check-out", "Mon 15 March 2027"]] },
    ]);
    expect(shape(lines("Description | Amount (GBP)", "Electricity | 52.10", "Total | 86.35"))).toEqual([
      { rows: [["Description", "Amount (GBP)"], ["Electricity", "52.10"], ["Total", "86.35"]] },
    ]);
  });

  it("two columns of values under two names have a header", () => {
    expect(shape(lines("Date | Amount", "3 May 2027 | $40.00", "4 May 2027 | $12.00"))).toEqual([
      { header: ["Date", "Amount"], rows: [["3 May 2027", "$40.00"], ["4 May 2027", "$12.00"]] },
    ]);
  });

  it("a first row that holds a date, a clock or an amount is a row, not a header", () => {
    expect(shape(lines("2 July 2027 | 07:30 | 10:45", "9 July 2027 | 16:00 | 19:15"))).toEqual([{ rows: [["2 July 2027", "07:30", "10:45"], ["9 July 2027", "16:00", "19:15"]] }]);
    expect(tableBlocks(lines("Room | £390.00 | paid", "VAT | £78.00 | paid"))[0]!.header).toBeUndefined();
    expect(tableBlocks(lines("Doors | 7:00 PM | Hall", "Show | 8:00 PM | Hall"))[0]!.header).toBeUndefined();
  });

  it("one line alone is no table, and a blank line parts two", () => {
    expect(tableBlocks("Total | £429.00")).toEqual([]);
    expect(tableBlocks(lines("Total | £429.00", "", "Paid | £429.00"))).toEqual([]);
    expect(tableBlocks(lines("Total | £429.00", "Thank you for your stay.", "Paid | £429.00"))).toEqual([]);
  });

  it("a row with one cell more or fewer still belongs, each cell under its column", () => {
    expect(
      shape(lines("Fare | Qty | Amount (GBP)", "Adult | 2 | 108.00", "Subtotal | | 170.00", "Total paid | 160.00", "Car | 1 | 62.00 | paid")),
    ).toEqual([
      {
        header: ["Fare", "Qty", "Amount (GBP)"],
        rows: [["Adult", "2", "108.00"], ["Subtotal", "", "170.00"], ["Total paid", "", "160.00"], ["Car", "1", "62.00", "paid"]],
      },
    ]);
    // A short row that is not a name and its sum cannot be placed: which cell is missing is not known (a page's
    // text has no mark for an empty cell). It keeps its own length, and nothing in it is read under a header.
    expect(shape(lines("Date | Departs | Arrives", "2 July 2027 | 07:30 | 10:45", "9 July 2027 | 19:15"))[0]!.rows[1]).toEqual(["9 July 2027", "19:15"]);
  });

  it("rows of a different width are a table of their own", () => {
    expect(shape(lines("Adult | 108.00", "Car | 62.00", "Sailing | Date | Departs | Arrives", "Outbound | 2 July 2027 | 07:30 | 10:45"))).toEqual([
      { rows: [["Adult", "108.00"], ["Car", "62.00"]] },
      { header: ["Sailing", "Date", "Departs", "Arrives"], rows: [["Outbound", "2 July 2027", "07:30", "10:45"]] },
    ]);
  });

  it("a row of names under rows of values is the header of a table of its own", () => {
    expect(
      shape(lines("Issued | 20 June 2027", "Date | Departs | Arrives", "5 August 2027 | 07:45 | 09:10", "12 August 2027 | 18:20 | 19:45", "Fare | Qty | Amount", "Foot passenger | 2 | 36.00")),
    ).toEqual([
      { header: ["Date", "Departs", "Arrives"], rows: [["5 August 2027", "07:45", "09:10"], ["12 August 2027", "18:20", "19:45"]] },
      { header: ["Fare", "Qty", "Amount"], rows: [["Foot passenger", "2", "36.00"]] },
    ]);
    expect(shape(lines("Check-in | Check-out | Nights", "13 Oct 2027 | 16 Oct 2027 | 3", "Description | Date | Amount (EUR)", "Room | 13 Oct 2027 | 95.00", "Total | | 313.50"))).toEqual([
      { header: ["Check-in", "Check-out", "Nights"], rows: [["13 Oct 2027", "16 Oct 2027", "3"]] },
      { header: ["Description", "Date", "Amount (EUR)"], rows: [["Room", "13 Oct 2027", "95.00"], ["Total", "", "313.50"]] },
    ]);
    // Rows of names only, with no row of values before them, stay one table.
    expect(tableBlocks(lines("Day | Class | Room", "Mon | Yoga | Hall", "Tue | Pilates | Studio"))).toHaveLength(1);
  });

  it("a colon inside a cell does not part it", () => {
    expect(shape(lines("12 High Street | Invoice date: 3 Feb 2027", "Lakeside LK1 2AB | Payment due: 23 Feb 2027"))).toEqual([
      { rows: [["12 High Street", "Invoice date: 3 Feb 2027"], ["Lakeside LK1 2AB", "Payment due: 23 Feb 2027"]] },
    ]);
  });

  it("reads two thousand rows in well under a twentieth of a second", () => {
    const text = lines("Date | Description | Amount (GBP)", ...Array.from({ length: 2000 }, (_, i) => `${(i % 28) + 1} March 2027 | Card payment ${i} | ${i}.50`));
    tableBlocks(text);
    const started = performance.now();
    const blocks = tableBlocks(text);
    expect(performance.now() - started).toBeLessThan(50);
    expect(blocks[0]!.rows).toHaveLength(2000);
  });
});
