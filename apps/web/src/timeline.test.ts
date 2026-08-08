import { describe, expect, it } from "vitest";
import { byMonth, monthKey } from "./timeline";

const at = (iso: string) => new Date(iso).getTime();

describe("byMonth", () => {
  it("sections in reverse chronology with files newest first inside each", () => {
    const files = [
      { id: "a", mtime: at("2026-07-02T10:00:00Z") },
      { id: "b", mtime: at("2026-08-05T10:00:00Z") },
      { id: "c", mtime: at("2026-08-01T10:00:00Z") },
      { id: "d", mtime: at("2025-12-31T10:00:00Z") },
    ];
    const sections = byMonth(files);
    expect(sections.map((s) => s.key)).toEqual(["2026-08", "2026-07", "2025-12"]);
    expect(sections[0]!.files.map((f) => f.id)).toEqual(["b", "c"]);
    expect(sections[0]!.label).toMatch(/2026/);
  });

  it("handles an empty list", () => {
    expect(byMonth([])).toEqual([]);
  });

  it("pads month keys", () => {
    expect(monthKey(at("2026-03-05T00:00:00"))).toBe("2026-03");
  });
});
