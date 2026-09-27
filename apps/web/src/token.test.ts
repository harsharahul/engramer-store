import { describe, expect, it } from "vitest";
import { RENEW_AFTER_MS, tokenDueForRenewal, tokenIssuedAtMs } from "./token";

/** An unsigned token with the given claims: the client reads, never verifies. */
function tokenWith(claims: Record<string, unknown>): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

describe("token issue time", () => {
  it("reads iat in milliseconds", () => {
    expect(tokenIssuedAtMs(tokenWith({ uid: 1, iat: 1_700_000_000, exp: 1_702_592_000 }))).toBe(
      1_700_000_000_000,
    );
  });

  it("is null for anything that is not a token, or carries no iat", () => {
    expect(tokenIssuedAtMs("")).toBeNull();
    expect(tokenIssuedAtMs("not.a.token")).toBeNull();
    expect(tokenIssuedAtMs("a.b")).toBeNull();
    expect(tokenIssuedAtMs(tokenWith({ uid: 1 }))).toBeNull();
    expect(tokenIssuedAtMs(tokenWith({ uid: 1, iat: "soon" }))).toBeNull();
  });

  it("is due for renewal after a day, and never on a token it cannot read", () => {
    const now = 1_800_000_000_000;
    const fresh = tokenWith({ iat: Math.floor((now - RENEW_AFTER_MS / 2) / 1000) });
    const aged = tokenWith({ iat: Math.floor((now - RENEW_AFTER_MS - 60_000) / 1000) });
    expect(tokenDueForRenewal(fresh, now)).toBe(false);
    expect(tokenDueForRenewal(aged, now)).toBe(true);
    expect(tokenDueForRenewal("opaque", now)).toBe(false);
  });
});
