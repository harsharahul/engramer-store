import { describe, expect, it } from "vitest";
import { stepThrough, swipeStep } from "./neighbors";

/**
 * Opening a photo and being stuck on it is the complaint: a viewer with no
 * way forward makes people close it and reopen the next one. Stepping is
 * over whatever the current view is showing, in the order it is showing it,
 * so it matches what the person can see behind the viewer.
 */

const ids = ["a", "b", "c"];

describe("stepping through what the view is showing", () => {
  it("moves forward and back one at a time", () => {
    expect(stepThrough(ids, "a", 1)).toBe("b");
    expect(stepThrough(ids, "b", 1)).toBe("c");
    expect(stepThrough(ids, "c", -1)).toBe("b");
  });

  it("stops at the ends rather than looping round", () => {
    // Wrapping makes a long folder feel endless and hides that you are done.
    expect(stepThrough(ids, "c", 1)).toBeNull();
    expect(stepThrough(ids, "a", -1)).toBeNull();
  });

  it("is a no-op when the open file is not in the list", () => {
    // A file can leave the view while open: trashed, renamed out of a search.
    expect(stepThrough(ids, "gone", 1)).toBeNull();
    expect(stepThrough([], "a", 1)).toBeNull();
  });

  it("does not move when the list holds only the open file", () => {
    expect(stepThrough(["only"], "only", 1)).toBeNull();
    expect(stepThrough(["only"], "only", -1)).toBeNull();
  });
});

/**
 * A swipe and a scroll start identically. Reading a long PDF drags a thumb
 * up the screen and drifts sideways doing it, so a sideways component alone
 * must not page away from what someone is reading.
 */
describe("reading a swipe", () => {
  it("pages forward on a clear leftward drag, and back on a rightward one", () => {
    expect(swipeStep(-120, 10)).toBe(1);
    expect(swipeStep(120, -10)).toBe(-1);
  });

  it("ignores a drag that is mostly vertical", () => {
    // Scrolling a document: sideways drift must not count.
    expect(swipeStep(-80, 90)).toBeNull();
    expect(swipeStep(70, -200)).toBeNull();
  });

  it("ignores a short drag, which is a tap that moved", () => {
    expect(swipeStep(-30, 2)).toBeNull();
    expect(swipeStep(0, 0)).toBeNull();
  });
});
