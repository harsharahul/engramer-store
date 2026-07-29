import { Readable } from "node:stream";

export type BufferedOrStream =
  | { kind: "buffered"; bytes: Buffer }
  | { kind: "stream"; stream: Readable };

/**
 * Reads a stream fully if it fits in cap bytes, otherwise hands back a
 * stream of what was read followed by the rest. The iterator is advanced by
 * hand because exiting a for-await destroys the underlying stream, which
 * would lose the unread remainder.
 */
export async function bufferUpTo(source: Readable, cap: number): Promise<BufferedOrStream> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      break;
    }
    const piece = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
    chunks.push(piece);
    total += piece.length;
    if (total > cap) {
      return {
        kind: "stream",
        stream: Readable.from(
          (async function* () {
            yield* chunks;
            for (;;) {
              const rest = await iterator.next();
              if (rest.done) {
                break;
              }
              yield rest.value;
            }
          })(),
        ),
      };
    }
  }
  return { kind: "buffered", bytes: Buffer.concat(chunks) };
}
