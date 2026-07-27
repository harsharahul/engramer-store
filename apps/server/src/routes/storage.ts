import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { BlobTooLargeError, blobKey, type BlobKind } from "../blobs.js";
import type { FileRow, FileVersionRow, FolderRow } from "../db.js";

/** A concurrent writer advanced the file while this request streamed in. */
class GenerationConflictError extends Error {
  constructor() {
    super("generation conflict");
  }
}

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

export function fileToDto(row: FileRow) {
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

  /**
   * Content writes are append-only: the new bytes land in the NEXT
   * generation's blob first, and only after that write fully succeeds does a
   * single transaction snapshot the old generation as a version and advance
   * the pointer. A failure at any point leaves the file serving its previous
   * content; the worst possible leftover is an orphaned blob, never a file
   * row that points at missing or partial data.
   */
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
    const keepsVersions = app.config.maxVersions > 0;
    const replacesContent = kind === "data" && file.uploaded === 1;
    // A replaced blob only frees quota when history is off; with versioning
    // the displaced content keeps occupying space as a version.
    const reclaimable =
      kind === "thumb" ? file.thumb_size : replacesContent && !keepsVersions ? file.size : 0;
    const quotaRoom = app.config.quotaBytes - (app.storageUsed(uid) - reclaimable);
    const maxBytes = Math.min(app.config.maxBlobBytes, quotaRoom);
    const declared = Number(request.headers["content-length"] ?? 0);
    if (maxBytes <= 0 || declared > maxBytes) {
      return reply.code(413).send({ error: "storage quota exceeded" });
    }
    const nextGen = replacesContent ? file.generation + 1 : file.generation;
    const targetKey = kind === "data" ? blobKey(id, "data", nextGen) : blobKey(id, "thumb");
    let written: number;
    try {
      written = await app.blobs.put(targetKey, request.body as Readable, maxBytes);
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        return reply.code(413).send({ error: "storage quota exceeded" });
      }
      throw err;
    }

    if (kind === "thumb") {
      app.db
        .prepare("UPDATE files SET thumb_size = ?, update_seq = ?, updated_at = ? WHERE id = ?")
        .run(written, app.nextSeq(uid), Date.now(), id);
      return { size: written };
    }

    const staleBlobs: string[] = [];
    try {
      const swap = app.db.transaction(() => {
        const current = app.db
          .prepare("SELECT generation, size, encrypted_meta, updated_at, uploaded FROM files WHERE id = ?")
          .get(id) as Pick<FileRow, "generation" | "size" | "encrypted_meta" | "updated_at" | "uploaded">;
        if (current.generation !== file.generation || current.uploaded !== file.uploaded) {
          throw new GenerationConflictError();
        }
        if (replacesContent) {
          if (keepsVersions) {
            app.db
              .prepare(
                `INSERT INTO file_versions (file_id, user_id, generation, size, encrypted_meta, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(id, uid, current.generation, current.size, current.encrypted_meta, current.updated_at);
          } else {
            staleBlobs.push(blobKey(id, "data", current.generation));
          }
        }
        app.db
          .prepare(
            "UPDATE files SET size = ?, generation = ?, uploaded = 1, update_seq = ?, updated_at = ? WHERE id = ?",
          )
          .run(written, nextGen, app.nextSeq(uid), Date.now(), id);
        staleBlobs.push(...pruneVersions(id, uid));
      });
      swap();
    } catch (err) {
      if (err instanceof GenerationConflictError) {
        await app.blobs.remove(targetKey).catch(() => {});
        return reply.code(409).send({ error: "the file changed while saving; retry" });
      }
      throw err;
    }
    // Only after the pointer moved is anything discarded, and even this is
    // best-effort: a leftover blob is garbage, not corruption.
    for (const key of staleBlobs) {
      await app.blobs.remove(key).catch(() => {});
    }
    return { size: written };
  };

  /** Drops version rows beyond the retention window; returns their blob keys. */
  const pruneVersions = (fileId: string, uid: number): string[] => {
    const excess = app.db
      .prepare(
        `SELECT generation FROM file_versions WHERE file_id = ? AND user_id = ?
         ORDER BY generation DESC LIMIT -1 OFFSET ?`,
      )
      .all(fileId, uid, app.config.maxVersions) as Array<{ generation: number }>;
    for (const row of excess) {
      app.db
        .prepare("DELETE FROM file_versions WHERE file_id = ? AND generation = ?")
        .run(fileId, row.generation);
    }
    return excess.map((row) => blobKey(fileId, "data", row.generation));
  };

  app.put("/api/files/:id/data", auth, (request, reply) => uploadBlob(request, reply, "data"));
  app.put("/api/files/:id/thumbnail", auth, (request, reply) => uploadBlob(request, reply, "thumb"));

  const downloadBlob = async (request: FastifyRequest, reply: FastifyReply, kind: BlobKind) => {
    const { id } = request.params as { id: string };
    const file = getOwnFile(id, request.user.uid);
    if (!file || (kind === "data" && !file.uploaded) || (kind === "thumb" && !file.thumb_size)) {
      return reply.code(404).send({ error: "blob not found" });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", kind === "data" ? file.size : file.thumb_size);
    return reply.send(await app.blobs.get(blobKey(id, kind, kind === "data" ? file.generation : 0)));
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
    const versionGens = app.db
      .prepare("SELECT generation FROM file_versions WHERE file_id = ?")
      .all(id) as Array<{ generation: number }>;
    const run = app.db.transaction(() => {
      app.db.prepare("DELETE FROM shares WHERE file_id = ?").run(id);
      app.db.prepare("DELETE FROM file_versions WHERE file_id = ?").run(id);
      app.db
        .prepare(
          "UPDATE files SET deleted = 1, size = 0, thumb_size = 0, uploaded = 0, update_seq = ?, updated_at = ? WHERE id = ?",
        )
        .run(app.nextSeq(uid), Date.now(), id);
    });
    run();
    await app.blobs.remove(blobKey(id, "data", file.generation)).catch(() => {});
    for (const row of versionGens) {
      await app.blobs.remove(blobKey(id, "data", row.generation)).catch(() => {});
    }
    await app.blobs.remove(blobKey(id, "thumb")).catch(() => {});
    return reply.code(204).send();
  });

  // ----- version history -----

  const versionToDto = (row: FileVersionRow) => ({
    generation: row.generation,
    size: row.size,
    encryptedMeta: JSON.parse(row.encrypted_meta) as unknown,
    createdAt: row.created_at,
  });

  app.get("/api/files/:id/versions", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getOwnFile(id, request.user.uid)) {
      return reply.code(404).send({ error: "file not found" });
    }
    const rows = app.db
      .prepare(
        "SELECT * FROM file_versions WHERE file_id = ? AND user_id = ? ORDER BY generation DESC",
      )
      .all(id, request.user.uid) as FileVersionRow[];
    return { versions: rows.map(versionToDto) };
  });

  app.get("/api/files/:id/versions/:gen/data", auth, async (request, reply) => {
    const { id, gen } = request.params as { id: string; gen: string };
    const uid = request.user.uid;
    if (!getOwnFile(id, uid)) {
      return reply.code(404).send({ error: "file not found" });
    }
    const version = app.db
      .prepare("SELECT * FROM file_versions WHERE file_id = ? AND user_id = ? AND generation = ?")
      .get(id, uid, Number(gen)) as FileVersionRow | undefined;
    if (!version) {
      return reply.code(404).send({ error: "version not found" });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", version.size);
    return reply.send(await app.blobs.get(blobKey(id, "data", version.generation)));
  });

  /**
   * Restore is a pure pointer swap inside one transaction: the displaced
   * current content becomes a version itself, so restoring is also undoable,
   * and no blob is written, moved, or removed. The client supplies merged
   * metadata (current name and tags, the version's size and search text) so
   * the row stays coherent with the restored bytes.
   */
  app.post("/api/files/:id/versions/:gen/restore", auth, async (request, reply) => {
    const { id, gen } = request.params as { id: string; gen: string };
    const uid = request.user.uid;
    const body = z.object({ encryptedMeta: secretBoxSchema }).parse(request.body);
    const file = getOwnFile(id, uid);
    if (!file || !file.uploaded || file.trashed) {
      return reply.code(404).send({ error: "file not found" });
    }
    const generation = Number(gen);
    const restore = app.db.transaction(() => {
      const version = app.db
        .prepare("SELECT * FROM file_versions WHERE file_id = ? AND user_id = ? AND generation = ?")
        .get(id, uid, generation) as FileVersionRow | undefined;
      if (!version) {
        return null;
      }
      app.db
        .prepare(
          `INSERT INTO file_versions (file_id, user_id, generation, size, encrypted_meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, uid, file.generation, file.size, file.encrypted_meta, file.updated_at);
      app.db
        .prepare("DELETE FROM file_versions WHERE file_id = ? AND generation = ?")
        .run(id, generation);
      app.db
        .prepare(
          "UPDATE files SET generation = ?, size = ?, encrypted_meta = ?, update_seq = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          generation,
          version.size,
          JSON.stringify(body.encryptedMeta),
          app.nextSeq(uid),
          Date.now(),
          id,
        );
      return app.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
    });
    const row = restore();
    if (!row) {
      return reply.code(404).send({ error: "version not found" });
    }
    return fileToDto(row);
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
