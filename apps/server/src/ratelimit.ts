/**
 * In-memory failure throttle for authentication endpoints. After a burst of
 * failures the key (address plus claimed identity) must wait, with the wait
 * doubling per further failure up to a cap. Success clears the slate. State
 * is per-process, which matches the single-binary deployment model.
 */

const FREE_FAILURES = 5;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60_000;
const FORGET_AFTER_MS = 60 * 60_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  lastFailure: number;
}

export class AuthThrottle {
  private entries = new Map<string, Entry>();

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const entry = this.entries.get(key);
    if (!entry) {
      return { allowed: true, retryAfterMs: 0 };
    }
    if (now - entry.lastFailure > FORGET_AFTER_MS) {
      this.entries.delete(key);
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.blockedUntil > now) {
      return { allowed: false, retryAfterMs: entry.blockedUntil - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.entries.get(key) ?? { failures: 0, blockedUntil: 0, lastFailure: now };
    entry.failures += 1;
    entry.lastFailure = now;
    if (entry.failures > FREE_FAILURES) {
      const exponent = entry.failures - FREE_FAILURES - 1;
      entry.blockedUntil = now + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
    }
    this.entries.set(key, entry);
    // Bound the table; oldest entries are the least interesting.
    if (this.entries.size > 10_000) {
      const oldest = [...this.entries.entries()].sort(
        (a, b) => a[1].lastFailure - b[1].lastFailure,
      )[0];
      if (oldest) {
        this.entries.delete(oldest[0]);
      }
    }
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }
}
