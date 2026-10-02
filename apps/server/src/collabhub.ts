import type { Bus } from "./bus.js";
import type { Db } from "./db.js";

/**
 * Fan-out for document channels. The DATABASE is the ordering authority:
 * every durable frame takes its seq from a single-row atomic before any
 * broadcast, so a hub only decides how a frame REACHES sockets that live
 * on other processes. Correctness never depends on which hub is running.
 *
 * InProcessHub covers single-process deployments (embedded SQLite mandates
 * one instance anyway). PgNotifyHub adds the other instances over the bus:
 * it delivers locally exactly as InProcessHub does, and tells the rest of
 * the instances what moved.
 */

export interface Connection {
  /** Per-connection random id; doubles as the sender id clients see. */
  id: string;
  /** Whose socket this is, so losing access can close it immediately. */
  userId: number;
  send(frame: Record<string, unknown>): void;
  close(code: number): void;
}

export interface ChannelHub {
  join(fileId: string, conn: Connection): void;
  leave(fileId: string, conn: Connection): void;
  /** Delivers to every member of the channel except the named connection. */
  broadcast(fileId: string, frame: Record<string, unknown>, exceptConnId?: string): void;
  /** Connection ids currently held by THIS process for the channel. */
  local(fileId: string): string[];
  /** Closes this account's sockets on a document; used when access ends. */
  evict(fileId: string, userId: number): void;
  close(): Promise<void>;
}

export class InProcessHub implements ChannelHub {
  protected channels = new Map<string, Map<string, Connection>>();

  join(fileId: string, conn: Connection): void {
    let members = this.channels.get(fileId);
    if (!members) {
      members = new Map();
      this.channels.set(fileId, members);
    }
    members.set(conn.id, conn);
  }

  leave(fileId: string, conn: Connection): void {
    const members = this.channels.get(fileId);
    if (!members) {
      return;
    }
    members.delete(conn.id);
    if (members.size === 0) {
      this.channels.delete(fileId);
    }
  }

  broadcast(fileId: string, frame: Record<string, unknown>, exceptConnId?: string): void {
    for (const [id, conn] of this.channels.get(fileId) ?? []) {
      if (id !== exceptConnId) {
        conn.send(frame);
      }
    }
  }

  local(fileId: string): string[] {
    return [...(this.channels.get(fileId)?.keys() ?? [])];
  }

  evict(fileId: string, userId: number): void {
    for (const conn of [...(this.channels.get(fileId)?.values() ?? [])]) {
      if (conn.userId === userId) {
        conn.close(4403);
      }
    }
  }

  async close(): Promise<void> {}
}

/** The bus channel every instance's hub listens on. */
export const HUB_CHANNEL = "engram_channel";

/**
 * What crosses the bus. A durable `log` frame travels as its position
 * only: the receiver re-reads the rows it has not delivered yet from
 * `channel_messages`, so a notification that never arrived is repaired by
 * the next one and nothing large rides a notification. The members list
 * travels as a signal and is rebuilt from the presence table on arrival,
 * so nobody's address does either. Small frames travel as they are.
 */
type Envelope =
  | { k: "log"; f: string; s: number; o: string }
  | { k: "members"; f: string; o: string }
  | { k: "evict"; f: string; u: number; o: string }
  | { k: "frame"; f: string; x?: string; o: string; fr: Record<string, unknown> };

export interface PgNotifyHubOptions {
  bus: Bus;
  db: Db;
  podId: string;
  /** Builds the members frame for a document from the presence table. */
  membersFrame: (fileId: string) => Promise<Record<string, unknown>>;
  /** Cursor frames from one sender within this window collapse to the
   * newest before they cross the bus; local delivery is immediate. */
  ephCoalesceMs?: number;
  log?: (message: string) => void;
}

export class PgNotifyHub extends InProcessHub {
  /** Per document: the highest log seq this instance has seen announced,
   * its own posts included. Rows above it are what a notification, or a
   * reconnect, has to deliver. */
  private readonly watermark = new Map<string, number>();
  private readonly pendingEph = new Map<string, { fileId: string; frame: Record<string, unknown>; timer: NodeJS.Timeout }>();
  private readonly unsubscribe: () => void;
  private readonly detachReconnect: () => void;
  private readonly log: (message: string) => void;
  private readonly ephCoalesceMs: number;

  constructor(private readonly options: PgNotifyHubOptions) {
    super();
    this.log = options.log ?? ((message) => console.warn(`hub: ${message}`));
    this.ephCoalesceMs = options.ephCoalesceMs ?? 100;
    this.unsubscribe = options.bus.subscribe(HUB_CHANNEL, (payload) => {
      void this.receive(payload);
    });
    this.detachReconnect = options.bus.onReconnect((first) => (first ? undefined : this.resync()));
  }

  override join(fileId: string, conn: Connection): void {
    super.join(fileId, conn);
    if (!this.watermark.has(fileId)) {
      // The baseline for gap detection: where the log stands as the first
      // local member arrives. Their hello replays everything up to here.
      void this.options.db
        .get<{ last_seq: number }>("SELECT last_seq FROM channel_state WHERE file_id = ?", fileId)
        .then((state) => {
          if (!this.watermark.has(fileId)) {
            this.watermark.set(fileId, Number(state?.last_seq ?? 0));
          }
        })
        .catch(() => {});
    }
  }

