/**
 * Recovering camera names from export paths.
 *
 * Backed-up photos used to be stored under the name of their staged
 * export file: the asset id, sanitized, prefixed to the real filename
 * for uniqueness on disk. New backups carry the library's own name; this
 * recognizes the old pattern so a one-shot pass can rename what is
 * already stored, and recognizes nothing else.
 */

/** The shell's export sanitizer, mirrored: every non-alphanumeric
 * character of the asset id became an underscore in the staged name. */
function sanitizedId(sourceId: string): string {
  return sourceId.replace(/[^\p{L}\p{N}]/gu, "_");
}

/**
 * The camera name hiding inside an id-prefixed stored name, or null when
 * the name carries no such prefix (or nothing would remain of it).
 */
export function tidyBackupName(name: string, sourceId: string): string | null {
  const prefix = `${sanitizedId(sourceId)}-`;
  if (!name.startsWith(prefix)) {
    return null;
  }
  const tidy = name.slice(prefix.length);
  return tidy.length > 0 ? tidy : null;
}
