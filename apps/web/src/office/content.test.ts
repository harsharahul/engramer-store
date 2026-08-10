import { describe, expect, it } from "vitest";
import { feedable, reconcile } from "./content";
import { acceptFrame, newChannelOrder, type ChannelFrame } from "./channel";

const frame = (n: number): ChannelFrame => ({ ch: "f1", s: "connA", n, k: "chg", d: {} });

describe("reconcile", () => {
  it("runs legacy against a server that names no marker", () => {
    expect(reconcile({ bytesGeneration: 3, marker: null, refetched: false })).toBe("legacy");
    expect(
      reconcile({ bytesGeneration: 3, marker: { generation: 0, seq: 0 }, refetched: false }),
    ).toBe("legacy");
  });

  it("is ready when the bytes match the marker's generation", () => {
    expect(
      reconcile({ bytesGeneration: 5, marker: { generation: 5, seq: 41 }, refetched: false }),
    ).toBe("ready");
  });

  it("asks for one refetch on a mismatch, then resyncs", () => {
    const stale = { bytesGeneration: 4, marker: { generation: 5, seq: 41 } };
    expect(reconcile({ ...stale, refetched: false })).toBe("refetch");
    expect(reconcile({ ...stale, refetched: true })).toBe("resync");
  });

  it("treats bytes without a named generation as unpaired when a marker exists", () => {
    const unpaired = { bytesGeneration: null, marker: { generation: 5, seq: 41 } };
    expect(reconcile({ ...unpaired, refetched: false })).toBe("refetch");
    expect(reconcile({ ...unpaired, refetched: true })).toBe("resync");
  });

  it("accepts a marker that moved backward, if the generation matches", () => {
    // A lagging saver's bytes really do contain less; pairing is identity,
    // never ordering.
    expect(
      reconcile({ bytesGeneration: 6, marker: { generation: 6, seq: 12 }, refetched: false }),
    ).toBe("ready");
  });
});

describe("feedable", () => {
  it("replays only what the stored bytes do not already contain", () => {
    const marker = { generation: 5, seq: 7 };
    for (let seq = 1; seq <= 7; seq += 1) {
      expect(feedable(seq, marker)).toBe(false);
    }
    expect(feedable(8, marker)).toBe(true);
    expect(feedable(9, marker)).toBe(true);
  });

  it("feeds everything when there is no marker", () => {
    expect(feedable(1, null)).toBe(true);
    expect(feedable(1, { generation: 0, seq: 0 })).toBe(true);
  });

  it("keeps the per-sender counters exact even for frames it does not feed", () => {
    // The order bookkeeping runs on EVERY frame; the marker only decides
    // what reaches the engine. A skipped frame must still advance its
    // sender's counter, or the first live frame after the replay would
    // read as a gap and force a pointless resync.
    const order = newChannelOrder("f1");
    const marker = { generation: 5, seq: 7 };
    const fed: number[] = [];
    for (let seq = 1; seq <= 10; seq += 1) {
      expect(acceptFrame(order, frame(seq), "connA")).toBe("apply");
      if (feedable(seq, marker)) {
        fed.push(seq);
      }
    }
    expect(fed).toEqual([8, 9, 10]);
    expect(acceptFrame(order, frame(11), "connA")).toBe("apply");
  });
});
