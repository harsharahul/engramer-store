import type { Db } from "./db.js";

/**
 * Who holds a live editing channel, across every server instance.
 *
 * Presence rows are written by whichever instance holds the socket and
 * read by all of them: the members list, and the gate that refuses a
 * plain save while someone edits live. A row's `last_seen` ages it out
 * after PRESENCE_TTL_MS; a row's `pod_id` ties it to the instance that
 * wrote it, and an instance that stopped heartbeating takes its rows out
 * of every read at once, instead of leaving saves refused for the TTL.
 * An instance leaving on purpose deletes its rows on the way out.
 */
export const PRESENCE_TTL_MS = 90_000;
export const POD_HEARTBEAT_MS = 30_000;
/** Two missed heartbeats and an instance is presumed gone. */
export const POD_TTL_MS = 2 * POD_HEARTBEAT_MS + 5_000;

/** SQL that keeps only presence rows from instances still heartbeating,
 * for a query that already filters `last_seen`. Binds one parameter: the
 * oldest acceptable pod heartbeat. */
export const LIVE_POD_SQL = "pod_id IN (SELECT pod_id FROM pods WHERE last_seen > ?)";

export interface PresenceRow {
  conn_id: string;
  pod_id: string;
  user_id: number;
  user_index: number;
  role: string | null;
  email: string;
  display_name: string | null;
}

/** The live members of a document's channel, on every instance. */
export async function livePresence(db: Db, fileId: string): Promise<PresenceRow[]> {
  const now = Date.now();
  return db.all<PresenceRow>(
    `SELECT p.conn_id, p.pod_id, p.user_id, p.user_index, p.role, u.email, u.display_name
       FROM channel_presence p JOIN users u ON u.id = p.user_id
      WHERE p.file_id = ? AND p.last_seen > ? AND p.${LIVE_POD_SQL}
      ORDER BY p.user_index`,
    fileId,
    now - PRESENCE_TTL_MS,
    now - POD_TTL_MS,
  );
}

/**
 * Who is here, by name. Everyone on this list was invited to this
 * document by its owner, and an editor showing "member 2" tells a person
 * nothing about who is typing beside them. Identity travels no further
 * than the document's own membership, and never over the bus: every
 * instance builds this frame from the table.
 */
export async function membersFrame(db: Db, fileId: string): Promise<Record<string, unknown>> {
  return {
    t: "members",
    members: (await livePresence(db, fileId)).map((row) => ({
      connId: row.conn_id,
      index: row.user_index,
      // What this connection may do, so clients can elect a member that
      // is actually allowed to write the checkpoint.
      role: row.role ?? undefined,
      // The name they chose, or their address if they chose none: an
      // account has no name until someone sets one, and a blank label
      // beside a cursor is worse than an address.
      name: row.display_name ?? row.email,
    })),
  };
}

/** Rows no reader can see any more: older than the TTL by a wide margin. */
export async function sweepPresence(db: Db): Promise<void> {
  await db.run("DELETE FROM channel_presence WHERE last_seen < ?", Date.now() - 60 * 60 * 1000);
}

/**
 * This instance's row in `pods`, refreshed while it runs and removed,
 * along with the presence rows it owns, when it stops.
 */
export class PodHeartbeat {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly podId: string,
    private readonly intervalMs = POD_HEARTBEAT_MS,
  ) {}

  async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      this.beat().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async beat(): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `INSERT INTO pods (pod_id, last_seen) VALUES (?, ?)
       ON CONFLICT (pod_id) DO UPDATE SET last_seen = ?`,
      this.podId,
      now,
      now,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.db.run("DELETE FROM channel_presence WHERE pod_id = ?", this.podId).catch(() => {});
    await this.db.run("DELETE FROM pods WHERE pod_id = ?", this.podId).catch(() => {});
  }
}
