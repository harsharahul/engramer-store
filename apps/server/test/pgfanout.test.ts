import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ready } from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { nextSeq } from "../src/db.js";
import { PostgresDb } from "../src/pgdb.js";

/**
 * Two server instances on one PostgreSQL database, the shape of a
 * replicated deployment. A change made through one must poke the
 * streams held by the other; a rolled-back change must poke nobody; and
 * the listener that carries the pokes must recover from losing its
 * session with a poke that names the current sequence, because the Mac
 * client drops any sequence at or below the last one it saw.
 */
const adminUrl = process.env.ENGRAMER_TEST_PG;

/** Collects the poke lines one stream receives. */
function sink(): { stream: Writable; seqs: number[]; next: (above: number, ms?: number) => Promise<number> } {
  const seqs: number[] = [];
  const waiters: Array<() => void> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const match = /"seq":(\d+)/.exec(String(chunk));
      if (match) {
        seqs.push(Number(match[1]));
        waiters.splice(0).forEach((wake) => wake());
      }
      callback();
    },
  });
  const next = async (above: number, ms = 3000): Promise<number> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = seqs.find((seq) => seq > above);
      if (hit !== undefined) {
        return hit;
      }
      if (Date.now() > deadline) {
        throw new Error(`no poke above ${above} within ${ms}ms (saw ${seqs.join(",")})`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  };
  return { stream, seqs, next };
}

describe.skipIf(!adminUrl)("two instances on one postgres", () => {
  const dbName = `engramer_fanout_${Date.now()}`;
  let url: string;
  let a: FastifyInstance;
  let b: FastifyInstance;
  let dataDir: string;
  let uid: number;

  beforeAll(async () => {
    await ready();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${dbName}`;
    url = parsed.toString();
    dataDir = mkdtempSync(join(tmpdir(), "engramer-fanout-"));
    const shared = { dataDir, webDistDir: null, databaseUrl: url, jwtSecret: "fanout-test-secret" };
    a = await buildApp(shared);
    b = await buildApp(shared);
    const row = await a.db.get<{ id: number }>(
      "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      "fanout@example.com",
      "digest",
      "{}",
      Date.now(),
    );
    uid = Number(row!.id);
  }, 60_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
    rmSync(dataDir, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it("gives each instance its own identity and a live bus", () => {
    expect(a.podId).not.toBe(b.podId);
    expect(a.bus.connected).toBe(true);
    expect(b.bus.connected).toBe(true);
  });

  it("pokes a stream on B for a change committed through A", async () => {
    const onB = sink();
    const unsubscribe = b.seqEvents.subscribe(uid, onB.stream);
    const seq = await a.db.tx((t) => nextSeq(t, uid));
    expect(await onB.next(seq - 1)).toBeGreaterThanOrEqual(seq);
    unsubscribe();
  });

  it("pokes nobody for a rolled-back change, and B only after the commit", async () => {
    const onB = sink();
    const unsubscribe = b.seqEvents.subscribe(uid, onB.stream);
    const before = (await a.db.get<{ last_seq: number }>("SELECT last_seq FROM users WHERE id = ?", uid))!
      .last_seq;
    await a.db
      .tx(async (t) => {
        await nextSeq(t, uid);
        throw new Error("abandon");
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(onB.seqs.filter((seq) => seq > Number(before))).toEqual([]);
    unsubscribe();
  });

  it("leaves a stream for another account quiet", async () => {
    const other = await a.db.get<{ id: number }>(
      "INSERT INTO users (email, login_key_digest, key_attributes, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      "quiet@example.com",
      "digest",
      "{}",
      Date.now(),
    );
    const onB = sink();
    const unsubscribe = b.seqEvents.subscribe(Number(other!.id), onB.stream);
    await a.db.tx((t) => nextSeq(t, uid));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(onB.seqs).toEqual([]);
    unsubscribe();
  });

  it("commits concurrent allocations from both instances in sequence order", async () => {
    const before = Number(
      (await a.db.get<{ last_seq: number }>("SELECT last_seq FROM users WHERE id = ?", uid))!.last_seq,
    );
    const seqs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).db.tx((t) => nextSeq(t, uid))),
    );
    expect(new Set(seqs).size).toBe(20);
    expect(Math.max(...seqs)).toBe(before + 20);
  });

  it("re-listens after its session is killed and pokes with the current sequence", async () => {
    const onB = sink();
    const unsubscribe = b.seqEvents.subscribe(uid, onB.stream);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const killed = await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [`engram-listener-${b.podId}`],
    );
    expect(killed.rowCount).toBe(1);
    // A change lands while B has no listener.
    const seq = await a.db.tx((t) => nextSeq(t, uid));
    // B comes back and its resync poke names the current sequence.
    expect(await onB.next(seq - 1, 8000)).toBeGreaterThanOrEqual(seq);
    await admin.end();
    unsubscribe();
  }, 15_000);

  it("runs two migrations at once, skips DDL nothing needs, and waits out a lock holder", async () => {
    const one = new PostgresDb(url);
    const two = new PostgresDb(url);
    const holder = new pg.Client({ connectionString: url });
    holder.on("error", () => {});
    try {
      await Promise.all([one.migrate(), two.migrate()]);
      // Nothing missing: a boot takes no table lock even while a long
      // transaction holds a table, so it never queues behind live traffic.
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE files IN ACCESS EXCLUSIVE MODE");
      const quick = Date.now();
      await one.migrate();
      expect(Date.now() - quick).toBeLessThan(2_000);
      await holder.query("COMMIT");
      // Something missing: the ALTER must wait for the holder; the lock
      // wait times out and the run is retried once the holder is gone.
      await holder.query("ALTER TABLE files DROP COLUMN index_size");
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE files IN ACCESS EXCLUSIVE MODE");
      const release = setTimeout(() => {
        holder.query("COMMIT").catch(() => {});
      }, 4_000);
      const started = Date.now();
      await one.migrate();
      clearTimeout(release);
      expect(Date.now() - started).toBeGreaterThan(3_000);
      const restored = await one.get<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'files' AND column_name = 'index_size'",
      );
      expect(restored).toBeDefined();
    } finally {
      await holder.end().catch(() => {});
      await one.close();
      await two.close();
    }
  }, 30_000);
});
