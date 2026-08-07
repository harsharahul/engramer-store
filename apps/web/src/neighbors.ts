/**
 * Moving between files without leaving the viewer.
 *
 * The order is whatever the current view is showing, so stepping matches the
 * grid behind the viewer: the same sort, the same filter, the same search.
 * Ends are hard stops rather than wrapping, so reaching the last photo tells
 * you it is the last one instead of quietly starting again.
 */

/**
 * The id one step from `currentId`, or null when there is nowhere to go:
 * at either end, alone in the list, or no longer in it at all (a file can
 * be trashed or filtered away while it is open).
 */
export function stepThrough(ids: readonly string[], currentId: string, direction: 1 | -1): string | null {
  const at = ids.indexOf(currentId);
  if (at === -1) {
    return null;
  }
  const next = at + direction;
  return next >= 0 && next < ids.length ? (ids[next] ?? null) : null;
}

/** Below this a drag is a tap that moved, not an attempt to page. */
const SWIPE_MIN_PX = 60;

/**
 * Which way a finger drag means to page, or null for "leave it alone".
 *
 * A swipe and a scroll begin the same way, so sideways travel has to clearly
 * beat vertical travel before it counts: reading a long document drags a
 * thumb up the screen and wanders sideways doing it, and paging away from
 * what someone is reading is worse than ignoring a real swipe.
 */
export function swipeStep(dx: number, dy: number): 1 | -1 | null {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy) * 2) {
    return null;
  }
  return dx < 0 ? 1 : -1;
}
