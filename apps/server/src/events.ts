import type { Writable } from "node:stream";

/**
 * Fan-out for "this account's data moved" pokes. Mutations advance a
 * per-account sequence through one allocator; this publisher watches
 * those advances and tells whoever is listening to pull. The message
 * carries only the sequence number, which the sync feed already hands
 * every client, so the channel adds no server knowledge.
 *
 * Bumps are recorded synchronously (the allocator may be inside a
 * database transaction, which must never wait on foreign I/O) and
 * flushed a beat later, coalescing a burst of writes into one poke.
 * The flush can therefore race a commit or announce a rolled-back
 * bump; both cost the listener one empty pull and nothing else, since
 * correctness lives in the cursor pull, not here.
 */
const FLUSH_MS = 150;

/** Streams one account may hold at once; a device needs exactly one.
 * The newest connection wins and the oldest is ended, the same stance
 * the session-key cap takes, so a looping reconnect can never pile up
 * server-side state. */
const STREAMS_PER_USER = 16;

export class SeqEvents {
  private readonly sinks = new Map<number, Set<Writable>>();
  private readonly pending = new Map<number, number>();
  private flush: NodeJS.Timeout | null = null;

  note(userId: number, seq: number): void {
    const held = this.pending.get(userId);
    if (held !== undefined && held >= seq) {
      return;
    }
    this.pending.set(userId, seq);
    if (!this.flush) {
      // Unref'd so a pending poke can never hold the process open.
      this.flush = setTimeout(() => this.deliver(), FLUSH_MS);
      this.flush.unref?.();
    }
  }

  subscribe(userId: number, sink: Writable): () => void {
    let set = this.sinks.get(userId);
    if (!set) {
      set = new Set();
      this.sinks.set(userId, set);
    }
    while (set.size >= STREAMS_PER_USER) {
      const oldest = set.values().next().value;
      if (!oldest) {
        break;
      }
      set.delete(oldest);
      oldest.end();
    }
    set.add(sink);
    return () => {
      set.delete(sink);
      if (set.size === 0) {
        this.sinks.delete(userId);
      }
    };
  }

  /** Ends every live stream so a closing server never hangs on one. */
  closeAll(): void {
    if (this.flush) {
      clearTimeout(this.flush);
      this.flush = null;
    }
    this.pending.clear();
    for (const set of this.sinks.values()) {
      for (const sink of set) {
        sink.end();
      }
    }
    this.sinks.clear();
  }

  private deliver(): void {
    this.flush = null;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [userId, seq] of batch) {
      const set = this.sinks.get(userId);
      if (!set) {
        continue;
      }
      for (const sink of set) {
        sink.write(`data: {"seq":${seq}}\n\n`);
      }
    }
  }
}
