import { generateAccountKeys, ready, unlockWithPassword } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, claims, PASSWORD, register } from "./accounts.js";

/**
 * Creating an account, the pre-login key attributes, signing in, and the
 * account itself: the shapes, status codes and wording the web client
 * relies on, identical on both backends.
 */
let target: Target;
let alice: Awaited<ReturnType<typeof register>>;

beforeAll(async () => {
  await ready();
  target = await startTarget({ quotaBytes: 512 * 1024 });
  alice = await register(target, "Alice@Example.com");
});

afterAll(async () => {
  await target?.close();
});

describe("creating an account", () => {
  it("answers 201 with a 30-day session token at epoch 0", () => {
    const { uid, ep, iat, exp } = claims(alice.token);
    expect(uid).toBeGreaterThan(0);
    expect(ep).toBe(0);
    expect((exp - iat) / 86400).toBeCloseTo(30, 5);
  });

  it("refuses a second account for the same email, whatever its case", async () => {
    const keys = generateAccountKeys(PASSWORD);
    const response = await target.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "ALICE@example.com", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "an account with this email already exists" });
  });

  it("refuses password hashing weaker than the floor", async () => {
    const keys = generateAccountKeys(PASSWORD);
    const weak = { ...keys.keyAttributes, kdf: { ...keys.keyAttributes.kdf, opsLimit: 1, memLimit: 8192 } };
    const response = await target.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "weak@example.com", loginKey: keys.loginKey, keyAttributes: weak },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid request" });
  });

  it("refuses an address that is not an email", async () => {
    const keys = generateAccountKeys(PASSWORD);
    const response = await target.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid request" });
  });
});

describe("the pre-login key attributes", () => {
  it("serve the account's own key-derivation parameters", async () => {
    const response = await target.inject({ method: "GET", url: "/api/auth/attributes?email=alice@example.com" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kdf: alice.keys.keyAttributes.kdf });
  });

  it("give an unknown email a stable decoy that looks like a real account", async () => {
    const known = (await target.inject({ method: "GET", url: "/api/auth/attributes?email=alice@example.com" })).json()
      .kdf as { salt: string; opsLimit: number; memLimit: number };
    const unknown = await target.inject({ method: "GET", url: "/api/auth/attributes?email=nobody@example.com" });
    expect(unknown.statusCode).toBe(200);
    const decoy = unknown.json().kdf as { salt: string; opsLimit: number; memLimit: number };
    expect(Object.keys(decoy).sort()).toEqual(Object.keys(known).sort());
    expect(decoy.opsLimit).toBe(known.opsLimit);
    expect(decoy.memLimit).toBe(known.memLimit);
    expect(decoy.salt).not.toBe(known.salt);
    expect(decoy.salt).toMatch(/^[A-Za-z0-9_-]+$/);
    const again = await target.inject({ method: "GET", url: "/api/auth/attributes?email=nobody@example.com" });
    expect(again.json().kdf.salt).toBe(decoy.salt);
  });

  it("refuse a missing or malformed email opaquely", async () => {
    for (const url of ["/api/auth/attributes", "/api/auth/attributes?email=nope"]) {
      const response = await target.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
    }
  });
});

describe("signing in", () => {
  it("returns a token and key attributes the client can unlock with", async () => {
    const response = await target.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", loginKey: alice.keys.loginKey },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(claims(body.token).uid).toBe(claims(alice.token).uid);
    expect(body.keyAttributes).toEqual(alice.keys.keyAttributes);
    const unlocked = unlockWithPassword(PASSWORD, body.keyAttributes);
    expect(unlocked.masterKey).toEqual(alice.keys.masterKey);
  });

  it("refuses a wrong key and an unknown email with the same answer", async () => {
    const wrong = await target.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", loginKey: generateAccountKeys("other").loginKey },
    });
    const unknown = await target.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", loginKey: alice.keys.loginKey },
    });
    for (const response of [wrong, unknown]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid email or password" });
    }
  });

  it("keeps validation errors opaque", async () => {
    for (const payload of [{ email: "alice@example.com" }, { email: "alice@example.com", loginKey: "***not base64***" }]) {
      const response = await target.inject({ method: "POST", url: "/api/auth/login", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
    }
  });
});

describe("a session", () => {
  it("is required, and a damaged token is refused", async () => {
    const tampered = `${alice.token.slice(0, -1)}${alice.token.endsWith("A") ? "B" : "A"}`;
    for (const headers of [undefined, bearer("not-a-token"), bearer(tampered), { authorization: "Basic abc" }]) {
      const response = await target.inject({ method: "GET", url: "/api/user", headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "authentication required" });
    }
  });
});

describe("the account", () => {
  it("describes itself", async () => {
    const response = await target.inject({ method: "GET", url: "/api/user", headers: bearer(alice.token) });
    expect(response.statusCode).toBe(200);
    const user = response.json();
    expect(user).toMatchObject({
      email: "alice@example.com",
      usedBytes: 0,
      quotaBytes: 512 * 1024,
      isAdmin: false,
      displayName: null,
      totpEnabled: false,
      recoveryCodesLeft: 0,
    });
    expect(typeof user.createdAt).toBe("number");
    expect(typeof user.collab.relay).toBe("boolean");
    expect(typeof user.events).toBe("boolean");
  });

  it("takes a display name, trimmed, and clears it when empty", async () => {
    const set = await target.inject({
      method: "PATCH",
      url: "/api/user",
      headers: bearer(alice.token),
      payload: { displayName: "  Alice  " },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ displayName: "Alice" });
    const read = await target.inject({ method: "GET", url: "/api/user", headers: bearer(alice.token) });
    expect(read.json().displayName).toBe("Alice");
    for (const displayName of ["", null]) {
      const cleared = await target.inject({
        method: "PATCH",
        url: "/api/user",
        headers: bearer(alice.token),
        payload: { displayName },
      });
      expect(cleared.json()).toEqual({ displayName: null });
    }
  });

  it("refuses a display name that is too long or missing", async () => {
    for (const payload of [{ displayName: "x".repeat(65) }, {}]) {
      const response = await target.inject({
        method: "PATCH",
        url: "/api/user",
        headers: bearer(alice.token),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request" });
    }
  });

  it("serves its key attributes to a signed-in session", async () => {
    const response = await target.inject({
      method: "GET",
      url: "/api/user/key-attributes",
      headers: bearer(alice.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ keyAttributes: alice.keys.keyAttributes });
  });
});
