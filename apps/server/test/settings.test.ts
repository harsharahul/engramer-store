import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAccountKeys, ready } from "@engramer/crypto";
import { buildApp } from "../src/app.js";

/**
 * Account settings travel as one client-sealed blob the server cannot
 * read. Without this, every preference lived in a device's local storage
 * and the same switches had to be flipped again on every device (and
 * again whenever iOS evicted the storage).
 */

let app: FastifyInstance;
let dataDir: string;
let token: string;

async function registerAccount(email: string) {
  const keys = generateAccountKeys("correct horse battery staple");
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, loginKey: keys.loginKey, keyAttributes: keys.keyAttributes },
  });
  expect(response.statusCode).toBe(201);
  return response.json().token as string;
}

beforeAll(async () => {
  await ready();
  dataDir = mkdtempSync(join(tmpdir(), "engramer-settings-test-"));
  app = await buildApp({ dataDir, quotaBytes: 512 * 1024, webDistDir: null });
  token = await registerAccount("settings@example.com");
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = (t = token) => ({ authorization: `Bearer ${t}` });

describe("account settings", () => {
  it("answers empty for an account that never stored any", async () => {
    const response = await app.inject({ method: "GET", url: "/api/settings", headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ blob: null, updatedAt: 0 });
  });

  it("round-trips the sealed blob with a server timestamp", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(),
      payload: { blob: "sealed-settings-v1" },
    });
    expect(put.statusCode).toBe(200);
    const stamped = put.json().updatedAt as number;
    expect(stamped).toBeGreaterThan(0);
    const got = await app.inject({ method: "GET", url: "/api/settings", headers: auth() });
    expect(got.json()).toEqual({ blob: "sealed-settings-v1", updatedAt: stamped });
  });

  it("last write wins, and the stamp moves forward", async () => {
    const first = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(),
      payload: { blob: "older" },
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(),
      payload: { blob: "newer" },
    });
    expect(second.json().updatedAt).toBeGreaterThan(first.json().updatedAt);
    const got = await app.inject({ method: "GET", url: "/api/settings", headers: auth() });
    expect(got.json().blob).toBe("newer");
  });

  it("keeps accounts apart", async () => {
    const other = await registerAccount("other-settings@example.com");
    const got = await app.inject({ method: "GET", url: "/api/settings", headers: auth(other) });
    expect(got.json()).toEqual({ blob: null, updatedAt: 0 });
  });

  it("requires a session", async () => {
    const got = await app.inject({ method: "GET", url: "/api/settings" });
    expect(got.statusCode).toBe(401);
  });

  it("refuses a blob too large to be settings", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(),
      payload: { blob: "x".repeat(20_000) },
    });
    expect(put.statusCode).toBe(400);
  });
});
