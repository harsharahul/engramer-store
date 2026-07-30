import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { BlobTooLargeError, blobKey, type BlobKind } from "../blobs.js";
import {
  nextSeq,
  storageUsed,
  userQuota,
  type Db,
  type FileRow,
  type FileVersionRow,
  type FolderRow,
} from "../db.js";

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
    indexSize: row.index_size,
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

  const getOwnFolder = (id: string, uid: number): Promise<FolderRow | undefined> =>
    app.db.get<FolderRow>(
      "SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted = 0",
      id,
      uid,
    );

  const getOwnFile = (id: string, uid: number): Promise<FileRow | undefined> =>
    app.db.get<FileRow>(
      "SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted = 0",
      id,
      uid,
    );

  app.post("/api/folders", auth, async (request, reply) => {
    const body = createFolderSchema.parse(request.body);
    const uid = request.user.uid;
    if (body.parentId && !(await getOwnFolder(body.parentId, uid))) {
      return reply.code(404).send({ error: "parent folder not found" });
    }
    const now = Date.now();
    const id = randomUUID();
    const seq = await nextSeq(app.db, uid);
    await app.db.run(
      `INSERT INTO folders (id, user_id, parent_id, encrypted_key, encrypted_meta, update_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      uid,
      body.parentId ?? null,
      JSON.stringify(body.encryptedKey),
      JSON.stringify(body.encryptedMeta),
      seq,
      now,
      now,
    );
    const row = (await app.db.get<FolderRow>("SELECT * FROM folders WHERE id = ?", id))!;
    return reply.code(201).send(folderToDto(row));
  });

  app.patch("/api/folders/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const body = patchFolderSchema.parse(request.body);
    const folder = await getOwnFolder(id, uid);
    if (!folder) {
      return reply.code(404).send({ error: "folder not found" });
    }
    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === id || !(await getOwnFolder(body.parentId, uid))) {
        return reply.code(400).send({ error: "invalid destination folder" });
      }
      if (await isDescendant(app, uid, body.parentId, id)) {
        return reply.code(400).send({ error: "cannot move a folder into its own subtree" });
      }
    }
    const seq = await nextSeq(app.db, uid);
    await app.db.run(
      `UPDATE folders SET
         parent_id = COALESCE(?, parent_id),
         encrypted_meta = COALESCE(?, encrypted_meta),
         update_seq = ?, updated_at = ?
       WHERE id = ?`,
      body.parentId !== undefined ? body.parentId : null,
      body.encryptedMeta ? JSON.stringify(body.encryptedMeta) : null,
      seq,
      Date.now(),
      id,
    );
    const row = (await app.db.get<FolderRow>("SELECT * FROM folders WHERE id = ?", id))!;
    return folderToDto(row);
  });

  // Deleting a folder tombstones its whole subtree and trashes the files in it.
  app.delete("/api/folders/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    if (!(await getOwnFolder(id, uid))) {
      return reply.code(404).send({ error: "folder not found" });
    }
    const subtree = await folderSubtreeIds(app, uid, id);
    const now = Date.now();
    await app.db.tx(async (t) => {
      for (const folderId of subtree) {
        await t.run(
          "UPDATE folders SET deleted = 1, update_seq = ?, updated_at = ? WHERE id = ?",
          await nextSeq(t, uid),
          now,
          folderId,
        );
        const files = await t.all<{ id: string }>(
          "SELECT id FROM files WHERE folder_id = ? AND user_id = ? AND deleted = 0 AND trashed = 0",
          folderId,
          uid,
        );
        for (const file of files) {
          await t.run(
            "UPDATE files SET trashed = 1, update_seq = ?, updated_at = ? WHERE id = ?",
            await nextSeq(t, uid),
            now,
            file.id,
          );
        }
      }
    });
    return reply.code(204).send();
  });

  app.post("/api/files", auth, async (request, reply) => {
    const body = createFileSchema.parse(request.body);
    const uid = request.user.uid;
    if (body.folderId && !(await getOwnFolder(body.folderId, uid))) {
      return reply.code(404).send({ error: "folder not found" });
    }
    const now = Date.now();
    const id = randomUUID();
    const seq = await nextSeq(app.db, uid);
    await app.db.run(
      `INSERT INTO files (id, user_id, folder_id, encrypted_key, encrypted_meta, update_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      uid,
      body.folderId ?? null,
      JSON.stringify(body.encryptedKey),
      JSON.stringify(body.encryptedMeta),
      seq,
      now,
      now,
    );
    const row = (await app.db.get<FileRow>("SELECT * FROM files WHERE id = ?", id))!;
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
    const file = await getOwnFile(id, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    const keepsVersions = app.config.maxVersions > 0;
    const replacesContent = kind === "data" && file.uploaded === 1;
    // A replaced blob only frees quota when history is off; with versioning
    // the displaced content keeps occupying space as a version. Derived blobs
    // (thumbnail, search index) always overwrite in place.
    const reclaimable =
      kind === "thumb"
        ? file.thumb_size
        : kind === "index"
          ? file.index_size
          : replacesContent && !keepsVersions
            ? file.size
            : 0;
    const quota = await userQuota(app.db, uid, app.config.quotaBytes);
    const quotaRoom = quota - ((await storageUsed(app.db, uid)) - reclaimable);
    const maxBytes = Math.min(app.config.maxBlobBytes, quotaRoom);
    const declared = Number(request.headers["content-length"] ?? 0);
    if (maxBytes <= 0 || declared > maxBytes) {
      return reply.code(413).send({ error: "storage quota exceeded" });
    }
    const nextGen = replacesContent ? file.generation + 1 : file.generation;
    const targetKey = kind === "data" ? blobKey(id, "data", nextGen) : blobKey(id, kind);
    let written: number;
    try {
      written = await app.blobs.put(targetKey, request.body as Readable, maxBytes);
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        return reply.code(413).send({ error: "storage quota exceeded" });
      }
      throw err;
    }

    if (kind === "thumb" || kind === "index") {
      const column = kind === "thumb" ? "thumb_size" : "index_size";
      await app.db.run(
        `UPDATE files SET ${column} = ?, update_seq = ?, updated_at = ? WHERE id = ?`,
        written,
        await nextSeq(app.db, uid),
        Date.now(),
        id,
      );
      return { size: written };
    }

    return commitData(reply, uid, id, file, nextGen, targetKey, written);
  };

  /**
   * The single commit point for content bytes, whether they arrived as one
   * request or were assembled from parts: snapshot or discard the displaced
   * generation, advance the pointer, prune history. A generation conflict
   * removes the fresh blob and yields 409; the row never moves.
   */
  const commitData = async (
    reply: FastifyReply,
    uid: number,
    id: string,
    file: Pick<FileRow, "generation" | "uploaded">,
    nextGen: number,
    targetKey: string,
    written: number,
  ) => {
    const keepsVersions = app.config.maxVersions > 0;
    const replacesContent = file.uploaded === 1;
    const staleBlobs: string[] = [];
    try {
      await app.db.tx(async (t) => {
        const current = (await t.get<
          Pick<FileRow, "generation" | "size" | "encrypted_meta" | "updated_at" | "uploaded">
        >(
          "SELECT generation, size, encrypted_meta, updated_at, uploaded FROM files WHERE id = ?",
          id,
        ))!;
        if (current.generation !== file.generation || current.uploaded !== file.uploaded) {
          throw new GenerationConflictError();
        }
        if (replacesContent) {
          if (keepsVersions) {
            await t.run(
              `INSERT INTO file_versions (file_id, user_id, generation, size, encrypted_meta, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              id,
              uid,
              current.generation,
              current.size,
              current.encrypted_meta,
              current.updated_at,
            );
          } else {
            staleBlobs.push(blobKey(id, "data", current.generation));
          }
        }
        await t.run(
          "UPDATE files SET size = ?, generation = ?, uploaded = 1, update_seq = ?, updated_at = ? WHERE id = ?",
          written,
          nextGen,
          await nextSeq(t, uid),
          Date.now(),
          id,
        );
        staleBlobs.push(...(await pruneVersions(t, id, uid)));
      });
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
  const pruneVersions = async (t: Db, fileId: string, uid: number): Promise<string[]> => {
    const rows = await t.all<{ generation: number }>(
      "SELECT generation FROM file_versions WHERE file_id = ? AND user_id = ? ORDER BY generation DESC",
      fileId,
      uid,
    );
    const excess = rows.slice(app.config.maxVersions);
    for (const row of excess) {
      await t.run(
        "DELETE FROM file_versions WHERE file_id = ? AND generation = ?",
        fileId,
        row.generation,
      );
    }
    return excess.map((row) => blobKey(fileId, "data", row.generation));
  };

  app.put("/api/files/:id/data", auth, (request, reply) => uploadBlob(request, reply, "data"));
  app.put("/api/files/:id/thumbnail", auth, (request, reply) => uploadBlob(request, reply, "thumb"));
  app.put("/api/files/:id/index", auth, (request, reply) => uploadBlob(request, reply, "index"));

  // ----- part uploads: large content in bounded requests -----
  //
  // Big blobs arrive as numbered parts inside a session, so any proxy body
  // ceiling stops mattering and one lost part costs one part, not the file.
  // The assembled blob is byte-identical to a single PUT and goes through
  // the same commit, so versions, shares, and downloads never know.

  interface UploadSessionRow {
    id: string;
    user_id: number;
    file_id: string;
    blob_key: string;
    handle: string;
    declared_bytes: number;
    base_generation: number;
    base_uploaded: number;
    created_at: number;
  }

  const partBeginSchema = z.object({ size: z.number().int().positive() });
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_PARTS = 10_000;

  const dropSession = async (session: UploadSessionRow) => {
    await app.blobs.abortParts(session.blob_key, session.handle).catch(() => {});
    await app.db.run("DELETE FROM upload_parts WHERE session_id = ?", session.id);
    await app.db.run("DELETE FROM upload_sessions WHERE id = ?", session.id);
  };

  const getOwnSession = async (
    sessionId: string,
    fileId: string,
    uid: number,
  ): Promise<UploadSessionRow | undefined> =>
    app.db.get<UploadSessionRow>(
      "SELECT * FROM upload_sessions WHERE id = ? AND file_id = ? AND user_id = ?",
      sessionId,
      fileId,
      uid,
    );

  app.post("/api/files/:id/data/parts", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = await getOwnFile(id, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    const body = partBeginSchema.parse(request.body);

    const keepsVersions = app.config.maxVersions > 0;
    const replacesContent = file.uploaded === 1;
    const reclaimable = replacesContent && !keepsVersions ? file.size : 0;
    const quota = await userQuota(app.db, uid, app.config.quotaBytes);
    const quotaRoom = quota - ((await storageUsed(app.db, uid)) - reclaimable);
    const maxBytes = Math.min(app.config.maxBlobBytes, quotaRoom);
    if (maxBytes <= 0 || body.size > maxBytes) {
      return reply.code(413).send({ error: "storage quota exceeded" });
    }

    // One session per file: a fresh begin supersedes anything stale, and
    // sessions abandoned by closed tabs get swept opportunistically.
    for (const stale of await app.db.all<UploadSessionRow>(
      "SELECT * FROM upload_sessions WHERE file_id = ?",
      id,
    )) {
      await dropSession(stale);
    }
    for (const abandoned of await app.db.all<UploadSessionRow>(
      "SELECT * FROM upload_sessions WHERE created_at < ?",
      Date.now() - SESSION_TTL_MS,
    )) {
      await dropSession(abandoned);
    }

    const nextGen = replacesContent ? file.generation + 1 : file.generation;
    const targetKey = blobKey(id, "data", nextGen);
    const handle = await app.blobs.beginParts(targetKey);
    const sessionId = randomUUID();
    await app.db.run(
      `INSERT INTO upload_sessions (id, user_id, file_id, blob_key, handle, declared_bytes, base_generation, base_uploaded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      uid,
      id,
      targetKey,
      handle,
      body.size,
      file.generation,
      file.uploaded,
      Date.now(),
    );
    return reply.code(201).send({ session: sessionId });
  });

  app.put("/api/files/:id/data/parts/:session/:part", auth, async (request, reply) => {
    const { id, session, part } = request.params as { id: string; session: string; part: string };
    const uid = request.user.uid;
    const row = await getOwnSession(session, id, uid);
    if (!row) {
      return reply.code(404).send({ error: "upload session not found" });
    }
    const partNo = Number(part);
    if (!Number.isInteger(partNo) || partNo < 1 || partNo > MAX_PARTS) {
      return reply.code(400).send({ error: "invalid part number" });
    }
    const length = Number(request.headers["content-length"] ?? 0);
    if (!Number.isInteger(length) || length <= 0) {
      return reply.code(400).send({ error: "content-length required" });
    }
    const others = await app.db.get<{ total: number | null }>(
      "SELECT SUM(bytes) AS total FROM upload_parts WHERE session_id = ? AND part_no != ?",
      row.id,
      partNo,
    );
    if (Number(others?.total ?? 0) + length > Number(row.declared_bytes)) {
      return reply.code(413).send({ error: "parts exceed the declared size" });
    }
    let receipt;
    try {
      receipt = await app.blobs.putPart(
        row.blob_key,
        row.handle,
        partNo,
        request.body as Readable,
        length,
      );
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        return reply.code(413).send({ error: "part exceeds its declared length" });
      }
      throw err;
    }
    await app.db.run(
      `INSERT INTO upload_parts (session_id, part_no, etag, bytes) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, part_no) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes`,
      row.id,
      partNo,
      receipt.etag ?? null,
      receipt.bytes,
    );
    return { part: partNo, size: receipt.bytes };
  });

  app.post("/api/files/:id/data/parts/:session/complete", auth, async (request, reply) => {
    const { id, session } = request.params as { id: string; session: string };
    const uid = request.user.uid;
    const row = await getOwnSession(session, id, uid);
    if (!row) {
      return reply.code(404).send({ error: "upload session not found" });
    }
    const parts = await app.db.all<{ part_no: number; etag: string | null; bytes: number }>(
      "SELECT part_no, etag, bytes FROM upload_parts WHERE session_id = ? ORDER BY part_no",
      row.id,
    );
    const total = parts.reduce((sum, p) => sum + Number(p.bytes), 0);
    const contiguous = parts.every((p, i) => Number(p.part_no) === i + 1);
    if (parts.length === 0 || !contiguous || total !== Number(row.declared_bytes)) {
      return reply.code(400).send({ error: "upload incomplete" });
    }
    const file = await getOwnFile(id, uid);
    if (!file) {
      await dropSession(row);
      return reply.code(404).send({ error: "file not found" });
    }
    // Fail before assembly when another writer moved the file meanwhile;
    // commitData re-checks the same condition transactionally.
    if (
      file.generation !== Number(row.base_generation) ||
      file.uploaded !== Number(row.base_uploaded)
    ) {
      await dropSession(row);
      return reply.code(409).send({ error: "the file changed while saving; retry" });
    }
    await app.blobs.completeParts(
      row.blob_key,
      row.handle,
      parts.map((p) => ({ partNo: Number(p.part_no), etag: p.etag ?? undefined })),
    );
    const nextGen = file.uploaded === 1 ? file.generation + 1 : file.generation;
    const result = await commitData(reply, uid, id, file, nextGen, row.blob_key, total);
    await app.db.run("DELETE FROM upload_parts WHERE session_id = ?", row.id);
    await app.db.run("DELETE FROM upload_sessions WHERE id = ?", row.id);
    return result;
  });

  app.delete("/api/files/:id/data/parts/:session", auth, async (request, reply) => {
    const { id, session } = request.params as { id: string; session: string };
    const uid = request.user.uid;
    const row = await getOwnSession(session, id, uid);
    if (!row) {
      return reply.code(404).send({ error: "upload session not found" });
    }
    await dropSession(row);
    return reply.code(204).send();
  });

  const downloadBlob = async (request: FastifyRequest, reply: FastifyReply, kind: BlobKind) => {
    const { id } = request.params as { id: string };
    const file = await getOwnFile(id, request.user.uid);
    const size =
      kind === "data" ? file?.size : kind === "thumb" ? file?.thumb_size : file?.index_size;
    if (!file || (kind === "data" && !file.uploaded) || (kind !== "data" && !size)) {
      return reply.code(404).send({ error: "blob not found" });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", size);
    return reply.send(await app.blobs.get(blobKey(id, kind, kind === "data" ? file.generation : 0)));
  };

  app.get("/api/files/:id/data", auth, (request, reply) => downloadBlob(request, reply, "data"));
  app.get("/api/files/:id/thumbnail", auth, (request, reply) => downloadBlob(request, reply, "thumb"));
  app.get("/api/files/:id/index", auth, (request, reply) => downloadBlob(request, reply, "index"));

  app.patch("/api/files/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const body = patchFileSchema.parse(request.body);
    if (!(await getOwnFile(id, uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (
      body.folderId !== undefined &&
      body.folderId !== null &&
      !(await getOwnFolder(body.folderId, uid))
    ) {
      return reply.code(404).send({ error: "destination folder not found" });
    }
    await app.db.run(
      `UPDATE files SET
         folder_id = CASE WHEN ? = 1 THEN ? ELSE folder_id END,
         encrypted_meta = COALESCE(?, encrypted_meta),
         update_seq = ?, updated_at = ?
       WHERE id = ?`,
      body.folderId !== undefined ? 1 : 0,
      body.folderId ?? null,
      body.encryptedMeta ? JSON.stringify(body.encryptedMeta) : null,
      await nextSeq(app.db, uid),
      Date.now(),
      id,
    );
    const row = (await app.db.get<FileRow>("SELECT * FROM files WHERE id = ?", id))!;
    return fileToDto(row);
  });

  app.delete("/api/files/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = await getOwnFile(id, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    await app.db.run(
      "UPDATE files SET trashed = 1, update_seq = ?, updated_at = ? WHERE id = ?",
      await nextSeq(app.db, uid),
      Date.now(),
      id,
    );
    return reply.code(204).send();
  });

  app.post("/api/trash/:id/restore", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = await getOwnFile(id, uid);
    if (!file || !file.trashed) {
      return reply.code(404).send({ error: "file not found in trash" });
    }
    // If the original folder was deleted, the file comes back at the root.
    const folderAlive = file.folder_id ? Boolean(await getOwnFolder(file.folder_id, uid)) : true;
    await app.db.run(
      "UPDATE files SET trashed = 0, folder_id = ?, update_seq = ?, updated_at = ? WHERE id = ?",
      folderAlive ? file.folder_id : null,
      await nextSeq(app.db, uid),
      Date.now(),
      id,
    );
    return reply.code(204).send();
  });

  app.delete("/api/trash/:id", auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = request.user.uid;
    const file = await getOwnFile(id, uid);
    if (!file || !file.trashed) {
      return reply.code(404).send({ error: "file not found in trash" });
    }
    const versionGens = await app.db.all<{ generation: number }>(
      "SELECT generation FROM file_versions WHERE file_id = ?",
      id,
    );
    await app.db.tx(async (t) => {
      await t.run("DELETE FROM shares WHERE file_id = ?", id);
      await t.run("DELETE FROM file_versions WHERE file_id = ?", id);
      await t.run(
        "UPDATE files SET deleted = 1, size = 0, thumb_size = 0, uploaded = 0, update_seq = ?, updated_at = ? WHERE id = ?",
        await nextSeq(t, uid),
        Date.now(),
        id,
      );
    });
    await app.blobs.remove(blobKey(id, "data", file.generation)).catch(() => {});
    for (const row of versionGens) {
      await app.blobs.remove(blobKey(id, "data", row.generation)).catch(() => {});
    }
    await app.blobs.remove(blobKey(id, "thumb")).catch(() => {});
    await app.blobs.remove(blobKey(id, "index")).catch(() => {});
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
    if (!(await getOwnFile(id, request.user.uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    const rows = await app.db.all<FileVersionRow>(
      "SELECT * FROM file_versions WHERE file_id = ? AND user_id = ? ORDER BY generation DESC",
      id,
      request.user.uid,
    );
    return { versions: rows.map(versionToDto) };
  });

  app.get("/api/files/:id/versions/:gen/data", auth, async (request, reply) => {
    const { id, gen } = request.params as { id: string; gen: string };
    const uid = request.user.uid;
    if (!(await getOwnFile(id, uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    const version = await app.db.get<FileVersionRow>(
      "SELECT * FROM file_versions WHERE file_id = ? AND user_id = ? AND generation = ?",
      id,
      uid,
      Number(gen),
    );
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
    const file = await getOwnFile(id, uid);
    if (!file || !file.uploaded || file.trashed) {
      return reply.code(404).send({ error: "file not found" });
    }
    const generation = Number(gen);
    const row = await app.db.tx(async (t) => {
      const version = await t.get<FileVersionRow>(
        "SELECT * FROM file_versions WHERE file_id = ? AND user_id = ? AND generation = ?",
        id,
        uid,
        generation,
      );
      if (!version) {
        return null;
      }
      await t.run(
        `INSERT INTO file_versions (file_id, user_id, generation, size, encrypted_meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        uid,
        file.generation,
        file.size,
        file.encrypted_meta,
        file.updated_at,
      );
      await t.run("DELETE FROM file_versions WHERE file_id = ? AND generation = ?", id, generation);
      await t.run(
        "UPDATE files SET generation = ?, size = ?, encrypted_meta = ?, update_seq = ?, updated_at = ? WHERE id = ?",
        generation,
        version.size,
        JSON.stringify(body.encryptedMeta),
        await nextSeq(t, uid),
        Date.now(),
        id,
      );
      return (await t.get<FileRow>("SELECT * FROM files WHERE id = ?", id))!;
    });
    if (!row) {
      return reply.code(404).send({ error: "version not found" });
    }
    return fileToDto(row);
  });

  // Delta sync: everything that changed after the client's cursor, tombstones included.
  app.get("/api/sync", auth, async (request) => {
    const uid = request.user.uid;
    const since = Number((request.query as { since?: string }).since ?? 0);
    const folders = await app.db.all<FolderRow>(
      "SELECT * FROM folders WHERE user_id = ? AND update_seq > ? ORDER BY update_seq",
      uid,
      since,
    );
    const files = await app.db.all<FileRow>(
      "SELECT * FROM files WHERE user_id = ? AND update_seq > ? ORDER BY update_seq",
      uid,
      since,
    );
    const user = (await app.db.get<{ last_seq: number }>(
      "SELECT last_seq FROM users WHERE id = ?",
      uid,
    ))!;
    return {
      seq: user.last_seq,
      folders: folders.map(folderToDto),
      files: files.map(fileToDto),
    };
  });
}

async function folderSubtreeIds(
  app: FastifyInstance,
  uid: number,
  rootId: string,
): Promise<string[]> {
  const rows = await app.db.all<{ id: string }>(
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted = 0
       UNION ALL
       SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
       WHERE f.user_id = ? AND f.deleted = 0
     ) SELECT id FROM subtree`,
    rootId,
    uid,
    uid,
  );
  return rows.map((r) => r.id);
}

async function isDescendant(
  app: FastifyInstance,
  uid: number,
  candidateId: string,
  ancestorId: string,
): Promise<boolean> {
  return (await folderSubtreeIds(app, uid, ancestorId)).includes(candidateId);
}
