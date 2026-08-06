import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractText } from "./extract";

// Real zip containers built in-test, so the reader is exercised end to end.
const packed = (entries: Record<string, string>, name: string, mime: string): File => {
  const zipped = zipSync(
    Object.fromEntries(Object.entries(entries).map(([path, xml]) => [path, strToU8(xml)])),
  );
  return new File([zipped.slice().buffer as ArrayBuffer], name, { type: mime });
};

describe("office text extraction", () => {
  it("reads the words out of a Word document", async () => {
    const file = packed(
      {
        "word/document.xml":
          "<w:document><w:body>" +
          "<w:p><w:r><w:t>Quarterly nautilus budget</w:t></w:r></w:p>" +
          "<w:p><w:r><w:t>Approved &amp; archived</w:t></w:r></w:p>" +
          "</w:body></w:document>",
        "word/media/image1.png": "not-really-an-image",
      },
      "budget.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const text = await extractText(file);
    expect(text).toContain("Quarterly nautilus budget");
    expect(text).toContain("Approved & archived");
    expect(text).not.toContain("not-really-an-image");
  });

  it("reads the cell strings out of a spreadsheet", async () => {
    const file = packed(
      {
        "xl/sharedStrings.xml":
          "<sst><si><t>Meridian totals</t></si><si><t>Harbor Way 200</t></si></sst>",
        "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
      },
      "totals.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const text = await extractText(file);
    expect(text).toContain("Meridian totals");
    expect(text).toContain("Harbor Way 200");
  });

  it("reads slide text out of a presentation", async () => {
    const file = packed(
      {
        "ppt/slides/slide1.xml":
          "<p:sld><p:txBody><a:p><a:r><a:t>Launch plan</a:t></a:r></a:p></p:txBody></p:sld>",
      },
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(await extractText(file)).toContain("Launch plan");
  });

  it("yields nothing for an office file with no words, rather than noise", async () => {
    const file = packed(
      { "word/document.xml": "<w:document><w:body></w:body></w:document>" },
      "empty.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(await extractText(file)).toBeUndefined();
  });

  it("still ignores formats it does not know", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.zip", { type: "application/zip" });
    expect(await extractText(file)).toBeUndefined();
  });
});
