import { describe, expect, it } from "vitest";
import { electedSnapshotter, shouldContentSave } from "./snapshot";

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

  it("never elects a viewer, even at the lowest index", () => {
    const members = [
      { connId: "v", index: 1, role: "viewer" },
      { connId: "e", index: 4, role: "editor" },
      { connId: "o", index: 9, role: "owner" },
    ];
    expect(electedSnapshotter(members)).toBe("e");
  });

  it("elects nobody in a room of viewers", () => {
    expect(
      electedSnapshotter([
        { connId: "v1", index: 1, role: "viewer" },
        { connId: "v2", index: 2, role: "viewer" },
      ]),
    ).toBeNull();
  });

  it("treats a member with no stated role as electable", () => {
    // An older server names no roles; degrading to the old election is
    // strictly better than a room where nobody ever snapshots.
    expect(
      electedSnapshotter([
        { connId: "x", index: 3 },
        { connId: "v", index: 1, role: "viewer" },
      ]),
    ).toBe("x");
  });
});

describe("shouldContentSave", () => {
  it("never fires with nothing pending", () => {
    expect(shouldContentSave({ pendingFrames: 0, msSinceLastFrame: 60_000 })).toBe(false);
  });

  it("fires after a quiet spell with anything pending", () => {
    expect(shouldContentSave({ pendingFrames: 1, msSinceLastFrame: 30_000 })).toBe(true);
    expect(shouldContentSave({ pendingFrames: 1, msSinceLastFrame: 5_000 })).toBe(false);
  });

  it("never fires on frame count alone; the byte ceiling owns the trim", () => {
    expect(shouldContentSave({ pendingFrames: 10_000, msSinceLastFrame: 0 })).toBe(false);
  });
});
