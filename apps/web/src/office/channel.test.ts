import { beforeAll, describe, expect, it } from "vitest";
import { generateKey, ready } from "@engramer/crypto";
import {
  acceptEphemeral,
  acceptFrame,
  decryptFrame,
  encryptFrame,
  newChannelOrder,
  type ChannelFrame,
} from "./channel";

const frame = (over: Partial<ChannelFrame> = {}): ChannelFrame => ({
  ch: "file-1",
  s: "conn-a",
  n: 1,
  k: "chg",
  d: { changes: ["64;AAAA"] },
  ...over,
});

describe("frame crypto", () => {
  beforeAll(async () => {
    await ready();
  });

  it("round-trips a frame under the file key", () => {
    const key = generateKey();
    const sealed = encryptFrame(frame(), key);
    expect(typeof sealed).toBe("string");
    expect(sealed).not.toContain("chg");
    expect(decryptFrame(sealed, key)).toEqual(frame());
  });

  it("rejects a tampered payload", () => {
    const key = generateKey();
    const sealed = encryptFrame(frame(), key);
    const middle = Math.floor(sealed.length / 2);
    const flipped = sealed[middle] === "A" ? "B" : "A";
    const tampered = sealed.slice(0, middle) + flipped + sealed.slice(middle + 1);
    expect(() => decryptFrame(tampered, key)).toThrow();
  });

  it("rejects a frame under the wrong key", () => {
    const sealed = encryptFrame(frame(), generateKey());
    expect(() => decryptFrame(sealed, generateKey())).toThrow();
  });
});

describe("acceptance order", () => {
  it("applies in-order frames and advances the per-sender counter", () => {
    const order = newChannelOrder("file-1");
    expect(acceptFrame(order, frame({ n: 1 }))).toBe("apply");
    expect(acceptFrame(order, frame({ n: 2 }))).toBe("apply");
    expect(acceptFrame(order, frame({ s: "conn-b", n: 1 }))).toBe("apply");
  });

  it("drops duplicates and replays", () => {
    const order = newChannelOrder("file-1");
    expect(acceptFrame(order, frame({ n: 1 }))).toBe("apply");
    expect(acceptFrame(order, frame({ n: 1 }))).toBe("drop");
  });

  it("drops frames addressed to another document", () => {
    const order = newChannelOrder("file-1");
    expect(acceptFrame(order, frame({ ch: "file-2" }))).toBe("drop");
  });

  it("demands a resync on a counter gap, never applies out of order", () => {
    const order = newChannelOrder("file-1");
    expect(acceptFrame(order, frame({ n: 1 }))).toBe("apply");
    expect(acceptFrame(order, frame({ n: 3 }))).toBe("resync");
    // After the gap, nothing further from that sender is trusted either.
    expect(acceptFrame(order, frame({ n: 4 }))).toBe("resync");
  });
});

/**
 * Every member holds the same file key, so a frame's self-declared sender
 * proves nothing: only the relay knows which connection actually sent it.
 * Binding the two is what stops one member forging another's identity —
 * stealing their locks, or minting objects under their index.
 */
describe("sender binding", () => {
  it("drops a frame whose claimed sender is not the one who sent it", () => {
    const order = newChannelOrder("file-1");
    expect(acceptFrame(order, frame({ s: "conn-a", n: 1 }), "conn-a")).toBe("apply");
    // Forged: claims to be conn-a, actually arrived from conn-b.
    expect(acceptFrame(order, frame({ s: "conn-a", n: 2 }), "conn-b")).toBe("drop");
  });

  it("leaves a forged frame unable to poison the counter", () => {
    const order = newChannelOrder("file-1");
    acceptFrame(order, frame({ s: "conn-a", n: 1 }), "conn-a");
    // A wild counter from an impostor must not break the real sender's run.
    expect(acceptFrame(order, frame({ s: "conn-a", n: 999 }), "conn-b")).toBe("drop");
    expect(acceptFrame(order, frame({ s: "conn-a", n: 2 }), "conn-a")).toBe("apply");
  });
});

/**
 * Ephemerals bypass the ordered log by design, so they get the strictest
 * check of all: this document, this sender, and cursors only. Anything
 * else arriving on that path would be an unordered, unreplayable write.
 */
describe("acceptEphemeral", () => {
  it("accepts a cursor from the attested sender on this document", () => {
    expect(acceptEphemeral("file-1", frame({ k: "cursor", s: "conn-b" }), "conn-b")).toBe(true);
  });

  it("refuses a document change dressed as an ephemeral", () => {
    expect(acceptEphemeral("file-1", frame({ k: "chg", s: "conn-b" }), "conn-b")).toBe(false);
    expect(acceptEphemeral("file-1", frame({ k: "lock", s: "conn-b" }), "conn-b")).toBe(false);
    expect(acceptEphemeral("file-1", frame({ k: "unlock", s: "conn-b" }), "conn-b")).toBe(false);
    expect(acceptEphemeral("file-1", frame({ k: "snap-done", s: "conn-b" }), "conn-b")).toBe(false);
  });

  it("refuses a forged sender or another document", () => {
    expect(acceptEphemeral("file-1", frame({ k: "cursor", s: "conn-a" }), "conn-b")).toBe(false);
    expect(acceptEphemeral("file-2", frame({ k: "cursor", s: "conn-b" }), "conn-b")).toBe(false);
  });
});
