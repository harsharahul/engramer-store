import { describe, expect, it } from "vitest";
import { SaveConflictError, copyName, describeConflict } from "./conflict";

describe("describeConflict", () => {
  it("is clean while the entry has not moved since open", () => {
    expect(describeConflict(1000, 1000)).toBe("clean");
  });

  it("is stale once someone else's save advanced the entry", () => {
    expect(describeConflict(1000, 1500)).toBe("stale");
  });

  it("stays clean when the local clock runs behind the open stamp", () => {
    // A refresh can rewrite updatedAt with a smaller server value after a
    // restore; only a strictly newer stamp means someone else saved.
    expect(describeConflict(1500, 1000)).toBe("clean");
  });
});

describe("copyName", () => {
  it("keeps the extension", () => {
    expect(copyName("report.docx")).toBe("report (your copy).docx");
  });

  it("handles names without an extension", () => {
    expect(copyName("notes")).toBe("notes (your copy)");
  });

  it("splits on the last dot only", () => {
    expect(copyName("q3.final.xlsx")).toBe("q3.final (your copy).xlsx");
  });
});

describe("SaveConflictError", () => {
  it("carries the file it happened to", () => {
    const err = new SaveConflictError("f1");
    expect(err.fileId).toBe("f1");
    expect(err).toBeInstanceOf(Error);
  });
});
