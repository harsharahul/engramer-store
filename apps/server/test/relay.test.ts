import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  generateAccountKeys,
  generateKey,
  secretBoxSeal,
  encryptBytes,
  encryptFileMetadata,
  sealToPublicKey,
  utf8Encode,
  type AccountKeys,
} from "@engramer/crypto";
import { buildApp } from "../src/app.js";

/**
 * The relay is the one server component that holds sockets, so these tests
 * run against a real listener; inject() cannot upgrade. Everything the
 * server touches here is opaque: payloads are base64 strings it never
 * parses, senders are per-connection ids, and the durable log is what makes
 * reconnection lossless.
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
let stranger: TestAccount;
let viewer: TestAccount;
let fileId: string;

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

/** Mints a single-use channel ticket for the account, or returns the status. */
async function ticketFor(account: TestAccount): Promise<{ ticket?: string; status: number }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/collab/${fileId}/ticket`,
    headers: auth(account),
    payload: {},
  });
  return { ticket: response.json().ticket as string | undefined, status: response.statusCode };
}

interface Frame {
  t: string;
  [key: string]: unknown;
}

/** A connected channel client with a readable frame queue. */
class Client {
  private socket: WebSocket;
  private frames: Frame[] = [];
  private waiters: Array<() => void> = [];
  closed = false;

  constructor(ticket: string) {
    this.socket = new WebSocket(`${base}/api/collab/${fileId}/channel?ticket=${ticket}`);
    this.socket.on("message", (data) => {
      this.frames.push(JSON.parse(String(data)) as Frame);
      this.waiters.splice(0).forEach((wake) => wake());
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.waiters.splice(0).forEach((wake) => wake());
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
  }

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The next frame matching the predicate, waiting up to two seconds. */
  async next(match: (frame: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(match);
      if (found) {
        this.frames.splice(this.frames.indexOf(found), 1);
        return found;
      }
      if (this.closed) {
        throw new Error("socket closed while waiting");
      }
      if (Date.now() > deadline) {
        throw new Error(`no matching frame; saw ${JSON.stringify(this.frames)}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** True when no frame matching the predicate arrives within the window. */
  async silence(match: (frame: Frame) => boolean, windowMs = 300): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return !this.frames.some(match);
  }

  close(): void {
    this.socket.close();
  }
}

async function connect(account: TestAccount, hello: Frame = { t: "hello", lastSeq: 0 }) {
  const { ticket, status } = await ticketFor(account);
  expect(status).toBe(201);
  const client = new Client(ticket!);
  await client.open();
  client.send(hello);
  return client;
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-relay-test-"));
  app = await buildApp({ dataDir, quotaBytes: 512 * 1024, webDistDir: null });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || !address) {
    throw new Error("no port");
  }
  base = `ws://127.0.0.1:${address.port}`;

  owner = await register("owner@example.com", "orchid lantern velvet");
  member = await register("member@example.com", "cedar mosaic thimble");
  stranger = await register("stranger@example.com", "quartz bellows meadow");
  viewer = await register("viewer@example.com", "lantern pebble driftwood");

  // One shared file: owner uploads, member joins via invite claim + grant.
  const fileKey = generateKey();
  const content = utf8Encode("relay body");
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
  const invites = await app.inject({ method: "GET", url: "/api/collab/invites", headers: auth(owner) });
  const entry = (invites.json().invites as Array<Record<string, unknown>>).find(
    (i) => i.token === inviteToken,
  )!;
  await app.inject({
    method: "POST",
    url: `/api/collab/invites/${inviteToken}/grant`,
    headers: auth(owner),
    payload: { sealedKey: sealToPublicKey(fileKey, entry.claimantPublicKey as string) },
  });

  // A second collaborator, read-only, for the role tests.
  const viewerInvite = await app.inject({
    method: "POST",
    url: "/api/collab/invites",
    headers: auth(owner),
    payload: { fileId, role: "viewer" },
  });
  const viewerToken = viewerInvite.json().token as string;
  await app.inject({
    method: "POST",
    url: `/api/collab/invites/${viewerToken}/claim`,
    headers: auth(viewer),
  });
  const viewerInvites = await app.inject({
    method: "GET",
    url: "/api/collab/invites",
    headers: auth(owner),
  });
  const viewerEntry = (viewerInvites.json().invites as Array<Record<string, unknown>>).find(
    (i) => i.token === viewerToken,
  )!;
  await app.inject({
    method: "POST",
    url: `/api/collab/invites/${viewerToken}/grant`,
    headers: auth(owner),
    payload: { sealedKey: sealToPublicKey(fileKey, viewerEntry.claimantPublicKey as string) },
  });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("channel tickets", () => {
  it("refuses a stranger, and admits owner and member", async () => {
    expect((await ticketFor(stranger)).status).toBe(404);
    expect((await ticketFor(owner)).status).toBe(201);
    expect((await ticketFor(member)).status).toBe(201);
  });

  it("burns a ticket on first use", async () => {
    const { ticket } = await ticketFor(owner);
    const first = new Client(ticket!);
    await first.open();
    first.send({ t: "hello", lastSeq: 0 });
    await first.next((f) => f.t === "welcome");
    const second = new Client(ticket!);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(second.closed).toBe(true);
    first.close();
  });
});

