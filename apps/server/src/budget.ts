import type { S3Client } from "@aws-sdk/client-s3";

/**
 * Request budget for rate-limited backing stores. Consumer object stores and
 * S3 bridges commonly cap transactions per second or concurrent connections
 * and throttle hard past the limit; pacing requests below the cap is faster
 * than triggering the penalty box. Both knobs are opt-in and independent.
 */

/**
 * Paces callers to a fixed number of starts per second with no burst beyond
 * the immediate token (transfer tools converge on burst 1 against throttled
 * backends). Virtual scheduling keeps arrivals strictly FIFO: each take
 * claims the next free slot and sleeps until it arrives.
 */
export class TokenBucket {
  private next = 0;
  private readonly intervalMs: number;

  constructor(perSecond: number) {
    this.intervalMs = 1000 / perSecond;
  }

  async take(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.intervalMs;
    if (slot > now) {
      await new Promise((resolve) => setTimeout(resolve, slot - now));
    }
  }
}

/** Classic FIFO counting semaphore for capping in-flight operations. */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
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
      if (bucket) {
        await bucket.take();
      }
      if (semaphore) {
        await semaphore.acquire();
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
