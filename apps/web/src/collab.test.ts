import { beforeAll, describe, expect, it } from "vitest";
import { generateKey, generateKeyPair, ready } from "@engramer/crypto";
import { inviteLink, openSharedFileKey, parseInviteToken, sealFileKeyFor } from "./collab";
import type { Session } from "./session";

const sessionFor = (pair: ReturnType<typeof generateKeyPair>): Session => ({
  email: "recipient@example.com",
  token: "jwt",
  masterKey: generateKey(),
  privateKey: pair.privateKey,
  publicKey: pair.publicKey,
});

describe("collab keys", () => {
  beforeAll(async () => {
    await ready();
  });

  it("seals a file key that only the recipient's key pair opens", () => {
    const recipient = generateKeyPair();
    const fileKey = generateKey();
    const sealed = sealFileKeyFor(fileKey, recipient.publicKey);
    expect(openSharedFileKey(sealed, sessionFor(recipient))).toEqual(fileKey);
  });

  it("refuses a seal opened with the wrong key pair", () => {
    const recipient = generateKeyPair();
    const stranger = generateKeyPair();
    const sealed = sealFileKeyFor(generateKey(), recipient.publicKey);
    expect(() => openSharedFileKey(sealed, sessionFor(stranger))).toThrow();
  });

  it("refuses a tampered sealed key", () => {
    const recipient = generateKeyPair();
    const sealed = sealFileKeyFor(generateKey(), recipient.publicKey);
    const middle = Math.floor(sealed.length / 2);
    const flipped = sealed[middle] === "A" ? "B" : "A";
    const tampered = sealed.slice(0, middle) + flipped + sealed.slice(middle + 1);
    expect(() => openSharedFileKey(tampered, sessionFor(recipient))).toThrow();
  });
});

describe("invite links", () => {
  it("builds the invite path from the token", () => {
    expect(inviteLink("tok_abc-123", "https://store.example.com")).toBe(
      "https://store.example.com/c/tok_abc-123",
    );
  });

  it("carries no key material in the fragment", () => {
    // A regression guard: the whole point of the claim flow is that the
    // invite conveys identity, never the key. Nothing may append one later.
    expect(inviteLink("tok", "https://store.example.com")).not.toContain("#");
  });

  it("parses its own links and refuses everything else", () => {
    expect(parseInviteToken("/c/tok_abc-123")).toBe("tok_abc-123");
    expect(parseInviteToken("/c/")).toBeNull();
    expect(parseInviteToken("/s/tok")).toBeNull();
    expect(parseInviteToken("/c/tok/extra")).toBeNull();
  });
});
