import { ready } from "@engramer/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTarget, type Target } from "../helpers/target.js";
import { bearer, register } from "./accounts.js";

/**
 * The change feed's read side. Rows arrive with the storage routes; here
 * the cursor, the response shape and the paging parameters are pinned.
 */
let target: Target;
let token: string;

beforeAll(async () => {
  await ready();
  target = await startTarget();
  token = (await register(target, "sync@example.com")).token;
});

afterAll(async () => {
  await target?.close();
});

describe("sync", () => {
  it("answers a new account with its cursor and nothing to pull", async () => {
    const response = await target.inject({ method: "GET", url: "/api/sync?since=0", headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ seq: 0, folders: [], files: [], shared: [] });
  });

  it("moves the cursor when the account changes", async () => {
    await target.inject({ method: "PUT", url: "/api/settings", headers: bearer(token), payload: { blob: "x" } });
    const response = await target.inject({ method: "GET", url: "/api/sync", headers: bearer(token) });
    expect(response.json()).toEqual({ seq: 1, folders: [], files: [], shared: [] });
  });

  it("accepts a page size and a cursor", async () => {
    const response = await target.inject({ method: "GET", url: "/api/sync?since=1&limit=1", headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ seq: 1, folders: [], files: [], shared: [] });
  });

  it("requires a session", async () => {
    const response = await target.inject({ method: "GET", url: "/api/sync?since=0" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication required" });
  });
});
