import { describe, expect, it } from "vitest";
import { CollabBridge, engineUserId, type EngineMessage } from "./collab";

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
    expect(participants).toHaveLength(3);
    expect(participants.map((p) => p.indexUser).sort()).toEqual([0, 2, 3]);
    expect(effects.toEditor.some((m) => m.type === "documentOpen")).toBe(true);
  });

  it("keeps a history keeper in the room so the engine is never alone", () => {
    // The engine's lock-release machinery only runs while it believes
    // other editors exist; a phantom at reserved index 0 keeps it on.
    const auth = authMessage(bridge()).toEditor.find((m) => m.type === "auth")!;
    const participants = auth.participants as Array<Record<string, unknown>>;
    const keeper = participants.find((p) => p.indexUser === 0)!;
    expect(keeper.id).toBe(engineUserId(0));
    expect(keeper.view).toBe(false);
  });
});

/**
 * The engine identifies itself as editorConfig.user.id concatenated with
 * the indexUser from the auth reply, and matches that string against the
 * `user` field on every lock and change frame. If a frame carries the
 * bare index instead, the engine reads its OWN locks as foreign and
 * undoes the keystroke. Every id on the wire must be the concatenated
 * form, keyed only on the relay index so every client agrees.
 */
describe("engine identity", () => {
  it("names each participant by the engine's concatenated id, not the bare index", () => {
    const auth = authMessage(bridge()).toEditor.find((m) => m.type === "auth")!;
    const participants = auth.participants as Array<Record<string, unknown>>;
    const self = participants.find((p) => p.indexUser === 3)!;
    expect(self.id).toBe(engineUserId(3));
    expect(self.idOriginal).toBe(engineUserId(3));
    // indexUser stays the numeric relay index the engine expects.
    expect(self.indexUser).toBe(3);
  });

  it("labels a remote cursor with the engine id of its sender", () => {
    const b = bridge();
    const effects = b.onRemoteFrame({
      ch: "file-1",
      s: "conn-peer",
      n: 1,
      k: "cursor",
      d: { idx: 2, cursor: "x" },
    });
    const cursor = effects.toEditor.find((m) => m.type === "cursor")!;
    const msg = (cursor.messages as Array<{ user: string; useridoriginal: string }>)[0]!;
    expect(msg.user).toBe(engineUserId(2));
    expect(msg.useridoriginal).toBe(engineUserId(2));
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
    expect(entries[0]!.user).toBe(engineUserId(2));
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

  it("exposes the cumulative count for diagnostics", () => {
    const b = bridge();
    expect(b.changes).toBe(0);
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "chg", d: { idx: 2, changes: ["a"] } });
    expect(b.changes).toBe(1);
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
    const part = acked.toEditor.find((m) => m.type === "savePartChanges")!;
    // -1 is the engine's "leave your counter alone" sentinel; a live
    // value here feeds its deleteIndex arithmetic with our bookkeeping.
    expect(part.changesIndex).toBe(-1);
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
    expect(locks["para-9"]!.user).toBe(engineUserId(3));
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
    expect(locks["para-9"]!.user).toBe(engineUserId(2));
  });

  it("frees a block on unlock so the next claim wins", () => {
    const b = bridge();
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "lock", d: { idx: 2, block: "p" } });
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 2, k: "unlock", d: { idx: 2 } });
    const claimed = b.onEngineMessage({ type: "getLock", block: "p" });
    const acked = b.onOwnFrameAcked(claimed.post[0]!.ref, 9);
    const grant = acked.toEditor.find((m) => m.type === "getLock")!;
    expect((grant.locks as Record<string, { user: string }>)["p"]!.user).toBe(engineUserId(3));
  });
});

/**
 * For text documents the ONLY way a peer's paragraph lock clears in the
 * engine is a locks array riding a saveChanges. A committing member must
 * carry the blocks it held, and a member who leaves must have its blocks
 * released for it, or the red brackets accumulate until nobody can type.
 */
describe("locks release into the engine", () => {
  it("carries the committing member's held blocks on its change frame", () => {
    const b = bridge();
    const claim = b.onEngineMessage({ type: "getLock", block: "para-1" });
    b.onOwnFrameAcked(claim.post[0]!.ref, 5);
    const save = b.onEngineMessage({
      type: "saveChanges",
      changes: JSON.stringify(["edit"]),
      startSaveChanges: true,
      endSaveChanges: true,
      deleteIndex: null,
    });
    expect(save.post[0]!.d.locks).toContain("para-1");
  });

  it("releases a remote committer's blocks into the local engine", () => {
    const b = bridge();
    const effects = b.onRemoteFrame({
      ch: "file-1",
      s: "conn-peer",
      n: 1,
      k: "chg",
      d: { idx: 2, changes: ["edit"], locks: ["para-1"] },
    });
    const save = effects.toEditor.find((m) => m.type === "saveChanges")!;
    expect(save.locks).toEqual([
      expect.objectContaining({ block: "para-1", user: engineUserId(2) }),
    ]);
  });

  it("releases a departed member's locks and erases its cursor", () => {
    const b = bridge();
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "lock", d: { idx: 2, block: "para-9" } });
    const effects = b.onMembers([{ connId: "conn-self", index: 3 }]);
    const release = effects.toEditor.find(
      (m) => m.type === "saveChanges" && Array.isArray(m.locks) && (m.locks as unknown[]).length > 0,
    )!;
    expect(release.locks).toContainEqual(
      expect.objectContaining({ block: "para-9", user: engineUserId(2) }),
    );
    const cursor = effects.toEditor.find((m) => m.type === "cursor")!;
    const msg = (cursor.messages as Array<{ user: string }>)[0]!;
    expect(msg.user).toBe(engineUserId(2));
  });

  it("does not release blocks for a member who is still present", () => {
    const b = bridge();
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "lock", d: { idx: 2, block: "para-9" } });
    const effects = b.onMembers([
      { connId: "conn-self", index: 3 },
      { connId: "conn-peer", index: 2 },
    ]);
    const release = effects.toEditor.find(
      (m) => m.type === "saveChanges" && Array.isArray(m.locks) && (m.locks as unknown[]).length > 0,
    );
    expect(release).toBeUndefined();
  });
});

