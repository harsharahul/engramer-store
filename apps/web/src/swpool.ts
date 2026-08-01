/**
 * Parking pool for upstream ciphertext readers, shared by the service
 * worker's media bridge. Media engines consume a stream as many short
 * range requests; a request that ends or cancels parks its reader here and
 * a later request picks it up instead of opening a fresh fetch.
 *
 * Unlike a one-reader-per-file slot, the pool holds several sessions so a
 * client reading with two cursors at once (desktop Safari keeps a playhead
 * and a prefetch position, and MP4 indexes often live at the tail) parks
 * both and resumes both. Matching is positional, best fit first:
 *
 *  - exact: the reader's next chunk is the one requested;
 *  - ring: the request re-enters a recently decrypted chunk (WebKit's
 *    ranges are rarely chunk-aligned and land a little behind a reader
 *    that ran ahead of the engine's commit point);
 *  - skip-ahead: the reader sits a few chunks short, and discarding that
 *    little from the wire is cheaper than a new round trip.
 */

export interface PoolSession {
  /** The next chunk index the upstream reader will yield. */
  nextChunk: number;
  /** Recently decrypted chunks, for continuations that re-enter them. */
  ring: Array<{ index: number; plain: Uint8Array }>;
}

interface Parked<S> {
  fileId: string;
  session: S;
  timer: ReturnType<typeof setTimeout>;
}

export class ContinuationPool<S extends PoolSession> {
  private readonly parked: Array<Parked<S>> = [];

  constructor(
    private readonly maxSessions: number,
    private readonly ttlMs: number,
    private readonly skipAheadChunks: number,
    private readonly onDrop: (session: S) => void,
  ) {}

  /**
   * Removes and returns the best-positioned parked session for a request
   * starting at firstChunk, or null. A session returned with its cursor
   * short of firstChunk is a skip-ahead: the caller discards the gap from
   * the wire before serving.
   */
  claim(fileId: string, firstChunk: number): S | null {
    let best: Parked<S> | null = null;
    let bestScore = Infinity;
    for (const entry of this.parked) {
      if (entry.fileId !== fileId) {
        continue;
      }
      const s = entry.session;
      let score: number;
      if (s.nextChunk === firstChunk) {
        score = 0;
      } else if (s.ring.some((held) => held.index === firstChunk)) {
        score = s.nextChunk - firstChunk;
      } else if (firstChunk > s.nextChunk && firstChunk - s.nextChunk <= this.skipAheadChunks) {
        score = 100 + (firstChunk - s.nextChunk);
      } else {
        continue;
      }
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
      if (score === 0) {
        break;
      }
    }
    if (best === null) {
      return null;
    }
    this.parked.splice(this.parked.indexOf(best), 1);
    clearTimeout(best.timer);
    return best.session;
  }

  /** Parks a session; past capacity the oldest parked session drops.
   * Idempotent: a session already parked only has its timer refreshed, so
   * a response whose teardown fires twice can never list its reader twice
   * (two claimants on one reader would interleave and desync it). */
  park(fileId: string, session: S): void {
    const existing = this.parked.find((entry) => entry.session === session);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.drop(session), this.ttlMs);
      return;
    }
    const timer = setTimeout(() => this.drop(session), this.ttlMs);
    this.parked.push({ fileId, session, timer });
    let oldest = this.parked[0];
    while (this.parked.length > this.maxSessions && oldest !== undefined) {
      this.drop(oldest.session);
      oldest = this.parked[0];
    }
  }

  private drop(session: S): void {
    const i = this.parked.findIndex((entry) => entry.session === session);
    const entry = this.parked[i];
    if (entry !== undefined) {
      clearTimeout(entry.timer);
      this.parked.splice(i, 1);
      this.onDrop(session);
    }
  }
}
