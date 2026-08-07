import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CollabInviteRow, FileCollaboratorRow, UserRow } from "../db.js";
import { nextSeq } from "../db.js";
import { AuthThrottle } from "../ratelimit.js";

const createInviteSchema = z.object({
  fileId: z.string(),
  role: z.enum(["viewer", "editor"]),
  expiresAt: z.number().int().positive().nullable().optional(),
});

const grantSchema = z.object({ sealedKey: z.string().min(1) });

const patchCollaboratorSchema = z.object({ role: z.enum(["viewer", "editor"]) });

const rekeySchema = z.object({
  epoch: z.number().int().positive(),
  keys: z.array(z.object({ userId: z.number().int(), sealedKey: z.string().min(1) })),
});

/**
 * Account-to-account sharing. An invite token conveys identity, never key
 * material: the recipient claims it while signed in, and the owner's client
 * then seals the file key to the claimant's published public key. The server
 * stores the sealed box and can open none of it.
 *
 * The privacy rule of this file: no route maps an email to an account, and
 * every dead token — fictional, revoked, expired, spent, someone else's —
 * answers with ONE identical 404 body, so tokens and accounts cannot be
 * probed apart. A claimant's email is revealed to the owner only after the
 * claimant chose to claim; that choice is the consent.
 */
export function registerCollabRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };
  const throttle = new AuthThrottle(app.db);
  // Keyed on the caller, NOT on the token: including the token gave every
  // guess its own fresh budget, so grinding the token space was never
  // slowed by the backoff this endpoint claimed to have.
  const throttleKey = (request: FastifyRequest) => `${request.ip}|invite`;

  const NOT_AVAILABLE = { error: "this invitation is no longer available" };

  const publicKeyOf = (user: Pick<UserRow, "key_attributes">): string =>
    (JSON.parse(user.key_attributes) as { publicKey: string }).publicKey;

  /** The file, but only when the caller owns it and it is live. */
  const ownedFile = (fileId: string, uid: number) =>
    app.db.get<{ id: string; key_epoch: number }>(
      "SELECT id, key_epoch FROM files WHERE id = ? AND user_id = ? AND deleted = 0 AND trashed = 0 AND uploaded = 1",
      fileId,
      uid,
    );

  app.post("/api/collab/invites", auth, async (request, reply) => {
    const body = createInviteSchema.parse(request.body);
    const uid = request.user.uid;
    if (!(await ownedFile(body.fileId, uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (body.expiresAt && body.expiresAt <= Date.now()) {
      return reply.code(400).send({ error: "expiry must be in the future" });
    }
    const token = randomBytes(16).toString("base64url");
    await app.db.run(
      `INSERT INTO collab_invites (token, file_id, owner_id, role, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      token,
      body.fileId,
      uid,
      body.role,
      body.expiresAt ?? null,
      Date.now(),
    );
    return reply.code(201).send({ token });
  });

  app.get("/api/collab/invites", auth, async (request) => {
    const rows = await app.db.all<CollabInviteRow>(
      "SELECT * FROM collab_invites WHERE owner_id = ? ORDER BY created_at DESC",
      request.user.uid,
    );
    const invites = [];
    for (const row of rows) {
      let claimant: { email: string; publicKey: string } | null = null;
      if (row.claimed_by !== null) {
        const user = await app.db.get<Pick<UserRow, "email" | "key_attributes">>(
          "SELECT email, key_attributes FROM users WHERE id = ?",
          row.claimed_by,
        );
        if (user) {
          claimant = { email: user.email, publicKey: publicKeyOf(user) };
        }
      }
      invites.push({
        token: row.token,
        fileId: row.file_id,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revoked: row.revoked === 1,
        granted: row.granted === 1,
        claimed: row.claimed_by !== null,
        ...(claimant
          ? { claimantEmail: claimant.email, claimantPublicKey: claimant.publicKey }
          : {}),
      });
    }
    return { invites };
  });

  app.delete("/api/collab/invites/:token", auth, async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = await app.db.run(
      "UPDATE collab_invites SET revoked = 1 WHERE token = ? AND owner_id = ?",
      token,
      request.user.uid,
    );
    if (result.changes === 0) {
      return reply.code(404).send({ error: "invite not found" });
    }
    return reply.code(204).send();
  });

  app.post("/api/collab/invites/:token/claim", auth, async (request, reply) => {
    const { token } = request.params as { token: string };
    const uid = request.user.uid;
    // Grinding tokens gets the sign-in backoff; every failure below counts.
    const blockedFor = await throttle.check(throttleKey(request));
    if (!blockedFor.allowed) {
      return reply
        .code(429)
        .header("retry-after", Math.ceil(blockedFor.retryAfterMs / 1000))
        .send({ error: "too many attempts" });
    }
    const refuse = async () => {
      await throttle.fail(throttleKey(request));
      return reply.code(404).send(NOT_AVAILABLE);
    };
    const invite = await app.db.get<CollabInviteRow>(
      "SELECT * FROM collab_invites WHERE token = ?",
      token,
    );
    // One refusal shape for every dead token: fictional, revoked, expired,
    // spent, or the owner's own. Distinguishing them would leak state.
    if (
      !invite ||
      invite.revoked === 1 ||
      invite.owner_id === uid ||
      (invite.expires_at !== null && invite.expires_at <= Date.now())
    ) {
      return refuse();
    }
    const file = await ownedFile(invite.file_id, invite.owner_id);
    const owner = await app.db.get<Pick<UserRow, "email" | "disabled">>(
      "SELECT email, disabled FROM users WHERE id = ?",
      invite.owner_id,
    );
    if (!file || !owner || owner.disabled === 1) {
      return refuse();
    }
    // Atomic: two racing claims can never both take the invite.
    const claimed = await app.db.run(
      "UPDATE collab_invites SET claimed_by = ?, claimed_at = ? WHERE token = ? AND claimed_by IS NULL AND revoked = 0",
      uid,
      Date.now(),
      token,
    );
    if (claimed.changes === 0) {
      return refuse();
    }
    await throttle.succeed(throttleKey(request));
    // Nothing about the file: the claimant learns who is sharing and at what
    // role, and sees the document only once the owner releases the key.
    return { ownerEmail: owner.email, role: invite.role };
  });

  app.post("/api/collab/invites/:token/grant", auth, async (request, reply) => {
    const { token } = request.params as { token: string };
    const uid = request.user.uid;
    const body = grantSchema.parse(request.body);
    const invite = await app.db.get<CollabInviteRow>(
      "SELECT * FROM collab_invites WHERE token = ?",
      token,
    );
    if (
      !invite ||
      invite.owner_id !== uid ||
      invite.revoked === 1 ||
      invite.claimed_by === null ||
      invite.granted === 1
    ) {
      return reply.code(404).send({ error: "invite not found or not claimable" });
    }
    const file = await ownedFile(invite.file_id, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    const now = Date.now();
    await app.db.tx(async (t) => {
      // The membership row carries a seq from the COLLABORATOR's counter, so
      // the share arrives through their ordinary delta sync.
      const seq = await nextSeq(t, invite.claimed_by!);
      await t.run(
        `INSERT INTO file_collaborators (file_id, user_id, owner_id, role, sealed_key, key_epoch, update_seq, revoked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (file_id, user_id) DO UPDATE SET
           role = excluded.role, sealed_key = excluded.sealed_key,
           key_epoch = excluded.key_epoch, update_seq = excluded.update_seq,
           revoked = 0, updated_at = excluded.updated_at`,
        invite.file_id,
        invite.claimed_by,
        uid,
        invite.role,
        body.sealedKey,
        file.key_epoch,
        seq,
        now,
        now,
      );
      await t.run("UPDATE collab_invites SET granted = 1 WHERE token = ?", token);
    });
    return reply.code(201).send({ ok: true });
  });

  app.get("/api/collab/files/:fileId/collaborators", auth, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const uid = request.user.uid;
    if (!(await ownedFile(fileId, uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    const rows = await app.db.all<FileCollaboratorRow & { email: string; key_attributes: string }>(
      `SELECT c.*, u.email, u.key_attributes FROM file_collaborators c JOIN users u ON u.id = c.user_id
       WHERE c.file_id = ? AND c.revoked = 0 ORDER BY c.created_at`,
      fileId,
    );
    return {
      collaborators: rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        // The member's account public key, so the owner can re-seal a
        // rotated file key without hunting through invite records.
        publicKey: publicKeyOf(row),
        role: row.role,
        keyEpoch: row.key_epoch,
        createdAt: row.created_at,
      })),
    };
  });

  /** Bumps one member's seq so the change reaches them through delta sync. */
  const touchMember = async (fileId: string, memberUid: number, now: number) => {
    await app.db.run(
      "UPDATE file_collaborators SET update_seq = ?, updated_at = ? WHERE file_id = ? AND user_id = ?",
      await nextSeq(app.db, memberUid),
      now,
      fileId,
      memberUid,
    );
  };

  app.patch("/api/collab/files/:fileId/collaborators/:uid", auth, async (request, reply) => {
    const { fileId, uid: memberParam } = request.params as { fileId: string; uid: string };
    const memberUid = Number(memberParam);
    const body = patchCollaboratorSchema.parse(request.body);
    if (!(await ownedFile(fileId, request.user.uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    const changed = await app.db.run(
      "UPDATE file_collaborators SET role = ? WHERE file_id = ? AND user_id = ? AND revoked = 0",
      body.role,
      fileId,
      memberUid,
    );
    if (changed.changes === 0) {
      return reply.code(404).send({ error: "collaborator not found" });
    }
    await touchMember(fileId, memberUid, Date.now());
    return reply.code(204).send();
  });

  app.delete("/api/collab/files/:fileId/collaborators/:uid", auth, async (request, reply) => {
    const { fileId, uid: memberParam } = request.params as { fileId: string; uid: string };
    const memberUid = Number(memberParam);
    if (!(await ownedFile(fileId, request.user.uid))) {
      return reply.code(404).send({ error: "file not found" });
    }
    const changed = await app.db.run(
      "UPDATE file_collaborators SET revoked = 1 WHERE file_id = ? AND user_id = ? AND revoked = 0",
      fileId,
      memberUid,
    );
    if (changed.changes === 0) {
      return reply.code(404).send({ error: "collaborator not found" });
    }
    // The tombstone still has to reach them, so the seq bump comes after.
    await touchMember(fileId, memberUid, Date.now());
    return reply.code(204).send();
  });

  app.delete("/api/collab/files/:fileId/me", auth, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const uid = request.user.uid;
    const changed = await app.db.run(
      "UPDATE file_collaborators SET revoked = 1 WHERE file_id = ? AND user_id = ? AND revoked = 0",
      fileId,
      uid,
    );
    if (changed.changes === 0) {
      return reply.code(404).send({ error: "not a collaborator" });
    }
    await touchMember(fileId, uid, Date.now());
    return reply.code(204).send();
  });

  app.post("/api/collab/files/:fileId/rekey", auth, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const uid = request.user.uid;
    const body = rekeySchema.parse(request.body);
    const file = await ownedFile(fileId, uid);
    if (!file) {
      return reply.code(404).send({ error: "file not found" });
    }
    const now = Date.now();
    await app.db.tx(async (t) => {
      // Every frame still in the channel is sealed under the key being
      // retired. Left there, the next client to open the document meets a
      // frame it cannot decrypt, reloads, meets it again, and never gets
      // in — the document would be permanently unopenable for everyone.
      await t.run("DELETE FROM channel_messages WHERE file_id = ?", fileId);
      await t.run(
        "UPDATE channel_state SET last_seq = 0, snapshot_seq = 0, bytes = 0, updated_at = ? WHERE file_id = ?",
        now,
        fileId,
      );
      for (const entry of body.keys) {
        await t.run(
          `UPDATE file_collaborators SET sealed_key = ?, key_epoch = ?, update_seq = ?, updated_at = ?
           WHERE file_id = ? AND user_id = ? AND revoked = 0`,
          entry.sealedKey,
          body.epoch,
          await nextSeq(t, entry.userId),
          now,
          fileId,
          entry.userId,
        );
      }
    });
    return reply.code(204).send();
  });
}
