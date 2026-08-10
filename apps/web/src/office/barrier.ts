/**
 * The save barrier's policy: whether the engine and channel are quiet
 * enough for a content save to capture its marker.
 *
 * Content-marker exactness. For bytes committed as generation G with
 * marker S:
 *  - (no double-apply) no channel frame with seq > S may be represented
 *    in those bytes;
 *  - (no loss) every frame with seq <= S must be represented in those
 *    bytes OR still live in the log.
 * A content save must satisfy both, because a joiner skips frames <= S
 * permanently. A checkpoint additionally deletes <= S, so its bound must
 * not exceed what its bytes fully contain.
 *
 * Quiet means: the engine holds no unsent changes, has applied everything
 * delivered, and every posted frame is acked (so lastSeenSeq covers it).
 * Anything still moving is a retry; a budget of retries that never finds
 * quiet abandons the save rather than committing a marker that lies.
 * The one exception is a relay that refuses further posts (byte ceiling):
 * a refused frame exists nowhere but this engine, so nothing will ever
 * replay it and the export is its only copy.
 */
export interface BarrierState {
  /** The engine holds changes it has not yet sent (its own view). */
  haveChanges: boolean;
  /** The engine holds received changes it has not yet applied. */
  haveOtherChanges: boolean;
  /** Frames posted to the channel and not yet acked. */
  pendingAcks: number;
  /** chg frames posted when the capture was taken. */
  postsAtCapture: number;
  /** chg frames posted now. */
  postsNow: number;
  /** The relay is refusing further posts until someone snapshots. */
  ceilingReached: boolean;
  /** This save will carry the trim that unclogs the room. */
  checkpoint: boolean;
  /** Zero-based retry attempt. */
  attempt: number;
}

export type BarrierVerdict = "capture" | "retry" | "proceed-unlogged" | "abandon";

const MAX_ATTEMPTS = 5;

export function barrierVerdict(state: BarrierState): BarrierVerdict {
  const engineMoving = state.haveChanges || state.haveOtherChanges;
  const posted = state.postsNow !== state.postsAtCapture;
  if (!engineMoving && !posted && state.pendingAcks === 0) {
    return "capture";
  }
  if (!engineMoving && !posted && state.ceilingReached) {
    return "proceed-unlogged";
  }
  // At the hard ceiling the relay refuses every post, so the engine's
  // save cycle cannot complete and quiet is unreachable; the checkpoint
  // that trims the log must still land or the room livelocks. Its bytes
  // carry the engine's held changes, which have no log positions, so
  // nothing can ever replay them and the marker stays exact.
  if (state.ceilingReached && state.checkpoint && state.attempt >= 2) {
    return "proceed-unlogged";
  }
  if (state.attempt >= MAX_ATTEMPTS) {
    return "abandon";
  }
  return "retry";
}

const DELAYS_MS = [0, 120, 250, 400, 700, 1000];

/** How long to wait before the given attempt; holds at the last delay. */
export function barrierDelayMs(attempt: number): number {
  return DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)]!;
}
