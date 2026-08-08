import { slug } from "./intel/trips";

/**
 * Albums are a reserved namespace inside the ordinary encrypted tags: a file
 * in the album "Holidays 2026" simply carries the tag `album:holidays-2026`.
 * Everything tags already do, albums inherit for free: many files per album
 * and many albums per file, encrypted metadata, sync, search. What is stored
 * is always the slug; the human name is derived on the way out, because
 * `setTags` lowercases every tag it writes and a stored display name would
 * not survive that round trip.
 *
 * The `trip:` namespace established this pattern; albums follow it exactly.
 * Both prefixes are reserved: the tag editor refuses hand-typed tags in
 * either namespace, so membership only ever changes through the dedicated
 * album and trip flows.
 */

export const ALBUM_PREFIX = "album:";

const RESERVED_PREFIXES = [ALBUM_PREFIX, "trip:"];

/** A tag the free-tag editor must not create or edit. */
export function isReservedTag(tag: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

export function albumSlug(name: string): string {
  return slug(name);
}

/** The stored tag for a human album name, or null when nothing survives slugging. */
export function albumTag(name: string): string | null {
  const s = albumSlug(name);
  return s ? ALBUM_PREFIX + s : null;
}

export function isAlbumTag(tag: string): boolean {
  return tag.startsWith(ALBUM_PREFIX) && tag.length > ALBUM_PREFIX.length;
}

/** The slug rendered back into words: "album:holidays-2026" reads as "Holidays 2026". */
export function albumTitle(tag: string): string {
  if (!isAlbumTag(tag)) {
    return tag;
  }
  return tag
    .slice(ALBUM_PREFIX.length)
    .split("-")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export interface Album {
  tag: string;
  title: string;
  count: number;
  /** The most recently taken member, the natural cover. */
  coverFileId?: string;
}

/** Every album present across `files`, counted, covered, sorted by title. */
export function albumsFrom(
  files: readonly { id: string; tags: readonly string[]; mtime?: number }[],
): Album[] {
  const byTag = new Map<string, { count: number; coverFileId?: string; coverMtime: number }>();
  for (const file of files) {
    for (const tag of file.tags) {
      if (!isAlbumTag(tag)) {
        continue;
      }
      const entry = byTag.get(tag) ?? { count: 0, coverMtime: -Infinity };
      entry.count++;
      const mtime = file.mtime ?? 0;
      if (mtime > entry.coverMtime) {
        entry.coverMtime = mtime;
        entry.coverFileId = file.id;
      }
      byTag.set(tag, entry);
    }
  }
  return [...byTag.entries()]
    .map(([tag, { count, coverFileId }]) => ({ tag, title: albumTitle(tag), count, coverFileId }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
