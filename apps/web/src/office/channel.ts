/**
 * Frame protection for the collaboration channel.
 *
 * The relay orders and stores frames but must learn nothing from them, so
 * every frame the engine produces is sealed under the FILE key before it
 * leaves this page, and everything that decides whether an incoming frame
 * may touch the document is checked against AUTHENTICATED data only: the
 * document id, the sender id, and a per-sender counter all live inside the
 * ciphertext. The server-assigned position is delivery order, never proof.
 *
 * A counter gap means frames were lost or withheld; the only safe answer
 * is a reload from the current snapshot, never an out-of-order apply.
 */

import { secretBoxOpen, secretBoxSeal, utf8Decode, utf8Encode } from "@engramer/crypto";

export type FrameKind = "chg" | "lock" | "unlock" | "snap-begin" | "snap-done" | "cursor" | "presence";

export interface ChannelFrame {
  /** The document this frame belongs to; anything else is dropped. */
  ch: string;
  /** Sender connection id, self-asserted but sealed under the file key. */
  s: string;
  /** Per-sender counter, 1-based and contiguous. */
  n: number;
  k: FrameKind;
  d: unknown;
}

/** Seals a frame for the relay: an opaque string the server never parses. */
export function encryptFrame(frame: ChannelFrame, fileKey: Uint8Array): string {
  const sealed = secretBoxSeal(utf8Encode(JSON.stringify(frame)), fileKey);
  return `${sealed.nonce}.${sealed.ciphertext}`;
}

/** Opens a sealed frame. Throws on tampering or the wrong key. */
export function decryptFrame(payload: string, fileKey: Uint8Array): ChannelFrame {
  const dot = payload.indexOf(".");
  if (dot <= 0) {
    throw new Error("malformed frame");
  }
  const opened = secretBoxOpen(
    { nonce: payload.slice(0, dot), ciphertext: payload.slice(dot + 1) },
    fileKey,
  );
  return JSON.parse(utf8Decode(opened)) as ChannelFrame;
}

/** Replay/reorder bookkeeping for one document's channel. */
export interface ChannelOrder {
  readonly fileId: string;
  /** Highest applied counter per sender. */
  readonly lastFrom: Map<string, number>;
  /** Set once a gap is seen; every later frame answers resync too. */
  broken: boolean;
}

export function newChannelOrder(fileId: string): ChannelOrder {
  return { fileId, lastFrom: new Map(), broken: false };
}

/**
 * Whether a decoded frame may be applied. "resync" is sticky: once frames
 * went missing, the document state is unknowable from the stream and only
 * a reload from the snapshot recovers it.
 */
export function acceptFrame(order: ChannelOrder, frame: ChannelFrame): "apply" | "drop" | "resync" {
  if (order.broken) {
    return "resync";
  }
  if (frame.ch !== order.fileId) {
    return "drop";
  }
  const last = order.lastFrom.get(frame.s) ?? 0;
  if (frame.n <= last) {
    return "drop";
  }
  if (frame.n !== last + 1) {
    order.broken = true;
    return "resync";
  }
  order.lastFrom.set(frame.s, frame.n);
  return "apply";
}
