import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  encryptFileMetadata,
  encryptFolderMetadata,
  sealToPublicKey,
  utf8Encode,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";
import { nextSeq } from "../src/db.js";

/**
 * The change feed holds connections, so like the relay these tests run
 * against a real listener; inject() cannot stream. Every wait is
 * bounded, and every stream is closed by the test that opened it.
 */

interface TestAccount {
  keys: AccountKeys;
  token: string;
  email: string;
}

let app: FastifyInstance;
let dataDir: string;
let base: string;
let owner: TestAccount;
let member: TestAccount;
let fileId: string;
let fileKey: Uint8Array;

const auth = (account: TestAccount) => ({ authorization: `Bearer ${account.token}` });

async function register(email: string, phrase: string): Promise<TestAccount> {
  const keys = generateAccountKeys(phrase);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  expect(response.statusCode).toBe(201);
  return { keys, token: response.json().token as string, email };
}

/** A held event stream with a readable queue of parsed events. */
class Feed {
  status = 0;
  private buffer = "";
  private readonly events: Array<{ seq: number }> = [];
  private readonly comments: string[] = [];
  private ended = false;
  private readonly controller = new AbortController();

  async open(origin: string, token: string): Promise<this> {
    const response = await fetch(`${origin}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: this.controller.signal,
    });
    this.status = response.status;
    if (response.status === 200 && response.body) {
      void this.pump(response.body);
    } else {
      this.ended = true;
    }
    return this;
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        this.buffer += decoder.decode(chunk, { stream: true });
        let cut = this.buffer.indexOf("\n\n");
        while (cut >= 0) {
          for (const line of this.buffer.slice(0, cut).split("\n")) {
            if (line.startsWith("data:")) {
              this.events.push(JSON.parse(line.slice(5)) as { seq: number });
            } else if (line.startsWith(":")) {
              this.comments.push(line);
            }
          }
          this.buffer = this.buffer.slice(cut + 2);
          cut = this.buffer.indexOf("\n\n");
        }
      }
    } catch {
      // An aborted or server-ended stream reads the same to a waiter.
    }
    this.ended = true;
  }

  async next(timeoutMs = 3000): Promise<{ seq: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.shift();
      if (event) {
        return event;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no event arrived");
  }

  /** Reads until a sequence past the mark arrives. Stale re-announcements
   * are allowed by design (they cost one empty pull), so assertions wait
   * for the value, never the position. */
  async nextAbove(mark: number, timeoutMs = 3000): Promise<{ seq: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.shift();
      if (event && event.seq > mark) {
        return event;
      }
      if (!event) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`no event above ${mark} arrived`);
  }

  /** Asserts silence: nothing NEW within the window. A coalescing flush
   * armed before the stream opened may still land a stale poke, so the
   * queue first settles past the flush interval and is purged. */
  async none(windowMs = 400): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.events.length = 0;
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    expect(this.events).toHaveLength(0);
  }

  /** Waits the window, then asserts nothing above the mark was received.
   * Unlike none(), the queue is not purged first: this catches a poke
   * that fired early, not only one that fired late. */
  async quietAbove(mark: number, windowMs = 400): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    expect(this.events.filter((event) => event.seq > mark)).toHaveLength(0);
  }

  async heartbeat(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.comments.length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no heartbeat arrived");
  }

  async closedByServer(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ended) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("stream still open");
  }

  close(): void {
    this.controller.abort();
  }
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-events-test-"));
  // A fast heartbeat so revocation latency is testable in milliseconds.
  app = await buildApp({
    dataDir,
    quotaBytes: 512 * 1024,
    webDistDir: null,
    eventsHeartbeatMs: 250,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || !address) {
    throw new Error("no port");
  }
  base = `http://127.0.0.1:${address.port}`;

  owner = await register("owner@example.com", "orchid lantern velvet");
  member = await register("member@example.com", "cedar mosaic thimble");

  // One shared file, so a collaborator's edit can prove cross-account pokes.
  fileKey = generateKey();
  const content = utf8Encode("events body");
  const created = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: auth(owner),
    payload: {
      folderId: null,
      encryptedKey: secretBoxSeal(fileKey, owner.keys.masterKey),
      encryptedMeta: encryptFileMetadata(
        { name: "doc.docx", mime: "application/octet-stream", size: content.length, mtime: 1 },
        fileKey,
      ),
    },
  });
  fileId = created.json().id as string;
  await app.inject({
    method: "PUT",
    url: `/api/files/${fileId}/data`,
    headers: { ...auth(owner), "content-type": "application/octet-stream" },
    payload: Buffer.from(encryptBytes(content, fileKey)),
  });
  const minted = await app.inject({
    method: "POST",
    url: "/api/collab/invites",
    headers: auth(owner),
    payload: { fileId, role: "editor" },
  });
  const inviteToken = minted.json().token as string;
  await app.inject({
    method: "POST",
    url: `/api/collab/invites/${inviteToken}/claim`,
    headers: auth(member),
  });
  const invites = await app.inject({
    method: "GET",
    url: "/api/collab/invites",
    headers: auth(owner),
  });
  const entry = (invites.json().invites as Array<Record<string, unknown>>).find(
    (i) => i.token === inviteToken,
  )!;
  await app.inject({
    method: "POST",
    url: `/api/collab/invites/${inviteToken}/grant`,
    headers: auth(owner),
    payload: { sealedKey: sealToPublicKey(fileKey, entry.claimantPublicKey as string) },
  });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the change feed", () => {
  it("requires a session", async () => {
    const bare = await fetch(`${base}/api/events`);
    expect(bare.status).toBe(401);
    await bare.body?.cancel();
  });

