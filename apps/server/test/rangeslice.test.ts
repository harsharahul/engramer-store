import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { sliceRange } from "../src/blobs.js";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function pattern(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 31 + 7) % 251;
  }
  return bytes;
}

/**
 * A storage backend that ignores Range and answers with the whole object
 * used to have its full body served AS the requested range: every chunk
 * the client decrypted was the wrong bytes, and playback froze on the
 * first frame while the clock kept running. When the backend's answer is
 * not the asked-for window, the window is cut from it here instead.
 */
describe("sliceRange", () => {
  it("cuts exactly the asked-for window out of a full body", async () => {
    const bytes = pattern(1000);
    const out = await collect(sliceRange(Readable.from(bytes), 100, 250));
    expect(out.equals(bytes.subarray(100, 350))).toBe(true);
  });

  it("is indifferent to how the source chops its chunks", async () => {
    const bytes = pattern(1000);
    const chunks = [bytes.subarray(0, 3), bytes.subarray(3, 150), bytes.subarray(150, 1000)];
    const out = await collect(sliceRange(Readable.from(chunks), 90, 500));
    expect(out.equals(bytes.subarray(90, 590))).toBe(true);
  });

  it("serves from the very start without dropping anything", async () => {
    const bytes = pattern(64);
    const out = await collect(sliceRange(Readable.from(bytes), 0, 10));
    expect(out.equals(bytes.subarray(0, 10))).toBe(true);
  });

  it("ends with the source when the window reaches past it", async () => {
    const bytes = pattern(64);
    const out = await collect(sliceRange(Readable.from(bytes), 60, 100));
    expect(out.equals(bytes.subarray(60))).toBe(true);
  });
});
