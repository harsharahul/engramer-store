import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { shareAccessDigest } from "@engramer/crypto";
import { blobKey } from "../blobs.js";
import type { FileRow, ShareRow } from "../db.js";

const secretBoxSchema = z.object({ ciphertext: z.string(), nonce: z.string() });

const kdfSchema = z.object({
  salt: z.string(),
  opsLimit: z.number().int().positive(),
  memLimit: z.number().int().positive(),
});

const createShareSchema = z.object({
  fileId: z.string(),
  expiresAt: z.number().int().positive().nullable().optional(),
  maxDownloads: z.number().int().positive().nullable().optional(),
  password: z
    .object({
      digest: z.string(),
      kdf: kdfSchema,
      wrappedKey: secretBoxSchema,
    })
    .nullable()
    .optional(),
});

function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function shareToDto(row: ShareRow) {
  return {
    token: row.token,
    fileId: row.file_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    protected: row.password_digest !== null,
  };
}

/**
 * Public share links. The server hands out an opaque token. For open links the
 * file key travels in the URL fragment, which browsers never send over the
 * wire. For password-protected links the server stores the file key wrapped
 * under a key derived from the link password with Argon2id, plus a digest of a
 * separate access subkey: it can gate downloads on knowledge of the password
 * without ever being able to unwrap the key itself.
 */
export function registerShareRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };

  app.post("/api/shares", auth, async (request, reply) => {
    const body = createShareSchema.parse(request.body);
    const uid = request.user.uid;
    const file = app.db
      .prepare(
        "SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted = 0 AND trashed = 0 AND uploaded = 1",
      )
      .get(body.fileId, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (body.expiresAt && body.expiresAt <= Date.now()) {
      return reply.code(400).send({ error: "expiry must be in the future" });
    }
    const token = randomBytes(16).toString("base64url");
    app.db
      .prepare(
        `INSERT INTO shares (token, user_id, file_id, created_at, expires_at, max_downloads,
                             download_count, password_digest, password_kdf, wrapped_key)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        token,
        uid,
        body.fileId,
        Date.now(),
        body.expiresAt ?? null,
        body.maxDownloads ?? null,
        body.password?.digest ?? null,
        body.password ? JSON.stringify(body.password.kdf) : null,
        body.password ? JSON.stringify(body.password.wrappedKey) : null,
      );
    return reply.code(201).send({ token });
  });

  app.get("/api/shares", auth, async (request) => {
    const rows = app.db
      .prepare("SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC")
      .all(request.user.uid) as ShareRow[];
    return { shares: rows.map(shareToDto) };
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

  interface LoadedShare {
    share: ShareRow;
    file: FileRow;
  }

  /** Resolves a token to a live share, or a status/message pair for the visitor. */
  const loadShare = (token: string): LoadedShare | { code: number; error: string } => {
    const share = app.db.prepare("SELECT * FROM shares WHERE token = ?").get(token) as
      | ShareRow
      | undefined;
    if (!share) {
      return { code: 404, error: "this link is no longer available" };
    }
    const file = app.db
      .prepare("SELECT * FROM files WHERE id = ? AND deleted = 0 AND trashed = 0 AND uploaded = 1")
      .get(share.file_id) as FileRow | undefined;
    if (!file) {
      return { code: 404, error: "this link is no longer available" };
    }
    if (share.expires_at !== null && share.expires_at <= Date.now()) {
      return { code: 410, error: "this link has expired" };
    }
    if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
      return { code: 410, error: "this link has reached its download limit" };
    }
    return { share, file };
  };

  /**
   * Password gate. Returns "open" when no password is set, "granted" when the
   * presented access key digests to the stored value, "denied" for a wrong
   * key, and "required" when the link is protected and no key was presented.
   */
  const gate = (share: ShareRow, request: FastifyRequest): "open" | "granted" | "denied" | "required" => {
    if (share.password_digest === null) {
      return "open";
    }
    const presented = request.headers["x-share-access"];
    if (typeof presented !== "string" || presented.length === 0) {
      return "required";
    }
    return digestsMatch(shareAccessDigest(presented), share.password_digest)
      ? "granted"
      : "denied";
  };

  app.get("/api/public/:token/meta", async (request, reply) => {
    const { token } = request.params as { token: string };
    const loaded = loadShare(token);
    if ("code" in loaded) {
      return reply.code(loaded.code).send({ error: loaded.error });
    }
    const { share, file } = loaded;
    const access = gate(share, request);
    if (access === "denied") {
      return reply.code(403).send({ error: "wrong password" });
    }
    if (access === "required") {
      return { protected: true, kdf: JSON.parse(share.password_kdf!) as unknown };
    }
    return {
      protected: share.password_digest !== null,
      encryptedMeta: JSON.parse(file.encrypted_meta) as unknown,
      size: file.size,
      ...(share.wrapped_key ? { wrappedKey: JSON.parse(share.wrapped_key) as unknown } : {}),
    };
  });

  app.get("/api/public/:token/data", async (request, reply) => {
    const { token } = request.params as { token: string };
    const loaded = loadShare(token);
    if ("code" in loaded) {
      return reply.code(loaded.code).send({ error: loaded.error });
    }
    const { share, file } = loaded;
    const access = gate(share, request);
    if (access === "denied" || access === "required") {
      return reply.code(403).send({ error: "wrong password" });
    }
    // Atomic claim: the count only advances while below the limit, so two
    // simultaneous downloads can never both take the last slot.
    const claimed = app.db
      .prepare(
        `UPDATE shares SET download_count = download_count + 1
         WHERE token = ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
      )
      .run(token);
    if (claimed.changes === 0) {
      return reply.code(410).send({ error: "this link has reached its download limit" });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", file.size);
    return reply.send(await app.blobs.get(blobKey(file.id, "data", file.generation)));
  });
}
