import { ready } from "@engramer/crypto";
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, claims, register } from "./accounts.js";
import { Feed } from "./feed.js";
import { createFile, createFolder, syncFor, type Account } from "./storage.js";

/**
 * The change feed: a held stream of content-free pokes, each a promise
 * that a pull will find the change. The target runs with a fast heartbeat
 * so revocation is testable in milliseconds.
 */
let target: Target;
let alice: Account;
let bob: Account;

beforeAll(async () => {
  await ready();
  target = await startTarget({ eventsHeartbeatMs: 250 });
  alice = await register(target, "alice@example.com");
  bob = await register(target, "bob@example.com");
});

afterAll(async () => {
  await target?.close();
});

/** Writes to the target's own database, as an administrator would. */
function writeDirect(sql: string, ...params: unknown[]): void {
  const db = new Database(join(target.dataDir, "engramer.db"));
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe("the change feed", () => {
  it("requires a session", async () => {
    const response = await fetch(`${target.baseUrl}/api/events`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication required" });
  });

  it("is advertised on the account", async () => {
    const user = await target.inject({ method: "GET", url: "/api/user", headers: bearer(alice.token) });
    expect(user.json().events).toBe(true);
  });

  it("opens with the account's current sequence and stream headers", async () => {
    await createFolder(target, alice, "Seed");
    const feed = await new Feed().open(target.baseUrl, alice.token);
    expect(feed.status).toBe(200);
    expect(feed.headers["content-type"]).toBe("text/event-stream");
    expect(feed.headers["cache-control"]).toBe("no-store");
    expect(feed.headers["x-accel-buffering"]).toBe("no");
    const first = await feed.next();
    expect(first.seq).toBe((await syncFor(target, alice)).seq);
    feed.close();
  });

  it("asks a client to wait five seconds before reconnecting", async () => {
    const controller = new AbortController();
    const response = await fetch(`${target.baseUrl}/api/events`, {
      headers: bearer(alice.token),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toMatch(/^retry: 5000\ndata: \{"seq":\d+\}\n\n/);
    controller.abort();
  });

  it("pokes once a write commits, and the pull finds the row", async () => {
    const feed = await new Feed().open(target.baseUrl, alice.token);
    const before = (await feed.next()).seq;
    const file = await createFile(target, alice, "new.bin");
    const poked = await feed.nextAbove(before);
    expect(poked.seq).toBe(file.row.updateSeq);
    const delta = await syncFor(target, alice, before);
    expect(delta.files.map((f) => f.id)).toContain(file.id);
    feed.close();
  });

  it("pokes when settings change", async () => {
    const feed = await new Feed().open(target.baseUrl, alice.token);
    const before = (await feed.next()).seq;
    const put = await target.inject({
      method: "PUT",
      url: "/api/settings",
      headers: bearer(alice.token),
      payload: { blob: "sealed" },
    });
    expect(put.statusCode).toBe(200);
    expect((await feed.nextAbove(before)).seq).toBe((await syncFor(target, alice)).seq);
    feed.close();
  });

  it("pokes only the account whose data moved", async () => {
    const feed = await new Feed().open(target.baseUrl, bob.token);
    await feed.next();
    await feed.settle();
    await createFile(target, alice, "not-bobs.bin");
    expect(await feed.drain()).toEqual([]);
    feed.close();
  });

  it("coalesces a burst into few pokes that end on the final sequence", async () => {
    const feed = await new Feed().open(target.baseUrl, alice.token);
    await feed.next();
    await feed.settle();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        target.inject({ method: "PUT", url: "/api/settings", headers: bearer(alice.token), payload: { blob: `b${i}` } }),
      ),
    );
    const pokes = await feed.drain(500);
    expect(pokes.length).toBeGreaterThan(0);
    expect(pokes.length).toBeLessThan(10);
    expect(pokes.at(-1)!.seq).toBe((await syncFor(target, alice)).seq);
    feed.close();
  });

  it("stays silent when idle", async () => {
    const feed = await new Feed().open(target.baseUrl, alice.token);
    await feed.next();
    await feed.none();
    feed.close();
  });

  it("keeps the line warm with heartbeats", async () => {
    const feed = await new Feed().open(target.baseUrl, alice.token);
    await feed.next();
    await feed.heartbeat();
    feed.close();
  });

  it("caps streams per account, ending the oldest", async () => {
    const account = await register(target, "capped@example.com");
    const first = await new Feed().open(target.baseUrl, account.token);
    await first.next();
    const rest: Feed[] = [];
    for (let i = 0; i < 16; i++) {
      const feed = await new Feed().open(target.baseUrl, account.token);
      await feed.next();
      rest.push(feed);
    }
    await first.closedByServer();
    for (const feed of rest.slice(0, 15)) {
      expect(feed.status).toBe(200);
    }
    // The survivors still hear the account.
    const mark = (await syncFor(target, account)).seq;
    await createFile(target, account, "still-heard.bin");
    expect((await rest.at(-1)!.nextAbove(mark)).seq).toBeGreaterThan(mark);
    for (const feed of rest) {
      feed.close();
    }
  });

  it("frees a stream's place when its client goes away", async () => {
    const account = await register(target, "churn@example.com");
    for (let i = 0; i < 16; i++) {
      const feed = await new Feed().open(target.baseUrl, account.token);
      await feed.next();
      feed.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const kept = await new Feed().open(target.baseUrl, account.token);
    await kept.next();
    const more: Feed[] = [];
    for (let i = 0; i < 15; i++) {
      const feed = await new Feed().open(target.baseUrl, account.token);
      await feed.next();
      more.push(feed);
    }
    // Sixteen live streams: the first one is still open and still hears.
    const mark = (await syncFor(target, account)).seq;
    await createFile(target, account, "heard.bin");
    expect((await kept.nextAbove(mark)).seq).toBeGreaterThan(mark);
    kept.close();
    for (const feed of more) {
      feed.close();
    }
  });

  it("does not poke for a refused write", async () => {
    const feed = await new Feed().open(target.baseUrl, alice.token);
    await feed.next();
    await feed.settle();
    const refused = await target.inject({
      method: "POST",
      url: "/api/folders",
      headers: bearer(alice.token),
      payload: {
        parentId: "00000000-0000-4000-8000-000000000000",
        encryptedKey: { ciphertext: "c", nonce: "n" },
        encryptedMeta: { ciphertext: "c", nonce: "n" },
      },
    });
    expect(refused.statusCode).toBe(404);
    expect(await feed.drain()).toEqual([]);
    feed.close();
  });

  it("ends the stream when every session is signed out", async () => {
    const account = await register(target, "revoked@example.com");
    const feed = await new Feed().open(target.baseUrl, account.token);
    await feed.next();
    const revoked = await target.inject({
      method: "POST",
      url: "/api/auth/sessions/revoke-all",
      headers: bearer(account.token),
    });
    expect(revoked.statusCode).toBe(200);
    await feed.closedByServer();
    // The fresh token opens a new stream.
    const fresh = revoked.json().token as string;
    expect(claims(fresh).ep).toBe(1);
    const again = await new Feed().open(target.baseUrl, fresh);
    expect(again.status).toBe(200);
    again.close();
  });

  it("ends the stream when the account is disabled", async () => {
    const account = await register(target, "disabled@example.com");
    const feed = await new Feed().open(target.baseUrl, account.token);
    await feed.next();
    writeDirect("UPDATE users SET disabled = 1 WHERE email = ?", "disabled@example.com");
    await feed.closedByServer();
  });
});