describe("presence and cursors", () => {
  it("sends cursors as ephemerals, never as durable frames", () => {
    const b = bridge();
    const effects = b.onEngineMessage({ type: "cursor", cursor: { pos: 12 } });
    expect(effects.post).toHaveLength(0);
    expect(effects.eph).toHaveLength(1);
  });

  it("keeps a cursor payload safe from the engine mutating it afterwards", () => {
    const b = bridge();
    const cursor = { pos: 12 };
    const effects = b.onEngineMessage({ type: "cursor", cursor });
    // The engine reuses and mutates the object it handed over.
    cursor.pos = 99;
    expect((effects.eph[0]!.d.cursor as { pos: number }).pos).toBe(12);
  });

  it("turns membership changes into connectState", () => {
    const b = bridge();
    const effects = b.onMembers([
      { connId: "conn-self", index: 3 },
      { connId: "conn-peer", index: 2 },
      { connId: "conn-new", index: 5 },
    ]);
    const message = effects.toEditor.find((m) => m.type === "connectState")!;
    // Three members plus the history keeper.
    expect((message.participants as unknown[]).length).toBe(4);
    expect(
      (message.participants as Array<{ indexUser: number }>).some((p) => p.indexUser === 0),
    ).toBe(true);
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
    const me = (auth.participants as Array<{ indexUser: number; username: string }>).find(
      (p) => p.indexUser === 3,
    )!;
    expect(me.username).toBe("member 3");
  });
});

/**
 * A joiner must learn which locks the room already holds, or its first
 * structure edit collides with an invisible lock, its save cycle never
 * completes, and the engine's only drain for received changes never
 * runs: the exact wedge the no-reload join experiment caught. Stock
 * OnlyOffice carries the table in the auth reply; CryptPad replays the
 * full table via getLock. This bridge does both.
 */
describe("the room's held locks reach a joiner", () => {
  it("carries every held lock in the auth reply", () => {
    const b = bridge();
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "lock", d: { idx: 2, block: "para-4" } });
    const auth = authMessage(b).toEditor.find((m) => m.type === "auth")!;
    const locks = auth.locks as Array<{ block: string; user: string }>;
    expect(locks).toHaveLength(1);
    expect(locks[0]!.block).toBe("para-4");
    expect(locks[0]!.user).toBe(engineUserId(2));
  });

  it("replays the full table when the membership changes", () => {
    const b = bridge();
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "lock", d: { idx: 2, block: "para-4" } });
    const effects = b.onMembers([
      { connId: "conn-self", index: 3 },
      { connId: "conn-peer", index: 2 },
      { connId: "conn-new", index: 5 },
    ]);
    const table = effects.toEditor.find((m) => m.type === "getLock")!;
    const locks = table.locks as Record<string, { user: string }>;
    expect(locks["para-4"]!.user).toBe(engineUserId(2));
  });

  it("keeps the internal save lock out of both", () => {
    const b = bridge();
    // A peer's save lock is bridge bookkeeping, never an engine lock.
    b.onRemoteFrame({ ch: "file-1", s: "conn-peer", n: 1, k: "lock", d: { idx: 2, block: "__save__" } });
    const auth = authMessage(b).toEditor.find((m) => m.type === "auth")!;
    expect(auth.locks as unknown[]).toHaveLength(0);
    const effects = b.onMembers([
      { connId: "conn-self", index: 3 },
      { connId: "conn-new", index: 5 },
    ]);
    expect(effects.toEditor.some((m) => m.type === "getLock")).toBe(false);
  });
});

/**
 * The engine straps its caret position to every change batch (the
 * misleadingly named excelAdditionalInfo carries {UserId, UserShortId,
 * CursorInfo} for word documents too) and updates foreign carets from
 * the same field on receipt. Dropping it on delivery froze remote
 * carets between rare selection changes; a stock server relays it
 * verbatim and so does this bridge.
 */
describe("the caret rides the change batch", () => {
  it("passes the sender's additional info through to the engine", () => {
    const b = bridge();
    const delivered = b.onRemoteFrame({
      ch: "file-1",
      s: "conn-peer",
      n: 1,
      k: "chg",
      d: {
        idx: 2,
        changes: ["chg-a"],
        excelAdditionalInfo: '{"UserId":"u22","CursorInfo":"10;AAA="}',
      },
    });
    const save = delivered.toEditor.find((m) => m.type === "saveChanges")!;
    expect(save.excelAdditionalInfo).toBe('{"UserId":"u22","CursorInfo":"10;AAA="}');
  });

  it("delivers null when the batch carried none", () => {
    const b = bridge();
    const delivered = b.onRemoteFrame({
      ch: "file-1",
      s: "conn-peer",
      n: 1,
      k: "chg",
      d: { idx: 2, changes: ["chg-a"] },
    });
    const save = delivered.toEditor.find((m) => m.type === "saveChanges")!;
    expect(save.excelAdditionalInfo).toBeNull();
  });
});