  override broadcast(fileId: string, frame: Record<string, unknown>, exceptConnId?: string): void {
    super.broadcast(fileId, frame, exceptConnId);
    const origin = this.options.podId;
    switch (frame.t) {
      case "log": {
        const seq = Number(frame.seq);
        if (Number.isFinite(seq)) {
          // A local post lands at `seq`; anything between the watermark and
          // it was posted through another instance and, if its notice never
          // arrived, is owed to the sockets here. Only then does the mark
          // move, so a gap is never stepped over by our own posts.
          const from = this.watermark.get(fileId);
          const members = this.channels.get(fileId);
          if (from !== undefined && members && seq - 1 > from) {
            void this.deliverRows(fileId, from, seq - 1, members).catch((err: Error) =>
              this.log(`gap fill for ${fileId} failed: ${err.message}`),
            );
          }
          this.watermark.set(fileId, Math.max(from ?? 0, seq));
          this.send({ k: "log", f: fileId, s: seq, o: origin });
        }
        return;
      }
      case "members":
        this.send({ k: "members", f: fileId, o: origin });
        return;
      case "eph": {
        const sender = typeof frame.sender === "string" ? frame.sender : "";
        const key = `${fileId}:${sender}`;
        const pending = this.pendingEph.get(key);
        if (pending) {
          pending.frame = frame;
          return;
        }
        const timer = setTimeout(() => {
          const latest = this.pendingEph.get(key);
          this.pendingEph.delete(key);
          if (latest) {
            this.send({ k: "frame", f: fileId, x: exceptConnId, o: origin, fr: latest.frame });
          }
        }, this.ephCoalesceMs);
        timer.unref?.();
        this.pendingEph.set(key, { fileId, frame, timer });
        return;
      }
      default:
        this.send({ k: "frame", f: fileId, x: exceptConnId, o: origin, fr: frame });
    }
  }

  override evict(fileId: string, userId: number): void {
    super.evict(fileId, userId);
    this.send({ k: "evict", f: fileId, u: userId, o: this.options.podId });
  }

  override async close(): Promise<void> {
    this.unsubscribe();
    this.detachReconnect();
    for (const pending of this.pendingEph.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingEph.clear();
  }

  private send(envelope: Envelope): void {
    this.options.bus.publish(HUB_CHANNEL, JSON.stringify(envelope)).catch((err: Error) => {
      // Too large, or the publisher is down: local sockets were served;
      // the other instances hear about durable state on the next signal.
      this.log(`could not publish a ${envelope.k} notice for ${envelope.f}: ${err.message}`);
    });
  }

  private async receive(payload: string): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(payload) as Envelope;
    } catch {
      return;
    }
    const own = envelope.o === this.options.podId;
    switch (envelope.k) {
      case "log":
        await this.deliverLog(envelope.f, envelope.s, own);
        return;
      case "members":
        if (!own && this.channels.has(envelope.f)) {
          super.broadcast(envelope.f, await this.options.membersFrame(envelope.f));
        }
        return;
      case "evict":
        if (!own) {
          super.evict(envelope.f, envelope.u);
        }
        return;
      case "frame":
        if (!own) {
          super.broadcast(envelope.f, envelope.fr, envelope.x);
        }
        return;
    }
  }

  /**
   * Delivers the log rows this instance has not yet delivered for the
   * document, up to `seq`. The instance's own posts were delivered when
   * they were made, so its own notice only moves the watermark past them,
   * after filling any gap other instances left below it.
   */
  private async deliverLog(fileId: string, seq: number, own: boolean): Promise<void> {
    const members = this.channels.get(fileId);
    if (!members || members.size === 0) {
      // Nobody here for this document: remember where it stands, so a
      // later joiner's first notice does not replay history their hello
      // already caught them up on.
      this.watermark.set(fileId, Math.max(this.watermark.get(fileId) ?? 0, seq));
      return;
    }
    const from = this.watermark.get(fileId);
    if (from === undefined) {
      // First notice for a document someone here just joined: hello
      // replayed the log for them, so only what comes next is news.
      this.watermark.set(fileId, seq);
      if (!own) {
        await this.deliverRows(fileId, seq - 1, seq, members);
      }
      return;
    }
    const upTo = own ? seq - 1 : seq;
    if (upTo > from) {
      await this.deliverRows(fileId, from, upTo, members);
    }
    this.watermark.set(fileId, Math.max(from, seq));
  }

  private async deliverRows(
    fileId: string,
    after: number,
    upTo: number,
    members: Map<string, Connection>,
  ): Promise<void> {
    const rows = await this.options.db.all<{ seq: number; sender: string; payload: string }>(
      "SELECT seq, sender, payload FROM channel_messages WHERE file_id = ? AND seq > ? AND seq <= ? ORDER BY seq",
      fileId,
      after,
      upTo,
    );
    for (const row of rows) {
      const frame = { t: "log", seq: Number(row.seq), sender: row.sender, payload: row.payload };
      for (const [id, conn] of members) {
        if (id !== row.sender) {
          conn.send(frame);
        }
      }
    }
  }

  /** After a gap: every document with members here catches up from its
   * watermark to the log's head, and hears who is here now. */
  private async resync(): Promise<void> {
    for (const fileId of [...this.channels.keys()]) {
      try {
        const state = await this.options.db.get<{ last_seq: number }>(
          "SELECT last_seq FROM channel_state WHERE file_id = ?",
          fileId,
        );
        const head = Number(state?.last_seq ?? 0);
        const members = this.channels.get(fileId);
        const from = this.watermark.get(fileId);
        if (members && from !== undefined && head > from) {
          await this.deliverRows(fileId, from, head, members);
        }
        this.watermark.set(fileId, Math.max(from ?? 0, head));
        if (members) {
          super.broadcast(fileId, await this.options.membersFrame(fileId));
        }
      } catch (err) {
        this.log(`resync of ${fileId} failed: ${(err as Error).message}`);
      }
    }
  }
}
