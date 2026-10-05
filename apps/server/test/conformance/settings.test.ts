import { ready } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";

/**
 * Account settings travel as one client-sealed blob the backend cannot
 * read, and a write advances the account's change sequence so other
 * devices are poked to pull.
 */
let target: Target;
let token: string;

beforeAll(async () => {
  await ready();
  target = await startTarget();
  token = (await register(target, "settings@example.com")).token;
});

afterAll(async () => {
  await target?.close();
});

const auth = (t = token) => bearer(t);
const seq = async (t = token) =>
  (await target.inject({ method: "GET", url: "/api/sync?since=0", headers: auth(t) })).json().seq as number;

describe("account settings", () => {
  it("answers empty for an account that never stored any", async () => {
    const response = await target.inject({ method: "GET", url: "/api/settings", headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ blob: null, updatedAt: 0 });
  });

  it("round-trips the sealed blob with a server timestamp", async () => {
    const put = await target.inject({ method: "PUT", url: "/api/settings", headers: auth(), payload: { blob: "sealed-settings-v1" } });
    expect(put.statusCode).toBe(200);
    const stamped = put.json().updatedAt as number;
    expect(stamped).toBeGreaterThan(0);
    const got = await target.inject({ method: "GET", url: "/api/settings", headers: auth() });
    expect(got.json()).toEqual({ blob: "sealed-settings-v1", updatedAt: stamped });
  });

  it("last write wins, and the stamp moves forward", async () => {
    const first = await target.inject({ method: "PUT", url: "/api/settings", headers: auth(), payload: { blob: "older" } });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = await target.inject({ method: "PUT", url: "/api/settings", headers: auth(), payload: { blob: "newer" } });
    expect(second.json().updatedAt).toBeGreaterThan(first.json().updatedAt);
    const got = await target.inject({ method: "GET", url: "/api/settings", headers: auth() });
    expect(got.json().blob).toBe("newer");
  });

  it("advances the account's change sequence by one per write", async () => {
    const before = await seq();
    const put = await target.inject({ method: "PUT", url: "/api/settings", headers: auth(), payload: { blob: "a decision" } });
    expect(put.statusCode).toBe(200);
    expect(await seq()).toBe(before + 1);
  });

  it("keeps accounts apart", async () => {
    const other = (await register(target, "other-settings@example.com")).token;
    const got = await target.inject({ method: "GET", url: "/api/settings", headers: auth(other) });
    expect(got.json()).toEqual({ blob: null, updatedAt: 0 });
    expect(await seq(other)).toBe(0);
  });

  it("requires a session", async () => {
    const got = await target.inject({ method: "GET", url: "/api/settings" });
    expect(got.statusCode).toBe(401);
  });

  it("refuses a blob too large to be settings, or none at all", async () => {
    for (const payload of [{ blob: "x".repeat(20_000) }, {}, { blob: null }]) {
      const put = await target.inject({ method: "PUT", url: "/api/settings", headers: auth(), payload });
      expect(put.statusCode).toBe(400);
      expect(put.json()).toEqual({ error: "invalid request" });
    }
  });
});
