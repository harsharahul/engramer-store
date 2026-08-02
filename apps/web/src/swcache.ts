/**
 * Shared decrypted-chunk cache for the service worker's media bridge, the
 * same shape the native desktop player uses. Every media response reads
 * chunks from one per-file pool; a missing chunk starts a windowed
 * upstream fetch that decrypts chunks into the pool as they arrive, and
 * every concurrent request wanting those chunks waits on the same fetch.
 * A media engine reading with two cursors becomes two windows in flight,
 * never a fetch per request, and a cancelled response costs nothing
 * because fetches belong to the pool, not to responses.
 */

interface Waiter {
  resolve: (plain: Uint8Array | null) => void;
}

interface InFlight {
  fileId: string;
  firstChunk: number;
  lastChunk: number;
  done: Promise<void>;
}

export class ChunkCache {
  /** Insertion order is recency order: a touch re-inserts at the tail. */
  private readonly chunks = new Map<string, Uint8Array>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly fetches = new Set<InFlight>();

  constructor(private readonly maxChunks: number) {}

  private key(fileId: string, index: number): string {
    return `${fileId}#${index}`;
  }

  get(fileId: string, index: number): Uint8Array | undefined {
    const key = this.key(fileId, index);
    const plain = this.chunks.get(key);
    if (plain !== undefined) {
      this.chunks.delete(key);
      this.chunks.set(key, plain);
    }
    return plain;
  }

  /** Inserts a decrypted chunk, wakes its waiters, evicts past budget. */
  insert(fileId: string, index: number, plain: Uint8Array): void {
    const key = this.key(fileId, index);
    this.chunks.delete(key);
    this.chunks.set(key, plain);
    for (const waiter of this.waiters.get(key) ?? []) {
      waiter.resolve(plain);
    }
    this.waiters.delete(key);
    while (this.chunks.size > this.maxChunks) {
      const oldest = this.chunks.keys().next().value as string;
      this.chunks.delete(oldest);
    }
  }

  /** The in-flight fetch covering a chunk, if any. */
  covering(fileId: string, index: number): InFlight | null {
    for (const flight of this.fetches) {
      if (flight.fileId === fileId && index >= flight.firstChunk && index <= flight.lastChunk) {
        return flight;
      }
    }
    return null;
  }

  /** How many consecutive chunks after index are already cached or being
   * fetched; read-ahead starts where this runs out. */
  readyAhead(fileId: string, index: number, limit: number): number {
    let ahead = 0;
    while (ahead < limit) {
      const next = index + 1 + ahead;
      if (this.chunks.has(this.key(fileId, next)) || this.covering(fileId, next)) {
        ahead++;
      } else {
        break;
      }
    }
    return ahead;
  }

  /**
   * Resolves the chunk's plaintext: from the cache, or by waiting on the
   * in-flight fetch that covers it, or by starting a new windowed fetch
   * via `fetch`. Resolves null if the covering fetch dies before the
   * chunk arrives.
   */
  async ensure(
    fileId: string,
    index: number,
    fetch: (firstChunk: number) => { lastChunk: number; done: Promise<void> },
  ): Promise<Uint8Array | null> {
    const cached = this.get(fileId, index);
    if (cached !== undefined) {
      return cached;
    }
    let flight = this.covering(fileId, index);
    if (!flight) {
      flight = this.start(fileId, index, fetch);
    }
    const key = this.key(fileId, index);
    const waited = new Promise<Uint8Array | null>((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push({ resolve });
      this.waiters.set(key, list);
    });
    // The fetch finishing without delivering the chunk (short read, error)
    // must not strand the waiter.
    void flight.done.then(() => {
      const late = this.chunks.get(key);
      for (const waiter of this.waiters.get(key) ?? []) {
        waiter.resolve(late ?? null);
      }
      this.waiters.delete(key);
    });
    return waited;
  }

  /** Starts a windowed fetch and tracks it; safe to call fire-and-forget. */
  start(
    fileId: string,
    firstChunk: number,
    fetch: (firstChunk: number) => { lastChunk: number; done: Promise<void> },
  ): InFlight {
    const { lastChunk, done } = fetch(firstChunk);
    const flight: InFlight = { fileId, firstChunk, lastChunk, done };
    this.fetches.add(flight);
    void done.finally(() => this.fetches.delete(flight));
    return flight;
  }

  /** Drops a file's chunks (session end, key revocation). */
  drop(fileId: string): void {
    for (const key of [...this.chunks.keys()]) {
      if (key.startsWith(`${fileId}#`)) {
        this.chunks.delete(key);
      }
    }
  }
}
