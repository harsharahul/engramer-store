import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Single-use secrets with a lifetime, for the flows where a bearer proves
 * one specific fact once: a recovery proof, a password reset, an emailed
 * account reset. Only a digest of the secret is stored, the same
 * discipline as login_key_digest, so a database read never hands out the
 * answer. Consumption is a conditional update: with many replicas racing,
 * exactly one wins.
 */

/** The flows a challenge can authorize; a row is only good for its own. */
export type ChallengeKind = "recovery-proof" | "reset" | "reset-pending-2fa" | "email-reset";

const digest = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** Stale rows are swept on a cadence rather than a schedule. */
let issuesSincePrune = 0;

export async function issueChallenge(
  db: Db,
  userId: number,
  kind: ChallengeKind,
  ttlMs: number,
): Promise<{ id: string; secret: string }> {
  issuesSincePrune += 1;
  if (issuesSincePrune >= 32) {
    issuesSincePrune = 0;
    await db.run("DELETE FROM auth_challenges WHERE expires_at < ?", Date.now() - 3_600_000);
  }
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await db.run(
    "INSERT INTO auth_challenges (id, user_id, kind, secret_digest, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    id,
    userId,
    kind,
    digest(secret),
    Date.now() + ttlMs,
    Date.now(),
  );
  return { id, secret };
}

/**
 * Spends the challenge and returns its user, or null: unknown id, wrong
 * kind, wrong secret, expired, or already spent. A wrong secret does not
 * spend the row, so a guesser cannot deny the real holder; the routes'
 * throttle is what bounds the guessing.
 */
export async function consumeChallenge(
  db: Db,
  id: string,
  secret: string,
  kind: ChallengeKind,
): Promise<number | null> {
  const row = await db.get<{ user_id: number; kind: string; secret_digest: string; expires_at: number }>(
    "SELECT user_id, kind, secret_digest, expires_at FROM auth_challenges WHERE id = ? AND used = 0",
    id,
  );
  if (!row || row.kind !== kind || row.expires_at < Date.now()) {
    return null;
  }
  const expected = Buffer.from(row.secret_digest, "hex");
  const offered = Buffer.from(digest(secret), "hex");
  if (expected.length !== offered.length || !timingSafeEqual(expected, offered)) {
    return null;
  }
  const spent = await db.run(
    "UPDATE auth_challenges SET used = 1 WHERE id = ? AND used = 0",
    id,
  );
  return spent.changes === 1 ? Number(row.user_id) : null;
}
