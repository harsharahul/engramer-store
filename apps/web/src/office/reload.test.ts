import { describe, expect, it } from "vitest";
import { describeStartupStall, editorFrameKey } from "./reload";

describe("editorFrameKey", () => {
  it("changes when the resync nonce changes", () => {
    expect(editorFrameKey("f1", "docx", 0)).not.toBe(editorFrameKey("f1", "docx", 1));
  });

  it("changes with the document and its type", () => {
    expect(editorFrameKey("f1", "docx", 0)).not.toBe(editorFrameKey("f2", "docx", 0));
    expect(editorFrameKey("f1", "docx", 0)).not.toBe(editorFrameKey("f1", "xlsx", 0));
  });

  it("is stable for the same attempt", () => {
    expect(editorFrameKey("f1", "docx", 2)).toBe(editorFrameKey("f1", "docx", 2));
  });
});

describe("describeStartupStall", () => {
  it("is no stall once the editor announced", () => {
    expect(describeStartupStall({ announced: true, originAlive: true })).toBe("none");
    expect(describeStartupStall({ announced: true, originAlive: false })).toBe("none");
  });

  it("names a refused frame when the origin is plainly reachable", () => {
    expect(describeStartupStall({ announced: false, originAlive: true })).toBe("blocked");
  });

  it("stays patient when the network itself is struggling", () => {
    expect(describeStartupStall({ announced: false, originAlive: false })).toBe("slow");
  });
});
