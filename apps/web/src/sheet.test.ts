import { describe, expect, it } from "vitest";
import { columnIndex, readWorkbook } from "./sheet";

/**
 * Reading a workbook needs a DOM parser, which the browser has and this
 * runner does not, so the parsing itself is covered by the preview gate that
 * opens a real workbook in a real engine. What is worth pinning here is the
 * arithmetic deciding which column a cell lands in: an off-by-one there
 * silently shifts every value in a sheet.
 */
describe("columnIndex", () => {
  it("reads column letters, which are base-26 with no zero", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("B")).toBe(1);
    expect(columnIndex("Z")).toBe(25);
    expect(columnIndex("AA")).toBe(26);
    expect(columnIndex("AB")).toBe(27);
    expect(columnIndex("BC")).toBe(54);
    expect(columnIndex("ZZ")).toBe(701);
  });
});

describe("readWorkbook", () => {
  it("refuses bytes that are not a workbook", async () => {
    await expect(readWorkbook(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
