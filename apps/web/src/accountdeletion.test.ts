import { beforeAll, describe, expect, it } from "vitest";
import { generateAccountKeys, ready } from "@engramer/crypto";
import { deletionProof } from "./accountdeletion";

describe("deletion proof", () => {
  beforeAll(() => ready());

  it("is the login key when the password opens the master key", () => {
    const account = generateAccountKeys("orchid lantern velvet thimble");
    expect(deletionProof("orchid lantern velvet thimble", account.keyAttributes)).toBe(account.loginKey);
  });

  it("refuses a wrong password before anything reaches the server", () => {
    const account = generateAccountKeys("orchid lantern velvet thimble");
    expect(() => deletionProof("something else", account.keyAttributes)).toThrow(/not your password/);
  });
});
