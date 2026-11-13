/**
 * How much of a document the on-device model is shown. Its window is small,
 * and part of it goes to the instructions, the schema and the answer.
 */

/** Tokens kept back for the instructions, the schema, and the answer. */
export const RESERVED_TOKENS = 700;
/** A rough measure of text against tokens, on the cautious side. */
export const CHARS_PER_TOKEN = 3;

/** The opening of a document, as much as the model's window holds. */
export function headChunk(text: string, contextSize: number): string {
  const budget = Math.max(1_500, (contextSize - RESERVED_TOKENS) * CHARS_PER_TOKEN);
  return text.length <= budget ? text : text.slice(0, budget);
}
