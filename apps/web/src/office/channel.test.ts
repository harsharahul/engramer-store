import { beforeAll, describe, expect, it } from "vitest";
import { generateKey, ready } from "@engramer/crypto";
import {
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
