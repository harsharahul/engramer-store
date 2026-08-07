import { describe, expect, it } from "vitest";
import { CollabBridge, type EngineMessage } from "./collab";

/**
 * The bridge translates between the engine's collaboration protocol and
 * channel frames, entirely as data: no sockets, no DOM, no crypto here.
 * The mappings under test were read out of the vendored engine and proven
 * by the injection spike; each shape below is load-bearing.
 */

const bridge = (over: Partial<ConstructorParameters<typeof CollabBridge>[0]> = {}) =>
  new CollabBridge({
    fileId: "file-1",
    selfConnId: "conn-self",
    selfIndex: 3,
    members: [
      { connId: "conn-self", index: 3 },
      { connId: "conn-peer", index: 2 },
    ],
    ...over,
  });

const authMessage = (b: CollabBridge) => b.onEngineMessage({ type: "auth" });

describe("auth", () => {
  it("answers with every present member as a participant and an EMPTY catch-up", () => {
    const effects = authMessage(bridge());
    const authChanges = effects.toEditor.find((m) => m.type === "authChanges")!;
    expect(authChanges.changes).toEqual([]);
    const auth = effects.toEditor.find((m) => m.type === "auth")!;
    expect(auth.result).toBe(1);
    expect(auth.indexUser).toBe(3);
    const participants = auth.participants as Array<Record<string, unknown>>;
    expect(participants).toHaveLength(2);
    expect(participants.map((p) => p.indexUser).sort()).toEqual([2, 3]);
    expect(effects.toEditor.some((m) => m.type === "documentOpen")).toBe(true);
  });
});

describe("remote changes", () => {
  it("wraps each change string as its own JSON-string-literal entry", () => {
    const b = bridge();
    const effects = b.onRemoteFrame({
      ch: "file-1",
      s: "conn-peer",
      n: 1,
      k: "chg",
      d: { idx: 2, changes: ["64;AAAA", "50;BBBB"] },
    });
    const message = effects.toEditor.find((m) => m.type === "saveChanges")!;
    const entries = message.changes as Array<{ change: string; user: string }>;
    expect(entries).toHaveLength(2);
    // JSON.parse of each entry's change must yield ONE STRING: the engine
    // hands the parsed value straight to its change reader, and an array
    // either crashes its sanity check or applies nothing.
    expect(JSON.parse(entries[0]!.change)).toBe("64;AAAA");
    expect(entries[0]!.user).toBe("2");
    expect(message.changesIndex).toBe(2);
    expect(message.endSaveChanges).toBe(true);
  });

  it("advances the cumulative index across batches from anyone", () => {
    const b = bridge();
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "chg", d: { idx: 2, changes: ["a"] } });
    const second = b.onRemoteFrame({
      ch: "file-1",
      s: "conn-peer",
      n: 2,
      k: "chg",
      d: { idx: 2, changes: ["b", "c"] },
    });
    const message = second.toEditor.find((m) => m.type === "saveChanges")!;
    expect(message.changesIndex).toBe(3);
  });
});

describe("own changes", () => {
  it("posts the parsed batch and acknowledges the engine only on the ack", () => {
    const b = bridge();
    const effects = b.onEngineMessage({
      type: "saveChanges",
      changes: JSON.stringify(["64;AAAA", "50;BBBB"]),
      startSaveChanges: true,
      endSaveChanges: true,
      deleteIndex: null,
    });
    expect(effects.post).toHaveLength(1);
    expect(effects.post[0]!.d).toMatchObject({ idx: 3, changes: ["64;AAAA", "50;BBBB"] });
    // Nothing back to the engine yet: the frame is not in the order.
    expect(effects.toEditor.some((m) => m.type === "unSaveLock")).toBe(false);

    const acked = b.onOwnFrameAcked(effects.post[0]!.ref, 7);
    const unSaveLock = acked.toEditor.find((m) => m.type === "unSaveLock")!;
    expect(unSaveLock.index).toBe(2);
  });

  it("pulls the next chunk of a split save with savePartChanges", () => {
    const b = bridge();
    const effects = b.onEngineMessage({
      type: "saveChanges",
      changes: JSON.stringify(["x"]),
      startSaveChanges: true,
      endSaveChanges: false,
      deleteIndex: null,
    });
    const acked = b.onOwnFrameAcked(effects.post[0]!.ref, 4);
    expect(acked.toEditor.some((m) => m.type === "savePartChanges")).toBe(true);
    expect(acked.toEditor.some((m) => m.type === "unSaveLock")).toBe(false);
  });
});