describe("the ordered channel", () => {
  it("delivers a post to the other member with a seq, never back to its sender", async () => {
    const a = await connect(owner);
    const b = await connect(member);
    await a.next((f) => f.t === "caught-up");
    await b.next((f) => f.t === "caught-up");

    a.send({ t: "post", ref: "r1", payload: "b64-opaque-1" });
    const ack = await a.next((f) => f.t === "ack");
    expect(ack.ref).toBe("r1");
    expect(typeof ack.seq).toBe("number");
    const delivered = await b.next((f) => f.t === "log");
    expect(delivered.payload).toBe("b64-opaque-1");
    expect(delivered.seq).toBe(ack.seq);
    expect(await a.silence((f) => f.t === "log" && f.payload === "b64-opaque-1")).toBe(true);
    a.close();
    b.close();
  });

  it("replays exactly the missing tail on reconnect", async () => {
    const a = await connect(owner);
    await a.next((f) => f.t === "caught-up");
    a.send({ t: "post", ref: "x1", payload: "tail-1" });
    const first = await a.next((f) => f.t === "ack");
    a.send({ t: "post", ref: "x2", payload: "tail-2" });
    const second = await a.next((f) => f.t === "ack");
    a.close();

    // A client that saw everything up to the first post asks from there.
    const late = await connect(member, { t: "hello", lastSeq: first.seq as number });
    const replayed = await late.next((f) => f.t === "log");
    expect(replayed.seq).toBe(second.seq);
    expect(replayed.payload).toBe("tail-2");
    await late.next((f) => f.t === "caught-up");
    expect(await late.silence((f) => f.t === "log")).toBe(true);
    late.close();
  });

  it("broadcasts ephemerals without storing a row", async () => {
    const a = await connect(owner);
    const b = await connect(member);
    await a.next((f) => f.t === "caught-up");
    await b.next((f) => f.t === "caught-up");

    a.send({ t: "eph", payload: "cursor-blob" });
    const seen = await b.next((f) => f.t === "eph");
    expect(seen.payload).toBe("cursor-blob");

    // The durable log must not have grown: a fresh join from zero replays
    // only real posts, and none of them carry the ephemeral payload.
    a.close();
    b.close();
    const probe = await connect(member);
    const rows: Frame[] = [];
    for (;;) {
      const frame = await probe.next((f) => f.t === "log" || f.t === "caught-up");
      if (frame.t === "caught-up") {
        break;
      }
      rows.push(frame);
    }
    expect(rows.every((row) => row.payload !== "cursor-blob")).toBe(true);
    probe.close();
  });
});

