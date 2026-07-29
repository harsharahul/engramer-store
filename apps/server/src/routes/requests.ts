import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { BlobTooLargeError, blobKey, type BlobKind } from "../blobs.js";
import {
  nextSeq,
  storageUsed,
  userQuota,
  type FileRequestRow,
  type FileRow,
  type RequestUploadRow,
  type UserRow,
} from "../db.js";
import { fileToDto } from "./storage.js";

const secretBoxSchema = z.object({ ciphertext: z.string(), nonce: z.string() });

const createRequestSchema = z.object({
  folderId: z.string().nullable().optional(),
  encryptedMeta: secretBoxSchema,
  expiresAt: z.number().int().positive().nullable().optional(),
});

const createUploadSchema = z.object({
  sealedKey: z.string().min(1),
  encryptedMeta: secretBoxSchema,
});

const acceptSchema = z.object({
  encryptedKey: secretBoxSchema,
  encryptedMeta: secretBoxSchema,
});

function requestToDto(row: FileRequestRow, received: number, pending: number) {
  return {
    token: row.token,
    folderId: row.folder_id,
    encryptedMeta: JSON.parse(row.encrypted_meta) as unknown,
    expiresAt: row.expires_at,
    revoked: row.revoked === 1,
    createdAt: row.created_at,
    received,
    pending,
  };
}

function uploadToDto(row: RequestUploadRow) {
  return {
    id: row.id,
    requestToken: row.request_token,
    sealedKey: row.sealed_key,
    encryptedMeta: JSON.parse(row.encrypted_meta) as unknown,
    size: row.size,
    thumbSize: row.thumb_size,
    createdAt: row.created_at,
  };
}

/**
 * File requests: receive files from anyone, end-to-end encrypted. The public
 * upload page encrypts each file with a fresh key on the sender's device and
 * seals that key to the owner's X25519 public key. The server stores only
 * ciphertext and the sealed key; the owner's client unseals, re-wraps under
 * the master key, and files the upload on the next sync.
 */
