import { ready } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, claims, register, signToken } from "./accounts.js";

/**
 * Session keys let a tab survive a reload without holding the master key
 * in the clear: the tab stores its keys sealed under a random key handed
 * out only to the live session that minted it. Signing out everywhere
 * advances the token epoch and deletes every stored key; renewal extends
 * a live session and revokes nothing.
 */
let target: Target;
let token: string;
let otherToken: string;

beforeAll(async () => {
  await ready();
  target = await startTarget();
  token = (await register(target, "tab@example.com")).token;
  otherToken = (await register(target, "other@example.com")).token;
});

afterAll(async () => {
  await target?.close();
});

const mint = async (t = token) =>
  (await target.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(t) })).json() as {
    id: string;
    key: string;
  };
const fetchKey = (id: string, t = token) =>
  target.inject({ method: "GET", url: `/api/auth/session-key/${id}`, headers: bearer(t) });

describe("session keys", () => {
  it("mints a random key and returns it to the same session only", async () => {
    const minted = await target.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(token) });
    expect(minted.statusCode).toBe(201);
    const { id, key } = minted.json() as { id: string; key: string };
    expect(id.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeGreaterThanOrEqual(40);
    const fetched = await fetchKey(id);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual({ key });
    const stranger = await fetchKey(id, otherToken);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json()).toEqual({ error: "session key not found" });
    const anonymous = await target.inject({ method: "GET", url: `/api/auth/session-key/${id}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it("two mints never share a key", async () => {
    const a = await mint();
    const b = await mint();
    expect(a.key).not.toBe(b.key);
    expect(a.id).not.toBe(b.id);
  });

  it("deleting a key makes it unfetchable; deleting again is harmless", async () => {
    const { id } = await mint();
    const gone = await target.inject({ method: "DELETE", url: `/api/auth/session-key/${id}`, headers: bearer(token) });
    expect(gone.statusCode).toBe(204);
    expect(gone.body).toBe("");
    expect((await fetchKey(id)).statusCode).toBe(404);
    const again = await target.inject({ method: "DELETE", url: `/api/auth/session-key/${id}`, headers: bearer(token) });
    expect(again.statusCode).toBe(204);
  });

  it("keeps only the newest fifty keys for an account", async () => {
    const { id: oldest } = await mint();
    // Keys minted in the same millisecond are ordered by their random id;
    // a pause makes the first one unambiguously the oldest.
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 55; i++) {
      await mint();
    }
    const { id: newest } = await mint();
    expect((await fetchKey(oldest)).statusCode).toBe(404);
    expect((await fetchKey(newest)).statusCode).toBe(200);
    const { id: theirs } = await mint(otherToken);
    for (let i = 0; i < 55; i++) {
      await mint();
    }
    expect((await fetchKey(theirs, otherToken)).statusCode).toBe(200);
  });

  it("cannot delete another account's key", async () => {
    const { id } = await mint();
    await target.inject({ method: "DELETE", url: `/api/auth/session-key/${id}`, headers: bearer(otherToken) });
    expect((await fetchKey(id)).statusCode).toBe(200);
  });
});

describe("sign out everywhere", () => {
  it("refuses every earlier token and key, and keeps the caller signed in with a new one", async () => {
    const { id } = await mint();
    const before = token;
    const revoked = await target.inject({
      method: "POST",
      url: "/api/auth/sessions/revoke-all",
      headers: bearer(before),
    });
    expect(revoked.statusCode).toBe(200);
    const fresh = revoked.json().token as string;
    expect(fresh).not.toBe(before);
    expect(claims(fresh).ep).toBe(claims(before).ep + 1);
    expect((await target.inject({ method: "GET", url: "/api/user", headers: bearer(before) })).statusCode).toBe(401);
    expect((await target.inject({ method: "GET", url: "/api/user", headers: bearer(fresh) })).statusCode).toBe(200);
    expect((await fetchKey(id, fresh)).statusCode).toBe(404);
    const next = await target.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(fresh) });
    expect(next.statusCode).toBe(201);
    token = fresh;
  });

  it("does not touch other accounts", async () => {
    const { id } = await mint(otherToken);
    await target.inject({ method: "POST", url: "/api/auth/sessions/revoke-all", headers: bearer(token) });
    expect((await fetchKey(id, otherToken)).statusCode).toBe(200);
  });
});

describe("session renewal", () => {
  let renewing: string;

  beforeAll(async () => {
    renewing = (await register(target, "renew@example.com")).token;
  });

  it("hands a live session a fresh 30-day token at the same epoch, and the old one keeps working", async () => {
    const before = renewing;
    // A token signed a second later differs even with identical claims.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const renewed = await target.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(before) });
    expect(renewed.statusCode).toBe(200);
    const fresh = renewed.json().token as string;
    expect(fresh).not.toBe(before);
    expect(claims(fresh).uid).toBe(claims(before).uid);
    expect(claims(fresh).ep).toBe(claims(before).ep);
    expect(claims(fresh).iat).toBeGreaterThan(claims(before).iat);
    expect((claims(fresh).exp - claims(fresh).iat) / 86400).toBeCloseTo(30, 5);
    expect((await target.inject({ method: "GET", url: "/api/user", headers: bearer(before) })).statusCode).toBe(200);
    expect((await target.inject({ method: "GET", url: "/api/user", headers: bearer(fresh) })).statusCode).toBe(200);
    renewing = fresh;
  });

  it("refuses an expired token and one from before a revocation", async () => {
    const { uid, ep } = claims(renewing);
    const now = Math.floor(Date.now() / 1000);
    const expired = signToken(target, { uid, ep, iat: now - 10, exp: now - 1 });
    expect((await target.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(expired) })).statusCode).toBe(
      401,
    );
    const earlier = renewing;
    const revoked = await target.inject({
      method: "POST",
      url: "/api/auth/sessions/revoke-all",
      headers: bearer(earlier),
    });
    renewing = revoked.json().token as string;
    expect((await target.inject({ method: "POST", url: "/api/auth/refresh", headers: bearer(earlier) })).statusCode).toBe(
      401,
    );
    expect((await target.inject({ method: "POST", url: "/api/auth/refresh" })).statusCode).toBe(401);
  });

  it("accepts a token the target's own secret signs, so both backends share one token format", async () => {
    const { uid, ep } = claims(renewing);
    const now = Math.floor(Date.now() / 1000);
    const handmade = signToken(target, { uid, ep, iat: now, exp: now + 60 });
    expect((await target.inject({ method: "GET", url: "/api/user", headers: bearer(handmade) })).statusCode).toBe(200);
  });
});
