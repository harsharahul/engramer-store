import type { Album } from "./albums";

/**
 * How the sidebar orders what the user made. Pinned collections lead,
 * ordered by title so the pinned zone is stable; then the rest by when
 * they last changed, newest first, so a new album or one that just grew
 * sits near the top of its group instead of wherever its name falls;
 * ties break by title. Derived collections (the Library) order by count
 * and do not pass through here.
 */
export function orderCollections(albums: readonly Album[], pinned: ReadonlySet<string>): Album[] {
  return [...albums].sort((a, b) => {
    const pinA = pinned.has(a.tag);
    const pinB = pinned.has(b.tag);
    if (pinA !== pinB) {
      return pinA ? -1 : 1;
    }
    if (pinA) {
      return a.title.localeCompare(b.title);
    }
    if (a.changedAt !== b.changedAt) {
      return b.changedAt - a.changedAt;
    }
    return a.title.localeCompare(b.title);
  });
}
