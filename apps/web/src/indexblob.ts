/**
 * The encrypted index blob's inner format. Historically it held raw UTF-8
 * search text; the envelope adds room for more derived signals (today: the
 * semantic image embedding) while every legacy blob keeps decoding as
 * plain text. The server never sees any of this; it stores ciphertext.
 */

const MAGIC = "EIDX1:";

export interface IndexPayload {
  text?: string;
  clip?: Float32Array;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeIndexPayload(payload: IndexPayload): Uint8Array {
  const body: { text?: string; clip?: string } = {};
  if (payload.text !== undefined) {
    body.text = payload.text;
  }
  if (payload.clip !== undefined) {
    body.clip = toBase64(new Uint8Array(payload.clip.buffer, payload.clip.byteOffset, payload.clip.byteLength));
  }
  return new TextEncoder().encode(MAGIC + JSON.stringify(body));
}

export function decodeIndexPayload(bytes: Uint8Array): IndexPayload {
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith(MAGIC)) {
    // Legacy blob: the whole payload is the search text.
    return { text };
  }
  try {
    const body = JSON.parse(text.slice(MAGIC.length)) as { text?: string; clip?: string };
    const payload: IndexPayload = {};
    if (typeof body.text === "string") {
      payload.text = body.text;
    }
    if (typeof body.clip === "string") {
      const raw = fromBase64(body.clip);
      payload.clip = new Float32Array(raw.buffer, 0, Math.floor(raw.length / 4));
    }
    return payload;
  } catch {
    // A malformed envelope indexes nothing rather than mis-indexing.
    return {};
  }
}
