import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContinuationPool, type PoolSession } from "./swpool";

interface FakeSession extends PoolSession {
  id: string;
  dropped: boolean;
}

function session(id: string, nextChunk: number, ringIndexes: number[] = []): FakeSession {
  return {
    id,
    nextChunk,
    ring: ringIndexes.map((index) => ({ index, plain: new Uint8Array(0) })),
    dropped: false,
  };
}

describe("ContinuationPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () => new ContinuationPool<FakeSession>(3, 20_000, 4, (s) => (s.dropped = true));

  it("claims an exact positional match and removes it", () => {
    const pool = make();
    const a = session("a", 10);
    pool.park("file", a);
    expect(pool.claim("file", 10)).toBe(a);
    expect(pool.claim("file", 10)).toBeNull();
  });

  it("matches a request re-entering any ring-held chunk", () => {
    const pool = make();
    const a = session("a", 13, [10, 11, 12]);
    pool.park("file", a);
    expect(pool.claim("file", 10)).toBe(a);
  });

  it("offers a session a short skip ahead, preferring the smallest gap", () => {
    const pool = make();
    const far = session("far", 6);
    const near = session("near", 9);
    pool.park("file", far);
    pool.park("file", near);
    expect(pool.claim("file", 10)).toBe(near);
  });

  it("prefers exact over ring over skip", () => {
    const pool = make();
    const skip = session("skip", 8);
    const ring = session("ring", 12, [10, 11]);
    const exact = session("exact", 10);
    pool.park("file", skip);
    pool.park("file", ring);
    pool.park("file", exact);
    expect(pool.claim("file", 10)).toBe(exact);
    expect(pool.claim("file", 10)).toBe(ring);
    expect(pool.claim("file", 10)).toBe(skip);
  });

  it("prefers the shallower ring re-entry", () => {
    const pool = make();
    const deep = session("deep", 13, [10, 11, 12]);
    const shallow = session("shallow", 11, [10]);
    pool.park("file", deep);
    pool.park("file", shallow);
    expect(pool.claim("file", 10)).toBe(shallow);
  });

  it("never crosses files and ignores backward or far-forward positions", () => {
    const pool = make();
    pool.park("other", session("other", 10));
    pool.park("file", session("behind", 20));
    pool.park("file", session("far", 2));
    expect(pool.claim("file", 10)).toBeNull();
  });

  it("keeps sessions for two cursors of the same file at once", () => {
    const pool = make();
    const playhead = session("playhead", 5);
    const tail = session("tail", 250);
    pool.park("file", playhead);
    pool.park("file", tail);
    expect(pool.claim("file", 250)).toBe(tail);
    expect(pool.claim("file", 5)).toBe(playhead);
  });

  it("drops the oldest session past capacity", () => {
    const pool = make();
    const oldest = session("s0", 0);
    pool.park("file", oldest);
    for (let i = 1; i <= 3; i++) {
      pool.park("file", session(`s${i}`, i * 100));
    }
    expect(oldest.dropped).toBe(true);
    expect(pool.claim("file", 0)).toBeNull();
  });

  it("drops a session when its parking TTL expires", () => {
    const pool = make();
    const a = session("a", 10);
    pool.park("file", a);
    vi.advanceTimersByTime(20_001);
    expect(a.dropped).toBe(true);
    expect(pool.claim("file", 10)).toBeNull();
  });

  it("parking the same session twice keeps a single entry", () => {
    const pool = make();
    const a = session("a", 10);
    pool.park("file", a);
    pool.park("file", a);
    expect(pool.claim("file", 10)).toBe(a);
    expect(pool.claim("file", 10)).toBeNull();
    expect(a.dropped).toBe(false);
  });

  it("a re-parked session's TTL restarts instead of doubling", () => {
    const pool = make();
    const a = session("a", 10);
    pool.park("file", a);
    vi.advanceTimersByTime(15_000);
    pool.park("file", a);
    vi.advanceTimersByTime(15_000);
    expect(a.dropped).toBe(false);
    vi.advanceTimersByTime(5_001);
    expect(a.dropped).toBe(true);
  });

  it("a claimed session no longer expires by timer", () => {
    const pool = make();
    const a = session("a", 10);
    pool.park("file", a);
    expect(pool.claim("file", 10)).toBe(a);
    vi.advanceTimersByTime(60_000);
    expect(a.dropped).toBe(false);
  });
});
