import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAccountKeys, ready } from "@engramer/crypto";
import { buildApp } from "../src/app.js";

/**
 * Session keys let a tab survive a reload without holding the master key
 * in the clear: the tab stores its keys sealed under a random key the
 * server hands out only to the live session that minted it. Signing out
 * everywhere advances the token epoch and deletes every stored key.
 */

let app: FastifyInstance;
let dataDir: string;
let token: string;
let otherToken: string;

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
  dataDir = mkdtempSync(join(tmpdir(), "engramer-sessions-test-"));
  app = await buildApp({ dataDir, quotaBytes: 512 * 1024, webDistDir: null });
  token = await registerAccount("tab@example.com");
  otherToken = await registerAccount("other@example.com");
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = (t = token) => ({ authorization: `Bearer ${t}` });

describe("session keys", () => {
  it("mints a random key and returns it to the same session only", async () => {
    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth() });
    expect(minted.statusCode).toBe(201);
    const { id, key } = minted.json() as { id: string; key: string };
    expect(id.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeGreaterThanOrEqual(40);

    const fetched = await app.inject({ method: "GET", url: `/api/auth/session-key/${id}`, headers: auth() });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().key).toBe(key);

    const stranger = await app.inject({
      method: "GET",
      url: `/api/auth/session-key/${id}`,
      headers: auth(otherToken),
    });
    expect(stranger.statusCode).toBe(404);

    const anonymous = await app.inject({ method: "GET", url: `/api/auth/session-key/${id}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it("two mints never share a key", async () => {
    const a = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth() });
    const b = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth() });
    expect(a.json().key).not.toBe(b.json().key);
    expect(a.json().id).not.toBe(b.json().id);
  });

  it("deleting a key makes it unfetchable; deleting again is harmless", async () => {
    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth() });
    const { id } = minted.json() as { id: string };
    const gone = await app.inject({ method: "DELETE", url: `/api/auth/session-key/${id}`, headers: auth() });
    expect(gone.statusCode).toBe(204);
    const fetched = await app.inject({ method: "GET", url: `/api/auth/session-key/${id}`, headers: auth() });
    expect(fetched.statusCode).toBe(404);
    const again = await app.inject({ method: "DELETE", url: `/api/auth/session-key/${id}`, headers: auth() });
    expect(again.statusCode).toBe(204);
  });

  it("cannot delete another account's key", async () => {
    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth() });
    const { id } = minted.json() as { id: string };
    await app.inject({ method: "DELETE", url: `/api/auth/session-key/${id}`, headers: auth(otherToken) });
    const fetched = await app.inject({ method: "GET", url: `/api/auth/session-key/${id}`, headers: auth() });
    expect(fetched.statusCode).toBe(200);
  });
});

describe("sign out everywhere", () => {
  it("refuses every earlier token and key, and keeps the caller signed in with a new one", async () => {
    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth() });
    const { id } = minted.json() as { id: string };
    const before = token;

    const revoked = await app.inject({
      method: "POST",
      url: "/api/auth/sessions/revoke-all",
      headers: auth(before),
    });
    expect(revoked.statusCode).toBe(200);
    const fresh = revoked.json().token as string;
    expect(fresh).not.toBe(before);

    // The old token is dead on an ordinary route.
    const stale = await app.inject({ method: "GET", url: "/api/user", headers: auth(before) });
    expect(stale.statusCode).toBe(401);
    // The new one works.
    const live = await app.inject({ method: "GET", url: "/api/user", headers: auth(fresh) });
    expect(live.statusCode).toBe(200);
    // The key minted before the revoke is gone even for the new session.
    const fetched = await app.inject({ method: "GET", url: `/api/auth/session-key/${id}`, headers: auth(fresh) });
    expect(fetched.statusCode).toBe(404);
    // A fresh mint under the new session works as before.
    const next = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth(fresh) });
    expect(next.statusCode).toBe(201);
    token = fresh;
  });

  it("does not touch other accounts", async () => {
    const theirs = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: auth(otherToken) });
    const { id } = theirs.json() as { id: string };
    await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-all", headers: auth() });
    const stillThere = await app.inject({
      method: "GET",
      url: `/api/auth/session-key/${id}`,
      headers: auth(otherToken),
    });
    expect(stillThere.statusCode).toBe(200);
  });
});
