import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trailingThrottle } from "./throttle";

describe("trailingThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first value immediately", () => {
    const sent: number[] = [];
    const t = trailingThrottle<number>(100, (v) => sent.push(v));
    t.push(1);
    expect(sent).toEqual([1]);
  });

  it("coalesces pushes inside the window to the latest value", () => {
    const sent: number[] = [];
    const t = trailingThrottle<number>(100, (v) => sent.push(v));
    t.push(1);
    t.push(2);
    t.push(3);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1, 3]);
  });

  it("sends immediately again after a quiet interval", () => {
    const sent: number[] = [];
    const t = trailingThrottle<number>(100, (v) => sent.push(v));
    t.push(1);
    vi.advanceTimersByTime(250);
    t.push(2);
    expect(sent).toEqual([1, 2]);
  });

  it("flush sends a pending value now", () => {
    const sent: number[] = [];
    const t = trailingThrottle<number>(100, (v) => sent.push(v));
    t.push(1);
    t.push(2);
    t.flush();
    expect(sent).toEqual([1, 2]);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([1, 2]);
  });

  it("cancel drops a pending value", () => {
    const sent: number[] = [];
    const t = trailingThrottle<number>(100, (v) => sent.push(v));
    t.push(1);
    t.push(2);
    t.cancel();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([1]);
  });
});
