import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  encryptFileMetadata,
  utf8Encode,
} from "@engramer/crypto";
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

  describe("document channels across instances", () => {
    let token: string;
    let fileId: string;
    let baseA: string;
    let baseB: string;

    /** A socket on one instance, with the frames it received. */
    class Socket {
      readonly frames: Array<Record<string, unknown>> = [];
      closeCode: number | undefined;
      private readonly ws: WebSocket;
      /** Settles when the socket opens, however early that happens. */
      private readonly opened: Promise<void>;

      constructor(base: string, ticket: string) {
        this.ws = new WebSocket(`${base}/api/collab/${fileId}/channel?ticket=${ticket}`);
        this.ws.on("message", (data) => this.frames.push(JSON.parse(String(data)) as Record<string, unknown>));
        this.ws.on("close", (code) => (this.closeCode = code));
        this.opened = new Promise<void>((resolve, reject) => {
          this.ws.once("open", () => resolve());
          this.ws.once("error", reject);
          this.ws.once("close", (code) => reject(new Error(`socket closed before open: ${code}`)));
        });
        this.opened.catch(() => {});
      }

      async open(): Promise<void> {
        await this.opened;
        this.ws.send(JSON.stringify({ t: "hello", lastSeq: 0 }));
        await this.next((f) => f.t === "caught-up");
      }

      send(frame: Record<string, unknown>): void {
        this.ws.send(JSON.stringify(frame));
      }

      async next(match: (f: Record<string, unknown>) => boolean, ms = 4000): Promise<Record<string, unknown>> {
        const deadline = Date.now() + ms;
        for (;;) {
          const hit = this.frames.find(match);
          if (hit) {
            return hit;
          }
          if (Date.now() > deadline) {
            throw new Error(`no matching frame within ${ms}ms; saw ${this.frames.map((f) => f.t).join(",")}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      close(): void {
        this.ws.close();
      }
    }

    const ticket = async (app: FastifyInstance) => {
      const minted = await app.inject({
        method: "POST",
        url: `/api/collab/${fileId}/ticket`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      return minted.json().ticket as string;
    };

    beforeAll(async () => {
      await a.listen({ port: 0, host: "127.0.0.1" });
      await b.listen({ port: 0, host: "127.0.0.1" });
      const port = (app: FastifyInstance) => (app.server.address() as { port: number }).port;
      baseA = `ws://127.0.0.1:${port(a)}`;
      baseB = `ws://127.0.0.1:${port(b)}`;
      const keys = generateAccountKeys("fanout channel phrase");
      const registered = await a.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { email: "channels@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
      });
      token = registered.json().token as string;
      const fileKey = generateKey();
      const content = utf8Encode("channel body");
      const created = await a.inject({
        method: "POST",
        url: "/api/files",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          folderId: null,
          encryptedKey: secretBoxSeal(fileKey, keys.masterKey),
          encryptedMeta: encryptFileMetadata(
            { name: "doc.docx", mime: "application/octet-stream", size: content.length, mtime: 1 },
            fileKey,
          ),
        },
      });
      fileId = created.json().id as string;
      // The same token works on B: one database, one signing key.
      const uploaded = await b.inject({
        method: "PUT",
        url: `/api/files/${fileId}/data`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        payload: Buffer.from(encryptBytes(content, fileKey)),
      });
      expect(uploaded.statusCode).toBe(200);
    }, 30_000);

    it("delivers a post made on A to a socket on B, and cursors too", async () => {
      const onA = new Socket(baseA, await ticket(a));
      const onB = new Socket(baseB, await ticket(b));
      await onA.open();
      await onB.open();
      // Each instance lists both sockets as present, but broadcasts to its own.
      onA.send({ t: "who" });
      const who = (await onA.next((f) => f.t === "who")).local as string[];
      expect(who).toHaveLength(1);
      onA.send({ t: "post", ref: "r1", payload: "Y2lwaGVy" });
      const log = await onB.next((f) => f.t === "log");
      expect(log.payload).toBe("Y2lwaGVy");
      expect(onA.frames.filter((f) => f.t === "log")).toEqual([]);
      onA.send({ t: "eph", payload: "Y3Vyc29y" });
      expect((await onB.next((f) => f.t === "eph")).payload).toBe("Y3Vyc29y");
      // Joining on B refreshed A's members list from the shared table.
      const members = onA.frames.filter((f) => f.t === "members");
      expect(members.length).toBeGreaterThan(0);
      onA.close();
      onB.close();
    }, 20_000);

    it("delivers what B posted while A's listener was down once A is back", async () => {
      const onA = new Socket(baseA, await ticket(a));
      const onB = new Socket(baseB, await ticket(b));
      await onA.open();
      await onB.open();
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [
        `engram-listener-${a.podId}`,
      ]);
      await admin.end();
      // A local post on A in between must not let A skip B's frame.
      onB.send({ t: "post", ref: "b1", payload: "ZnJvbS1i" });
      await onB.next((f) => f.t === "ack");
      onA.send({ t: "post", ref: "a1", payload: "ZnJvbS1h" });
      await onA.next((f) => f.t === "ack");
      const fromB = await onA.next((f) => f.t === "log" && f.payload === "ZnJvbS1i", 10_000);
      expect(fromB.payload).toBe("ZnJvbS1i");
      onA.close();
      onB.close();
    }, 30_000);
  });
});
