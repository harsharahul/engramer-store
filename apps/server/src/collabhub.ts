/**
 * Fan-out for document channels. The DATABASE is the ordering authority —
 * every durable frame takes its seq from a single-row atomic before any
 * broadcast — so a hub only decides how a frame REACHES sockets that live
 * on other processes. Correctness never depends on which hub is running.
 *
 * InProcessHub covers the single-process deployments (embedded SQLite
 * mandates one replica anyway). A LISTEN/NOTIFY hub for replicated
 * PostgreSQL deployments plugs into the same interface.
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
}

export class InProcessHub implements ChannelHub {
  private channels = new Map<string, Map<string, Connection>>();

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
}
