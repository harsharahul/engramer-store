import type { FileMetadata } from "@engramer/crypto";

/**
 * Metadata for a restored version: the file keeps how the user organized it
 * (name, tags, favorite, category), while everything derived from the content
 * (size, times, search text, dimensions, digest, facts) comes from the version
 * being restored, so search and display stay coherent with the restored bytes.
 *
 * Facts are deliberately absent from the preserved list, and the omission is
 * the point rather than an oversight: a tag is something the owner chose about
 * the file, while a fact is something the file said. Restoring older contents
 * has to restore what those contents said, or the file would carry an expiry
 * date that no version of it ever contained.
 */
export function mergeRestoredMeta(current: FileMetadata, version: FileMetadata): FileMetadata {
  return {
    ...version,
    name: current.name,
    category: current.category,
    tags: current.tags,
    favorite: current.favorite,
  };
}
