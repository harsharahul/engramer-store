/**
 * Counters for one live editing session, kept in memory and shown only in
 * the in-app diagnostics, following the same policy as diag.ts: nothing
 * here is transmitted or persisted.
 *
 * They exist to let a production session answer the questions that
 * otherwise become guesses: is the other side's cursor missing because it
 * was never sent or never received, and is typing lag in the posts or in
 * the acks.
 */

export interface CollabStats {
  ephSent: number;
  ephReceivedBySender: Map<string, number>;
  /** Total ephemeral frames fed to the engine; a plain number because an
   * external probe reading this object serializes Maps into nothing. */
  ephReceivedTotal: number;
  /** Total log frames that ENTERED the receive handler, before any
   * verdict: the counter that separates "not arriving" from "arriving
   * and silently dying". */
  logReceivedTotal: number;
  chgPosted: number;
  chgAcked: number;
  ackLatency: { count: number; totalMs: number; maxMs: number; lastMs: number };
  /** The cumulative change count last handed to the local engine. */
  changesIndex: number;
  /** Posted refs waiting for their ack, by the time they left. */
  pendingAcks: Map<number, number>;
  /** Received frames that never reached the engine, counted by reason.
   * A plain object, so a probe can read it: a silent feed death is
   * invisible exactly when it matters most. */
  skips: Record<string, number>;
}

export function newCollabStats(): CollabStats {
  return {
    ephSent: 0,
    ephReceivedBySender: new Map(),
    ephReceivedTotal: 0,
    logReceivedTotal: 0,
    chgPosted: 0,
    chgAcked: 0,
    ackLatency: { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 },
    changesIndex: 0,
    pendingAcks: new Map(),
    skips: {},
  };
}

export function noteSkip(stats: CollabStats, reason: string): void {
  stats.skips[reason] = (stats.skips[reason] ?? 0) + 1;
}

export function notePost(stats: CollabStats, ref: number, at: number): void {
  stats.chgPosted += 1;
  stats.pendingAcks.set(ref, at);
}

export function noteAck(stats: CollabStats, ref: number, at: number): void {
  const postedAt = stats.pendingAcks.get(ref);
  if (postedAt === undefined) {
    return;
  }
  stats.pendingAcks.delete(ref);
  stats.chgAcked += 1;
  const ms = at - postedAt;
  const l = stats.ackLatency;
  l.count += 1;
  l.totalMs += ms;
  l.lastMs = ms;
  if (ms > l.maxMs) {
    l.maxMs = ms;
  }
}

export function noteEphSent(stats: CollabStats): void {
  stats.ephSent += 1;
}

export function noteEphReceived(stats: CollabStats, sender: string): void {
  stats.ephReceivedBySender.set(sender, (stats.ephReceivedBySender.get(sender) ?? 0) + 1);
  stats.ephReceivedTotal += 1;
}

/**
 * How long the oldest posted-but-unacknowledged change has been waiting,
 * or null with nothing pending. A healthy relay acks within a round
 * trip; a change stuck beyond tens of seconds means the stream is dead
 * in a way the socket has not noticed, and only a repair fixes it.
 */
export function oldestPendingMs(stats: CollabStats, now: number): number | null {
  let oldest: number | null = null;
  for (const at of stats.pendingAcks.values()) {
    if (oldest === null || at < oldest) {
      oldest = at;
    }
  }
  return oldest === null ? null : now - oldest;
}

export function describeCollabStats(stats: CollabStats): string {
  const l = stats.ackLatency;
  const avg = l.count ? Math.round(l.totalMs / l.count) : 0;
  const bySender =
    [...stats.ephReceivedBySender.entries()].map(([who, n]) => `${who}:${n}`).join(" ") || "none";
  return (
    `chg ${stats.chgAcked}/${stats.chgPosted} acked, ` +
    `ack avg ${avg}ms last ${l.lastMs}ms max ${l.maxMs}ms, ` +
    `eph out ${stats.ephSent}, eph in ${bySender}, index ${stats.changesIndex}`
  );
}
