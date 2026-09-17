import type { FastifyInstance } from "fastify";
import { blobKey } from "./blobs.js";

/**
 * Removing an account: every row that names the user, then every blob
 * those rows pointed at. One function, used by the operator's admin
 * route and by the account's own delete, so the two can never drift.
 *
 * Rows go first, inside one transaction, so a half-finished deletion is
 * impossible; blobs go after, best effort: a leftover blob is
 * unreferenced ciphertext under a key nobody holds any more, garbage
 * rather than data. Files the user shared with collaborators go with
 * the user; the collaborators' own sequences advance so their next pull
 * learns the file is gone.
 */
export async function deleteUserCascade(app: FastifyInstance, userId: number): Promise<void> {
  const files = await app.db.all<{ id: string; generation: number }>(
    "SELECT id, generation FROM files WHERE user_id = ?",
    userId,
  );
  const versions = await app.db.all<{ file_id: string; generation: number }>(
    "SELECT file_id, generation FROM file_versions WHERE user_id = ?",
    userId,
  );
  const uploads = await app.db.all<{ id: string }>(
    "SELECT id FROM request_uploads WHERE user_id = ?",
    userId,
  );
  const fileIds = files.map((file) => file.id);
  await app.db.tx(async (t) => {
    for (const fileId of fileIds) {
      await t.run("DELETE FROM channel_messages WHERE file_id = ?", fileId);
      await t.run("DELETE FROM channel_state WHERE file_id = ?", fileId);
      await t.run("DELETE FROM channel_presence WHERE file_id = ?", fileId);
      await t.run("DELETE FROM collab_invites WHERE file_id = ?", fileId);
    }
    // People this user shared with: their copies of the record vanish, and
    // their sequence moves so a pull notices.
    const collaborators = await t.all<{ user_id: number }>(
      "SELECT DISTINCT user_id FROM file_collaborators WHERE owner_id = ?",
      userId,
    );
    await t.run("DELETE FROM file_collaborators WHERE owner_id = ? OR user_id = ?", userId, userId);
    for (const { user_id } of collaborators) {
      await t.run("UPDATE users SET last_seq = last_seq + 1 WHERE id = ?", user_id);
    }
    await t.run("DELETE FROM collab_tickets WHERE user_id = ?", userId);
    await t.run("DELETE FROM auth_challenges WHERE user_id = ?", userId);
    await t.run("DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE user_id = ?)", userId);
    await t.run("DELETE FROM upload_sessions WHERE user_id = ?", userId);
    await t.run("DELETE FROM shares WHERE user_id = ?", userId);
    await t.run("DELETE FROM file_versions WHERE user_id = ?", userId);
    await t.run("DELETE FROM request_uploads WHERE user_id = ?", userId);
    await t.run("DELETE FROM file_requests WHERE user_id = ?", userId);
    await t.run("DELETE FROM files WHERE user_id = ?", userId);
    await t.run("DELETE FROM folders WHERE user_id = ?", userId);
    await t.run("DELETE FROM invites WHERE created_by = ?", userId);
    await t.run("DELETE FROM session_keys WHERE user_id = ?", userId);
    await t.run("DELETE FROM users WHERE id = ?", userId);
  });
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
}
