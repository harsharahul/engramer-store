import { describe, expect, it } from "vitest";
import { isGathering, nextSelection, type SelectionState } from "./selection";

const order = ["a", "b", "c", "d", "e"];
const state = (ids: string[], anchor: string | null = null): SelectionState => ({
  selection: new Set(ids),
  anchor,
});
const ids = (s: SelectionState) => [...s.selection].sort();
const mods = (over: Partial<{ meta: boolean; shift: boolean; gathering: boolean }> = {}) => ({
  meta: false,
  shift: false,
  gathering: false,
  ...over,
});

describe("nextSelection outside gathering (Finder rules)", () => {
  it("a plain click selects only that item and moves the anchor", () => {
    const next = nextSelection(state(["a", "b", "c"], "a"), "d", order, mods());
    expect(ids(next)).toEqual(["d"]);
    expect(next.anchor).toBe("d");
  });

  it("a plain click on an already selected item in a multi-selection keeps only it", () => {
    const next = nextSelection(state(["a", "b", "c"], "a"), "b", order, mods());
    expect(ids(next)).toEqual(["b"]);
  });

  it("cmd-click toggles one item and keeps the rest", () => {
    const added = nextSelection(state(["a"], "a"), "c", order, mods({ meta: true }));
    expect(ids(added)).toEqual(["a", "c"]);
    const removed = nextSelection(added, "a", order, mods({ meta: true }));
    expect(ids(removed)).toEqual(["c"]);
    expect(removed.anchor).toBe("a");
  });

  it("shift-click selects the range from the anchor, in either direction", () => {
    const down = nextSelection(state(["b"], "b"), "d", order, mods({ shift: true }));
    expect(ids(down)).toEqual(["b", "c", "d"]);
    expect(down.anchor).toBe("b");
    const up = nextSelection(state(["d"], "d"), "a", order, mods({ shift: true }));
    expect(ids(up)).toEqual(["a", "b", "c", "d"]);
  });

  it("shift-click without an anchor behaves like a plain click", () => {
    const next = nextSelection(state([], null), "c", order, mods({ shift: true }));
    expect(ids(next)).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });

  it("shift-click whose anchor left the visible order falls back to a plain click", () => {
    const next = nextSelection(state(["z"], "z"), "c", order, mods({ shift: true }));
    expect(ids(next)).toEqual(["c"]);
  });
});

describe("nextSelection while gathering (bulk bar visible)", () => {
  it("a plain click toggles membership", () => {
    const all = state(order, "a");
    const fewer = nextSelection(all, "c", order, mods({ gathering: true }));
    expect(ids(fewer)).toEqual(["a", "b", "d", "e"]);
    const back = nextSelection(fewer, "c", order, mods({ gathering: true }));
    expect(ids(back)).toEqual(order);
    expect(back.anchor).toBe("c");
  });

  it("cmd-click still toggles", () => {
    const next = nextSelection(state(["a", "b"], "a"), "b", order, mods({ gathering: true, meta: true }));
    expect(ids(next)).toEqual(["a"]);
  });

  it("shift-click adds the range to what is already gathered", () => {
    const next = nextSelection(state(["a", "e"], "a"), "c", order, mods({ gathering: true, shift: true }));
    expect(ids(next)).toEqual(["a", "b", "c", "e"]);
  });
});

describe("isGathering", () => {
  it("is the bulk bar's own condition: explicit mode or more than one item", () => {
    expect(isGathering(false, 0)).toBe(false);
    expect(isGathering(false, 1)).toBe(false);
    expect(isGathering(false, 2)).toBe(true);
    expect(isGathering(true, 0)).toBe(true);
  });
});