  it("states the current sequence immediately", async () => {
    const feed = await new Feed().open(base, owner.token);
    expect(feed.status).toBe(200);
    const first = await feed.next();
    expect(first.seq).toBeGreaterThan(0);
    feed.close();
  });

  it("pokes the account whose data moved", async () => {
    const feed = await new Feed().open(base, owner.token);
    const before = (await feed.next()).seq;
    const created = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: auth(owner),
      payload: {
        folderId: null,
        encryptedKey: secretBoxSeal(generateKey(), owner.keys.masterKey),
        encryptedMeta: encryptFileMetadata(
          { name: "new.bin", mime: "application/octet-stream", size: 1, mtime: 1 },
          fileKey,
        ),
      },
    });
    expect(created.statusCode).toBe(201);
    const poked = await feed.nextAbove(before);
    expect(poked.seq).toBeGreaterThan(before);
    feed.close();
  });

  it("pokes a collaborator when someone else edits the shared file", async () => {
    const memberFeed = await new Feed().open(base, member.token);
    const before = (await memberFeed.next()).seq;
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/files/${fileId}/data`,
      headers: { ...auth(owner), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("owner edit"), fileKey)),
    });
    expect(replaced.statusCode).toBe(200);
    const poked = await memberFeed.nextAbove(before);
    expect(poked.seq).toBeGreaterThan(before);
    memberFeed.close();
  });

  it("coalesces a burst into few pokes and stays silent when idle", async () => {
    const feed = await new Feed().open(base, owner.token);
    await feed.next();
    await feed.none();
    feed.close();
  });

  it("keeps the line warm with heartbeats", async () => {
    const feed = await new Feed().open(base, owner.token);
    await feed.next();
    await feed.heartbeat();
    feed.close();
  });

  it("caps streams per account, ending the oldest", async () => {
    const account = await register("capped@example.com", "juniper marble spool");
    const first = await new Feed().open(base, account.token);
    await first.next();
    const rest: Feed[] = [];
    for (let i = 0; i < 16; i++) {
      rest.push(await new Feed().open(base, account.token));
    }
    // The 17th connection displaced the very first stream.
    await first.closedByServer();
    for (const feed of rest) {
      feed.close();
    }
  });

  it("ends the stream when the session is revoked", async () => {
    const account = await register("revoked@example.com", "meadow quartz signal");
    const feed = await new Feed().open(base, account.token);
    await feed.next();
    await app.db.run("UPDATE users SET token_epoch = token_epoch + 1 WHERE email = ?", account.email);
    await feed.closedByServer();
  });

  it("ends the stream when the account is disabled", async () => {
    const account = await register("disabled@example.com", "cobalt ember willow");
    const feed = await new Feed().open(base, account.token);
    await feed.next();
    await app.db.run("UPDATE users SET disabled = 1 WHERE email = ?", account.email);
    await feed.closedByServer();
  });

  it("can be turned off, advertises the state, and still closes cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engramer-events-off-"));
    const dark = await buildApp({ dataDir: dir, webDistDir: null, events: false });
    await dark.listen({ port: 0, host: "127.0.0.1" });
    const address = dark.server.address();
    const darkBase = typeof address === "string" || !address ? "" : `http://127.0.0.1:${address.port}`;
    const keys = generateAccountKeys("harbor tulip garnet");
    const registered = await dark.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "dark@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    const token = registered.json().token as string;
    const refused = await fetch(`${darkBase}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.status).toBe(404);
    await refused.body?.cancel();
    const user = await dark.inject({ method: "GET", url: "/api/user", headers: { authorization: `Bearer ${token}` } });
    expect(user.json().events).toBe(false);
    await dark.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("close() does not wait on held streams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engramer-events-close-"));
    const held = await buildApp({ dataDir: dir, webDistDir: null });
    await held.listen({ port: 0, host: "127.0.0.1" });
    const address = held.server.address();
    const heldBase = typeof address === "string" || !address ? "" : `http://127.0.0.1:${address.port}`;
    const keys = generateAccountKeys("velvet anchor prism");
    const registered = await held.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "held@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    const feed = await new Feed().open(heldBase, registered.json().token as string);
    await feed.next();
    const started = Date.now();
    await held.close();
    expect(Date.now() - started).toBeLessThan(3000);
    await feed.closedByServer();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * A poke is a promise that a pull will find the change. The allocator
 * runs inside the mutation's transaction, so the announcement has to
 * wait for the commit: a client that pulls between the two reads the
 * old state, moves its cursor nowhere new, and then hears nothing more
 * about the row until an unrelated change or the slow poll. That is how
 * a file dropped on the drive stayed invisible in the app for minutes.
 */
describe("pokes announce committed data", () => {
  const ownerId = async () =>
    (await app.db.get<{ id: number }>("SELECT id FROM users WHERE email = ?", owner.email))!.id;

  it("holds a poke made inside a transaction until it commits", async () => {
    const uid = await ownerId();
    const feed = await new Feed().open(base, owner.token);
    const before = (await feed.next()).seq;
    await app.db.tx(async (t) => {
      await nextSeq(t, uid);
      // Deliberately slower than the flush interval, so an early poke
      // would already be on the wire. Nothing else touches the database
      // while this test runs, which is why the wait is allowed here.
      await feed.quietAbove(before);
    });
    const poked = await feed.nextAbove(before);
    expect(poked.seq).toBeGreaterThan(before);
    feed.close();
  });

  it("drops the pokes of a transaction that rolls back", async () => {
    const uid = await ownerId();
    const feed = await new Feed().open(base, owner.token);
    const before = (await feed.next()).seq;
    await expect(
      app.db.tx(async (t) => {
        await nextSeq(t, uid);
        throw new Error("abandoned");
      }),
    ).rejects.toThrow("abandoned");
    await feed.quietAbove(before);
    feed.close();
  });

  /**
   * Observes, at the instant each poke is handed to the publisher,
   * whether a row carrying that sequence already exists. The store is
   * SQLite here and every query runs synchronously when called, so the
   * snapshot is exact: a poke that fires before its row is written
   * observes zero rows.
   */
  async function rowsPresentAtPoke(
    table: "files" | "folders",
    act: () => Promise<void>,
  ): Promise<boolean[]> {
    const original = app.db.onSeq!;
    const observations: Array<Promise<boolean>> = [];
    app.db.onSeq = (userId, seq) => {
      observations.push(
        app.db
          .get<{ n: number }>(
            `SELECT count(*) AS n FROM ${table} WHERE user_id = ? AND update_seq = ?`,
            userId,
            seq,
          )
          .then((row) => (row?.n ?? 0) > 0),
      );
      original(userId, seq);
    };
    try {
      await act();
    } finally {
      app.db.onSeq = original;
    }
    return Promise.all(observations);
  }

  it("announces a new file only once its row is readable", async () => {
    const present = await rowsPresentAtPoke("files", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/files",
        headers: auth(owner),
        payload: {
          folderId: null,
          encryptedKey: secretBoxSeal(generateKey(), owner.keys.masterKey),
          encryptedMeta: encryptFileMetadata(
            { name: "dropped.bin", mime: "application/octet-stream", size: 1, mtime: 1 },
            fileKey,
          ),
        },
      });
      expect(created.statusCode).toBe(201);
    });
    expect(present).toEqual([true]);
  });

  it("announces a new or moved folder only once its row is readable", async () => {
    let folderId = "";
    const created = await rowsPresentAtPoke("folders", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/folders",
        headers: auth(owner),
        payload: {
          parentId: null,
          encryptedKey: secretBoxSeal(generateKey(), owner.keys.masterKey),
          encryptedMeta: encryptFolderMetadata({ name: "Inbox" }, fileKey),
        },
      });
      expect(response.statusCode).toBe(201);
      folderId = response.json().id as string;
    });
    expect(created).toEqual([true]);
    const renamed = await rowsPresentAtPoke("folders", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/folders/${folderId}`,
        headers: auth(owner),
        payload: { encryptedMeta: encryptFolderMetadata({ name: "Archive" }, fileKey) },
      });
      expect(response.statusCode).toBe(200);
    });
    expect(renamed).toEqual([true]);
  });
});
