import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgNotifyHub, type Connection } from "../src/collabhub.js";
import { openDatabase, type SqliteDb } from "../src/db.js";
import { LoopbackBus, type LoopbackMember } from "./helpers/loopbackbus.js";

/**
 * Two hubs, one per server instance, sharing a database and a bus. The
 * database orders every durable frame; the hub only decides how a frame
 * reaches the sockets the OTHER instance holds. A `log` crosses as its
 * sequence number and is re-read from the log by the receiver, so a lost
 * notification is repaired by the next one and nothing large ever rides
 * the bus.
 */
interface Fake extends Connection {
  frames: Array<Record<string, unknown>>;
  closes: number[];
}

function conn(id: string, userId: number): Fake {
  const fake: Fake = {
    id,
    userId,
    frames: [],
    closes: [],
    send(frame) {
      fake.frames.push(frame);
    },
    close(code) {
      fake.closes.push(code);
    },
  };
  return fake;
}

const FILE = "doc-1";

describe("PgNotifyHub", () => {
  let dir: string;
  let db: SqliteDb;
  let bus: LoopbackBus;
  let a: PgNotifyHub;
  let b: PgNotifyHub;
  let busA: LoopbackMember;
  let busB: LoopbackMember;
  let membersCalls = 0;

  const appendLog = async (seq: number, sender: string, payload: string) => {
    await db.run(
      "INSERT INTO channel_messages (file_id, seq, sender, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      FILE,
      seq,
      sender,
      payload,
      payload.length,
      Date.now(),
    );
    await db.run(
      `INSERT INTO channel_state (file_id, last_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET last_seq = ?, updated_at = ?`,
      FILE,
      seq,
      Date.now(),
      seq,
      Date.now(),
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engramer-hub-"));
    db = openDatabase(join(dir, "hub.db"));
    bus = new LoopbackBus();
    busA = bus.attach();
    busB = bus.attach();
    membersCalls = 0;
    const membersFrame = async (fileId: string) => {
      membersCalls++;
      return { t: "members", members: [{ connId: `recomputed-${fileId}` }] };
    };
    a = new PgNotifyHub({ bus: busA, db, podId: "pod-a", membersFrame, ephCoalesceMs: 20 });
    b = new PgNotifyHub({ bus: busB, db, podId: "pod-b", membersFrame, ephCoalesceMs: 20 });
  });

  afterEach(async () => {
    await a.close();
    await b.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers a log frame to the other instance's sockets, never back to its sender", async () => {
    const sender = conn("s", 1);
    const localPeer = conn("p", 2);
    const remote = conn("r", 3);
    a.join(FILE, sender);
    a.join(FILE, localPeer);
    b.join(FILE, remote);
    await appendLog(1, "s", "cipher-1");
    a.broadcast(FILE, { t: "log", seq: 1, sender: "s", payload: "cipher-1" }, "s");
    await settle();
    expect(sender.frames).toEqual([]);
    expect(localPeer.frames).toEqual([{ t: "log", seq: 1, sender: "s", payload: "cipher-1" }]);
    expect(remote.frames).toEqual([{ t: "log", seq: 1, sender: "s", payload: "cipher-1" }]);
    // The payload never rode the bus: only the position did.
    expect(busA.published.every((p) => !p.payload.includes("cipher-1"))).toBe(true);
  });

  it("repairs a lost notification from the log on the next one", async () => {
    const sender = conn("s", 1);
    const remote = conn("r", 3);
    a.join(FILE, sender);
    b.join(FILE, remote);
    await appendLog(1, "s", "one");
    a.broadcast(FILE, { t: "log", seq: 1, sender: "s", payload: "one" }, "s");
    await settle();
    busB.listening = false;
    await appendLog(2, "s", "two");
    a.broadcast(FILE, { t: "log", seq: 2, sender: "s", payload: "two" }, "s");
    await settle();
    busB.listening = true;
    await appendLog(3, "s", "three");
    a.broadcast(FILE, { t: "log", seq: 3, sender: "s", payload: "three" }, "s");
    await settle();
    expect(remote.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("replays from its watermark when its listener reconnects", async () => {
    const sender = conn("s", 1);
    const remote = conn("r", 3);
    a.join(FILE, sender);
    b.join(FILE, remote);
    await appendLog(1, "s", "one");
    a.broadcast(FILE, { t: "log", seq: 1, sender: "s", payload: "one" }, "s");
    await settle();
    busB.listening = false;
    await appendLog(2, "s", "two");
    a.broadcast(FILE, { t: "log", seq: 2, sender: "s", payload: "two" }, "s");
    await settle();
    const logs = () => remote.frames.filter((f) => f.t === "log").map((f) => f.seq);
    expect(logs()).toEqual([1]);
    await busB.reconnect();
    await settle();
    expect(logs()).toEqual([1, 2]);
    // The instance also refreshes who is here after a gap.
    expect(remote.frames.some((f) => f.t === "members")).toBe(true);
  });

  it("fills a gap another instance left before a local post moves the watermark", async () => {
    // A's listener misses B's post; A's own next post must not step over
    // it: the rows in between are owed to A's sockets right then.
    const onA = conn("a1", 1);
    const onB = conn("b1", 2);
    a.join(FILE, onA);
    b.join(FILE, onB);
    await settle();
    await appendLog(1, "b1", "from-b-1");
    b.broadcast(FILE, { t: "log", seq: 1, sender: "b1", payload: "from-b-1" }, "b1");
    await settle();
    busA.listening = false;
    await appendLog(2, "b1", "from-b-2");
    b.broadcast(FILE, { t: "log", seq: 2, sender: "b1", payload: "from-b-2" }, "b1");
    await settle();
    expect(onA.frames.map((f) => f.payload)).toEqual(["from-b-1"]);
    await appendLog(3, "a1", "from-a-3");
    a.broadcast(FILE, { t: "log", seq: 3, sender: "a1", payload: "from-a-3" }, "a1");
    await settle();
    expect(onA.frames.map((f) => f.payload)).toEqual(["from-b-1", "from-b-2"]);
  });

  it("does not deliver its own log twice, and skips channels with no local members", async () => {
    const sender = conn("s", 1);
    const localPeer = conn("p", 2);
    a.join(FILE, sender);
    a.join(FILE, localPeer);
    await appendLog(1, "s", "one");
    a.broadcast(FILE, { t: "log", seq: 1, sender: "s", payload: "one" }, "s");
    await settle();
    expect(localPeer.frames.map((f) => f.seq)).toEqual([1]);
    // B has nobody on this document and reads nothing for it.
    expect(b.local(FILE)).toEqual([]);
  });

  it("recomputes the members list on the receiving side instead of carrying names", async () => {
    const remote = conn("r", 3);
    b.join(FILE, remote);
    a.broadcast(FILE, { t: "members", members: [{ connId: "x", name: "someone@example.com" }] });
    await settle();
    expect(remote.frames).toEqual([{ t: "members", members: [{ connId: `recomputed-${FILE}` }] }]);
    expect(busA.published.every((p) => !p.payload.includes("someone@example.com"))).toBe(true);
    expect(membersCalls).toBeGreaterThan(0);
  });

  it("evicts an account's sockets on every instance", async () => {
    const mine = conn("m", 7);
    const theirs = conn("t", 8);
    b.join(FILE, mine);
    b.join(FILE, theirs);
    a.evict(FILE, 7);
    await settle();
    expect(mine.closes).toEqual([4403]);
    expect(theirs.closes).toEqual([]);
  });

  it("carries small frames as they are and coalesces cursor frames per sender", async () => {
    const sender = conn("s", 1);
    const remote = conn("r", 3);
    a.join(FILE, sender);
    b.join(FILE, remote);
    a.broadcast(FILE, { t: "please-snapshot", reason: "soft" });
    for (let i = 1; i <= 5; i++) {
      a.broadcast(FILE, { t: "eph", sender: "s", payload: `cursor-${i}` }, "s");
    }
    await settle(60);
    const kinds = remote.frames.map((f) => f.t);
    expect(kinds.filter((k) => k === "please-snapshot")).toHaveLength(1);
    const cursors = remote.frames.filter((f) => f.t === "eph");
    expect(cursors).toHaveLength(1);
    expect(cursors[0]!.payload).toBe("cursor-5");
  });

  it("keeps a frame too large for the bus local rather than sending a broken one", async () => {
    const localPeer = conn("p", 2);
    const remote = conn("r", 3);
    a.join(FILE, localPeer);
    b.join(FILE, remote);
    a.broadcast(FILE, { t: "content", note: "x".repeat(9000) });
    await settle();
    expect(localPeer.frames).toHaveLength(1);
    expect(remote.frames).toEqual([]);
  });
});

async function settle(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
