import type { FastifyInstance } from "fastify";

/**
 * Change-feed pokes across server instances. The allocator on PostgreSQL
 * notifies `engram_seq` from inside its own UPDATE, so the notification
 * commits, or rolls back, with the change it announces. Every instance
 * hears every notification, including its own: the local path has
 * already poked for those, so they are skipped by origin. A poke is only
 * ever "pull now", so one that arrives twice costs one empty pull.
 *
 * While an instance's listener is down, notifications are simply gone.
 * On reconnect the instance pokes every account it holds a stream for
 * with the account's current sequence, read fresh: the Mac client drops
 * any sequence at or below the last one it saw, so a blank or stale poke
 * would heal nothing.
 */
export const SEQ_CHANNEL = "engram_seq";

export function attachSeqFanout(app: FastifyInstance): void {
  app.bus.subscribe(SEQ_CHANNEL, (payload) => {
    const [user, seq, origin] = payload.split(":");
    if (origin === app.podId) {
      return;
    }
    const userId = Number(user);
    const value = Number(seq);
    if (Number.isFinite(userId) && Number.isFinite(value)) {
      app.seqEvents.note(userId, value);
    }
  });
  app.bus.onReconnect(async (first) => {
    if (first) {
      return;
    }
    const users = app.seqEvents.subscribedUsers();
    if (users.length === 0) {
      return;
    }
    const rows = await app.db.all<{ id: number; last_seq: number }>(
      `SELECT id, last_seq FROM users WHERE id IN (${users.map(() => "?").join(", ")})`,
      ...users,
    );
    for (const row of rows) {
      app.seqEvents.note(Number(row.id), Number(row.last_seq));
    }
  });
}