describe("member indexes", () => {
  it("assigns each joiner a distinct sticky index that survives others leaving", async () => {
    const a = await connect(owner);
    const welcomeA = await a.next((f) => f.t === "welcome");
    const b = await connect(member);
    const welcomeB = await b.next((f) => f.t === "welcome");
    expect(typeof welcomeA.yourIndex).toBe("number");
    expect(typeof welcomeB.yourIndex).toBe("number");
    expect(welcomeA.yourIndex).not.toBe(welcomeB.yourIndex);

    // A third joiner after the first leaves must NOT reuse the freed index:
    // the engine namespaces object ids by participant index, and a reused
    // index would let two histories mint colliding ids.
    a.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const c = await connect(owner);
    const welcomeC = await c.next((f) => f.t === "welcome");
    expect(welcomeC.yourIndex).not.toBe(welcomeA.yourIndex);
    expect(welcomeC.yourIndex).not.toBe(welcomeB.yourIndex);

    // Members lists carry each connection's index alongside its id.
    const members = welcomeC.members as Array<{ connId: string; index: number }>;
    expect(members.some((m) => m.index === welcomeB.yourIndex)).toBe(true);
    b.close();
    c.close();
  });
});

describe("snapshots truncate the log safely", () => {
  it("drops frames up to the snapshot point, keeps later ones, and tells the room", async () => {
    const a = await connect(owner);
    await a.next((f) => f.t === "caught-up");
    a.send({ t: "post", ref: "s1", payload: "before-1" });
    const first = await a.next((f) => f.t === "ack");
    a.send({ t: "post", ref: "s2", payload: "before-2" });
    const second = await a.next((f) => f.t === "ack");

    a.send({ t: "snap", generation: 3, upTo: second.seq });
    const truncated = await a.next((f) => f.t === "truncated");
    expect(truncated.snapshotGeneration).toBe(3);
    expect(truncated.snapshotSeq).toBe(second.seq);

    a.send({ t: "post", ref: "s3", payload: "after-1" });
    await a.next((f) => f.t === "ack");
    a.close();

    // A fresh joiner from zero sees ONLY the frame after the snapshot.
    const probe = await connect(member);
    const welcome = await probe.next((f) => f.t === "welcome");
    expect(welcome.snapshotGeneration).toBe(3);
    const replayed: string[] = [];
    for (;;) {
      const frame = await probe.next((f) => f.t === "log" || f.t === "caught-up");
      if (frame.t === "caught-up") {
        break;
      }
      replayed.push(String(frame.payload));
    }
    expect(replayed).toEqual(["after-1"]);
    expect(replayed).not.toContain("before-1");
    probe.close();
    void first;
  });

  it("refuses a plain whole-document write while members are live, and admits a snapshot", async () => {
    const live = await connect(owner);
    await live.next((f) => f.t === "caught-up");

    const plain = await app.inject({
      method: "PUT",
      url: `/api/files/${fileId}/data`,
      headers: { ...auth(owner), "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("plain overwrite"), generateKey())),
    });
    expect(plain.statusCode).toBe(409);

    const snapshot = await app.inject({
      method: "PUT",
      url: `/api/files/${fileId}/data`,
      headers: {
        ...auth(owner),
        "content-type": "application/octet-stream",
        "x-collab-snapshot": "1",
      },
      payload: Buffer.from(encryptBytes(utf8Encode("snapshot write"), generateKey())),
    });
    expect(snapshot.statusCode).toBe(200);
    live.close();
  });
});

/**
 * A browser sends its greeting the instant the socket opens, while the
 * server is still several database round trips into admitting it. That
 * greeting must not be lost: losing it means no welcome, no channel, and
 * live editing that silently never starts. Caught by the first live
 * two-account run, which found exactly that.
 */
describe("a greeting that beats the join", () => {
  it("answers a hello sent in the same breath as the connection", async () => {
    const { ticket } = await ticketFor(owner);
    const socket = new WebSocket(`${base}/api/collab/${fileId}/channel?ticket=${ticket}`);
    const frames: Frame[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
    // No await between open and hello: exactly what the browser does.
    socket.on("open", () => socket.send(JSON.stringify({ t: "hello", lastSeq: 0 })));

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !frames.some((f) => f.t === "welcome")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const welcome = frames.find((f) => f.t === "welcome");
    expect(welcome).toBeDefined();
    expect(typeof welcome!.yourIndex).toBe("number");
    socket.close();
  });

  it("keeps two rapid posts in the order they were sent", async () => {
    const a = await connect(owner);
    await a.next((f) => f.t === "caught-up");
    // Back to back, no await: their positions must follow send order.
    a.send({ t: "post", ref: "o1", payload: "first" });
    a.send({ t: "post", ref: "o2", payload: "second" });
    const first = await a.next((f) => f.t === "ack" && f.ref === "o1");
    const second = await a.next((f) => f.t === "ack" && f.ref === "o2");
    expect(Number(second.seq)).toBeGreaterThan(Number(first.seq));
    a.close();
  });
});

describe("joining tells the room", () => {
  it("delivers a members frame to those already here when someone joins", async () => {
    const first = await connect(owner);
    await first.next((f) => f.t === "caught-up");

    const second = await connect(member);
    await second.next((f) => f.t === "welcome");

    // The one already in the room learns a second person is present. This
    // is what the editor turns into "someone joined" for the engine, and
    // without it the first editor stays in single-user mode forever. The
    // predicate names the frame meant here: every client also sees a
    // members frame for its own arrival.
    const members = await first.next(
      (f) => f.t === "members" && (f.members as unknown[]).length === 2,
    );
    const list = members.members as Array<{ connId: string; index: number }>;
    expect(list.length).toBe(2);
    expect(new Set(list.map((m) => m.index)).size).toBe(2);

    first.close();
    second.close();
  });
});

/**
 * View-only means view-only on the channel too. A viewer's frames would be
 * applied by every editor's engine and then persisted by whoever saves
 * next — a read-only collaborator writing to the document by laundering
 * the edit through someone else's save.
 */
describe("a viewer cannot write through the channel", () => {
  it("relays nothing a viewer posts, and stores nothing", async () => {
    const editor = await connect(member);
    await editor.next((f) => f.t === "caught-up");

    const watcher = await connect(viewer);
    await watcher.next((f) => f.t === "caught-up");
    watcher.send({ t: "post", ref: "v1", payload: "viewer-edit" });

    // No acknowledgement to the viewer, and nothing delivered to the editor.
    expect(await watcher.silence((f) => f.t === "ack", 600)).toBe(true);
    expect(await editor.silence((f) => f.t === "log" && f.payload === "viewer-edit")).toBe(true);

    watcher.close();
    editor.close();

    // And nothing durable: a fresh joiner never replays it.
    const probe = await connect(owner);
    const seen: string[] = [];
    for (;;) {
      const frame = await probe.next((f) => f.t === "log" || f.t === "caught-up");
      if (frame.t === "caught-up") break;
      seen.push(String(frame.payload));
    }
    expect(seen).not.toContain("viewer-edit");
    probe.close();
  });

  it("refuses a viewer's attempt to truncate the log with a snapshot claim", async () => {
    const editor = await connect(member);
    await editor.next((f) => f.t === "caught-up");
    editor.send({ t: "post", ref: "keep1", payload: "editor-work" });
    const ack = await editor.next((f) => f.t === "ack");

    const watcher = await connect(viewer);
    await watcher.next((f) => f.t === "caught-up");
    watcher.send({ t: "snap", generation: 99, upTo: ack.seq });
    expect(await editor.silence((f) => f.t === "truncated", 600)).toBe(true);

    watcher.close();
    editor.close();

    // The editor's work survived the viewer's claim.
    const probe = await connect(stranger === undefined ? owner : owner);
    const seen: string[] = [];
    for (;;) {
      const frame = await probe.next((f) => f.t === "log" || f.t === "caught-up");
      if (frame.t === "caught-up") break;
      seen.push(String(frame.payload));
    }
    expect(seen).toContain("editor-work");
    probe.close();
  });
});

describe("the log cannot grow without bound", () => {
  it("refuses posts past the cap and asks the room to snapshot", async () => {
    // A dedicated instance with a tiny cap, so the test stays fast and the
    // shared one keeps its normal limits.
    const dir = mkdtempSync(join(tmpdir(), "engramer-cap-test-"));
    const capped = await buildApp({
      dataDir: dir,
      quotaBytes: 512 * 1024,
      webDistDir: null,
      channelMaxBytes: 2_000,
    });
    await capped.listen({ port: 0, host: "127.0.0.1" });
    const addr = capped.server.address();
    const capBase = `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const keys = generateAccountKeys("cap test passphrase");
    const reg = await capped.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "cap@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    const capToken = reg.json().token as string;
    const capAuth = { authorization: `Bearer ${capToken}` };
    const capFileKey = generateKey();
    const made = await capped.inject({
      method: "POST",
      url: "/api/files",
      headers: capAuth,
      payload: {
        folderId: null,
        encryptedKey: secretBoxSeal(capFileKey, keys.masterKey),
        encryptedMeta: encryptFileMetadata(
          { name: "big.docx", mime: "application/octet-stream", size: 1, mtime: 1 },
          capFileKey,
        ),
      },
    });
    const capFileId = made.json().id as string;
    await capped.inject({
      method: "PUT",
      url: `/api/files/${capFileId}/data`,
      headers: { ...capAuth, "content-type": "application/octet-stream" },
      payload: Buffer.from(encryptBytes(utf8Encode("x"), capFileKey)),
    });

    const ticketRes = await capped.inject({
      method: "POST",
      url: `/api/collab/${capFileId}/ticket`,
      headers: capAuth,
      payload: {},
    });
    const socket = new WebSocket(
      `${capBase}/api/collab/${capFileId}/channel?ticket=${ticketRes.json().ticket}`,
    );
    const frames: Frame[] = [];
    socket.on("message", (d) => frames.push(JSON.parse(String(d)) as Frame));
    await new Promise<void>((res) => socket.once("open", () => res()));
    socket.send(JSON.stringify({ t: "hello", lastSeq: 0 }));
    await new Promise((r) => setTimeout(r, 300));

    const chunk = "y".repeat(500);
    for (let i = 0; i < 12; i++) {
      socket.send(JSON.stringify({ t: "post", ref: `c${i}`, payload: chunk }));
    }
    await new Promise((r) => setTimeout(r, 800));

    const acks = frames.filter((f) => f.t === "ack").length;
    expect(acks).toBeGreaterThan(0); // early posts land
    expect(acks).toBeLessThan(12); // later ones do not
    expect(frames.some((f) => f.t === "please-snapshot")).toBe(true);

    socket.close();
    await capped.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the ephemeral path is not a way around the write gate", () => {
  it("relays nothing a viewer sends as an ephemeral either", async () => {
    const editor = await connect(member);
    await editor.next((f) => f.t === "caught-up");
    const watcher = await connect(viewer);
    await watcher.next((f) => f.t === "caught-up");

    // The same edit a viewer cannot post, relabelled as a cursor.
    watcher.send({ t: "eph", payload: "viewer-edit-as-eph" });
    expect(
      await editor.silence((f) => f.t === "eph" && f.payload === "viewer-edit-as-eph"),
    ).toBe(true);

    watcher.close();
    editor.close();
  });

  it("still carries an editor's ephemerals", async () => {
    const a = await connect(owner);
    await a.next((f) => f.t === "caught-up");
    const b = await connect(member);
    await b.next((f) => f.t === "caught-up");
    b.send({ t: "eph", payload: "editor-cursor" });
    const seen = await a.next((f) => f.t === "eph");
    expect(seen.payload).toBe("editor-cursor");
    a.close();
    b.close();
  });
});
