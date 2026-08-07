import { describe, expect, it } from "vitest";
import { answerServerMessage } from "./session";
import { CollabBridge } from "./collab";

/**
 * The regression net for single-user editing. Every office document ever
 * opened runs through these answers; the collaborative path must change
 * NOTHING here. The expected shapes are pinned to what shipped, byte for
 * byte, before any bridge existed.
 */

describe("single-user answers (no bridge)", () => {
  it("answers auth with one hardcoded participant and no history", () => {
    const { toEditor } = answerServerMessage({ type: "auth" });
    expect(toEditor[0]).toEqual({ type: "authChanges", changes: [] });
    const auth = toEditor[1] as Record<string, unknown>;
    expect(auth.type).toBe("auth");
    expect(auth.result).toBe(1);
    expect(auth.sessionId).toBe("session-id");
    expect(auth.participants).toEqual([
      { id: "0", idOriginal: "0", username: "you", indexUser: 0, connectionId: "local" },
    ]);
    expect(auth.locks).toEqual([]);
    expect(auth.changes).toEqual([]);
    expect(auth.changesIndex).toBe(0);
    expect(auth.indexUser).toBe(0);
    const open = toEditor[2] as Record<string, unknown>;
    expect(open.type).toBe("documentOpen");
    expect((open.data as Record<string, unknown>).status ?? (open.data as { status?: string })).toBeDefined();
  });

  it("keeps the document address the engine asked for", () => {
    const { toEditor } = answerServerMessage({
      type: "auth",
      openCmd: { url: "engram:document" },
    });
    const open = toEditor[2] as { data: { data: Record<string, string> } };
    expect(open.data.data["Editor.bin"]).toBe("engram:document");
  });

  it("never save-locks a single user", () => {
    const { toEditor } = answerServerMessage({ type: "isSaveLock" });
    expect(toEditor).toEqual([{ type: "saveLock", saveLock: false }]);
  });

  it("grants every lock instantly", () => {
    const { toEditor } = answerServerMessage({ type: "getLock" });
    expect(toEditor).toEqual([{ type: "getLock", locks: {} }]);
  });

  it("acknowledges saveChanges immediately", () => {
    const { toEditor } = answerServerMessage({ type: "saveChanges" });
    expect(toEditor).toHaveLength(1);
    const ack = toEditor[0] as Record<string, unknown>;
    expect(ack.type).toBe("unSaveLock");
    expect(ack.index).toBe(0);
    expect(typeof ack.time).toBe("number");
  });

  it("answers unLockDocument only when it is a save", () => {
    expect(answerServerMessage({ type: "unLockDocument", isSave: true }).toEditor).toEqual([
      { type: "unSaveLock", time: -1, index: -1 },
    ]);
    expect(answerServerMessage({ type: "unLockDocument" }).toEditor).toEqual([]);
  });

  it("answers getMessages with an empty chat", () => {
    expect(answerServerMessage({ type: "getMessages" }).toEditor).toEqual([{ type: "message" }]);
  });

  it("stays silent on anything else", () => {
    expect(answerServerMessage({ type: "mystery" }).toEditor).toEqual([]);
  });
});

describe("collaborative answers (bridge attached)", () => {
  it("delegates auth to the bridge's membership", () => {
    const bridge = new CollabBridge({
      fileId: "f1",
      selfConnId: "me",
      selfIndex: 4,
      members: [
        { connId: "me", index: 4 },
        { connId: "peer", index: 1 },
      ],
    });
    const { toEditor } = answerServerMessage({ type: "auth" }, bridge);
    const auth = toEditor.find((m) => (m as { type?: string }).type === "auth") as Record<
      string,
      unknown
    >;
    expect(auth.indexUser).toBe(4);
    expect((auth.participants as unknown[]).length).toBe(2);
  });

  it("posts instead of self-acknowledging a saveChanges", () => {
    const bridge = new CollabBridge({
      fileId: "f1",
      selfConnId: "me",
      selfIndex: 4,
      members: [{ connId: "me", index: 4 }],
    });
    const effects = answerServerMessage(
      { type: "saveChanges", changes: JSON.stringify(["a"]), endSaveChanges: true },
      bridge,
    );
    expect(effects.post).toHaveLength(1);
    expect(effects.toEditor.some((m) => (m as { type?: string }).type === "unSaveLock")).toBe(
      false,
    );
  });
});
