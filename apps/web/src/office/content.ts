/**
 * Pairing stored bytes with the channel's content marker.
 *
 * A content save records which generation the stored bytes are and the
 * channel position those bytes contain (the marker). A joiner downloads
 * bytes and replays the log; feeding it frames the bytes already contain
 * would apply them twice, so the marker decides what reaches the engine.
 *
 * Pairing is identity on the generation, never ordering: a lagging
 * saver's marker legitimately moves backward, and its bytes really do
 * contain less. Bytes of a DIFFERENT generation than the marker names
 * cannot be paired at all; the honest answers are one re-download with a
 * refreshed entry, then a full resync.
 */

export interface ContentMarker {
  generation: number;
  seq: number;
}

export type Reconcile = "legacy" | "ready" | "refetch" | "resync";

/** No marker, or a channel nothing has stamped yet: replay everything. */
function unmarked(marker: ContentMarker | null): boolean {
  return marker === null || marker.generation === 0;
}

export function reconcile(input: {
  bytesGeneration: number | null;
  marker: ContentMarker | null;
  refetched: boolean;
}): Reconcile {
  if (unmarked(input.marker)) {
    return "legacy";
  }
  if (input.bytesGeneration !== null && input.bytesGeneration === input.marker!.generation) {
    return "ready";
  }
  return input.refetched ? "resync" : "refetch";
}

/** Whether a frame at this server position should reach the engine. */
export function feedable(seq: number, marker: ContentMarker | null): boolean {
  if (unmarked(marker)) {
    return true;
  }
  return seq > marker!.seq;
}
