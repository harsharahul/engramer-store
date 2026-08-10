/**
 * Concurrent-save decisions, pure and testable.
 *
 * Two people can hold the same document open; the server's generation check
 * guarantees the second save cannot clobber the first, and everything here
 * exists to turn that refusal into a clean question instead of a generic
 * error. The bytes someone typed always have somewhere to go.
 */

/** The server refused a save because the file moved under it. */
export class SaveConflictError extends Error {
  constructor(readonly fileId: string) {
    super("the file changed while saving");
  }
}

/**
 * Whether the entry advanced since the editor opened it. Only strictly
 * newer counts: a refresh can lower the stamp (a restore, clock skew) and
 * that is not somebody else's save.
 */
export function describeConflict(
  openedUpdatedAt: number,
  currentUpdatedAt: number,
): "clean" | "stale" {
  return currentUpdatedAt > openedUpdatedAt ? "stale" : "clean";
}

/**
 * Whether losing a save race actually lost anything. In a LIVE room with
 * every posted frame acknowledged, this client's content sits in the log
 * and inside the winner's engine, so the winner's committed bytes and the
 * surviving tail carry it in full; the refusal is bookkeeping, not loss.
 * A solo save or an unacked frame means content that may exist nowhere
 * but this engine, and that must surface as a real conflict.
 */
export function satisfiedByPeer(state: { live: boolean; pendingAcks: number }): boolean {
  return state.live && state.pendingAcks === 0;
}

/** The name a conflicting save lands under when kept as a copy. */
export function copyName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return `${name} (your copy)`;
  }
  return `${name.slice(0, dot)} (your copy)${name.slice(dot)}`;
}
