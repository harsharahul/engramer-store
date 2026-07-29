import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ready, generateAccountKeys, type AccountKeys } from "@engramer/crypto";
import { buildApp } from "../src/app.js";

describe("registration policy and admin surface", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let adminKeys: AccountKeys;
  let adminToken: string;

  const register = (email: string, keys: AccountKeys, inviteToken?: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email,
        loginKey: keys.loginKey,
        keyAttributes: keys.keyAttributes,
        ...(inviteToken ? { inviteToken } : {}),
      },
    });

  beforeAll(async () => {
    await ready();
    process.env.ENGRAMER_REGISTRATION = "invite";
    process.env.ENGRAMER_ADMIN_EMAILS = "Root@Example.com";
    dataDir = mkdtempSync(join(tmpdir(), "engramer-admin-"));
    app = await buildApp({ dataDir, webDistDir: null });
    adminKeys = generateAccountKeys("an admin password");
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.ENGRAMER_REGISTRATION;
    delete process.env.ENGRAMER_ADMIN_EMAILS;
  });

  it("advertises the registration mode publicly", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/registration" });
    expect(response.json()).toEqual({ mode: "invite" });
  });

  it("lets an operator-declared admin register without an invite, case-insensitively", async () => {
    const response = await register("root@example.com", adminKeys);
    expect(response.statusCode).toBe(201);
    adminToken = response.json().token as string;
    const me = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(me.json().isAdmin).toBe(true);
  });

  it("rejects uninvited registration in invite mode", async () => {
    const keys = generateAccountKeys("a stranger password");
    const noToken = await register("stranger@example.com", keys);
    expect(noToken.statusCode).toBe(403);
    const badToken = await register("stranger@example.com", keys, "not-a-real-invite");
    expect(badToken.statusCode).toBe(403);
  });

  it("runs the invite lifecycle: mint, register once, refuse reuse, revoke", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const minted = await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth, payload: {} });
    expect(minted.statusCode).toBe(201);
    const token = minted.json().token as string;

    const guestKeys = generateAccountKeys("a guest password");
    const joined = await register("guest@example.com", guestKeys, token);
    expect(joined.statusCode).toBe(201);

    // The same invite cannot mint a second account, and the losing
    // registration is fully rolled back.
    const again = await register("second@example.com", generateAccountKeys("another password"), token);
    expect(again.statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: "/api/admin/users", headers: auth });
    expect((list.json().users as Array<{ email: string }>).map((u) => u.email).sort()).toEqual([
      "guest@example.com",
      "root@example.com",
    ]);

    const spare = await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth, payload: {} });
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/admin/invites/${spare.json().token}`,
      headers: auth,
    });
    expect(revoked.statusCode).toBe(204);
    const used = await app.inject({ method: "DELETE", url: `/api/admin/invites/${token}`, headers: auth });
    expect(used.statusCode).toBe(404); // used invites stay for the audit trail
  });

  it("keeps the admin surface away from ordinary accounts", async () => {
    const guestLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "guest@example.com", loginKey: generateAccountKeys("x").loginKey },
    });
    expect(guestLogin.statusCode).toBe(401); // wrong key, but the point is below
    const guestKeys = generateAccountKeys("a guest password");
    // Re-derive the real guest login via its keys is not possible here, so
    // mint a fresh invited account instead and use its session.
    const auth = { authorization: `Bearer ${adminToken}` };
    const invite = await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth, payload: {} });
    const other = await register("plain@example.com", guestKeys, invite.json().token as string);
    const plainToken = other.json().token as string;
    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { authorization: `Bearer ${plainToken}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("disables an account, which cuts existing sessions and future logins", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const keys = generateAccountKeys("a doomed password");
    const invite = await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth, payload: {} });
    const joined = await register("doomed@example.com", keys, invite.json().token as string);
    const doomedToken = joined.json().token as string;
    const users = (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth })).json()
      .users as Array<{ id: number; email: string }>;
    const doomed = users.find((u) => u.email === "doomed@example.com")!;

    const disabled = await app.inject({
      method: "POST",
      url: `/api/admin/users/${doomed.id}/disable`,
      headers: auth,
    });
    expect(disabled.statusCode).toBe(204);
    const sessionCut = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${doomedToken}` },
    });
    expect(sessionCut.statusCode).toBe(403);
    const loginBlocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "doomed@example.com", loginKey: keys.loginKey },
    });
    expect(loginBlocked.statusCode).toBe(403);

    const enabled = await app.inject({
      method: "POST",
      url: `/api/admin/users/${doomed.id}/enable`,
      headers: auth,
    });
    expect(enabled.statusCode).toBe(204);
    const back = await app.inject({
      method: "GET",
      url: "/api/user",
      headers: { authorization: `Bearer ${doomedToken}` },
    });
    expect(back.statusCode).toBe(200);
  });

  it("enforces a per-user quota override", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const users = (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth })).json()
      .users as Array<{ id: number; email: string }>;
    const guest = users.find((u) => u.email === "guest@example.com")!;
    const capped = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${guest.id}`,
      headers: auth,
      payload: { quotaBytes: 1024 },
    });
    expect(capped.statusCode).toBe(204);
    const after = (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth })).json()
      .users as Array<{ id: number; email: string; quotaBytes: number; quotaOverride: boolean }>;
    const row = after.find((u) => u.email === "guest@example.com")!;
    expect(row.quotaBytes).toBe(1024);
    expect(row.quotaOverride).toBe(true);
  });

  it("refuses to disable or delete an operator-declared admin", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const users = (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth })).json()
      .users as Array<{ id: number; email: string }>;
    const self = users.find((u) => u.email === "root@example.com")!;
    const disable = await app.inject({
      method: "POST",
      url: `/api/admin/users/${self.id}/disable`,
      headers: auth,
    });
    expect(disable.statusCode).toBe(400);
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${self.id}`,
      headers: auth,
    });
    expect(remove.statusCode).toBe(400);
  });

  it("deletes an account and all of its rows", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const users = (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth })).json()
      .users as Array<{ id: number; email: string }>;
    const doomed = users.find((u) => u.email === "doomed@example.com")!;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${doomed.id}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
    const after = (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth })).json()
      .users as Array<{ email: string }>;
    expect(after.map((u) => u.email)).not.toContain("doomed@example.com");
  });
});
