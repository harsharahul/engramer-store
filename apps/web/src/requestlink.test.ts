import { beforeAll, describe, expect, it } from "vitest";
import { ready, toB64, utf8Encode } from "@engramer/crypto";
import { buildRequestFragment, parseRequestFragment } from "./requestlink";

beforeAll(async () => {
  await ready();
});

describe("request link fragment", () => {
  it("carries the label and the owner's public key, and reads them back", () => {
    const fragment = buildRequestFragment("Tax documents 2026", "owner-public-key");
    expect(parseRequestFragment(fragment)).toEqual({
      label: "Tax documents 2026",
      publicKey: "owner-public-key",
    });
    expect(parseRequestFragment(`#${fragment}`).publicKey).toBe("owner-public-key");
  });

  it("still reads links minted with a bare label", () => {
    expect(parseRequestFragment(toB64(utf8Encode("Receipts")))).toEqual({ label: "Receipts" });
  });

  it("treats a malformed fragment as no label rather than an error", () => {
    expect(parseRequestFragment("")).toEqual({ label: "" });
    expect(parseRequestFragment("!!not base64!!")).toEqual({ label: "" });
  });
});
