/**
 * Mailbox exports, read one message at a time.
 *
 * A Google Takeout or Apple Mail export is one mbox file that can run to
 * tens of gigabytes, so it is never read whole: the splitter reads fixed
 * chunks, hands each message over as soon as its last line arrives, and
 * waits for the handler before reading on. Memory stays at about one chunk
 * plus one message whatever the size of the file.
 */

import type { UploadSource } from "../transfer";

/** Bytes read from the source per step. */
export const MBOX_CHUNK = 4 * 1024 * 1024;

/** Mail lines stop at 998 characters by standard; a line past this is not
 * mail, and holding it would mean holding the whole file. */
const MAX_LINE = 16 * 1024 * 1024;

const LF = 0x0a;
const GT = 0x3e;
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

function startsWithFrom(data: Uint8Array, at: number, end: number): boolean {
  if (end - at < FROM.length) {
    return false;
  }
  for (let i = 0; i < FROM.length; i++) {
    if (data[at + i] !== FROM[i]) {
      return false;
    }
  }
  return true;
}

/** Whether a line is an mboxrd-escaped body line: one or more ">" then "From ". */
function escapedFrom(data: Uint8Array, at: number, end: number): boolean {
  let i = at;
  while (i < end && data[i] === GT) {
    i++;
  }
  return i > at && startsWithFrom(data, i, end);
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) {
    return parts[0]!;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** What is kept of a message past the size cap: enough to name it. */
const OVERSIZED_HEAD = 64 * 1024;

export interface SplitOptions {
  /** A message past this many bytes is not handed to `onMessage`. */
  maxMessageBytes?: number;
  /** Receives the first 64 KiB of each message past the cap, and its index. */
  onOversized?: (head: Uint8Array, index: number) => Promise<void>;
}

/** Whether a source is a single message rather than a mailbox. */
export function isSingleMessage(source: Pick<UploadSource, "name" | "type">): boolean {
  return source.type === "message/rfc822" || /\.eml$/i.test(source.name);
}

/**
 * Calls `onMessage` with each message's raw bytes, in file order, and waits
 * for it before reading further. An mbox is split on lines that start with
 * "From " (the separator line itself is dropped) and mboxrd escapes are
 * undone; an .eml is one message. An abort stops before the next message is
 * handed over. `peakBufferedBytes` is the most the splitter held at once.
 *
 * A message larger than `maxMessageBytes` is never held whole: its first
 * 64 KiB, enough to name it, go to `onOversized`, and the rest is passed
 * over until the next separator.
 */
export async function splitMbox(
  source: UploadSource,
  onMessage: (raw: Uint8Array, index: number) => Promise<void>,
  signal?: AbortSignal,
  opts?: SplitOptions,
): Promise<{ messages: number; peakBufferedBytes: number }> {
  const max = opts?.maxMessageBytes;
  if (isSingleMessage(source)) {
    if (signal?.aborted) {
      return { messages: 0, peakBufferedBytes: 0 };
    }
    if (max !== undefined && source.size > max) {
      const head = new Uint8Array(
        await source.slice(0, Math.min(source.size, OVERSIZED_HEAD)).arrayBuffer(),
      );
      await opts?.onOversized?.(head, 0);
      return { messages: 1, peakBufferedBytes: head.length };
    }
    const raw = new Uint8Array(await source.arrayBuffer());
    await onMessage(raw, 0);
    return { messages: 1, peakBufferedBytes: raw.length };
  }

  let messages = 0;
  let peak = 0;
  let parts: Uint8Array[] = [];
  let partsBytes = 0;
  let stopped = false;
  let oversized = false;

  const hold = (data: Uint8Array, start: number, end: number) => {
    if (end <= start || oversized) {
      return;
    }
    if (max !== undefined && partsBytes + (end - start) > max) {
      // Past the cap: keep only the head, to name the message, and pass
      // over the rest until the next separator.
      const head = new Uint8Array(Math.min(OVERSIZED_HEAD, partsBytes + (end - start)));
      let at = 0;
      for (const part of parts) {
        if (at >= head.length) {
          break;
        }
        const take = part.subarray(0, head.length - at);
        head.set(take, at);
        at += take.length;
      }
      if (at < head.length) {
        head.set(data.subarray(start, start + head.length - at), at);
      }
      parts = [head];
      partsBytes = head.length;
      oversized = true;
      return;
    }
    parts.push(data.slice(start, end));
    partsBytes += end - start;
  };

  const flush = async () => {
    if (partsBytes === 0 && !oversized) {
      return;
    }
    if (signal?.aborted) {
      stopped = true;
      return;
    }
    if (oversized) {
      const head = concat(parts, partsBytes);
      parts = [];
      partsBytes = 0;
      oversized = false;
      await opts?.onOversized?.(head, messages);
      messages++;
      if (signal?.aborted) {
        stopped = true;
      }
      return;
    }
    const total = partsBytes;
    const raw = concat(parts, total);
    // The pieces and their joined copy coexist for a moment.
    peak = Math.max(peak, total + (parts.length > 1 ? total : 0));
    parts = [];
    partsBytes = 0;
    await onMessage(raw, messages);
    messages++;
    if (signal?.aborted) {
      stopped = true;
    }
  };

  let carry: Uint8Array = new Uint8Array(0);
  for (let offset = 0; offset < source.size && !stopped; offset += MBOX_CHUNK) {
    const chunk = new Uint8Array(
      await source.slice(offset, Math.min(source.size, offset + MBOX_CHUNK)).arrayBuffer(),
    );
    let data = chunk;
    if (carry.length > 0) {
      data = new Uint8Array(carry.length + chunk.length);
      data.set(carry);
      data.set(chunk, carry.length);
    }
    peak = Math.max(peak, partsBytes + data.length);

    // Untouched lines are copied out in runs; only separators and escaped
    // lines break a run.
    let runStart = 0;
    let lineStart = 0;
    while (!stopped) {
      const newline = data.indexOf(LF, lineStart);
      if (newline < 0) {
        break;
      }
      const lineEnd = newline + 1;
      if (startsWithFrom(data, lineStart, lineEnd)) {
        hold(data, runStart, lineStart);
        await flush();
        runStart = lineEnd;
      } else if (data[lineStart] === GT && escapedFrom(data, lineStart, lineEnd)) {
        hold(data, runStart, lineStart);
        hold(data, lineStart + 1, lineEnd);
        runStart = lineEnd;
      }
      lineStart = lineEnd;
    }
    hold(data, runStart, lineStart);
    carry = data.slice(lineStart);
    if (carry.length > MAX_LINE) {
      throw new Error("This file is not a mailbox export: a line runs past 16 MB");
    }
  }

  if (!stopped && carry.length > 0) {
    // The last line, with no newline after it.
    const end = carry.length;
    if (startsWithFrom(carry, 0, end)) {
      await flush();
    } else if (carry[0] === GT && escapedFrom(carry, 0, end)) {
      hold(carry, 1, end);
    } else {
      hold(carry, 0, end);
    }
  }
  if (!stopped) {
    await flush();
  }
  return { messages, peakBufferedBytes: peak };
}