export function registerRequestRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };

  app.post("/api/requests", auth, async (request, reply) => {
    const body = createRequestSchema.parse(request.body);
    const uid = request.user.uid;
    if (body.folderId) {
      const folder = await app.db.get(
        "SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted = 0",
        body.folderId,
        uid,
      );
      if (!folder) {
        return reply.code(404).send({ error: "folder not found" });
      }
    }
    if (body.expiresAt && body.expiresAt <= Date.now()) {
      return reply.code(400).send({ error: "expiry must be in the future" });
    }
    const token = randomBytes(16).toString("base64url");
    await app.db.run(
      `INSERT INTO file_requests (token, user_id, folder_id, encrypted_meta, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      token,
      uid,
      body.folderId ?? null,
      JSON.stringify(body.encryptedMeta),
      body.expiresAt ?? null,
      Date.now(),
    );
    return reply.code(201).send({ token });
  });

  app.get("/api/requests", auth, async (request) => {
    const uid = request.user.uid;
    const rows = await app.db.all<FileRequestRow>(
      "SELECT * FROM file_requests WHERE user_id = ? ORDER BY created_at DESC",
      uid,
    );
    const counts = await app.db.all<{ request_token: string; received: number; pending: number }>(
      `SELECT request_token,
              SUM(uploaded) AS received,
              SUM(CASE WHEN uploaded = 1 AND consumed = 0 THEN 1 ELSE 0 END) AS pending
       FROM request_uploads WHERE user_id = ? GROUP BY request_token`,
      uid,
    );
    const byToken = new Map(counts.map((c) => [c.request_token, c]));
    return {
      requests: rows.map((row) =>
        requestToDto(row, byToken.get(row.token)?.received ?? 0, byToken.get(row.token)?.pending ?? 0),
      ),
    };
  });

  app.delete("/api/requests/:token", auth, async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = await app.db.run(
      "UPDATE file_requests SET revoked = 1 WHERE token = ? AND user_id = ?",
      token,
      request.user.uid,
    );
    if (result.changes === 0) {
      return reply.code(404).send({ error: "request not found" });
    }
    return reply.code(204).send();
  });

  /** Uploads that arrived and are waiting for the owner's client to file them. */
  app.get("/api/requests/uploads", auth, async (request) => {
    const rows = await app.db.all<RequestUploadRow>(
      "SELECT * FROM request_uploads WHERE user_id = ? AND uploaded = 1 AND consumed = 0 ORDER BY created_at",
      request.user.uid,
    );
    return { uploads: rows.map(uploadToDto) };
  });

  /**
   * Files an upload into the vault. The client sends the file key re-wrapped
   * under its master key plus refreshed metadata; the blob is already here
   * under the upload's id, which simply becomes the file's id.
   */
  app.post("/api/requests/uploads/:id/accept", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const body = acceptSchema.parse(request.body);
    const upload = await app.db.get<RequestUploadRow>(
      "SELECT * FROM request_uploads WHERE id = ? AND user_id = ? AND uploaded = 1 AND consumed = 0",
      id,
      uid,
    );
    if (!upload) {
      return reply.code(404).send({ error: "upload not found" });
    }
    const req = await app.db.get<Pick<FileRequestRow, "folder_id">>(
      "SELECT folder_id FROM file_requests WHERE token = ?",
      upload.request_token,
    );
    // If the destination folder is gone the file lands at the root.
    const folderAlive =
      req?.folder_id &&
      (await app.db.get(
        "SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted = 0",
        req.folder_id,
        uid,
      ));
    const now = Date.now();
    await app.db.tx(async (t) => {
      await t.run(
        `INSERT INTO files (id, user_id, folder_id, encrypted_key, encrypted_meta, size, thumb_size,
                            index_size, uploaded, update_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        id,
        uid,
        folderAlive ? req!.folder_id : null,
        JSON.stringify(body.encryptedKey),
        JSON.stringify(body.encryptedMeta),
        upload.size,
        upload.thumb_size,
        upload.index_size,
        await nextSeq(t, uid),
        now,
        now,
      );
      await t.run("UPDATE request_uploads SET consumed = 1 WHERE id = ?", id);
    });
    const row = (await app.db.get<FileRow>("SELECT * FROM files WHERE id = ?", id))!;
    return reply.code(201).send(fileToDto(row));
  });

  /** Discards an upload without filing it; the ciphertext is deleted. */
  app.delete("/api/requests/uploads/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const upload = await app.db.get<RequestUploadRow>(
      "SELECT * FROM request_uploads WHERE id = ? AND user_id = ? AND consumed = 0",
      id,
      request.user.uid,
    );
    if (!upload) {
      return reply.code(404).send({ error: "upload not found" });
    }
    await app.db.run("DELETE FROM request_uploads WHERE id = ?", id);
    await app.blobs.remove(blobKey(id, "data"));
    await app.blobs.remove(blobKey(id, "thumb"));
    await app.blobs.remove(blobKey(id, "index"));
    return reply.code(204).send();
  });

  /** Resolves a token to a live request, or a status/message for the sender. */
  const loadRequest = async (
    token: string,
  ): Promise<FileRequestRow | { code: number; error: string }> => {
    const row = await app.db.get<FileRequestRow>(
      "SELECT * FROM file_requests WHERE token = ?",
      token,
    );
    if (!row || row.revoked === 1) {
      return { code: 404, error: "this request is no longer accepting files" };
    }
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      return { code: 410, error: "this request has expired" };
    }
    return row;
  };

  app.get("/api/public/requests/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const loaded = await loadRequest(token);
    if ("code" in loaded) {
      return reply.code(loaded.code).send({ error: loaded.error });
    }
    const owner = (await app.db.get<Pick<UserRow, "key_attributes">>(
      "SELECT key_attributes FROM users WHERE id = ?",
      loaded.user_id,
    ))!;
    const { publicKey } = JSON.parse(owner.key_attributes) as { publicKey: string };
    const quota = await userQuota(app.db, loaded.user_id, app.config.quotaBytes);
    const quotaRoom = quota - (await storageUsed(app.db, loaded.user_id));
    return {
      publicKey,
      maxBytes: Math.max(0, Math.min(app.config.maxBlobBytes, quotaRoom)),
    };
  });

  app.post("/api/public/requests/:token/files", async (request, reply) => {
    const { token } = request.params as { token: string };
    const loaded = await loadRequest(token);
    if ("code" in loaded) {
      return reply.code(loaded.code).send({ error: loaded.error });
    }
    const body = createUploadSchema.parse(request.body);
    const id = randomUUID();
    await app.db.run(
      `INSERT INTO request_uploads (id, request_token, user_id, sealed_key, encrypted_meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      token,
      loaded.user_id,
      body.sealedKey,
      JSON.stringify(body.encryptedMeta),
      Date.now(),
    );
    return reply.code(201).send({ id });
  });

  const uploadRequestBlob = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: BlobKind,
  ) => {
    const { token, id } = request.params as { token: string; id: string };
    const loaded = await loadRequest(token);
    if ("code" in loaded) {
      return reply.code(loaded.code).send({ error: loaded.error });
    }
    const upload = await app.db.get<RequestUploadRow>(
      "SELECT * FROM request_uploads WHERE id = ? AND request_token = ? AND consumed = 0",
      id,
      token,
    );
    // Data can only be written once; a finished upload is immutable.
    if (!upload || (kind === "data" && upload.uploaded === 1)) {
      return reply.code(404).send({ error: "upload not found" });
    }
    const quota = await userQuota(app.db, loaded.user_id, app.config.quotaBytes);
    const quotaRoom = quota - (await storageUsed(app.db, loaded.user_id));
    const maxBytes = Math.min(app.config.maxBlobBytes, quotaRoom);
    const declared = Number(request.headers["content-length"] ?? 0);
    if (maxBytes <= 0 || declared > maxBytes) {
      return reply.code(413).send({ error: "the recipient is out of storage space" });
    }
    let written: number;
    try {
      written = await app.blobs.put(blobKey(id, kind), request.body as Readable, maxBytes);
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        return reply.code(413).send({ error: "the recipient is out of storage space" });
      }
      throw err;
    }
    if (kind === "data") {
      await app.db.run("UPDATE request_uploads SET size = ?, uploaded = 1 WHERE id = ?", written, id);
    } else {
      const column = kind === "thumb" ? "thumb_size" : "index_size";
      await app.db.run(`UPDATE request_uploads SET ${column} = ? WHERE id = ?`, written, id);
    }
    return { size: written };
  };

  app.put("/api/public/requests/:token/files/:id/data", (request, reply) =>
    uploadRequestBlob(request, reply, "data"),
  );
  app.put("/api/public/requests/:token/files/:id/thumbnail", (request, reply) =>
    uploadRequestBlob(request, reply, "thumb"),
  );
  app.put("/api/public/requests/:token/files/:id/index", (request, reply) =>
    uploadRequestBlob(request, reply, "index"),
  );
}
