import { describe, expect, it } from "vitest";
import { electedSnapshotter, shouldAutoSnapshot } from "./snapshot";

describe("electedSnapshotter", () => {
  it("elects the lowest member index, identically for every client", () => {
    const members = [
      { connId: "c", index: 7 },
      { connId: "a", index: 2 },
      { connId: "b", index: 5 },
    ];
    expect(electedSnapshotter(members)).toBe("a");
  });

  it("elects nobody in an empty room", () => {
    expect(electedSnapshotter([])).toBeNull();
  });
});

describe("shouldAutoSnapshot", () => {
  it("never fires with nothing pending", () => {
    expect(shouldAutoSnapshot({ pendingFrames: 0, msSinceLastFrame: 60_000 })).toBe(false);
  });

  it("fires once enough frames pile up, regardless of quiet", () => {
    expect(shouldAutoSnapshot({ pendingFrames: 200, msSinceLastFrame: 0 })).toBe(true);
  });

  it("fires after a quiet spell with anything pending", () => {
    expect(shouldAutoSnapshot({ pendingFrames: 1, msSinceLastFrame: 30_000 })).toBe(true);
    expect(shouldAutoSnapshot({ pendingFrames: 1, msSinceLastFrame: 5_000 })).toBe(false);
  });
});
