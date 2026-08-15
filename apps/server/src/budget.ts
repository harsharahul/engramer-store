import { AsyncLocalStorage } from "node:async_hooks";
import type { S3Client } from "@aws-sdk/client-s3";

/**
 * Request budget for rate-limited backing stores. Consumer object stores and
 * S3 bridges commonly cap transactions per second or concurrent connections
 * and throttle hard past the limit; pacing requests below the cap is faster
 * than triggering the penalty box. Both knobs are opt-in and independent.
 *
 * The budget has two lanes. Interactive work is whatever a request handler
 * is waiting on; background work (bookend copies, window fills, heals) only
 * ever spends budget no interactive caller wants right now. Without the
 * split, one warming sweep against a rate-limited provider queues ahead of
 * every grid scroll and playback start behind it.
 */

export type Lane = "interactive" | "background";

const laneContext = new AsyncLocalStorage<Lane>();

/** Runs work in the background lane; the lane follows the async context,
 * so everything awaited inside pays budget at background priority. */
export function inBackground<T>(fn: () => Promise<T>): Promise<T> {
  return laneContext.run("background", fn);
}

export function currentLane(): Lane {
  return laneContext.getStore() ?? "interactive";
}

/**
 * Paces callers to a fixed number of starts per second with no burst beyond
 * the immediate token (transfer tools converge on burst 1 against throttled
 * backends). Grants are strictly FIFO within a lane; the interactive lane
 * drains first, so an interactive arrival overtakes any amount of queued
 * background work, at most one slot interval away.
 */
export class TokenBucket {
  private next = 0;
  private readonly intervalMs: number;
  private readonly lanes: Record<Lane, Array<() => void>> = {
    interactive: [],
    background: [],
  };
  private pumping = false;

  constructor(perSecond: number) {
    this.intervalMs = 1000 / perSecond;
  }

  take(lane: Lane = "interactive"): Promise<void> {
    const granted = new Promise<void>((resolve) => this.lanes[lane].push(resolve));
    void this.pump();
    return granted;
  }

  /** Sleeps out each slot and hands it to the head of the busiest-priority
   * queue at grant time, which is what lets late interactive arrivals win. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.lanes.interactive.length > 0 || this.lanes.background.length > 0) {
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + this.intervalMs;
        if (slot > now) {
          await new Promise((resolve) => setTimeout(resolve, slot - now));
        }
        (this.lanes.interactive.shift() ?? this.lanes.background.shift())?.();
      }
    } finally {
      this.pumping = false;
    }
  }
}

/** FIFO counting semaphore for capping in-flight operations; freed slots
 * go to interactive waiters before any background ones. */
export class Semaphore {
  private inFlight = 0;
  private readonly lanes: Record<Lane, Array<() => void>> = {
    interactive: [],
    background: [],
  };

  constructor(private readonly max: number) {}

  async acquire(lane: Lane = "interactive"): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.lanes[lane].push(resolve));
    this.inFlight++;
  }

  release(): void {
    this.inFlight--;
    (this.lanes.interactive.shift() ?? this.lanes.background.shift())?.();
  }
}

export interface BudgetOptions {
  /** Maximum request starts per second toward the backing store. */
  maxTps?: number;
  /** Maximum in-flight requests toward the backing store. */
  maxConcurrent?: number;
}

/**
 * Installs the budget as S3 client middleware so every HTTP attempt pays it:
 * plain commands, each part of a multipart upload, and SDK retries alike.
 * Wrapping only the store's public methods would let one large upload fan
 * out into an unbounded number of part requests underneath the cap.
 */
export function attachBudget(client: S3Client, options: BudgetOptions): void {
  const bucket = options.maxTps && options.maxTps > 0 ? new TokenBucket(options.maxTps) : null;
  const semaphore =
    options.maxConcurrent && options.maxConcurrent > 0 ? new Semaphore(options.maxConcurrent) : null;
  if (!bucket && !semaphore) {
    return;
  }
  client.middlewareStack.add(
    (next) => async (args) => {
      // The lane rides the async context from whoever started the work,
      // so background fills pay background priority all the way down to
      // the HTTP attempt, retries included.
      const lane = currentLane();
      if (bucket) {
        await bucket.take(lane);
      }
      if (semaphore) {
        await semaphore.acquire(lane);
      }
      try {
        return await next(args);
      } finally {
        semaphore?.release();
      }
    },
    { step: "finalizeRequest", name: "engramerRequestBudget", priority: "low" },
  );
}
