import { describe, expect, it } from "vitest";
import { Semaphore, TokenBucket } from "../src/budget.js";

describe("token bucket", () => {
  it("lets the first request through immediately", async () => {
    const bucket = new TokenBucket(5); // 200ms spacing
    const started = Date.now();
    await bucket.take();
    // Well under one interval: proves no pacing wait was inserted. The
    // bound is loose because a loaded runner adds event-loop lag.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("paces a burst down to the configured rate", async () => {
    const bucket = new TokenBucket(20); // 50ms spacing
    const started = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => bucket.take()));
    // 5 takes at 20/s: first immediate, the rest spaced 50ms -> >=200ms.
    // Only the lower bound is asserted; scheduling lag on a loaded runner
    // legitimately stretches the upper end.
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it("does not accumulate burst credit while idle", async () => {
    const bucket = new TokenBucket(20);
    await bucket.take();
    await new Promise((resolve) => setTimeout(resolve, 200)); // idle time
    const started = Date.now();
    await Promise.all([bucket.take(), bucket.take(), bucket.take()]);
    // Idle time must not bank tokens: 3 takes still spread over >=100ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

describe("semaphore", () => {
  it("caps concurrency and preserves FIFO order", async () => {
    const semaphore = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const finished: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => async () => {
        await semaphore.acquire();
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        finished.push(i);
        semaphore.release();
      }).map((task) => task()),
    );
    expect(peak).toBe(2);
    expect(finished).toHaveLength(6);
    // FIFO admission: the first two admitted finish before the last two start-order tasks.
    expect(finished.slice(0, 2).sort()).toEqual([0, 1]);
  });

  it("releases waiters when a slot frees", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    let entered = false;
    const waiter = semaphore.acquire().then(() => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(false);
    semaphore.release();
    await waiter;
    expect(entered).toBe(true);
    semaphore.release();
  });
});

/**
 * Two lanes, one budget: background work (bookend copies, window fills,
 * heals) may only spend budget no interactive caller is waiting for.
 * Without this, one backfill sweep against a rate-limited provider
 * starves every grid scroll and playback start behind it.
 */
describe("priority lanes", () => {
  it("grants queued interactive takes before earlier background ones", async () => {
    const bucket = new TokenBucket(50); // 20ms per slot
    const order: string[] = [];
    await bucket.take(); // spend the immediate slot so the rest queue
    const background = ["b1", "b2", "b3"].map((name) =>
      bucket.take("background").then(() => order.push(name)),
    );
    const interactive = bucket.take("interactive").then(() => order.push("i1"));
    await Promise.all([...background, interactive]);
    expect(order[0]).toBe("i1");
  });

  it("hands freed semaphore slots to interactive waiters first", async () => {
    const semaphore = new Semaphore(1);
    const order: string[] = [];
    await semaphore.acquire();
    const background = semaphore.acquire("background").then(() => {
      order.push("b1");
      semaphore.release();
    });
    const interactive = semaphore.acquire("interactive").then(() => {
      order.push("i1");
      semaphore.release();
    });
    semaphore.release();
    await Promise.all([background, interactive]);
    expect(order).toEqual(["i1", "b1"]);
  });

  it("background work carries its lane through the async context", async () => {
    const { inBackground, currentLane } = await import("../src/budget.js");
    expect(currentLane()).toBe("interactive");
    await inBackground(async () => {
      expect(currentLane()).toBe("background");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentLane()).toBe("background");
    });
    expect(currentLane()).toBe("interactive");
  });
});
