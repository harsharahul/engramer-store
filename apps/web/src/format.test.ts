import { describe, expect, it } from "vitest";
import { fileKind } from "./format";

/**
 * What a file is decides whether it previews at all, so a kind that falls
 * through to "other" is a file the user is told cannot be shown. Uploads do
 * not always carry a usable content type: a browser can hand over an empty
 * one, and files arriving from a share sheet or a watched folder routinely
 * do, which is why every kind has to be recognisable by name as well.
 */
describe("fileKind", () => {
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  it("recognises a kind from its content type", () => {
    expect(fileKind("application/pdf", "statement")).toBe("pdf");
    expect(fileKind(DOCX, "report")).toBe("doc");
    expect(fileKind(XLSX, "budget")).toBe("sheet");
    expect(fileKind("image/jpeg", "holiday")).toBe("image");
    expect(fileKind("video/mp4", "clip")).toBe("video");
    expect(fileKind("audio/mpeg", "song")).toBe("audio");
    expect(fileKind("text/plain", "notes")).toBe("text");
  });

  it("recognises a kind from its name when the content type is missing", () => {
    expect(fileKind("", "statement.pdf")).toBe("pdf");
    expect(fileKind("", "report.docx")).toBe("doc");
    expect(fileKind("", "budget.xlsx")).toBe("sheet");
    expect(fileKind("", "notes.md")).toBe("text");
    expect(fileKind("", "backup.zip")).toBe("archive");
  });

  it("recognises a kind when the content type is wrong rather than absent", () => {
    // What a share sheet or a byte-stream upload tends to send.
    expect(fileKind("application/octet-stream", "StubHub tickets.pdf")).toBe("pdf");
    expect(fileKind("application/octet-stream", "report.docx")).toBe("doc");
  });

  it("is not fooled by an extension inside the name", () => {
    expect(fileKind("", "not-a-pdf.txt")).toBe("text");
    expect(fileKind("", "archive.zip.txt")).toBe("text");
  });

  it("falls back to other only when nothing identifies it", () => {
    expect(fileKind("", "mystery")).toBe("other");
    expect(fileKind("application/octet-stream", "blob")).toBe("other");
  });
});
