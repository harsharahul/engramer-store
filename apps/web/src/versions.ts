import type { FileMetadata } from "@engramer/crypto";

/**
 * Metadata for a restored version: the file keeps how the user organized it
 * (name, tags, favorite, category), while everything derived from the content
 * (size, times, search text, dimensions) comes from the version being
 * restored, so search and display stay coherent with the restored bytes.
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
