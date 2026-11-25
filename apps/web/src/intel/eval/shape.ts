/**
 * The shape a stored file's text has when the app's PDF step hands a page
 * over as one line: every line break and every cell boundary is a space.
 * The harness measures with it what a reader finds in such text.
 */
export function flatPages(text: string): string {
  return text
    .replace(/ \| /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
