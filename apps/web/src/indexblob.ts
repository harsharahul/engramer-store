/**
 * The encrypted index blob's inner format. Historically it held raw UTF-8
 * search text; the envelope adds room for more derived signals (today: the
 * semantic image embedding) while every legacy blob keeps decoding as
 * plain text. The server never sees any of this; it stores ciphertext.
 */

const MAGIC = "EIDX1:";

/**
 * The half of a fact that does not belong in metadata: the complete reference
 * number, and the passage it was read from so a fact can show its work.
 * Fetched only when someone opens a fact, which is what keeps the most
 * sensitive string in the vault out of the structure every device decrypts on
 * every sync.
 */
export interface FactEvidence {
  /** Matches the fact's id in metadata. */
  id: string;
  /** The complete value, of which metadata carries the last four characters. */
  full?: string;
  /** The passage the value came from. */
  span?: string;
  page?: number;
}

export interface IndexPayload {
  text?: string;
  /** Where each fact in this file's metadata came from. */
  evidence?: FactEvidence[];
  /** The primary meaning vector: the image, or a video's poster frame. */
  clip?: Float32Array;
  /** Every meaning vector, when there is more than one: videos sample
   * several frames so any scene matches, not only the poster. The first
   * entry always equals `clip`, keeping older readers correct. */
  clips?: Float32Array[];
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

function vectorToBase64(vector: Float32Array): string {
  return toBase64(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

export function encodeIndexPayload(payload: IndexPayload): Uint8Array {
  const body: {
    text?: string;
    clip?: string;
    clips?: string[];
    evidence?: FactEvidence[];
  } = {};
  if (payload.text !== undefined) {
    body.text = payload.text;
  }
  if (payload.evidence !== undefined && payload.evidence.length > 0) {
    body.evidence = payload.evidence;
  }
  const primary = payload.clip ?? payload.clips?.[0];
  if (primary !== undefined) {
    body.clip = vectorToBase64(primary);
  }
  if (payload.clips !== undefined && payload.clips.length > 1) {
    body.clips = payload.clips.map(vectorToBase64);
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
    const body = JSON.parse(text.slice(MAGIC.length)) as {
      text?: string;
      clip?: string;
      clips?: string[];
      evidence?: FactEvidence[];
    };
    const payload: IndexPayload = {};
    if (typeof body.text === "string") {
      payload.text = body.text;
    }
    if (Array.isArray(body.evidence)) {
      payload.evidence = body.evidence.filter(
        (entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string",
      );
    }
    const decodeVector = (encoded: string) => {
      const raw = fromBase64(encoded);
      return new Float32Array(raw.buffer, 0, Math.floor(raw.length / 4));
    };
    if (typeof body.clip === "string") {
      payload.clip = decodeVector(body.clip);
    }
    if (Array.isArray(body.clips) && body.clips.every((c) => typeof c === "string")) {
      payload.clips = body.clips.map(decodeVector);
      payload.clip ??= payload.clips[0];
    }
    return payload;
  } catch {
    // A malformed envelope indexes nothing rather than mis-indexing.
    return {};
  }
}
