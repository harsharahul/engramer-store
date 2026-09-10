import { describe, expect, it } from "vitest";
import {
  autoScrollStep,
  hitsInRect,
  marqueeSelection,
  rectFromPoints,
  type Rect,
} from "./marquee";

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({
  left,
  top,
  right,
  bottom,
});

describe("rectFromPoints", () => {
  it("normalizes a drag in any direction", () => {
    expect(rectFromPoints({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual(rect(10, 20, 50, 60));
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 50, y: 60 })).toEqual(rect(10, 20, 50, 60));
  });
});

describe("hitsInRect", () => {
  const cards = [
    { id: "a", rect: rect(0, 0, 100, 100) },
    { id: "b", rect: rect(120, 0, 220, 100) },
    { id: "c", rect: rect(0, 120, 100, 220) },
  ];

  it("selects every card the rectangle touches, partial overlap included", () => {
    expect(hitsInRect(cards, rect(90, 90, 130, 130))).toEqual(["a", "b", "c"]);
  });

  it("ignores cards the rectangle only borders on", () => {
    expect(hitsInRect(cards, rect(100, 100, 120, 120))).toEqual([]);
  });

  it("keeps the cards' own order", () => {
    expect(hitsInRect(cards, rect(0, 0, 300, 50))).toEqual(["a", "b"]);
  });
});

describe("marqueeSelection", () => {
  it("replaces the selection by default and extends it with a modifier", () => {
    const base = new Set(["x"]);
    expect([...marqueeSelection(base, ["a", "b"], false)]).toEqual(["a", "b"]);
    expect([...marqueeSelection(base, ["a", "b"], true)].sort()).toEqual(["a", "b", "x"]);
  });
});

describe("autoScrollStep", () => {
  it("is still away from the edges", () => {
    expect(autoScrollStep(200, 0, 400)).toBe(0);
  });

  it("scrolls faster the closer the pointer is to an edge, and past it", () => {
    const near = autoScrollStep(390, 0, 400);
    const nearer = autoScrollStep(398, 0, 400);
    const past = autoScrollStep(450, 0, 400);
    expect(near).toBeGreaterThan(0);
    expect(nearer).toBeGreaterThan(near);
    expect(past).toBeGreaterThanOrEqual(nearer);
    expect(autoScrollStep(5, 0, 400)).toBeLessThan(0);
  });
});
