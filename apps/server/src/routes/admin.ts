import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { blobKey } from "../blobs.js";
import { storageUsed, type InviteRow, type UserRow } from "../db.js";

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Operator surface. Administrators are declared by the operator through
 * ENGRAMER_ADMIN_EMAILS, never stored as a role: on an end-to-end encrypted
 * server an admin can manage what the server actually controls (who may
 * register, quotas, disabling and deleting accounts) and nothing more; there
 * is no password reset to offer because the server never holds key material,
 * and account recovery is the recovery key's job.
 */
export function registerAdminRoutes(app: FastifyInstance): void {
  const isAdmin = (email: string) => app.config.adminEmails.includes(email.toLowerCase());

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await app.db.get<Pick<UserRow, "email">>(
      "SELECT email FROM users WHERE id = ?",
      request.user.uid,
    );
    if (!user || !isAdmin(user.email)) {
      await reply.code(403).send({ error: "administrator access required" });
    }
  };
  const admin = { preHandler: [app.authenticate, requireAdmin] };

  app.get("/api/admin/users", admin, async () => {
    const rows = await app.db.all<UserRow>("SELECT * FROM users ORDER BY created_at");
    const users = [];
    for (const row of rows) {
      users.push({
        id: row.id,
        email: row.email,
        createdAt: row.created_at,
        usedBytes: await storageUsed(app.db, row.id),
        quotaBytes: row.quota_bytes ?? app.config.quotaBytes,
        quotaOverride: row.quota_bytes !== null,
        totpEnabled: row.totp_enabled === 1,
        disabled: row.disabled === 1,
        isAdmin: isAdmin(row.email),
      });
    }
    return { users, registration: app.config.registration };
  });

  app.post("/api/admin/invites", admin, async (request, reply) => {
    const body = z
      .object({ expiresAt: z.number().int().positive().nullable().optional() })
      .parse(request.body ?? {});
    const token = randomBytes(16).toString("base64url");
    await app.db.run(
      "INSERT INTO invites (token, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)",
      token,
      request.user.uid,
      Date.now(),
      body.expiresAt === undefined ? Date.now() + DEFAULT_INVITE_TTL_MS : body.expiresAt,
    );
    return reply.code(201).send({ token });
  });

  app.get("/api/admin/invites", admin, async () => {
    const rows = await app.db.all<InviteRow>("SELECT * FROM invites ORDER BY created_at DESC");
    return {
      invites: rows.map((row) => ({
        token: row.token,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        used: row.used_by !== null,
        usedAt: row.used_at,
      })),
    };
  });

  app.delete("/api/admin/invites/:token", admin, async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = await app.db.run(
      "DELETE FROM invites WHERE token = ? AND used_by IS NULL",
      token,
    );
    if (result.changes === 0) {
      return reply.code(404).send({ error: "invite not found or already used" });
    }
    return reply.code(204).send();
  });

  /** Loads a target account, refusing to touch operator-declared admins. */
  const loadTarget = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<UserRow | null> => {
    const { id } = request.params as { id: string };
    const user = await app.db.get<UserRow>("SELECT * FROM users WHERE id = ?", Number(id));
    if (!user) {
      await reply.code(404).send({ error: "user not found" });
      return null;
    }
    if (isAdmin(user.email)) {
      await reply.code(400).send({
        error: "this account is an administrator; remove it from ENGRAMER_ADMIN_EMAILS first",
      });
      return null;
    }
    return user;
  };

  const setDisabled = (disabled: number) => async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await loadTarget(request, reply);
    if (!user) {
      return;
    }
    await app.db.run("UPDATE users SET disabled = ? WHERE id = ?", disabled, user.id);
    return reply.code(204).send();
  };
  app.post("/api/admin/users/:id/disable", admin, setDisabled(1));
  app.post("/api/admin/users/:id/enable", admin, setDisabled(0));

  app.patch("/api/admin/users/:id", admin, async (request, reply) => {
    const user = await loadTarget(request, reply);
    if (!user) {
      return;
    }
    const body = z
      .object({ quotaBytes: z.number().int().positive().nullable() })
      .parse(request.body);
    await app.db.run("UPDATE users SET quota_bytes = ? WHERE id = ?", body.quotaBytes, user.id);
    return reply.code(204).send();
  });

  /** Removes the account and every byte it stored. */
  app.delete("/api/admin/users/:id", admin, async (request, reply) => {
    const user = await loadTarget(request, reply);
    if (!user) {
      return;
    }
    // Collect blob keys before the rows disappear.
    const files = await app.db.all<{ id: string; generation: number }>(
      "SELECT id, generation FROM files WHERE user_id = ?",
      user.id,
    );
    const versions = await app.db.all<{ file_id: string; generation: number }>(
      "SELECT file_id, generation FROM file_versions WHERE user_id = ?",
      user.id,
    );
    const uploads = await app.db.all<{ id: string }>(
      "SELECT id FROM request_uploads WHERE user_id = ?",
      user.id,
    );
    await app.db.tx(async (t) => {
      await t.run("DELETE FROM shares WHERE user_id = ?", user.id);
      await t.run("DELETE FROM file_versions WHERE user_id = ?", user.id);
      await t.run("DELETE FROM request_uploads WHERE user_id = ?", user.id);
      await t.run("DELETE FROM file_requests WHERE user_id = ?", user.id);
      await t.run("DELETE FROM files WHERE user_id = ?", user.id);
      await t.run("DELETE FROM folders WHERE user_id = ?", user.id);
      await t.run("DELETE FROM invites WHERE created_by = ?", user.id);
      await t.run("DELETE FROM users WHERE id = ?", user.id);
    });
    // Ciphertext cleanup is best-effort; a leftover blob is unreferenced
    // garbage, not data anyone can read or reach.
    for (const file of files) {
      await app.blobs.remove(blobKey(file.id, "data", file.generation)).catch(() => {});
      await app.blobs.remove(blobKey(file.id, "thumb")).catch(() => {});
      await app.blobs.remove(blobKey(file.id, "index")).catch(() => {});
    }
    for (const version of versions) {
      await app.blobs.remove(blobKey(version.file_id, "data", version.generation)).catch(() => {});
    }
    for (const upload of uploads) {
      await app.blobs.remove(blobKey(upload.id, "data")).catch(() => {});
      await app.blobs.remove(blobKey(upload.id, "thumb")).catch(() => {});
      await app.blobs.remove(blobKey(upload.id, "index")).catch(() => {});
    }
    return reply.code(204).send();
  });
}
