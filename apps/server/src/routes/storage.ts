import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import {
  BlobTooLargeError,
  blobPath,
  deleteBlobIfExists,
  writeBlobStream,
  type BlobKind,
} from "../blobs.js";
import type { FileRow, FolderRow } from "../db.js";

const secretBoxSchema = z.object({ ciphertext: z.string(), nonce: z.string() });

const createFolderSchema = z.object({
  parentId: z.string().nullable().optional(),
  encryptedKey: secretBoxSchema,
  encryptedMeta: secretBoxSchema,
});

const patchFolderSchema = z.object({
  parentId: z.string().nullable().optional(),
  encryptedMeta: secretBoxSchema.optional(),
});

const createFileSchema = z.object({
  folderId: z.string().nullable().optional(),
  encryptedKey: secretBoxSchema,
  encryptedMeta: secretBoxSchema,
});

const patchFileSchema = z.object({
  folderId: z.string().nullable().optional(),
  encryptedMeta: secretBoxSchema.optional(),
});

function folderToDto(row: FolderRow) {
  return {
    id: row.id,
    parentId: row.parent_id,
    encryptedKey: JSON.parse(row.encrypted_key) as unknown,
    encryptedMeta: JSON.parse(row.encrypted_meta) as unknown,
    deleted: row.deleted === 1,
    updateSeq: row.update_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fileToDto(row: FileRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    encryptedKey: JSON.parse(row.encrypted_key) as unknown,
    encryptedMeta: JSON.parse(row.encrypted_meta) as unknown,
    size: row.size,
    thumbSize: row.thumb_size,
    uploaded: row.uploaded === 1,
    trashed: row.trashed === 1,
    deleted: row.deleted === 1,
    updateSeq: row.update_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerStorageRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };

  const getOwnFolder = (id: string, uid: number): FolderRow | undefined =>
    app.db
      .prepare("SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted = 0")
      .get(id, uid) as FolderRow | undefined;

  const getOwnFile = (id: string, uid: number): FileRow | undefined =>
    app.db
      .prepare("SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted = 0")
      .get(id, uid) as FileRow | undefined;

  app.post("/api/folders", auth, async (request, reply) => {
    const body = createFolderSchema.parse(request.body);
    const uid = request.user.uid;
    if (body.parentId && !getOwnFolder(body.parentId, uid)) {
      return reply.code(404).send({ error: "parent folder not found" });
    }
    const now = Date.now();
    const id = randomUUID();
    const seq = app.nextSeq(uid);
    app.db
      .prepare(
        `INSERT INTO folders (id, user_id, parent_id, encrypted_key, encrypted_meta, update_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        uid,
        body.parentId ?? null,
        JSON.stringify(body.encryptedKey),
        JSON.stringify(body.encryptedMeta),
        seq,
        now,
        now,
      );
    const row = app.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow;
    return reply.code(201).send(folderToDto(row));
  });

  app.patch("/api/folders/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const body = patchFolderSchema.parse(request.body);
    const folder = getOwnFolder(id, uid);
    if (!folder) {
      return reply.code(404).send({ error: "folder not found" });
    }
    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === id || !getOwnFolder(body.parentId, uid)) {
        return reply.code(400).send({ error: "invalid destination folder" });
      }
      if (isDescendant(app, uid, body.parentId, id)) {
        return reply.code(400).send({ error: "cannot move a folder into its own subtree" });
      }
    }
    const seq = app.nextSeq(uid);
    app.db
      .prepare(
        `UPDATE folders SET
           parent_id = COALESCE(?, parent_id),
           encrypted_meta = COALESCE(?, encrypted_meta),
           update_seq = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        body.parentId !== undefined ? body.parentId : null,
        body.encryptedMeta ? JSON.stringify(body.encryptedMeta) : null,
        seq,
        Date.now(),
        id,
      );
    const row = app.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow;
    return folderToDto(row);
  });

  // Deleting a folder tombstones its whole subtree and trashes the files in it.
  app.delete("/api/folders/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    if (!getOwnFolder(id, uid)) {
      return reply.code(404).send({ error: "folder not found" });
    }
    const subtree = folderSubtreeIds(app, uid, id);
    const now = Date.now();
    const run = app.db.transaction(() => {
      for (const folderId of subtree) {
        app.db
          .prepare("UPDATE folders SET deleted = 1, update_seq = ?, updated_at = ? WHERE id = ?")
          .run(app.nextSeq(uid), now, folderId);
        const files = app.db
          .prepare("SELECT id FROM files WHERE folder_id = ? AND user_id = ? AND deleted = 0 AND trashed = 0")
          .all(folderId, uid) as Array<{ id: string }>;
        for (const file of files) {
          app.db
            .prepare("UPDATE files SET trashed = 1, update_seq = ?, updated_at = ? WHERE id = ?")
            .run(app.nextSeq(uid), now, file.id);
        }
      }
    });
    run();
    return reply.code(204).send();
  });

  app.post("/api/files", auth, async (request, reply) => {
    const body = createFileSchema.parse(request.body);
    const uid = request.user.uid;
    if (body.folderId && !getOwnFolder(body.folderId, uid)) {
      return reply.code(404).send({ error: "folder not found" });
    }
    const now = Date.now();
    const id = randomUUID();
    const seq = app.nextSeq(uid);
    app.db
      .prepare(
        `INSERT INTO files (id, user_id, folder_id, encrypted_key, encrypted_meta, update_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        uid,
        body.folderId ?? null,
        JSON.stringify(body.encryptedKey),
        JSON.stringify(body.encryptedMeta),
        seq,
        now,
        now,
      );
    const row = app.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
    return reply.code(201).send(fileToDto(row));
  });

  const uploadBlob = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: BlobKind,
  ) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = getOwnFile(id, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    const currentBlobBytes = kind === "data" ? file.size : file.thumb_size;
    const quotaRoom = app.config.quotaBytes - (app.storageUsed(uid) - currentBlobBytes);
    const maxBytes = Math.min(app.config.maxBlobBytes, quotaRoom);
    const declared = Number(request.headers["content-length"] ?? 0);
    if (maxBytes <= 0 || declared > maxBytes) {
      return reply.code(413).send({ error: "storage quota exceeded" });
    }
    const destination = blobPath(app.config.blobDir, id, kind);
    let written: number;
    try {
      written = await writeBlobStream(request.body as Readable, destination, maxBytes);
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        return reply.code(413).send({ error: "storage quota exceeded" });
      }
      throw err;
    }
    const seq = app.nextSeq(uid);
    const column = kind === "data" ? "size" : "thumb_size";
    const uploadedFlag = kind === "data" ? 1 : file.uploaded;
    app.db
      .prepare(
        `UPDATE files SET ${column} = ?, uploaded = ?, update_seq = ?, updated_at = ? WHERE id = ?`,
      )
      .run(written, uploadedFlag, seq, Date.now(), id);
    return { size: written };
  };

  app.put("/api/files/:id/data", auth, (request, reply) => uploadBlob(request, reply, "data"));
  app.put("/api/files/:id/thumbnail", auth, (request, reply) => uploadBlob(request, reply, "thumb"));

  const downloadBlob = (request: FastifyRequest, reply: FastifyReply, kind: BlobKind) => {
    const { id } = request.params as { id: string };
    const file = getOwnFile(id, request.user.uid);
    if (!file || (kind === "data" && !file.uploaded) || (kind === "thumb" && !file.thumb_size)) {
      return reply.code(404).send({ error: "blob not found" });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", kind === "data" ? file.size : file.thumb_size);
    return reply.send(createReadStream(blobPath(app.config.blobDir, id, kind)));
  };

  app.get("/api/files/:id/data", auth, (request, reply) => downloadBlob(request, reply, "data"));
  app.get("/api/files/:id/thumbnail", auth, (request, reply) => downloadBlob(request, reply, "thumb"));

  app.patch("/api/files/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const body = patchFileSchema.parse(request.body);
    if (!getOwnFile(id, uid)) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (body.folderId !== undefined && body.folderId !== null && !getOwnFolder(body.folderId, uid)) {
      return reply.code(404).send({ error: "destination folder not found" });
    }
    app.db
      .prepare(
        `UPDATE files SET
           folder_id = CASE WHEN ? THEN ? ELSE folder_id END,
           encrypted_meta = COALESCE(?, encrypted_meta),
           update_seq = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        body.folderId !== undefined ? 1 : 0,
        body.folderId ?? null,
        body.encryptedMeta ? JSON.stringify(body.encryptedMeta) : null,
        app.nextSeq(uid),
        Date.now(),
        id,
      );
    const row = app.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
    return fileToDto(row);
  });

  app.delete("/api/files/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = getOwnFile(id, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    app.db
      .prepare("UPDATE files SET trashed = 1, update_seq = ?, updated_at = ? WHERE id = ?")
      .run(app.nextSeq(uid), Date.now(), id);
    return reply.code(204).send();
  });

  app.post("/api/trash/:id/restore", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = getOwnFile(id, uid);
    if (!file || !file.trashed) {
      return reply.code(404).send({ error: "file not found in trash" });
    }
    // If the original folder was deleted, the file comes back at the root.
    const folderAlive = file.folder_id ? Boolean(getOwnFolder(file.folder_id, uid)) : true;
    app.db
      .prepare(
        "UPDATE files SET trashed = 0, folder_id = ?, update_seq = ?, updated_at = ? WHERE id = ?",
      )
      .run(folderAlive ? file.folder_id : null, app.nextSeq(uid), Date.now(), id);
    return reply.code(204).send();
  });

  app.delete("/api/trash/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = getOwnFile(id, uid);
    if (!file || !file.trashed) {
      return reply.code(404).send({ error: "file not found in trash" });
    }
    const run = app.db.transaction(() => {
      app.db.prepare("DELETE FROM shares WHERE file_id = ?").run(id);
      app.db
        .prepare(
          "UPDATE files SET deleted = 1, size = 0, thumb_size = 0, uploaded = 0, update_seq = ?, updated_at = ? WHERE id = ?",
        )
        .run(app.nextSeq(uid), Date.now(), id);
    });
    run();
    deleteBlobIfExists(blobPath(app.config.blobDir, id, "data"));
    deleteBlobIfExists(blobPath(app.config.blobDir, id, "thumb"));
    return reply.code(204).send();
  });

  // Delta sync: everything that changed after the client's cursor, tombstones included.
  app.get("/api/sync", auth, async (request) => {
    const uid = request.user.uid;
    const since = Number((request.query as { since?: string }).since ?? 0);
    const folders = app.db
      .prepare("SELECT * FROM folders WHERE user_id = ? AND update_seq > ? ORDER BY update_seq")
      .all(uid, since) as FolderRow[];
    const files = app.db
      .prepare("SELECT * FROM files WHERE user_id = ? AND update_seq > ? ORDER BY update_seq")
      .all(uid, since) as FileRow[];
    const user = app.db
      .prepare("SELECT last_seq FROM users WHERE id = ?")
      .get(uid) as { last_seq: number };
    return {
      seq: user.last_seq,
      folders: folders.map(folderToDto),
      files: files.map(fileToDto),
    };
  });
}

function folderSubtreeIds(app: FastifyInstance, uid: number, rootId: string): string[] {
  const rows = app.db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted = 0
         UNION ALL
         SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
         WHERE f.user_id = ? AND f.deleted = 0
       ) SELECT id FROM subtree`,
    )
    .all(rootId, uid, uid) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function isDescendant(
  app: FastifyInstance,
  uid: number,
  candidateId: string,
  ancestorId: string,
): boolean {
  return folderSubtreeIds(app, uid, ancestorId).includes(candidateId);
}
