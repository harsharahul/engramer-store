import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { blobKey } from "../blobs.js";
import type { FileRow, ShareRow } from "../db.js";

/**
 * Public share links. The server hands out an opaque token; the file key
 * travels in the URL fragment, which browsers never send over the wire, so
 * the server can serve ciphertext to link holders without ever seeing a key.
 */
export function registerShareRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };

  app.post("/api/shares", auth, async (request, reply) => {
    const { fileId } = z.object({ fileId: z.string() }).parse(request.body);
    const uid = request.user.uid;
    const file = app.db
      .prepare(
        "SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted = 0 AND trashed = 0 AND uploaded = 1",
      )
      .get(fileId, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    const token = randomBytes(16).toString("base64url");
    app.db
      .prepare("INSERT INTO shares (token, user_id, file_id, created_at) VALUES (?, ?, ?, ?)")
      .run(token, uid, fileId, Date.now());
    return reply.code(201).send({ token });
  });

  app.get("/api/shares", auth, async (request) => {
    const rows = app.db
      .prepare("SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC")
      .all(request.user.uid) as ShareRow[];
    return {
      shares: rows.map((r) => ({ token: r.token, fileId: r.file_id, createdAt: r.created_at })),
    };
  });

  app.delete("/api/shares/:token", auth, async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = app.db
      .prepare("DELETE FROM shares WHERE token = ? AND user_id = ?")
      .run(token, request.user.uid);
    if (result.changes === 0) {
      return reply.code(404).send({ error: "share not found" });
    }
    return reply.code(204).send();
  });

  const sharedFile = (token: string): FileRow | undefined =>
    app.db
      .prepare(
        `SELECT f.* FROM shares s JOIN files f ON f.id = s.file_id
         WHERE s.token = ? AND f.deleted = 0 AND f.trashed = 0 AND f.uploaded = 1`,
      )
      .get(token) as FileRow | undefined;

  app.get("/api/public/:token/meta", async (request, reply) => {
    const { token } = request.params as { token: string };
    const file = sharedFile(token);
    if (!file) {
      return reply.code(404).send({ error: "this link is no longer available" });
    }
    return {
      encryptedMeta: JSON.parse(file.encrypted_meta) as unknown,
      size: file.size,
    };
  });

  app.get("/api/public/:token/data", async (request, reply) => {
    const { token } = request.params as { token: string };
    const file = sharedFile(token);
    if (!file) {
      return reply.code(404).send({ error: "this link is no longer available" });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", file.size);
    return reply.send(await app.blobs.get(blobKey(file.id, "data")));
  });
}
