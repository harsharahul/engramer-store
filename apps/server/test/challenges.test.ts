import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db.js";
import { consumeChallenge, issueChallenge } from "../src/challenges.js";

describe("auth challenges", () => {
  let dir: string;
  let db: Db;
  let uid: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engramer-challenges-"));
    db = openDatabase(join(dir, "challenges.db"));
    await db.run(
      "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES (?, ?, ?, ?)",
      "challenge@example.test",
      "digest",
      "{}",
      Date.now(),
    );
    const row = await db.get<{ id: number }>(
      "SELECT id FROM users WHERE email = ?",
      "challenge@example.test",
    );
    uid = Number(row?.id);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("consumes a valid challenge exactly once", async () => {
    const { id, secret } = await issueChallenge(db, uid, "reset", 60_000);
    expect(await consumeChallenge(db, id, secret, "reset")).toBe(uid);
    expect(await consumeChallenge(db, id, secret, "reset")).toBeNull();
  });

  it("refuses an expired challenge", async () => {
    const { id, secret } = await issueChallenge(db, uid, "reset", -1);
    expect(await consumeChallenge(db, id, secret, "reset")).toBeNull();
  });

  it("refuses a wrong secret without spending the challenge", async () => {
    const { id, secret } = await issueChallenge(db, uid, "reset", 60_000);
    expect(await consumeChallenge(db, id, "not-the-secret", "reset")).toBeNull();
    expect(await consumeChallenge(db, id, secret, "reset")).toBe(uid);
  });

  it("refuses a wrong kind without spending the challenge", async () => {
    const { id, secret } = await issueChallenge(db, uid, "recovery-proof", 60_000);
    expect(await consumeChallenge(db, id, secret, "reset")).toBeNull();
    expect(await consumeChallenge(db, id, secret, "recovery-proof")).toBe(uid);
  });

  it("stores no plaintext secret", async () => {
    const { id, secret } = await issueChallenge(db, uid, "reset", 60_000);
    const row = await db.get<{ secret_digest: string }>(
      "SELECT secret_digest FROM auth_challenges WHERE id = ?",
      id,
    );
    expect(row?.secret_digest).toBeTruthy();
    expect(row?.secret_digest).not.toBe(secret);
    expect(row?.secret_digest.includes(secret)).toBe(false);
  });

  it("lets concurrent consumers win exactly once", async () => {
    const { id, secret } = await issueChallenge(db, uid, "reset", 60_000);
    const results = await Promise.all([
      consumeChallenge(db, id, secret, "reset"),
      consumeChallenge(db, id, secret, "reset"),
      consumeChallenge(db, id, secret, "reset"),
    ]);
    expect(results.filter((r) => r === uid)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
  });
});
