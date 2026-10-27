import { describe, expect, it } from "vitest";
import type { UploadSource } from "../transfer";
import { MBOX_CHUNK, splitMbox } from "./mbox";

/** An in-memory source, the shape the picker and the native bridge hand over. */
function sourceOf(bytes: Uint8Array, name: string, type = ""): UploadSource {
  const blob = new Blob([bytes as BlobPart], { type });
  return {
    name,
    type,
    size: bytes.length,
    lastModified: 0,
    slice: (start, end) => blob.slice(start, end),
    arrayBuffer: () => blob.arrayBuffer(),
    text: () => blob.text(),
  };
}

const utf8 = new TextEncoder();
const text = (raw: Uint8Array) => new TextDecoder().decode(raw);

describe("splitMbox", () => {
  it("splits three messages and unescapes >From lines", async () => {
    // mboxrd: a body line starting "From " is stored as ">From ", and one
    // already starting ">From " as ">>From ". Reading takes one ">" off.
    const mbox = [
      "From a@example.com Mon Jan  5 09:00:00 2026\n",
      "From: a@example.com\nSubject: one\n\n>From the start\nplain line\n\n",
      "From b@example.com Tue Jan  6 09:00:00 2026\r\n",
      "From: b@example.com\r\nSubject: two\r\n\r\n>>From quoted\r\n\r\n",
      "From c@example.com Wed Jan  7 09:00:00 2026\n",
      "From: c@example.com\nSubject: three\n\nlast line without newline",
    ].join("");
    const seen: string[] = [];
    const result = await splitMbox(sourceOf(utf8.encode(mbox), "export.mbox"), async (raw, index) => {
      expect(index).toBe(seen.length);
      seen.push(text(raw));
    });
    expect(result.messages).toBe(3);
    expect(seen[0]).toBe("From: a@example.com\nSubject: one\n\nFrom the start\nplain line\n\n");
    expect(seen[1]).toBe("From: b@example.com\r\nSubject: two\r\n\r\n>From quoted\r\n\r\n");
    expect(seen[2]).toBe("From: c@example.com\nSubject: three\n\nlast line without newline");
  });

  it("an eml file is one message", async () => {
    // An .eml has no separator line, and a body line starting "From " in it
    // is just text.
    const eml = "From: a@example.com\nSubject: hi\n\nFrom the desk of A\n";
    const seen: string[] = [];
    const result = await splitMbox(sourceOf(utf8.encode(eml), "Hi.eml"), async (raw) => {
      seen.push(text(raw));
    });
    expect(result.messages).toBe(1);
    expect(seen).toEqual([eml]);
  });

  it("peak buffered bytes stay within one chunk plus a few messages on a 200 MiB source", async () => {
    // 64 KiB messages, repeated to 200 MiB, generated on demand so the test
    // itself never holds the file.
    const MESSAGE = 64 * 1024;
    const line = `${"x".repeat(1022)}\n`;
    const head = "From a@example.com Mon Jan  5 09:00:00 2026\nSubject: filler\n\n";
    let body = head;
    while (body.length + line.length <= MESSAGE) {
      body += line;
    }
    const template = utf8.encode(body.padEnd(MESSAGE, "\n"));
    const size = 200 * 1024 * 1024;
    const source: UploadSource = {
      name: "big.mbox",
      type: "",
      size,
      lastModified: 0,
      slice: (start = 0, end = size) => {
        const out = new Uint8Array(Math.min(end, size) - start);
        for (let at = 0; at < out.length; ) {
          const offset = (start + at) % MESSAGE;
          const piece = template.subarray(offset, Math.min(MESSAGE, offset + out.length - at));
          out.set(piece, at);
          at += piece.length;
        }
        return { size: out.length, arrayBuffer: async () => out.buffer };
      },
      arrayBuffer: () => Promise.reject(new Error("whole-file read")),
      text: () => Promise.reject(new Error("whole-file read")),
    };
    let count = 0;
    const result = await splitMbox(source, async () => {
      count++;
    });
    expect(count).toBe(size / MESSAGE);
    expect(result.messages).toBe(size / MESSAGE);
    // Bounded by one chunk, a carried partial line, and a message assembled
    // from its pieces; never by the size of the file.
    expect(result.peakBufferedBytes).toBeLessThanOrEqual(MBOX_CHUNK + 3 * MESSAGE);
  });

  it("refuses a file whose line never ends instead of holding it whole", async () => {
    const size = 40 * 1024 * 1024;
    const source: UploadSource = {
      name: "photo.mbox",
      type: "",
      size,
      lastModified: 0,
      slice: (start = 0, end = size) => {
        const out = new Uint8Array(Math.min(end, size) - start).fill(0x78);
        return { size: out.length, arrayBuffer: async () => out.buffer };
      },
      arrayBuffer: () => Promise.reject(new Error("whole-file read")),
      text: () => Promise.reject(new Error("whole-file read")),
    };
    await expect(splitMbox(source, async () => {})).rejects.toThrow(/not a mailbox/);
  });

  it("stops between messages when aborted", async () => {
    const mbox = ["a", "b", "c"]
      .map((who) => `From ${who}@example.com Mon Jan  5 09:00:00 2026\nSubject: ${who}\n\nbody\n\n`)
      .join("");
    const controller = new AbortController();
    const seen: number[] = [];
    const result = await splitMbox(
      sourceOf(utf8.encode(mbox), "three.mbox"),
      async (_raw, index) => {
        seen.push(index);
        if (index === 0) {
          controller.abort();
        }
      },
      controller.signal,
    );
    expect(seen).toEqual([0]);
    expect(result.messages).toBe(1);
  });
});
