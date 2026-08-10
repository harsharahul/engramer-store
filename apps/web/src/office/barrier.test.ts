import { describe, expect, it } from "vitest";
import { barrierDelayMs, barrierVerdict, type BarrierState } from "./barrier";

const quiet: BarrierState = {
  haveChanges: false,
  haveOtherChanges: false,
  pendingAcks: 0,
  postsAtCapture: 4,
  postsNow: 4,
  ceilingReached: false,
  checkpoint: false,
  attempt: 0,
};

describe("barrierVerdict", () => {
  it("captures only when nothing is unsent, unapplied or unacked", () => {
    expect(barrierVerdict(quiet)).toBe("capture");
    expect(barrierVerdict({ ...quiet, haveChanges: true })).toBe("retry");
    expect(barrierVerdict({ ...quiet, haveOtherChanges: true })).toBe("retry");
    expect(barrierVerdict({ ...quiet, pendingAcks: 1 })).toBe("retry");
  });

  it("retries when a post landed between the capture and the check", () => {
    expect(barrierVerdict({ ...quiet, postsNow: 5 })).toBe("retry");
  });

  it("retries when the engine reports unsent work the app never saw", () => {
    // The keystroke case: nothing posted, nothing pending, but the engine
    // holds a change it has not yet turned into a batch.
    expect(barrierVerdict({ ...quiet, haveChanges: true, attempt: 3 })).toBe("retry");
  });

  it("proceeds without acks once the relay has refused posts", () => {
    // A refused frame exists nowhere but this engine; the export is the
    // only copy, so waiting for an ack that can never come helps nobody.
    expect(barrierVerdict({ ...quiet, pendingAcks: 2, ceilingReached: true })).toBe(
      "proceed-unlogged",
    );
  });

  it("still retries at the ceiling while the engine itself is moving", () => {
    expect(
      barrierVerdict({ ...quiet, haveChanges: true, pendingAcks: 2, ceilingReached: true }),
    ).toBe("retry");
  });

  it("lets a checkpoint through the hard ceiling once flushing had its chance", () => {
    // At the hard ceiling the relay refuses every post, so the engine's
    // save cycle can never complete and quiet is unreachable: the room
    // livelocks unless the one save that trims the log is allowed to
    // carry the engine's held changes in its bytes. Those changes have
    // no log positions, so nothing can ever replay them: the marker
    // stays exact.
    const wedged = {
      ...quiet,
      haveChanges: true,
      pendingAcks: 2,
      ceilingReached: true,
      checkpoint: true,
    };
    expect(barrierVerdict({ ...wedged, attempt: 0 })).toBe("retry");
    expect(barrierVerdict({ ...wedged, attempt: 1 })).toBe("retry");
    expect(barrierVerdict({ ...wedged, attempt: 2 })).toBe("proceed-unlogged");
    // A plain content save gets no such pass; only the trim unclogs.
    expect(barrierVerdict({ ...wedged, checkpoint: false, attempt: 5 })).toBe("abandon");
  });

  it("abandons after the budget rather than saving something inexact", () => {
    expect(barrierVerdict({ ...quiet, haveChanges: true, attempt: 5 })).toBe("abandon");
    expect(barrierVerdict({ ...quiet, pendingAcks: 1, attempt: 9 })).toBe("abandon");
    // A quiet engine captures no matter how late the attempt.
    expect(barrierVerdict({ ...quiet, attempt: 5 })).toBe("capture");
  });
});

describe("barrierDelayMs", () => {
  it("backs off and then holds its last delay", () => {
    expect(barrierDelayMs(0)).toBe(0);
    expect(barrierDelayMs(1)).toBe(120);
    expect(barrierDelayMs(2)).toBe(250);
    expect(barrierDelayMs(3)).toBe(400);
    expect(barrierDelayMs(4)).toBe(700);
    expect(barrierDelayMs(5)).toBe(1000);
    expect(barrierDelayMs(9)).toBe(1000);
  });
});