describe("locks derive from the total order", () => {
  it("grants our claim once acked with no earlier claim standing", () => {
    const b = bridge();
    const claimed = b.onEngineMessage({ type: "getLock", block: "para-9" });
    expect(claimed.post[0]!.d).toMatchObject({ idx: 3, block: "para-9" });
    const acked = b.onOwnFrameAcked(claimed.post[0]!.ref, 10);
    const grant = acked.toEditor.find((m) => m.type === "getLock")!;
    const locks = grant.locks as Record<string, { user: string }>;
    expect(locks["para-9"]!.user).toBe("3");
  });

  it("denies our claim when a remote claim came earlier in the order", () => {
    const b = bridge();
    const claimed = b.onEngineMessage({ type: "getLock", block: "para-9" });
    // The peer's claim lands at seq 5; ours acks later at seq 6.
    b.onRemoteFrame({
      ch: "file-1",
      s: "conn-peer",
      n: 1,
      k: "lock",
      d: { idx: 2, block: "para-9" },
    });
    const acked = b.onOwnFrameAcked(claimed.post[0]!.ref, 6);
    const grant = acked.toEditor.find((m) => m.type === "getLock")!;
    const locks = grant.locks as Record<string, { user: string }>;
    expect(locks["para-9"]!.user).toBe("2");
  });

  it("frees a block on unlock so the next claim wins", () => {
    const b = bridge();
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "lock", d: { idx: 2, block: "p" } });
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 2, k: "unlock", d: { idx: 2 } });
    const claimed = b.onEngineMessage({ type: "getLock", block: "p" });
    const acked = b.onOwnFrameAcked(claimed.post[0]!.ref, 9);
    const grant = acked.toEditor.find((m) => m.type === "getLock")!;
    expect((grant.locks as Record<string, { user: string }>)["p"]!.user).toBe("3");
  });
});

describe("presence and cursors", () => {
  it("sends cursors as ephemerals, never as durable frames", () => {
    const b = bridge();
    const effects = b.onEngineMessage({ type: "cursor", cursor: { pos: 12 } });
    expect(effects.post).toHaveLength(0);
    expect(effects.eph).toHaveLength(1);
  });

  it("turns membership changes into connectState", () => {
    const b = bridge();
    const effects = b.onMembers([
      { connId: "conn-self", index: 3 },
      { connId: "conn-peer", index: 2 },
      { connId: "conn-new", index: 5 },
    ]);
    const message = effects.toEditor.find((m) => m.type === "connectState")!;
    expect((message.participants as unknown[]).length).toBe(3);
  });
});

describe("tail replay", () => {
  it("replays a stored chg frame exactly like a live one", () => {
    const b = bridge();
    const effects = b.onRemoteFrame({
      ch: "file-1",
      s: "conn-old",
      n: 1,
      k: "chg",
      d: { idx: 1, changes: ["old-edit"] },
    });
    const message = effects.toEditor.find((m) => m.type === "saveChanges") as EngineMessage;
    expect(JSON.parse((message.changes as Array<{ change: string }>)[0]!.change)).toBe("old-edit");
  });
});

/**
 * "member 2" tells a person nothing about who is typing beside them. The
 * editor shows whatever the participant list carries, so the name has to
 * survive the trip from the relay into the engine's own idea of a user.
 */
describe("participants are people", () => {
  it("passes each member's name to the editor", () => {
    const b = new CollabBridge({
      fileId: "file-1",
      selfConnId: "conn-self",
      selfIndex: 1,
      members: [
        { connId: "conn-self", index: 1, name: "alpha@example.com" },
        { connId: "conn-peer", index: 2, name: "beta@example.com" },
      ],
    });
    const auth = b.onEngineMessage({ type: "auth" }).toEditor.find((m) => m.type === "auth")!;
    const names = (auth.participants as Array<{ username: string }>).map((p) => p.username);
    expect(names).toContain("alpha@example.com");
    expect(names).toContain("beta@example.com");
  });

  it("falls back to a number when a name is missing, rather than showing nothing", () => {
    const b = new CollabBridge({
      fileId: "file-1",
      selfConnId: "conn-self",
      selfIndex: 3,
      members: [{ connId: "conn-self", index: 3 }],
    });
    const auth = b.onEngineMessage({ type: "auth" }).toEditor.find((m) => m.type === "auth")!;
    expect((auth.participants as Array<{ username: string }>)[0]!.username).toBe("member 3");
  });
});
