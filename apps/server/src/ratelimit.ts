import type { Db } from "./db.js";

/**
 * Failure throttle for authentication endpoints, backed by the metadata
 * database so every server replica sees the same counters: N pods must not
 * hand an attacker N times the failure budget. After a burst of failures the
 * key (address plus claimed identity) must wait, with the wait doubling per
 * further failure up to a cap. Success clears the slate.
 *
 * On embedded SQLite this behaves exactly like the previous in-process
 * throttle; the table is tiny and rows are pruned as they go stale.
 */

const FREE_FAILURES = 5;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60_000;
const FORGET_AFTER_MS = 60 * 60_000;

interface ThrottleRow {
  failures: number;
  blocked_until: number;
  last_failure: number;
}

export class AuthThrottle {
  constructor(private readonly db: Db) {}

  async check(key: string, now = Date.now()): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const row = await this.db.get<ThrottleRow>(
      "SELECT failures, blocked_until, last_failure FROM auth_throttle WHERE key = ?",
      key,
    );
    if (!row) {
      return { allowed: true, retryAfterMs: 0 };
    }
    if (now - row.last_failure > FORGET_AFTER_MS) {
      await this.db.run("DELETE FROM auth_throttle WHERE key = ?", key);
      return { allowed: true, retryAfterMs: 0 };
    }
    if (row.blocked_until > now) {
      return { allowed: false, retryAfterMs: row.blocked_until - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  async fail(key: string, now = Date.now()): Promise<void> {
    // Single-statement upsert so concurrent failures across replicas count
    // correctly; the block window is derived from the returned count.
    const row = await this.db.get<{ failures: number }>(
      `INSERT INTO auth_throttle (key, failures, blocked_until, last_failure)
       VALUES (?, 1, 0, ?)
       ON CONFLICT (key) DO UPDATE SET
         failures = auth_throttle.failures + 1,
         last_failure = ?
       RETURNING failures`,
      key,
      now,
      now,
    );
    const failures = row!.failures;
    if (failures > FREE_FAILURES) {
      const exponent = failures - FREE_FAILURES - 1;
      const blockedUntil = now + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
      await this.db.run(
        "UPDATE auth_throttle SET blocked_until = ? WHERE key = ?",
        blockedUntil,
        key,
      );
    }
    // Opportunistic prune keeps the table bounded without a scheduler.
    if (failures % 25 === 0) {
      await this.db.run("DELETE FROM auth_throttle WHERE last_failure < ?", now - FORGET_AFTER_MS);
    }
  }

  async succeed(key: string): Promise<void> {
    await this.db.run("DELETE FROM auth_throttle WHERE key = ?", key);
  }
}
