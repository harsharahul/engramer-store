/**
 * When the channel's frames become a stored document again.
 *
 * Any member's explicit save is a snapshot: the exported document contains
 * every frame that member has applied, so the log up to that point stops
 * being needed. Automatic snapshots — so a room nobody saves in still
 * converges and the log stays bounded — are the ELECTED member's job, and
 * the election is a pure function of the membership every client computes
 * identically: the lowest index present. No server involvement, no races;
 * at worst two members snapshot and the second is merely redundant.
 */

/** Frames worth carrying before a snapshot happens regardless of quiet. */
const SNAPSHOT_AFTER_FRAMES = 200;
/** A quiet spell with anything pending is the natural snapshot moment. */
const SNAPSHOT_IDLE_MS = 30_000;

export function electedSnapshotter(
  members: Array<{ connId: string; index: number; role?: string }>,
): string | null {
  // A viewer cannot write, so electing one jams the room: its save would
  // be refused and nobody else would consider themselves responsible. A
  // member with no stated role comes from an older server and stays
  // electable, which is exactly the old behavior.
  const writers = members.filter((m) => m.role === undefined || m.role !== "viewer");
  if (writers.length === 0) {
    return null;
  }
  return writers.reduce((low, m) => (m.index < low.index ? m : low)).connId;
}

export function shouldAutoSnapshot(state: {
  pendingFrames: number;
  msSinceLastFrame: number;
}): boolean {
  if (state.pendingFrames <= 0) {
    return false;
  }
  return (
    state.pendingFrames >= SNAPSHOT_AFTER_FRAMES || state.msSinceLastFrame >= SNAPSHOT_IDLE_MS
  );
}
